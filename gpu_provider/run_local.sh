#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi

source .venv/bin/activate
pip install -r requirements.txt

echo "[warn] This entrypoint is for development only."
echo "[warn] Heavy inference should run on your Windows GPU workstation."

uvicorn app:app --host 0.0.0.0 --port 8000
