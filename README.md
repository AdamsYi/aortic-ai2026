# AorticAI Production Template

This repository is now organized around a manifest-first showcase/reference template for AorticAI.

The primary delivery in this branch is:
- `cases/default_clinical_case/` as the default instant-open case
- `cases/default_clinical_case/artifacts/case_manifest.json` as the single source of truth
- `cases/default_clinical_case/artifacts/planning.json` as the planning artifact source
- `apps/web/` as the active workstation frontend
- `services/api/` as the importable business-truth layer
- `src/index.ts` as the Cloudflare Worker adapter

`default_clinical_case` is intentionally all three:
- default case
- showcase case
- reference implementation case

It is now a committed real CTA showcase bundle:
- real CTA root ROI NIfTI committed in-repo for demo and validation
- renderable STL / PDF assets
- full measurements / planning / QA / download flow
- explicit success + failure coexistence
- `Showcase` is the default `/demo` entry and `Latest Case` is a secondary in-UI switch

## Runtime Model

- Cloudflare Worker is the only public entrypoint.
- `services/api` is the only business-truth layer and is not deployed as a standalone service.
- `gpu_provider/` remains the hidden imaging pipeline and is not part of the default showcase demo chain.
- GPU is segmentation-only.
- Geometry, measurements, planning, and simulation remain CPU-side.

## Repository Policy

- `src/generated/workstationAssets.ts` and `src/generated/defaultCaseBundle.ts` are committed generated files.
- They must stay in sync with `npm run build:web`.
- `frontend/workstation/` is retained only as migration-era reference source and no longer participates in build or runtime.
- Unspecified items are treated as having no specific constraint.

## Repository Layout

```text
apps/web/                     Active workstation frontend
services/api/                 Manifest-first case and API truth layer
cases/default_clinical_case/  Showcase/reference case bundle
schemas/                      JSON Schema contracts
docs/                         Bilingual product and implementation docs
tests/                        Schema, API, E2E, performance, and safety checks
src/index.ts                  Cloudflare Worker adapter
gpu_provider/                 Hidden imaging pipeline (not used by default demo)
```

## Quickstart

```bash
npm install
npm run build:web
npm run test
```

Local worker demo:

```bash
npm run dev
```

Open:

- `/demo`
- `/demo/showcase`
- `/demo?case=latest`
- `/api/cases/default_clinical_case/summary`
- `/workstation/cases/default_clinical_case`

## What `/demo` Must Show

The first screen is expected to show, without upload or waiting:
- axial / sagittal / coronal MPR
- synchronized crosshair
- double-oblique controls
- 3D anatomy
- centerline and landmark overlays
- measurements
- planning
- uncertainty / QA
- downloads

Capability gating is explicit:
- unavailable capabilities must show a reason
- `historical`, `inferred`, and `legacy` states must be visibly labeled
- planning data is read from `planning.json`; the frontend must not synthesize missing values

## Build and Test

Core commands:

```bash
npm run build:web
npm run test:schema
npm run test:unit
npm run test:e2e
npm run test
```

`make up`, `make build`, and `make test` are thin wrappers around the same flow.

## Background / Deferred Lines

This branch is not trying to finish the clinical algorithm roadmap. The following remain downstream work after the template/showcase baseline:
- VMTK-first centerline on real provider output
- curved MPR / vessel straightening
- coronary ostia detection v2
- cusp-wise leaflet geometry

The older upload / queue / provider platform remains in the repository as background infrastructure, but it is not the primary narrative of this template delivery.

## Docs

See:
- `docs/EXECUTIVE_SUMMARY.md`
- `docs/SYSTEM_ARCHITECTURE.md`
- `docs/UI_UX_SPEC_ZH_EN.md`
- `docs/CODEX_EXECUTION_CHECKLIST.md`

## Positioning

Current external positioning remains:
- `research-grade preclinical planning platform`

This branch does not claim clinical-ready status.
