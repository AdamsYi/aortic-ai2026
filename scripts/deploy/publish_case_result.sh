#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 || $# -gt 5 ]]; then
  echo "usage: $0 <case_id> <study_id> <job_id> <case_dir> [raw_ct_file]" >&2
  exit 2
fi

CASE_ID="$1"
STUDY_ID="$2"
JOB_ID="$3"
CASE_DIR="$4"
RAW_CT_FILE="${5:-}"

R2_RAW_BUCKET="${R2_RAW_BUCKET:-aortic-ct-raw}"
R2_MASK_BUCKET="${R2_MASK_BUCKET:-aortic-mask-out}"
D1_DB="${D1_DB:-aortic_meta}"
RAW_KEY="studies/${STUDY_ID}/raw/ct_preop.nii.gz"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ ! -d "$CASE_DIR" ]]; then
  echo "case dir not found: $CASE_DIR" >&2
  exit 1
fi

MESH_DIR="${CASE_DIR}/meshes"
ARTIFACT_DIR="${CASE_DIR}/artifacts"
RESULT_JSON="${ARTIFACT_DIR}/pipeline_result.json"
if [[ ! -f "$RESULT_JSON" && -f "${ARTIFACT_DIR}/pipeline_output.json" ]]; then
  RESULT_JSON="${ARTIFACT_DIR}/pipeline_output.json"
fi
if [[ ! -f "$RESULT_JSON" ]]; then
  echo "result json not found: ${ARTIFACT_DIR}/pipeline_result.json" >&2
  exit 1
fi

put_object() {
  local bucket="$1"
  local key="$2"
  local file="$3"
  local ctype="$4"
  npx wrangler r2 object put "${bucket}/${key}" --remote --file "$file" --content-type "$ctype" >/dev/null
}

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

json_sql_literal() {
  node -e 'const fs=require("fs"); const p=process.argv[1]; process.stdout.write(JSON.stringify(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,"utf8")) : null));' "$1" \
    | sed "s/'/''/g"
}

