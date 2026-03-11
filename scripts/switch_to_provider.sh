#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./scripts/switch_to_provider.sh https://your-gpu-host/infer [callback_secret]

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <provider_infer_url> [callback_secret]" >&2
  exit 1
fi

PROVIDER_URL="$1"
CALLBACK_SECRET="${2:-}"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && ( -z "${CLOUDFLARE_EMAIL:-}" || -z "${CLOUDFLARE_API_KEY:-}" ) ]]; then
  echo "Set CLOUDFLARE_API_TOKEN or CLOUDFLARE_EMAIL+CLOUDFLARE_API_KEY first" >&2
  exit 1
fi

if [[ -z "$CALLBACK_SECRET" ]]; then
  CALLBACK_SECRET="cb-$(date +%s)-$RANDOM"
fi

printf '%s' "$PROVIDER_URL" | npx wrangler secret put INFERENCE_WEBHOOK_URL
printf '%s' "$CALLBACK_SECRET" | npx wrangler secret put INFERENCE_CALLBACK_SECRET

npx wrangler deploy

echo "Done."
echo "INFERENCE_WEBHOOK_URL set to: $PROVIDER_URL"
echo "INFERENCE_CALLBACK_SECRET set (save this on provider side if callback mode): $CALLBACK_SECRET"
