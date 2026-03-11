#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-https://aortic-ai-api.we085197.workers.dev}"
CT_FILE="${2:-data/CTACardio.nii.gz}"
MASK_FILE="${3:-data/CTACardio_real_multiclass.nii.gz}"
CASE_FILE="${4:-data/CTACardio_real_multiclass.nii.gz}"

if [[ ! -f "$CT_FILE" ]]; then
  echo "CT file not found: $CT_FILE" >&2
  exit 1
fi
if [[ ! -f "$MASK_FILE" ]]; then
  echo "Mask file not found: $MASK_FILE" >&2
  exit 1
fi
if [[ ! -f "$CASE_FILE" ]]; then
  echo "Case pointer file not found: $CASE_FILE" >&2
  exit 1
fi

TIME_TAG="$(date +%s)"
CASE_STUDY_ID="hqcta-cardio-${TIME_TAG}"
FULL_STUDY_ID="hqcta-full-ctacardio"
MASK_STUDY_ID="hqcta-full-ctacardio-mask"
OUT_DIR="runs/${CASE_STUDY_ID}"
mkdir -p "$OUT_DIR" runs

json_field() {
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d||'{}');const v=j['$1'];process.stdout.write(typeof v==='string'?v:'');});"
}

upload_one() {
  local study_id="$1"
  local file_path="$2"
  local source_dataset="$3"
  local modality="$4"
  local phase="$5"
  local tag="$6"

  local payload
  payload=$(cat <<JSON
{"study_id":"${study_id}","filename":"$(basename "$file_path")","source_dataset":"${source_dataset}","patient_code":"anon-${study_id}","image_format":"nifti","modality":"${modality}","phase":"${phase}"}
JSON
)

  local sess
  sess=$(curl -sS "${BASE_URL}/upload-url" \
    -H 'content-type: application/json' \
    -d "$payload")
  echo "$sess" > "${OUT_DIR}/upload_session_${tag}.json"

  local upload_url
  upload_url=$(echo "$sess" | json_field upload_url)
  if [[ -z "$upload_url" ]]; then
    echo "upload_url missing for ${tag}" >&2
    cat "${OUT_DIR}/upload_session_${tag}.json" >&2
    exit 1
  fi

  curl -sS -X PUT "${BASE_URL}${upload_url}" \
    -H 'content-type: application/octet-stream' \
    --data-binary @"${file_path}" > "${OUT_DIR}/upload_done_${tag}.json"
}

echo "[1/5] Uploading full CTA study (${FULL_STUDY_ID})..."
upload_one "${FULL_STUDY_ID}" "${CT_FILE}" "supervisely-demo-volumes-CTACardio" "CTA" "cardiac-cta-full" "full"

echo "[2/5] Uploading default demo case pointer (${CASE_STUDY_ID})..."
upload_one "${CASE_STUDY_ID}" "${CASE_FILE}" "hqcta-default-case-pointer" "CTA" "cardiac-cta-full" "case"

echo "[3/5] Uploading precomputed multiclass mask (${MASK_STUDY_ID})..."
upload_one "${MASK_STUDY_ID}" "${MASK_FILE}" "totalsegmentator-total-heart-aorta" "SEG" "derived-from-${CASE_STUDY_ID}" "mask"

echo "[4/5] Creating segmentation job for default case..."
JOB_RESP=$(curl -sS "${BASE_URL}/jobs" \
  -H 'content-type: application/json' \
  -d "{\"study_id\":\"${CASE_STUDY_ID}\",\"job_type\":\"segmentation_v1\",\"model_tag\":\"hqcta-real-mask-v1\"}")
echo "$JOB_RESP" > "${OUT_DIR}/job_create_response.json"
JOB_ID=$(echo "$JOB_RESP" | json_field job_id)
if [[ -z "$JOB_ID" ]]; then
  echo "job_id missing" >&2
  cat "${OUT_DIR}/job_create_response.json" >&2
  exit 1
fi

FINAL_JSON=""
for i in $(seq 1 60); do
  RESP=$(curl -sS "${BASE_URL}/jobs/${JOB_ID}")
  echo "$RESP" > "${OUT_DIR}/job_status_latest.json"
  STATUS=$(echo "$RESP" | json_field status)
  echo "  poll ${i}: ${STATUS}"
  if [[ "$STATUS" == "succeeded" || "$STATUS" == "failed" ]]; then
    FINAL_JSON="$RESP"
    break
  fi
  sleep 2
done

if [[ -z "$FINAL_JSON" ]]; then
  echo "job poll timeout: ${JOB_ID}" >&2
  exit 1
fi
echo "$FINAL_JSON" > "${OUT_DIR}/job_result.json"

FINAL_STATUS=$(echo "$FINAL_JSON" | json_field status)
if [[ "$FINAL_STATUS" != "succeeded" ]]; then
  echo "job failed: ${FINAL_STATUS}" >&2
  cat "${OUT_DIR}/job_result.json" >&2
  exit 1
fi

echo "[5/5] Reading latest demo case snapshot..."
curl -sS "${BASE_URL}/demo/latest-case" > "${OUT_DIR}/latest_case.json"
cp "${OUT_DIR}/latest_case.json" runs/latest_case.json

cat > runs/latest_publish.json <<JSON
{
  "base_url": "${BASE_URL}",
  "study_id": "${CASE_STUDY_ID}",
  "job_id": "${JOB_ID}",
  "status": "${FINAL_STATUS}",
  "full_study_id": "${FULL_STUDY_ID}",
  "mask_study_id": "${MASK_STUDY_ID}",
  "ct_file": "${CT_FILE}",
  "mask_file": "${MASK_FILE}",
  "output_dir": "${OUT_DIR}"
}
JSON

echo "Published default case:"
echo "  study_id=${CASE_STUDY_ID}"
echo "  job_id=${JOB_ID}"
echo "  demo=${BASE_URL}/demo"
