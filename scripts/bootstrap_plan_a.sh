#!/usr/bin/env bash
set -euo pipefail

# Run from repository root.

npx wrangler r2 bucket create aortic-ct-raw || true
npx wrangler r2 bucket create aortic-mask-out || true
npx wrangler d1 create aortic_meta || true
npx wrangler queues create seg-jobs || true

echo "Resource bootstrap complete."
echo "Next: update database_id in wrangler.toml, then run migrations."
