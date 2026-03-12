#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-https://aortic-ai-api.we085197.workers.dev}"
CT_FILE="${2:-data/CTACardio.nii.gz}"
MASK_FILE="${3:-data/CTACardio_real_multiclass.nii.gz}"

if [[ ! -f "$CT_FILE" ]]; then
  echo "CT file not found: $CT_FILE" >&2
  exit 1
fi
if [[ ! -f "$MASK_FILE" ]]; then
  echo "Mask file not found: $MASK_FILE" >&2
  exit 1
fi

TIME_TAG="$(date +%s)"
CASE_STUDY_ID="hqcta-cardio-${TIME_TAG}"
WORK_DIR="runs/${CASE_STUDY_ID}"
LOCAL_PIPE_DIR="${WORK_DIR}/local_pipeline"
mkdir -p "${LOCAL_PIPE_DIR}" runs

json_field() {
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d||'{}');const v=j['$1'];process.stdout.write(typeof v==='string'?v:'');});"
}

echo "[1/7] Building local digital twin artifacts..."
source .venv/bin/activate
python - <<PY
from pathlib import Path
import json
from gpu_provider.pipeline_runner import run_geometry_pipeline

out_dir = Path("${LOCAL_PIPE_DIR}")
out_dir.mkdir(parents=True, exist_ok=True)
result, _artifacts = run_geometry_pipeline(
    Path("${CT_FILE}"),
    Path("${MASK_FILE}"),
    {"device": "gpu", "quality": "high", "published_via": "publish_digital_twin_default_case.sh"},
    out_dir,
)
(out_dir / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps({
    "runtime_seconds": result.get("pipeline", {}).get("runtime_seconds"),
    "centerline_method": result.get("centerline", {}).get("method"),
}, ensure_ascii=False))
PY

echo "[2/7] Uploading raw CTA study..."
UPLOAD_PAYLOAD=$(cat <<JSON
{"study_id":"${CASE_STUDY_ID}","filename":"$(basename "$CT_FILE")","source_dataset":"supervisely-demo-volumes-CTACardio","patient_code":"anon-${CASE_STUDY_ID}","image_format":"nifti","modality":"CTA","phase":"cardiac-cta-full"}
JSON
)
UPLOAD_RESP=$(curl -sS "${BASE_URL}/upload-url" -H 'content-type: application/json' -d "${UPLOAD_PAYLOAD}")
echo "${UPLOAD_RESP}" > "${WORK_DIR}/upload_session.json"
UPLOAD_URL=$(echo "${UPLOAD_RESP}" | json_field upload_url)
if [[ -z "${UPLOAD_URL}" ]]; then
  echo "upload_url missing" >&2
  cat "${WORK_DIR}/upload_session.json" >&2
  exit 1
fi
curl -sS -X PUT "${BASE_URL}${UPLOAD_URL}" -H 'content-type: application/octet-stream' --data-binary @"${CT_FILE}" > "${WORK_DIR}/upload_done.json"

echo "[3/7] Creating job..."
JOB_RESP=$(curl -sS "${BASE_URL}/jobs" \
  -H 'content-type: application/json' \
  -d "{\"study_id\":\"${CASE_STUDY_ID}\",\"job_type\":\"segmentation_v1\",\"model_tag\":\"digital-twin-default-v1\"}")
echo "${JOB_RESP}" > "${WORK_DIR}/job_create.json"
JOB_ID=$(echo "${JOB_RESP}" | json_field job_id)
if [[ -z "${JOB_ID}" ]]; then
  echo "job_id missing" >&2
  cat "${WORK_DIR}/job_create.json" >&2
  exit 1
fi

artifact_json() {
  local type="$1"
  local file_path="$2"
  local content_type="$3"
  local filename
  filename="$(basename "$file_path")"
  local b64
  b64=$(base64 < "$file_path" | tr -d '\n')
  cat <<JSON
{
  "artifact_type": "${type}",
  "filename": "${filename}",
  "content_type": "${content_type}",
  "base64": "${b64}"
}
JSON
}

