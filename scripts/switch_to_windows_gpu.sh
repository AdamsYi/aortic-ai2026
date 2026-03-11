#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./scripts/switch_to_windows_gpu.sh <host-or-url> [callback_secret]
# Example:
#   ./scripts/switch_to_windows_gpu.sh http://100.88.10.2:8000

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <host-or-url> [callback_secret]" >&2
  exit 1
fi

RAW="$1"
SECRET="${2:-}"

if [[ "$RAW" =~ ^https?:// ]]; then
  BASE="$RAW"
else
  BASE="http://$RAW"
fi

if [[ "$BASE" =~ /infer$ ]]; then
  URL="$BASE"
else
  URL="${BASE%/}/infer"
fi

exec ./scripts/switch_to_provider.sh "$URL" "$SECRET"
