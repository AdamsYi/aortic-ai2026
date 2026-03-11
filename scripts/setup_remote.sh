#!/usr/bin/env bash
set -euo pipefail

# Auth env (either one mode):
#   1) CLOUDFLARE_API_TOKEN
#   2) CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY
#
# Optional:
#   WRANGLER_ENV

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && ( -z "${CLOUDFLARE_EMAIL:-}" || -z "${CLOUDFLARE_API_KEY:-}" ) ]]; then
  echo "Provide CLOUDFLARE_API_TOKEN, or CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY" >&2
  exit 1
fi

echo "Creating buckets/queue (no-op if already exists)..."
npx wrangler r2 bucket create aortic-ct-raw || true
npx wrangler r2 bucket create aortic-mask-out || true
npx wrangler queues create seg-jobs || true

echo "Create D1 database and copy returned database_id into wrangler.toml if this is first run:"
echo "  npx wrangler d1 create aortic_meta"

echo "Applying remote migrations..."
npx wrangler d1 migrations apply aortic_meta --remote

echo "Deploying worker..."
npx wrangler deploy

echo "Done."