echo "[4/7] Preparing callback payload..."
RESULT_MIN=$(node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('${LOCAL_PIPE_DIR}/result.json','utf8'));process.stdout.write(JSON.stringify(p));")
MASK_B64=$(base64 < "${MASK_FILE}" | tr -d '\n')
ARTIFACTS_JSON=$(cat <<JSON
[
$(artifact_json "segmentation_mask_nifti" "${MASK_FILE}" "application/gzip"),
$(artifact_json "centerline_json" "${LOCAL_PIPE_DIR}/centerline.json" "application/json"),
$(artifact_json "annulus_plane_json" "${LOCAL_PIPE_DIR}/annulus_plane.json" "application/json"),
$(artifact_json "measurements_json" "${LOCAL_PIPE_DIR}/measurements.json" "application/json"),
$(artifact_json "planning_report_pdf" "${LOCAL_PIPE_DIR}/planning_report.pdf" "application/pdf"),
$(artifact_json "aortic_root_stl" "${LOCAL_PIPE_DIR}/aortic_root.stl" "model/stl"),
$(artifact_json "ascending_aorta_stl" "${LOCAL_PIPE_DIR}/ascending_aorta.stl" "model/stl"),
$(artifact_json "leaflets_stl" "${LOCAL_PIPE_DIR}/leaflets.stl" "model/stl"),
$(artifact_json "aortic_root_model_json" "${LOCAL_PIPE_DIR}/aortic_root_model.json" "application/json"),
$(artifact_json "leaflet_model_json" "${LOCAL_PIPE_DIR}/leaflet_model.json" "application/json")
]
JSON
)

CALLBACK_PAYLOAD="${WORK_DIR}/callback_payload.json"
cat > "${CALLBACK_PAYLOAD}" <<JSON
{
  "job_id": "${JOB_ID}",
  "status": "succeeded",
  "provider_job_id": "local-digital-twin-${TIME_TAG}",
  "result_json": ${RESULT_MIN},
  "mask_base64": "${MASK_B64}",
  "mask_filename": "$(basename "$MASK_FILE")",
  "mask_content_type": "application/gzip",
  "artifacts": ${ARTIFACTS_JSON},
  "metrics": [
    { "name": "published_default_case", "value": 1, "unit": "flag" },
    { "name": "local_runtime_seconds", "value": $(node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('${LOCAL_PIPE_DIR}/result.json','utf8'));process.stdout.write(String(Number(p.pipeline?.runtime_seconds||0)))"), "unit": "s" }
  ]
}
JSON

echo "[5/7] Posting callback..."
curl -sS "${BASE_URL}/callbacks/inference" \
  -H 'content-type: application/json' \
  --data @"${CALLBACK_PAYLOAD}" > "${WORK_DIR}/callback_response.json"

echo "[6/7] Polling job..."
FINAL_JSON=""
for i in $(seq 1 30); do
  RESP=$(curl -sS "${BASE_URL}/jobs/${JOB_ID}")
  echo "${RESP}" > "${WORK_DIR}/job_latest.json"
  STATUS=$(echo "${RESP}" | json_field status)
  echo "  poll ${i}: ${STATUS}"
  if [[ "${STATUS}" == "succeeded" || "${STATUS}" == "failed" ]]; then
    FINAL_JSON="${RESP}"
    break
  fi
  sleep 2
done

if [[ -z "${FINAL_JSON}" ]]; then
  echo "job did not reach terminal state" >&2
  exit 1
fi
echo "${FINAL_JSON}" > "${WORK_DIR}/job_final.json"

FINAL_STATUS=$(echo "${FINAL_JSON}" | json_field status)
if [[ "${FINAL_STATUS}" != "succeeded" ]]; then
  echo "job failed" >&2
  cat "${WORK_DIR}/job_final.json" >&2
  exit 1
fi

echo "[7/7] Capturing latest demo snapshot..."
curl -sS "${BASE_URL}/demo/latest-case" > "${WORK_DIR}/latest_case.json"
cp "${WORK_DIR}/latest_case.json" runs/latest_case.json

echo "Published default digital twin case:"
echo "  study_id=${CASE_STUDY_ID}"
echo "  job_id=${JOB_ID}"
echo "  demo=${BASE_URL}/demo"
