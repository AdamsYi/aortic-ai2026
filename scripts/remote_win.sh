#!/usr/bin/env bash
# remote_win.sh — Mac → Win AorticAI remote control over the existing
# cloudflared tunnel. Streams /admin/run output live to the terminal.
#
# Usage:
#   ./scripts/remote_win.sh status
#   ./scripts/remote_win.sh git_pull
#   ./scripts/remote_win.sh pip_sync
#   ./scripts/remote_win.sh ingest --dry-run --case-ids 1,2,3
#   ./scripts/remote_win.sh ingest --case-ids 5
#   ./scripts/remote_win.sh ingest_zenodo --dry-run --max-cases 5
#   ./scripts/remote_win.sh ingest_zenodo --case-index 3
#   ./scripts/remote_win.sh zenodo_inspect
#   ./scripts/remote_win.sh tcia_probe
#   ./scripts/remote_win.sh imagecas_probe
#   ./scripts/remote_win.sh imagecas_extract_first_split
#   ./scripts/remote_win.sh install_7zip
#   ./scripts/remote_win.sh commit_case 5
#   ./scripts/remote_win.sh inspect_case 5
#   ./scripts/remote_win.sh scan_imagecas_meshqa --case-ids 1,23,47
#
# Env overrides:
#   AORTICAI_WIN_BASE   default https://api.heartvalvepro.edu.kg
#   PROVIDER_SECRET     default aorticai-internal-2026

set -euo pipefail

BASE="${AORTICAI_WIN_BASE:-https://api.heartvalvepro.edu.kg}"
SECRET="${PROVIDER_SECRET:-aorticai-internal-2026}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <status|git_pull|pip_sync|ingest|scan_imagecas_meshqa|ingest_zenodo|zenodo_inspect|tcia_probe|imagecas_probe|imagecas_extract_first_split|install_7zip|commit_case|inspect_case> [args...]" >&2
  exit 2
fi

SUB="$1"
shift

case "$SUB" in
  status|git_pull)
    COMMAND="$SUB"
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"command": sys.argv[1], "args": []}))' "$COMMAND")
    ;;
  pip_sync)
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 pip_sync" >&2
      exit 2
    fi
    BODY='{"command":"pip_sync","args":[]}'
    ;;
  ingest)
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"command": "ingest_imagecas", "args": sys.argv[1:]}))' "$@")
    ;;
  scan_imagecas_meshqa)
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"command": "scan_imagecas_meshqa", "args": sys.argv[1:]}))' "$@")
    ;;
  ingest_zenodo)
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"command": "ingest_zenodo", "args": sys.argv[1:]}))' "$@")
    ;;
  zenodo_inspect)
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 zenodo_inspect" >&2
      exit 2
    fi
    BODY='{"command":"zenodo_inspect","args":[]}'
    ;;
  tcia_probe)
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 tcia_probe" >&2
      exit 2
    fi
    BODY='{"command":"tcia_probe","args":[]}'
    ;;
  imagecas_probe)
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 imagecas_probe" >&2
      exit 2
    fi
    BODY='{"command":"imagecas_probe","args":[]}'
    ;;
  imagecas_extract_first_split)
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 imagecas_extract_first_split" >&2
      exit 2
    fi
    BODY='{"command":"imagecas_extract_first_split","args":[]}'
    ;;
  install_7zip)
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 install_7zip" >&2
      exit 2
    fi
    BODY='{"command":"install_7zip","args":[]}'
    ;;
  commit_case)
    if [[ $# -ne 1 || ! "$1" =~ ^[0-9]+$ ]]; then
      echo "Usage: $0 commit_case <digits>" >&2
      exit 2
    fi
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"command": "commit_case", "args": ["--case-id", sys.argv[1]]}))' "$1")
    ;;
  inspect_case)
    if [[ $# -ne 1 || ! "$1" =~ ^[0-9]+$ ]]; then
      echo "Usage: $0 inspect_case <digits>" >&2
      exit 2
    fi
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"command": "inspect_case", "args": ["--case-id", sys.argv[1]]}))' "$1")
    ;;
  *)
    echo "unknown subcommand: $SUB" >&2
    exit 2
    ;;
esac

HTTP_CODE=$(curl --http1.1 --no-buffer -sS \
  -X POST "${BASE}/admin/run" \
  -H "content-type: application/json" \
  -H "x-provider-secret: ${SECRET}" \
  --data "$BODY" \
  -o >(cat) \
  -w '%{http_code}')

echo
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "[remote_win] HTTP ${HTTP_CODE}" >&2
  exit 1
fi
