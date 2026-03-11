#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-https://aortic-ai-api.we085197.workers.dev}"
DATA_URL="${2:-https://raw.githubusercontent.com/wasserth/TotalSegmentator/master/tests/reference_files/example_ct.nii.gz}"
MAX_POLL_ROUNDS="${MAX_POLL_ROUNDS:-240}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-3}"
TIME_TAG="$(date +%s)"
STUDY_ID="openct-${TIME_TAG}"
OUT_DIR="runs/${STUDY_ID}"
mkdir -p "$OUT_DIR"
mkdir -p runs

INPUT_FILE="/tmp/${STUDY_ID}.nii.gz"

printf 'Downloading open CT sample...\n'
curl -fsSL "$DATA_URL" -o "$INPUT_FILE"
ls -lh "$INPUT_FILE" | tee "$OUT_DIR/input_size.txt"

printf 'Creating upload session...\n'
UPLOAD_RESP=$(curl -sS "$BASE_URL/upload-url" \
  -H 'content-type: application/json' \
  -d '{"study_id":"'"$STUDY_ID"'","filename":"'"$STUDY_ID"'.nii.gz","source_dataset":"TotalSegmentator-tests","patient_code":"anon-'"$STUDY_ID"'","image_format":"nifti","phase":"unknown"}')

echo "$UPLOAD_RESP" > "$OUT_DIR/upload_response.json"
UPLOAD_URL=$(echo "$UPLOAD_RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).upload_url||''))")

if [[ -z "$UPLOAD_URL" ]]; then
  echo "Failed: upload_url missing" >&2
  cat "$OUT_DIR/upload_response.json" >&2
  exit 1
fi

printf 'Uploading CT file...\n'
UPLOAD_DONE=$(curl -sS -X PUT "$BASE_URL$UPLOAD_URL" -H 'content-type: application/octet-stream' --data-binary @"$INPUT_FILE")
echo "$UPLOAD_DONE" > "$OUT_DIR/upload_done.json"

printf 'Creating segmentation job...\n'
JOB_RESP=$(curl -sS "$BASE_URL/jobs" \
  -H 'content-type: application/json' \
  -d '{"study_id":"'"$STUDY_ID"'","job_type":"segmentation_v1","model_tag":"openct-demo"}')

echo "$JOB_RESP" > "$OUT_DIR/job_create_response.json"
JOB_ID=$(echo "$JOB_RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).job_id||''))")

if [[ -z "$JOB_ID" ]]; then
  echo "Failed: job_id missing" >&2
  cat "$OUT_DIR/job_create_response.json" >&2
  exit 1
fi

printf 'Polling job status: %s\n' "$JOB_ID"

FINAL_JSON=""
for i in $(seq 1 "$MAX_POLL_ROUNDS"); do
  RESP=$(curl -sS "$BASE_URL/jobs/$JOB_ID")
  STATUS=$(echo "$RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write((JSON.parse(d).status||'')))")
  printf '[%02d] status=%s\n' "$i" "$STATUS"
  echo "$RESP" > "$OUT_DIR/job_status_latest.json"
  if [[ "$STATUS" == "succeeded" || "$STATUS" == "failed" ]]; then
    FINAL_JSON="$RESP"
    break
  fi
  sleep "$POLL_INTERVAL_SECONDS"
done

if [[ -z "$FINAL_JSON" ]]; then
  echo "Timed out waiting for terminal status: $JOB_ID" >&2
  exit 1
fi

echo "$FINAL_JSON" > "$OUT_DIR/job_result.json"

FINAL_STATUS=$(echo "$FINAL_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write((JSON.parse(d).status||'')))")
ARTIFACT_COUNT=$(echo "$FINAL_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write(String((j.artifacts||[]).length));})")

printf '\nDone.\n'
printf 'study_id=%s\n' "$STUDY_ID"
printf 'job_id=%s\n' "$JOB_ID"
printf 'status=%s\n' "$FINAL_STATUS"
printf 'artifacts=%s\n' "$ARTIFACT_COUNT"
printf 'result_json=%s\n' "$OUT_DIR/job_result.json"

printf '\nDownloading job artifacts into %s ...\n' "$OUT_DIR"
echo "$FINAL_JSON" | node -e '
let d="";
process.stdin.on("data",c=>d+=c).on("end",()=>{
  const j=JSON.parse(d);
  const arr=Array.isArray(j.artifacts)?j.artifacts:[];
  for (const a of arr){
    const t=String(a.artifact_type||"").trim();
    const k=String(a.object_key||"").trim();
    if(!t) continue;
    const fname=(k.split("/").pop()||(`${t}.bin`)).replace(/[^a-zA-Z0-9._-]/g,"_");
    process.stdout.write(`${t}|${fname}\n`);
  }
});
' | while IFS='|' read -r ART_TYPE ART_FILE; do
  [[ -z "${ART_TYPE:-}" ]] && continue
  DEST="$OUT_DIR/$ART_FILE"
  if curl -fsS "$BASE_URL/jobs/$JOB_ID/artifacts/$ART_TYPE" -o "$DEST"; then
    printf '  - %s -> %s\n' "$ART_TYPE" "$DEST"
  else
    printf '  - %s -> download failed\n' "$ART_TYPE" >&2
  fi
done

cat > runs/latest_run.json <<JSON
{
  "study_id": "${STUDY_ID}",
  "job_id": "${JOB_ID}",
  "status": "${FINAL_STATUS}",
  "result_json": "${OUT_DIR}/job_result.json",
  "base_url": "${BASE_URL}",
  "data_url": "${DATA_URL}"
}
JSON

cp "$OUT_DIR/job_result.json" runs/latest_job_result.json
