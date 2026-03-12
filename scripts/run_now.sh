#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source "./scripts/_local_paths.sh"
./scripts/run_open_ct_case.sh >/tmp/aortic_run_now.log 2>&1 || {
  cat /tmp/aortic_run_now.log >&2
  exit 1
}
cat /tmp/aortic_run_now.log

echo
WORK_ROOT="$(aortic_local_work_root)"
printf 'latest_meta=%s\n' "${WORK_ROOT}/latest_run.json"
printf 'latest_result=%s\n' "${WORK_ROOT}/latest_job_result.json"
