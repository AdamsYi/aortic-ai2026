# AorticAI Production Template

This repository now contains a manifest-first default showcase/reference case:
- `cases/default_clinical_case/artifacts/case_manifest.json` is the single source of truth
- `cases/default_clinical_case/artifacts/planning.json` is the planning artifact source
- `services/api` is the only business-truth layer
- Cloudflare Worker remains the only public entrypoint

The default case is a placeholder-only showcase bundle:
- no real CTA data
- renderable NIfTI / STL / PDF assets
- full measurements / planning / QA / download flow
- explicit success + failure coexistence

Repository policy:
- `src/generated/workstationAssets.ts` and `src/generated/defaultCaseBundle.ts` are committed generated files.
- They must stay in sync with `npm run build:web`; review and submit them as part of the template change set.
- `frontend/workstation/` is retained as migration-era reference source only and no longer participates in build or runtime.

Quickstart:

```bash
npm install
npm run build:web
npx tsc --noEmit
npm run test:schema
npm run test:unit
```

E2E showcase run:

```bash
npm run test:e2e
```

`default_clinical_case` is intentionally both:
- default instant-open case
- showcase case
- reference implementation case

Unspecified items: no specific constraint.

# Aortic AI Web Platform (Worker + External GPU Provider)

This repository now targets a real web-driven pipeline:
- browser upload and orchestration
- Cloudflare Worker gateway
- external GPU FastAPI inference backend (Windows workstation or Linux cloud GPU)
- real segmentation masks + centerline-orthogonal geometry measurements (no placeholders)

Core exports per case:
- `segmentation_mask.nii.gz`
- `measurements.json`
- `planning_report.pdf`
- `aortic_root.stl`
- `centerline.json`
- `annulus_plane.json`

## 1) What is included

- Cloudflare Worker API (`src/index.ts`)
- D1 schema migration (`migrations/0001_init.sql`)
- R2 bucket bindings for raw data and outputs
- Queue producer + consumer

Core tables:
- `studies`
- `jobs`
- `artifacts`
- `metrics`

Helper table:
- `upload_sessions` (ephemeral upload token flow)

Governance tables:
- `study_repository` (study traceability / metadata registry)
- `pipeline_runs` (pipeline version + provenance + runtime tracking)
- `artifact_access_audit` (artifact download audit log)

## 2) Endpoints

- `GET /health`
- `GET /demo` -> built-in web UI with latest completed case
- `GET /demo/latest-case` -> latest completed case payload
- `POST /upload-url` -> create one-time upload session
- `PUT /upload/:session_id?token=...` -> upload a CTA file
- `POST /jobs` -> enqueue segmentation
- `GET /jobs/:id` -> query status + artifacts + metrics
- `GET /studies/:id/raw` -> download raw CT file
- `GET /studies/:id/meta` -> study metadata + repository summary
- `GET /studies/:id/repository` -> study repository view + recent jobs/runs
- `GET /jobs/:id/artifacts/:artifact_type` -> download artifact by type
- `POST /callbacks/inference` -> inference provider callback (for webhook mode)
- `POST /providers/mock-inference` -> built-in mock provider (for zero-cost webhook flow)

Artifact download model:
- if `ARTIFACT_LINK_SECRET` is set, `/studies/:id/raw` and `/jobs/:id/artifacts/:type` require signed URLs
- signed links are returned from `GET /jobs/:id` and `GET /demo/latest-case`

`/demo/latest-case` includes `clinical_targets` focused on:
- `pears` (pre-op 3D mesh planning readiness)
- `vsrr` (pre-op geometric reconstruction readiness)

## 3) Prerequisites

- Node.js 20+
- Cloudflare account
- `wrangler` CLI

## 4) Setup

```bash
npm install
npx wrangler login
```

Create resources once:

```bash
npx wrangler r2 bucket create aortic-ct-raw
npx wrangler r2 bucket create aortic-mask-out
npx wrangler d1 create aortic_meta
npx wrangler queues create seg-jobs
```

Or run the helper script:

```bash
./scripts/bootstrap_plan_a.sh
```

Update `wrangler.toml` with your real `database_id`.

Apply migration:

```bash
npm run d1:migrate:local
# after deployment target is ready:
npm run d1:migrate:remote
```

Important:
- this repo now includes `migrations/0002_governance.sql`
- apply both migrations before using study repository / pipeline run traceability features

Run locally:

```bash
npm run dev
```

Deploy:

```bash
npm run deploy
```

Remote one-shot (after `database_id` is set and token exported):

```bash
./scripts/setup_remote.sh
```

Auth options for `setup_remote.sh`:
- preferred: `CLOUDFLARE_API_TOKEN`
- compatible: `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY`

## 4.1 Inference modes

- `INFERENCE_MODE=mock`: queue consumer writes demo output.
- `INFERENCE_MODE=webhook` (default in this repo): queue consumer sends case data to webhook provider.

