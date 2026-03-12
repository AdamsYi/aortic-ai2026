#!/usr/bin/env bash

aortic_local_work_root() {
  if [[ -n "${AORTICAI_LOCAL_WORK_ROOT:-}" ]]; then
    printf '%s\n' "${AORTICAI_LOCAL_WORK_ROOT}"
    return
  fi
  if [[ "$(uname -s)" == "Darwin" ]]; then
    printf '/tmp/aorticai\n'
    return
  fi
  printf 'runs\n'
}
