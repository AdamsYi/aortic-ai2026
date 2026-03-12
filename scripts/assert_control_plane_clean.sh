#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(pwd)}"
cd "$ROOT"

violations=()

check_path() {
  local p="$1"
  if [ -e "$p" ]; then
    violations+=("$p")
  fi
}

check_glob_count() {
  local label="$1"
  shift
  local count
  count=$(find . "$@" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [ "${count:-0}" != "0" ]; then
    violations+=("${label}:${count}")
  fi
}

check_path "runs"
check_path "data"
check_glob_count "*.nii/.nii.gz" \( -name '*.nii' -o -name '*.nii.gz' \)
check_glob_count "*.stl/.vtk" \( -name '*.stl' -o -name '*.vtk' \)

if [ "${#violations[@]}" -gt 0 ]; then
  printf 'AorticAI control-plane policy violation:\n' >&2
  printf '  %s\n' "${violations[@]}" >&2
  exit 1
fi

echo "AorticAI control-plane policy OK"
