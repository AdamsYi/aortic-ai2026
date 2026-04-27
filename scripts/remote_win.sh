#!/usr/bin/env bash
# remote_win.sh — Mac → Win AorticAI remote control over the existing
# cloudflared tunnel. Prints /admin/run output and validates HTTP status.
#
# Usage:
#   ./scripts/remote_win.sh status
#   ./scripts/remote_win.sh git_pull
#   ./scripts/remote_win.sh git_reset
#   ./scripts/remote_win.sh git_switch codex/cleanup-mao-first-case
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
#   ./scripts/remote_win.sh diagnose_nme_seam --case-id 5
#   ./scripts/remote_win.sh scan_imagecas_meshqa --case-ids 1,23,47
#   ./scripts/remote_win.sh diagnose_segmentation
#   ./scripts/remote_win.sh diagnose_lumen
#   ./scripts/remote_win.sh tail_mao_log [--lines 120]
#   ./scripts/remote_win.sh start_mao_segmentation_only
#   ./scripts/remote_win.sh run_mao_segmentation_only
#   ./scripts/remote_win.sh start_mao_pipeline
#   ./scripts/remote_win.sh run_mao_pipeline
#   ./scripts/remote_win.sh run_mao_pears_visual
#   ./scripts/remote_win.sh run_mao_pipeline_http
#   ./scripts/remote_win.sh run_mao_pipeline_r2
#   ./scripts/remote_win.sh list_case_files --case-id 999
#
# Env overrides:
#   AORTICAI_WIN_BASE   default https://api.heartvalvepro.edu.kg
#   PROVIDER_SECRET     default aorticai-internal-2026

set -euo pipefail

BASE="${AORTICAI_WIN_BASE:-https://api.heartvalvepro.edu.kg}"
SECRET="${PROVIDER_SECRET:-aorticai-internal-2026}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <status|git_pull|git_reset|git_switch|pip_sync|ingest|scan_imagecas_meshqa|ingest_zenodo|zenodo_inspect|tcia_probe|imagecas_probe|imagecas_extract_first_split|install_7zip|commit_case|inspect_case|diagnose_nme_seam|tail_mao_log|start_mao_segmentation_only|run_mao_segmentation_only|start_mao_pipeline|run_mao_pipeline|run_mao_pears_visual|run_mao_pipeline_http|run_mao_pipeline_r2|list_case_files> [args...]" >&2
  exit 2
fi

SUB="$1"
shift

case "$SUB" in
  status|git_pull|git_reset)
    COMMAND="$SUB"
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"command": sys.argv[1], "args": []}))' "$COMMAND")
    ;;
  git_switch)
    if [[ $# -ne 1 ]]; then
      echo "Usage: $0 git_switch <branch>" >&2
      exit 2
    fi
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"command": "git_switch", "args": [sys.argv[1]]}))' "$1")
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
  diagnose_nme_seam)
    if [[ $# -ne 2 || "$1" != "--case-id" || ! "$2" =~ ^[0-9]+$ ]]; then
      echo "Usage: $0 diagnose_nme_seam --case-id <digits>" >&2
      exit 2
    fi
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"command": "diagnose_nme_seam", "args": sys.argv[1:]}))' "$@")
    ;;
  diagnose_segmentation)
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 diagnose_segmentation" >&2
      exit 2
    fi
    BODY='{"command":"diagnose_segmentation","args":[]}'
    ;;
  diagnose_lumen)
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 diagnose_lumen" >&2
      exit 2
    fi
    BODY='{"command":"diagnose_lumen","args":[]}'
    ;;
  tail_mao_log)
    if [[ $# -ne 0 && ! ( $# -eq 2 && "$1" == "--lines" && "$2" =~ ^[0-9]+$ ) ]]; then
      echo "Usage: $0 tail_mao_log [--lines N]" >&2
      exit 2
    fi
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"command": "tail_mao_log", "args": sys.argv[1:]}))' "$@")
    ;;
  run_mao_segmentation_only)
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 run_mao_segmentation_only" >&2
      exit 2
    fi
    BODY='{"command":"run_mao_segmentation_only","args":[]}'
    ;;
  start_mao_segmentation_only)
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 start_mao_segmentation_only" >&2
      exit 2
    fi
    BODY='{"command":"start_mao_segmentation_only","args":[]}'
    ;;
  start_mao_pipeline)
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 start_mao_pipeline" >&2
      exit 2
    fi
    BODY='{"command":"start_mao_pipeline","args":[]}'
    ;;
  run_mao_pipeline)
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 run_mao_pipeline" >&2
      exit 2
    fi
    BODY='{"command":"run_mao_pipeline","args":[]}'
    ;;
  run_mao_pears_visual)
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 run_mao_pears_visual" >&2
      exit 2
    fi
    BODY='{"command":"run_mao_pears_visual","args":[]}'
    ;;
  run_mao_pipeline_http)
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 run_mao_pipeline_http" >&2
      exit 2
    fi
    BODY='{"command":"run_module","args":["gpu_provider.process_mao_from_http"]}'
    ;;
  run_mao_pipeline_r2)
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 run_mao_pipeline_r2" >&2
      exit 2
    fi
    BODY='{"command":"run_module","args":["gpu_provider.process_mao_from_r2"]}'
    ;;
  list_case_files)
    if [[ $# -ne 2 || "$1" != "--case-id" ]]; then
      echo "Usage: $0 list_case_files --case-id <id>" >&2
      exit 2
    fi
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"command": "list_case_files", "args": sys.argv[1:]}))' "$@")
    ;;
  *)
    echo "unknown subcommand: $SUB" >&2
    exit 2
    ;;
esac

RESPONSE_BODY=$(mktemp)
trap 'rm -f "$RESPONSE_BODY"' EXIT

HTTP_CODE=$(curl --http1.1 --no-buffer -sS \
  -X POST "${BASE}/admin/run" \
  -H "content-type: application/json" \
  -H "x-provider-secret: ${SECRET}" \
  --data "$BODY" \
  -o "$RESPONSE_BODY" \
  -w '%{http_code}')

cat "$RESPONSE_BODY"
echo
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "[remote_win] HTTP ${HTTP_CODE}" >&2
  exit 1
fi
