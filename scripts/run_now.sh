#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
./scripts/run_open_ct_case.sh >/tmp/aortic_run_now.log 2>&1 || {
  cat /tmp/aortic_run_now.log >&2
  exit 1
}
cat /tmp/aortic_run_now.log

echo
printf 'latest_meta=%s\n' "$(pwd)/runs/latest_run.json"
printf 'latest_result=%s\n' "$(pwd)/runs/latest_job_result.json"