Environment variables in `wrangler.toml`:
- `INFERENCE_MODE`
- `INFERENCE_WEBHOOK_TIMEOUT_MS`
- `INFERENCE_MAX_INPUT_BYTES`
- `API_BASE_URL` (used to build callback URL)
- `INFERENCE_WEBHOOK_URL`
- `ARTIFACT_LINK_TTL_SECONDS`

Recommended secret:

```bash
npx wrangler secret put ARTIFACT_LINK_SECRET
```

## 4.2 Start Now (No Talk)

1. Deploy provider on your GPU host:

```bash
cd gpu_provider
./run_local.sh
```

If your provider runs on Windows GPU, use:

```powershell
cd gpu_provider
.\run_windows_gpu.ps1 -Quality fast
```

2. Point Cloudflare Worker to your provider URL:

```bash
cd ..
./scripts/switch_to_provider.sh https://<your-gpu-host>/infer
```

Windows shortcut:

```bash
./scripts/switch_to_windows_gpu.sh http://<win-gpu-host>:8000
```

One-shot attach + validation (recommended):

```bash
./scripts/attach_windows_gpu_and_validate.sh http://<win-gpu-host>:8000
```

Linux cloud GPU path:

```bash
./scripts/deploy_linux_gpu_provider.sh <ssh-target> [public_provider_base_url]
./scripts/attach_linux_gpu_and_validate.sh <ssh-target> [public_provider_base_url]
```

Important:
- If Worker runs on Cloudflare (not local dev), `192.168.x.x` / `10.x.x.x` private IP is not directly reachable from cloud runtime.
- Expose your Windows provider as a public HTTPS endpoint first (Cloudflare Tunnel / Tailscale Funnel), then switch webhook to that public URL.
- For Linux cloud GPU, image build, provider selftest, and Worker end-to-end CTA validation all run on the remote GPU host; the Mac remains control-plane only.

3. Submit a case and check job status:

```bash
curl -sS https://aortic-ai-api.we085197.workers.dev/jobs/<job_id>
```

Secret for callback auth:

```bash
npx wrangler secret put INFERENCE_CALLBACK_SECRET
```

Set webhook URL (recommended via secret or dashboard env var, replace mock endpoint with your real GPU API):

```bash
npx wrangler secret put INFERENCE_WEBHOOK_URL
```

## 5) Quick API flow (curl)

### 5.1 Create upload URL

```bash
curl -sS http://127.0.0.1:8787/upload-url \
  -H 'content-type: application/json' \
  -d '{
    "study_id":"case-001",
    "filename":"case-001.nii.gz",
    "source_dataset":"TAVRP-PL",
    "patient_code":"anon-001",
    "image_format":"nifti",
    "phase":"mid-diastole"
  }'
```

### 5.2 Upload file

Use response field `upload_url` and run:

```bash
curl -sS -X PUT "http://127.0.0.1:8787/upload/<session>?token=<token>" \
  -H 'content-type: application/octet-stream' \
  --data-binary @/absolute/path/to/case-001.nii.gz
```

### 5.3 Create job

```bash
curl -sS http://127.0.0.1:8787/jobs \
  -H 'content-type: application/json' \
  -d '{"study_id":"case-001","job_type":"segmentation_v1","model_tag":"baseline"}'
```

### 5.4 Check job

```bash
curl -sS http://127.0.0.1:8787/jobs/<job_id>
```

## 6) Webhook contract (Phase 2)

When `INFERENCE_MODE=webhook`, the Worker sends:

```json
{
  "job_id": "uuid",
  "study_id": "case-001",
  "image_key": "studies/.../raw/...nii.gz",
  "input_content_type": "application/octet-stream",
  "input_base64": "...",
  "callback": {
    "url": "https://<your-worker>/callbacks/inference",
    "header": "x-callback-secret",
    "secret": "<secret-or-null>"
  }
}
```

Provider callback example:

```json
{
  "job_id": "uuid",
  "status": "succeeded",
  "provider_job_id": "gpu-123",
  "result_json": { "model": "nnunet-v2", "dice_root": 0.93 },
  "metrics": [
    { "name": "inference_seconds", "value": 18.4, "unit": "s" }
  ]
}
```

Or include binary mask:

```json
{
  "job_id": "uuid",
  "status": "succeeded",
  "mask_base64": "<base64>",
  "mask_filename": "mask.nii.gz",
  "mask_content_type": "application/gzip"
}
```

## 7) Current behavior

- Web UI controls the workflow end-to-end from browser.
- Worker forwards jobs to webhook provider (`INFERENCE_WEBHOOK_URL`).
- GPU provider must run a real pipeline (`pipeline_runner.py` or custom `INFER_CMD`).
- Placeholder/stub inference is disabled in provider code.

## 8) Security note

Do not use Cloudflare Global API Key for automation.
Use scoped API Token only.
