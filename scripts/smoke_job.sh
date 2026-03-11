#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-https://aortic-ai-api.we085197.workers.dev}"
STUDY_ID="smoke-$(date +%s)"
TMP_FILE="/tmp/${STUDY_ID}.nii.gz"

echo 'smoke-case' > "$TMP_FILE"

UPLOAD_RESP=$(curl -sS "$BASE_URL/upload-url" \
  -H 'content-type: application/json' \
  -d '{"study_id":"'"$STUDY_ID"'","filename":"'"$STUDY_ID"'.nii.gz","source_dataset":"smoke","patient_code":"anon-'"$STUDY_ID"'","image_format":"nifti","phase":"mid-diastole"}')

UPLOAD_URL=$(echo "$UPLOAD_RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).upload_url||''))")

curl -sS -X PUT "$BASE_URL$UPLOAD_URL" -H 'content-type: application/octet-stream' --data-binary @"$TMP_FILE" >/dev/null

JOB_RESP=$(curl -sS "$BASE_URL/jobs" -H 'content-type: application/json' -d '{"study_id":"'"$STUDY_ID"'","job_type":"segmentation_v1","model_tag":"smoke"}')
JOB_ID=$(echo "$JOB_RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).job_id||''))")

echo "job_id=$JOB_ID"

for _ in $(seq 1 20); do
  RESP=$(curl -sS "$BASE_URL/jobs/$JOB_ID")
  STATUS=$(echo "$RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write((JSON.parse(d).status||'')))")
  echo "status=$STATUS"
  if [[ "$STATUS" == "succeeded" || "$STATUS" == "failed" ]]; then
    echo "$RESP"
    exit 0
  fi
  sleep 3
done

echo "timeout waiting for job: $JOB_ID" >&2
exit 1
