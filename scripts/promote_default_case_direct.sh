#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" == "Darwin" && "${AORTICAI_ALLOW_LOCAL_ARTIFACTS:-0}" != "1" ]]; then
  echo "Refusing direct local artifact promotion on Mac control plane. Use Windows/CI artifacts or set AORTICAI_ALLOW_LOCAL_ARTIFACTS=1 to override." >&2
  exit 1
fi

if [[ $# -lt 4 ]]; then
  echo "usage: $0 <study_id> <job_id> <artifact_dir> <ct_file>" >&2
  exit 1
fi

STUDY_ID="$1"
JOB_ID="$2"
ARTIFACT_DIR="$3"
CT_FILE="$4"

if [[ ! -d "$ARTIFACT_DIR" ]]; then
  echo "artifact dir not found: $ARTIFACT_DIR" >&2
  exit 1
fi
if [[ ! -f "$CT_FILE" ]]; then
  echo "ct file not found: $CT_FILE" >&2
  exit 1
fi

R2_RAW_BUCKET="aortic-ct-raw"
R2_MASK_BUCKET="aortic-mask-out"
D1_DB="aortic_meta"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RAW_KEY="studies/${STUDY_ID}/raw/$(date +%s)-$(basename "$CT_FILE")"
RESULT_JSON="${ARTIFACT_DIR}/result.json"
PROVIDER_RECEIPT="${ARTIFACT_DIR}/provider_receipt.json"

if [[ ! -f "$RESULT_JSON" ]]; then
  echo "result.json not found in ${ARTIFACT_DIR}" >&2
  exit 1
fi

cat > "${PROVIDER_RECEIPT}" <<JSON
{
  "status": "succeeded",
  "job_id": "${JOB_ID}",
  "provider_job_id": "direct-publish-${STUDY_ID}",
  "artifact_types": [
    "segmentation_mask_nifti",
    "centerline_json",
    "annulus_plane_json",
    "measurements_json",
    "planning_report_pdf",
    "aortic_root_stl",
    "ascending_aorta_stl",
    "leaflets_stl",
    "aortic_root_model_json",
    "leaflet_model_json",
    "result_json"
  ],
  "metrics": [
    { "name": "published_default_case", "value": 1, "unit": "flag" }
  ],
  "error_message": null
}
JSON

put_object() {
  local bucket="$1"
  local key="$2"
  local file="$3"
  local ctype="$4"
  npx wrangler r2 object put "${bucket}/${key}" --remote --file "${file}" --content-type "${ctype}" >/dev/null
}

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

insert_artifact_sql() {
  local artifact_type="$1"
  local object_key="$2"
  local file="$3"
  local sha bytes
  sha="$(shasum -a 256 "$file" | awk '{print $1}')"
  bytes="$(wc -c < "$file" | tr -d ' ')"
  local artifact_id
  artifact_id="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
  printf "INSERT INTO artifacts (id, job_id, artifact_type, bucket, object_key, sha256, bytes, created_at) VALUES ('%s','%s','%s','%s','%s','%s',%s,'%s');\n" \
    "$(sql_escape "$artifact_id")" \
    "$(sql_escape "$JOB_ID")" \
    "$(sql_escape "$artifact_type")" \
    "$(sql_escape "$R2_MASK_BUCKET")" \
    "$(sql_escape "$object_key")" \
    "$(sql_escape "$sha")" \
    "$bytes" \
    "$NOW_ISO"
}

echo "[1/4] Uploading raw CT object..."
put_object "${R2_RAW_BUCKET}" "${RAW_KEY}" "${CT_FILE}" "application/octet-stream"

echo "[2/4] Uploading artifact objects to R2..."
declare -a FILES=(
  "segmentation_mask_nifti|data/CTACardio_real_multiclass.nii.gz|application/gzip"
  "centerline_json|${ARTIFACT_DIR}/centerline.json|application/json"
  "annulus_plane_json|${ARTIFACT_DIR}/annulus_plane.json|application/json"
  "measurements_json|${ARTIFACT_DIR}/measurements.json|application/json"
  "planning_report_pdf|${ARTIFACT_DIR}/planning_report.pdf|application/pdf"
  "aortic_root_stl|${ARTIFACT_DIR}/aortic_root.stl|model/stl"
  "ascending_aorta_stl|${ARTIFACT_DIR}/ascending_aorta.stl|model/stl"
  "leaflets_stl|${ARTIFACT_DIR}/leaflets.stl|model/stl"
  "aortic_root_model_json|${ARTIFACT_DIR}/aortic_root_model.json|application/json"
  "leaflet_model_json|${ARTIFACT_DIR}/leaflet_model.json|application/json"
  "result_json|${ARTIFACT_DIR}/result.json|application/json"
  "provider_receipt|${ARTIFACT_DIR}/provider_receipt.json|application/json"
)

SQL_FILE="$(mktemp)"
{
  printf "UPDATE studies SET image_key='%s', source_dataset='supervisely-demo-volumes-CTACardio', modality='CTA', phase='cardiac-cta-full', updated_at='%s' WHERE id='%s';\n" \
    "$(sql_escape "$RAW_KEY")" "$(sql_escape "$NOW_ISO")" "$(sql_escape "$STUDY_ID")"
  printf "DELETE FROM artifacts WHERE job_id='%s';\n" "$(sql_escape "$JOB_ID")"
  printf "DELETE FROM metrics WHERE job_id='%s';\n" "$(sql_escape "$JOB_ID")"
} > "${SQL_FILE}"

for spec in "${FILES[@]}"; do
  IFS='|' read -r type file ctype <<< "${spec}"
  if [[ ! -f "$file" ]]; then
    echo "missing artifact file: $file" >&2
    rm -f "${SQL_FILE}"
    exit 1
  fi
  key="studies/${STUDY_ID}/jobs/${JOB_ID}/$(basename "$file")"
  put_object "${R2_MASK_BUCKET}" "${key}" "${file}" "${ctype}"
  insert_artifact_sql "${type}" "${key}" "${file}" >> "${SQL_FILE}"
done

METRIC_ID_1="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
METRIC_ID_2="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
RUNTIME_VALUE="$(node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('${RESULT_JSON}','utf8'));process.stdout.write(String(Number(p.pipeline?.runtime_seconds||0)))")"
{
  printf "INSERT INTO metrics (id, job_id, metric_name, metric_value, unit, created_at) VALUES ('%s','%s','published_default_case',1,'flag','%s');\n" \
    "$(sql_escape "$METRIC_ID_1")" "$(sql_escape "$JOB_ID")" "$(sql_escape "$NOW_ISO")"
  printf "INSERT INTO metrics (id, job_id, metric_name, metric_value, unit, created_at) VALUES ('%s','%s','local_runtime_seconds',%s,'s','%s');\n" \
    "$(sql_escape "$METRIC_ID_2")" "$(sql_escape "$JOB_ID")" "$RUNTIME_VALUE" "$(sql_escape "$NOW_ISO")"
  printf "UPDATE jobs SET status='succeeded', model_tag='digital-twin-default-v1', error_message=NULL, started_at=COALESCE(started_at,'%s'), finished_at='%s' WHERE id='%s';\n" \
    "$(sql_escape "$NOW_ISO")" "$(sql_escape "$NOW_ISO")" "$(sql_escape "$JOB_ID")"
} >> "${SQL_FILE}"

echo "[3/4] Updating D1 metadata..."
npx wrangler d1 execute "${D1_DB}" --remote --file "${SQL_FILE}" >/dev/null
rm -f "${SQL_FILE}"

echo "[4/4] Done."
echo "study_id=${STUDY_ID}"
echo "job_id=${JOB_ID}"
