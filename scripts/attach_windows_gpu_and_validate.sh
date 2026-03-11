#!/usr/bin/env bash
set -euo pipefail

# One-shot helper:
# 1) Verify Windows GPU provider health
# 2) Switch Worker webhook to that provider
# 3) Run a real open CTA case through Worker -> Win GPU pipeline
#
# Usage:
#   ./scripts/attach_windows_gpu_and_validate.sh <win-host-or-url> [worker_base_url] [callback_secret] [data_url]
# Example:
#   ./scripts/attach_windows_gpu_and_validate.sh http://100.88.10.2:8000

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <win-host-or-url> [worker_base_url] [callback_secret] [data_url]" >&2
  exit 1
fi

RAW_HOST="$1"
WORKER_BASE_URL="${2:-https://aortic-ai-api.we085197.workers.dev}"
CALLBACK_SECRET="${3:-}"
DATA_URL="${4:-https://raw.githubusercontent.com/wasserth/TotalSegmentator/master/tests/reference_files/example_ct.nii.gz}"

if [[ "$RAW_HOST" =~ ^https?:// ]]; then
  PROVIDER_BASE="${RAW_HOST%/}"
else
  PROVIDER_BASE="http://${RAW_HOST%/}"
fi

PROVIDER_INFER_URL="${PROVIDER_BASE}/infer"
PROVIDER_HEALTH_URL="${PROVIDER_BASE}/health"
HOSTPORT="${PROVIDER_BASE#http://}"
HOSTPORT="${HOSTPORT#https://}"
HOST="${HOSTPORT%%:*}"

if [[ "$HOST" =~ ^127\. || "$HOST" =~ ^10\. || "$HOST" =~ ^192\.168\. || "$HOST" =~ ^172\.(1[6-9]|2[0-9]|3[0-1])\. ]]; then
  echo "Warning: provider host ${HOST} is private/local."
  echo "Cloudflare Worker usually cannot call private LAN IP directly."
  echo "Use a public HTTPS endpoint (Cloudflare Tunnel / Tailscale Funnel) for end-to-end cloud execution."
fi

echo "[1/4] Checking Windows provider health: ${PROVIDER_HEALTH_URL}"
curl -fsS "${PROVIDER_HEALTH_URL}" | tee runs/provider_health_latest.json >/dev/null

echo "[2/4] Switching Worker webhook to: ${PROVIDER_INFER_URL}"
./scripts/switch_to_windows_gpu.sh "${PROVIDER_BASE}" "${CALLBACK_SECRET}"

echo "[3/4] Triggering real open CTA case via Worker"
./scripts/run_open_ct_case.sh "${WORKER_BASE_URL}" "${DATA_URL}"

echo "[4/4] Verifying demo endpoint returns latest completed case"
curl -fsS "${WORKER_BASE_URL}/demo/latest-case" | tee runs/latest_case_after_attach.json >/dev/null

echo ""
echo "Done. Key files:"
echo "- runs/provider_health_latest.json"
echo "- runs/latest_run.json"
echo "- runs/latest_job_result.json"
echo "- runs/latest_case_after_attach.json"
