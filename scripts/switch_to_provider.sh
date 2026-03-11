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

# INFERENCE_WEBHOOK_URL is defined in wrangler.toml [vars].
# Keep it as an env var binding (do not store as secret with same name),
# otherwise Wrangler reports "Binding name already in use".
TMP_FILE="$(mktemp)"
awk -v url="$PROVIDER_URL" '
BEGIN { updated = 0 }
{
  if ($0 ~ /^INFERENCE_WEBHOOK_URL[[:space:]]*=/) {
    print "INFERENCE_WEBHOOK_URL = \"" url "\""
    updated = 1
  } else {
    print $0
  }
}
END {
  if (updated == 0) exit 2
}
' wrangler.toml > "$TMP_FILE" || {
  rm -f "$TMP_FILE"
  echo "Failed to update INFERENCE_WEBHOOK_URL in wrangler.toml" >&2
  exit 1
}
mv "$TMP_FILE" wrangler.toml

printf '%s' "$CALLBACK_SECRET" | npx wrangler secret put INFERENCE_CALLBACK_SECRET

npx wrangler deploy

echo "Done."
echo "INFERENCE_WEBHOOK_URL set to: $PROVIDER_URL"
echo "INFERENCE_CALLBACK_SECRET set (save this on provider side if callback mode): $CALLBACK_SECRET"
