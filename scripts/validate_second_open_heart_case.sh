#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-https://aortic-ai-api.we085197.workers.dev}"
CASE_URL="${2:-https://huggingface.co/datasets/Angelou0516/totalsegmentator-cardiac/resolve/main/s0016/ct.nii.gz}"
DEVICE="${3:-cpu}"

TIME_TAG="$(date +%s)"
STUDY_ID="hfcardio-${TIME_TAG}"
WORK_DIR="runs/${STUDY_ID}"
mkdir -p "${WORK_DIR}" runs

CT_FILE="${WORK_DIR}/ct.nii.gz"
MASK_FILE="${WORK_DIR}/mask_multiclass.nii.gz"
META_FILE="${WORK_DIR}/mask_multiclass.meta.json"

json_field() {
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d||'{}');const v=j['$1'];process.stdout.write(typeof v==='string'?v:'');});"
}

echo "[1/8] Downloading second open cardiac CT case..."
curl -fsSL "${CASE_URL}" -o "${CT_FILE}"
ls -lh "${CT_FILE}" | tee "${WORK_DIR}/ct_size.txt"

echo "[2/8] Building real multiclass mask (root/leaflets/ascending)..."
source .venv/bin/activate
python scripts/build_real_multiclass_mask.py \
  --input "${CT_FILE}" \
  --output "${MASK_FILE}" \
  --meta "${META_FILE}" \
  --device "${DEVICE}"
ls -lh "${MASK_FILE}" | tee "${WORK_DIR}/mask_size.txt"

echo "[3/8] Creating upload session..."
UPLOAD_RESP=$(curl -sS "${BASE_URL}/upload-url" \
  -H 'content-type: application/json' \
  -d '{"study_id":"'"${STUDY_ID}"'","filename":"ct.nii.gz","source_dataset":"hf-totalsegmentator-cardiac-s0016","patient_code":"anon-'"${STUDY_ID}"'","image_format":"nifti","modality":"CTA","phase":"cardiac-cta"}')
echo "${UPLOAD_RESP}" > "${WORK_DIR}/upload_session.json"
UPLOAD_URL=$(echo "${UPLOAD_RESP}" | json_field upload_url)
if [[ -z "${UPLOAD_URL}" ]]; then
  echo "upload_url missing" >&2
  cat "${WORK_DIR}/upload_session.json" >&2
  exit 1
fi

echo "[4/8] Uploading CT..."
curl -sS -X PUT "${BASE_URL}${UPLOAD_URL}" \
  -H 'content-type: application/octet-stream' \
  --data-binary @"${CT_FILE}" > "${WORK_DIR}/upload_done.json"

echo "[5/8] Creating job..."
JOB_RESP=$(curl -sS "${BASE_URL}/jobs" \
  -H 'content-type: application/json' \
  -d '{"study_id":"'"${STUDY_ID}"'","job_type":"segmentation_v1","model_tag":"hfcardio-real-mask-v1"}')
echo "${JOB_RESP}" > "${WORK_DIR}/job_create.json"
JOB_ID=$(echo "${JOB_RESP}" | json_field job_id)
if [[ -z "${JOB_ID}" ]]; then
  echo "job_id missing" >&2
  cat "${WORK_DIR}/job_create.json" >&2
  exit 1
fi

echo "[6/8] Injecting real mask artifact via callback..."
MASK_B64=$(base64 < "${MASK_FILE}" | tr -d '\n')
CALLBACK_PAYLOAD="${WORK_DIR}/callback_payload.json"
cat > "${CALLBACK_PAYLOAD}" <<JSON
{
  "job_id": "${JOB_ID}",
  "status": "succeeded",
  "provider_job_id": "manual-callback-${TIME_TAG}",
  "result_json": {
    "model": "totalsegmentator-total-heart-aorta + geometric_split_v1",
    "study_id": "${STUDY_ID}",
    "generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "labels": {
      "0": "LVOT/background",
      "1": "aortic_root",
      "2": "leaflets",
      "3": "ascending_aorta"
    },
    "source_case_url": "${CASE_URL}"
  },
  "artifacts": [
    {
      "artifact_type": "mask_multiclass",
      "filename": "mask_multiclass.nii.gz",
      "content_type": "application/gzip",
      "base64": "${MASK_B64}"
    }
  ],
  "metrics": [
    { "name": "manual_callback_injected", "value": 1, "unit": "flag" }
  ]
}
JSON

curl -sS "${BASE_URL}/callbacks/inference" \
  -H 'content-type: application/json' \
  --data @"${CALLBACK_PAYLOAD}" > "${WORK_DIR}/callback_response.json"

echo "[7/8] Polling job until succeeded and mask artifact appears..."
FINAL_JSON=""
for i in $(seq 1 30); do
  RESP=$(curl -sS "${BASE_URL}/jobs/${JOB_ID}")
  echo "${RESP}" > "${WORK_DIR}/job_latest.json"
  STATUS=$(echo "${RESP}" | json_field status)
  HAS_MASK=$(echo "${RESP}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d||'{}');const ok=(j.artifacts||[]).some(a=>a.artifact_type==='mask_multiclass');process.stdout.write(ok?'1':'0');});")
  echo "  poll ${i}: status=${STATUS}, mask=${HAS_MASK}"
  if [[ "${STATUS}" == "succeeded" && "${HAS_MASK}" == "1" ]]; then
    FINAL_JSON="${RESP}"
    break
  fi
  if [[ "${STATUS}" == "failed" ]]; then
    echo "job failed" >&2
    cat "${WORK_DIR}/job_latest.json" >&2
    exit 1
  fi
  sleep 2
done

if [[ -z "${FINAL_JSON}" ]]; then
  echo "job did not reach succeeded+mask" >&2
  cat "${WORK_DIR}/job_latest.json" >&2
  exit 1
fi
echo "${FINAL_JSON}" > "${WORK_DIR}/job_final.json"

echo "[8/8] Running full browser E2E on this exact case..."
E2E_BASE_URL="${BASE_URL}/demo?study_id=${STUDY_ID}&job_id=${JOB_ID}" npm run -s e2e:user | tee "${WORK_DIR}/e2e_report.json"

cat > runs/latest_second_case_validation.json <<JSON
{
  "base_url": "${BASE_URL}",
  "case_url": "${CASE_URL}",
  "study_id": "${STUDY_ID}",
  "job_id": "${JOB_ID}",
  "work_dir": "${WORK_DIR}",
  "mask_meta": "${META_FILE}",
  "e2e_report": "${WORK_DIR}/e2e_report.json"
}
JSON

echo "Validation complete:"
echo "  study_id=${STUDY_ID}"
echo "  job_id=${JOB_ID}"
echo "  report=runs/latest_second_case_validation.json"