insert_artifact_sql() {
  local artifact_type="$1"
  local object_key="$2"
  local file="$3"
  local sha bytes artifact_id
  sha="$(shasum -a 256 "$file" | awk '{print $1}')"
  bytes="$(wc -c < "$file" | tr -d ' ')"
  artifact_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
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

if [[ -n "$RAW_CT_FILE" ]]; then
  if [[ ! -f "$RAW_CT_FILE" ]]; then
    echo "raw CT file not found: $RAW_CT_FILE" >&2
    exit 1
  fi
  echo "[1/4] Uploading raw CT..."
  put_object "$R2_RAW_BUCKET" "$RAW_KEY" "$RAW_CT_FILE" "application/gzip"
else
  echo "[1/4] Reusing existing raw CT key: ${RAW_KEY}"
fi

declare -a FILES=(
  "segmentation_mask_nifti|${MESH_DIR}/segmentation.nii.gz|application/gzip"
  "lumen_mask_nifti|${MESH_DIR}/lumen_mask.nii.gz|application/gzip"
  "centerline_json|${MESH_DIR}/centerline.json|application/json"
  "annulus_plane_json|${MESH_DIR}/annulus_plane.json|application/json"
  "measurements_json|${MESH_DIR}/measurements.json|application/json"
  "planning_report_pdf|${MESH_DIR}/planning_report.pdf|application/pdf"
  "aortic_root_stl|${MESH_DIR}/aortic_root.stl|model/stl"
  "ascending_aorta_stl|${MESH_DIR}/ascending_aorta.stl|model/stl"
  "leaflets_stl|${MESH_DIR}/leaflets.stl|model/stl"
  "annulus_ring_stl|${MESH_DIR}/annulus_ring.stl|model/stl"
  "pears_outer_aorta_stl|${MESH_DIR}/pears_outer_aorta.stl|model/stl"
  "pears_support_sleeve_stl|${MESH_DIR}/pears_support_sleeve_preview.stl|model/stl"
  "aortic_root_model_json|${MESH_DIR}/aortic_root_model.json|application/json"
  "leaflet_model_json|${MESH_DIR}/leaflet_model.json|application/json"
  "pears_model_json|${ARTIFACT_DIR}/pears_model.json|application/json"
  "pears_coronary_windows_json|${ARTIFACT_DIR}/pears_coronary_windows.json|application/json"
  "result_json|${RESULT_JSON}|application/json"
)

declare -a OPTIONAL_FILES=(
  "pears_visual_qa_json|${CASE_DIR}/qa/pears_visual_qa.json|application/json"
)

SQL_FILE="$(mktemp)"
{
  printf "INSERT INTO studies (id, patient_code, source_dataset, image_key, image_format, modality, phase, created_at, updated_at) VALUES ('%s','%s','%s','%s','nifti','CTA','arterial','%s','%s') ON CONFLICT(id) DO UPDATE SET patient_code=excluded.patient_code, source_dataset=excluded.source_dataset, image_key=excluded.image_key, image_format=excluded.image_format, modality=excluded.modality, phase=excluded.phase, updated_at=excluded.updated_at;\n" \
    "$(sql_escape "$STUDY_ID")" "$(sql_escape "$CASE_ID")" "mao_mianqiang_preop" "$(sql_escape "$RAW_KEY")" "$NOW_ISO" "$NOW_ISO"
  printf "INSERT INTO study_repository (study_id, raw_filename, image_bytes, image_sha256, ingestion_format, metadata_json, created_at, updated_at) VALUES ('%s','ct_preop.nii.gz',NULL,NULL,'nifti','{}','%s','%s') ON CONFLICT(study_id) DO UPDATE SET raw_filename=excluded.raw_filename, ingestion_format=excluded.ingestion_format, updated_at=excluded.updated_at;\n" \
    "$(sql_escape "$STUDY_ID")" "$NOW_ISO" "$NOW_ISO"
  printf "INSERT INTO jobs (id, study_id, job_type, status, model_tag, started_at, finished_at, created_at) VALUES ('%s','%s','segmentation_v1','succeeded','mao-first-case','%s','%s','%s') ON CONFLICT(id) DO UPDATE SET status='succeeded', model_tag='mao-first-case', error_message=NULL, finished_at='%s';\n" \
    "$(sql_escape "$JOB_ID")" "$(sql_escape "$STUDY_ID")" "$NOW_ISO" "$NOW_ISO" "$NOW_ISO" "$NOW_ISO"
  printf "UPDATE jobs SET progress=100, result_case_id='%s', stage='completed', updated_at='%s' WHERE id='%s';\n" \
    "$(sql_escape "$CASE_ID")" "$NOW_ISO" "$(sql_escape "$JOB_ID")"
  printf "DELETE FROM artifacts WHERE job_id='%s';\n" "$(sql_escape "$JOB_ID")"
} > "$SQL_FILE"

echo "[2/4] Uploading result artifacts..."
for spec in "${FILES[@]}"; do
  IFS='|' read -r type file ctype <<< "$spec"
  if [[ ! -f "$file" ]]; then
    rm -f "$SQL_FILE"
    echo "missing artifact file: $file" >&2
    exit 1
  fi
  key="studies/${STUDY_ID}/jobs/${JOB_ID}/$(basename "$file")"
  put_object "$R2_MASK_BUCKET" "$key" "$file" "$ctype"
  insert_artifact_sql "$type" "$key" "$file" >> "$SQL_FILE"
done
for spec in "${OPTIONAL_FILES[@]}"; do
  IFS='|' read -r type file ctype <<< "$spec"
  if [[ ! -f "$file" ]]; then
    continue
  fi
  key="studies/${STUDY_ID}/jobs/${JOB_ID}/$(basename "$file")"
  put_object "$R2_MASK_BUCKET" "$key" "$file" "$ctype"
  insert_artifact_sql "$type" "$key" "$file" >> "$SQL_FILE"
done

MEASUREMENTS_JSON="${MESH_DIR}/measurements.json"
MEASUREMENTS_JSON_TMP="$(mktemp)"
PLANNING_JSON_TMP="$(mktemp)"
node -e 'const fs=require("fs"); const p=process.argv[1]; const outM=process.argv[2]; const outP=process.argv[3]; const m=JSON.parse(fs.readFileSync(p,"utf8")); const pears=m.pears_geometry && typeof m.pears_geometry==="object" ? m.pears_geometry : null; const measurementSummary={measurements:m.measurements||null,pears_geometry:pears?{intended_use:pears.intended_use||null,manufacturing_ready:Boolean(pears.manufacturing_ready),visual_ready:Boolean(pears.visual_ready),blockers:Array.isArray(pears.blockers)?pears.blockers:[],warnings:Array.isArray(pears.warnings)?pears.warnings:[],support_segment:pears.support_segment||null,diameter_stations:Array.isArray(pears.diameter_stations)?pears.diameter_stations:[],geometry:pears.geometry||null,quality:pears.quality||null,source:pears.source||null}:null,phase_metadata:m.phase_metadata||null,provenance:m.provenance||null,risk_flags:Array.isArray(m.risk_flags)?m.risk_flags:[]}; fs.writeFileSync(outM, JSON.stringify(measurementSummary)); fs.writeFileSync(outP, JSON.stringify(m.planning || m.planning_metrics || {}));' "$MEASUREMENTS_JSON" "$MEASUREMENTS_JSON_TMP" "$PLANNING_JSON_TMP"
{
  printf "INSERT OR REPLACE INTO case_results (case_id, job_id, measurements_json, planning_json, created_at) VALUES ('%s','%s','%s','%s',%s);\n" \
    "$(sql_escape "$CASE_ID")" \
    "$(sql_escape "$JOB_ID")" \
    "$(json_sql_literal "$MEASUREMENTS_JSON_TMP")" \
    "$(json_sql_literal "$PLANNING_JSON_TMP")" \
    "$(python3 -c 'import time; print(int(time.time() * 1000))')"
} >> "$SQL_FILE"
rm -f "$MEASUREMENTS_JSON_TMP" "$PLANNING_JSON_TMP"

echo "[3/4] Updating D1 metadata..."
npx wrangler d1 execute "$D1_DB" --remote --file "$SQL_FILE" >/dev/null
rm -f "$SQL_FILE"

echo "[4/4] Published case result."
echo "case_id=${CASE_ID}"
echo "study_id=${STUDY_ID}"
echo "job_id=${JOB_ID}"
echo "raw_key=${RAW_KEY}"
