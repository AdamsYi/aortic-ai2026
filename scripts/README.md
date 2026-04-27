# Scripts Directory

Organized by function. All scripts are run from the repo root.

## Subdirectories

| Folder | Purpose |
|--------|---------|
| `build/` | Build artifacts (Workstation bundle, default case, version management) |
| `deploy/` | Deployment and publishing (Worker deploy, case publishing) |
| `diagnostic/` | Testing and validation (E2E flows, acceptance tests, provider self-tests) |
| `data-import/` | Data ingest pipelines (Zenodo TAVI, measurement format conversion) |

## Build Scripts

| Script | Description |
|--------|-------------|
| `build/build_workstation.mjs` | Main build: compiles `apps/web/src/` → `dist/` |
| `build/build_default_case_bundle.mjs` | Builds default clinical case bundle for offline fallback |
| `build/set_build_version.mjs` | Sets `BUILD_VERSION` in `wrangler.toml` |

## Deploy Scripts

| Script | Description |
|--------|-------------|
| `deploy/promote_default_case_direct.sh` | Promotes default case to production |
| `deploy/publish_default_case.sh` | Publishes default case bundle |
| `deploy/publish_digital_twin_default_case.sh` | Publishes digital twin variant |
| `deploy/publish_case_result.sh` | Publishes a completed non-default case result to R2/D1 |

## Diagnostic Scripts

| Script | Description |
|--------|-------------|
| `diagnostic/assert_control_plane_clean.sh` | Verifies CF Worker deployment state |
| `diagnostic/e2e_user_flow.mjs` | End-to-end user flow tests |
| `diagnostic/provider_selftest.mjs` | GPU provider self-tests |
| `diagnostic/run_online_workstation_acceptance.mjs` | Workstation acceptance tests |
| `diagnostic/validate_second_open_heart_case.sh` | Validates second open-heart case |

## Data Import Scripts

| Script | Description |
|--------|-------------|
| `data-import/build_real_multiclass_mask.py` | Builds multiclass segmentation masks using TotalSegmentator |
| `data-import/convert_measurements_format.py` | Converts legacy measurement formats |

## Remote Operations

| Script | Description |
|--------|-------------|
| `remote_win.sh` | Main remote Windows GPU machine control (ingest, status, pip_sync, commit_case) |
| `run_now.sh` | Triggers immediate job on remote |
| `attach_windows_gpu_and_validate.sh` | Attaches Windows GPU and validates |
| `run_open_ct_case.sh` | Runs open CT case on remote |
| `setup_remote.sh` | Initial remote machine setup |
| `switch_to_windows_gpu.sh` | Switches context to Windows GPU machine |
| `switch_to_provider.sh` | Switches to GPU provider context |

## VPS / Cloudflare Setup

| Script | Description |
|--------|-------------|
| `setup_vps.sh` | VPS provisioning script |
| `cloudflare_setup.ps1` | Cloudflare Tunnel setup (PowerShell) |
| `nginx_aorticai.conf` | Nginx configuration template |
| `bootstrap_plan_a.sh` | Bootstrap script for Plan A deployment |
| `attach_windows_gpu_and_validate.sh` | Windows GPU attachment validation |

## Local Paths

| Script | Description |
|--------|-------------|
| `_local_paths.sh` | Local path overrides (development only) |

---

## Usage Examples

```bash
# Build workstation
npm run build
# or manually:
node scripts/build/build_workstation.mjs

# Run E2E tests
node scripts/diagnostic/e2e_user_flow.mjs

# Ingest a specific ImageCAS case
./scripts/remote_win.sh ingest --case-ids 1

# Validate remote status
./scripts/remote_win.sh status
```
