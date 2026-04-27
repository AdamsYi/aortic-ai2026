#!/usr/bin/env python3
"""Download and process mao_mianqiang_preop NIfTI from Cloudflare storage."""
import os
import sys
import subprocess
from pathlib import Path

CASE_ID = "mao_mianqiang_preop"
SOURCE_URL = os.getenv(
    "AORTICAI_MAO_SOURCE_URL",
    "https://aortic-ai-api.we085197.workers.dev/studies/mao_mianqiang_preop/raw/ct_preop.nii.gz",
)
SOURCE_HEADER = os.getenv("AORTICAI_MAO_SOURCE_HEADER", "").strip()
SOURCE_HEADER_VALUE = os.getenv("AORTICAI_MAO_SOURCE_HEADER_VALUE", "").strip()
DEVICE = os.getenv("AORTICAI_MAO_DEVICE", "cpu")
QUALITY = os.getenv("AORTICAI_MAO_QUALITY", "high")

for candidate in [r"C:\AorticAI", r"C:\aortic-ai", r"C:\aortic_ai"]:
    if Path(candidate).exists():
        REPO_ROOT = Path(candidate)
        break
else:
    REPO_ROOT = Path(r"C:\AorticAI")

CASE_DIR = REPO_ROOT / "cases" / CASE_ID
NIFTI_DEST = CASE_DIR / "imaging_hidden" / "ct_preop.nii.gz"

def download_with_powershell(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    header_script = ""
    if SOURCE_HEADER and SOURCE_HEADER_VALUE:
        header_script = f'$client.Headers.Add("{SOURCE_HEADER}", "{SOURCE_HEADER_VALUE}")'

    ps_script = f'''
$url = "{url}"
$dest = "{dest}"
try {{
    $client = New-Object System.Net.WebClient
    $client.Headers.Add("User-Agent", "PowerShell")
    {header_script}
    $client.DownloadFile($url, $dest)
    Write-Host "WebClient download succeeded: $($dest.Length / 1MB) MB"
}} catch {{
    Write-Host "WebClient failed: $_"
    throw
}}
'''
    print("Using PowerShell WebClient...")
    result = subprocess.run(["powershell", "-Command", ps_script], capture_output=True, text=True)
    if result.returncode == 0 and dest.exists():
        print(f"WebClient download succeeded: {dest.stat().st_size / (1024*1024):.1f} MB")
        return

    print(f"WebClient failed: {result.stderr[:200] if result.stderr else result.stdout[:200]}")
    raise RuntimeError("Download failed")


def run_pipeline() -> None:
    gpu_provider_dir = REPO_ROOT / "gpu_provider"
    output_mask = CASE_DIR / "meshes" / "segmentation.nii.gz"
    output_json = CASE_DIR / "artifacts" / "pipeline_result.json"
    output_dir = CASE_DIR / "meshes"

    env = os.environ.copy()
    env["PYTHONPATH"] = str(REPO_ROOT)
    cmd = [
        sys.executable,
        "-u",
        str(gpu_provider_dir / "pipeline_runner.py"),
        "--input",
        str(NIFTI_DEST),
        "--output-mask",
        str(output_mask),
        "--output-json",
        str(output_json),
        "--output-dir",
        str(output_dir),
        "--device",
        DEVICE,
        "--quality",
        QUALITY,
        "--pears-visual",
        "--job-id",
        CASE_ID,
        "--study-id",
        CASE_ID,
    ]
    print("Running pipeline:")
    print(" ".join(cmd))
    result = subprocess.run(cmd, cwd=str(REPO_ROOT), env=env)
    if result.returncode != 0:
        raise RuntimeError(f"Pipeline failed with code {result.returncode}")


def verify_outputs() -> None:
    required = [
        CASE_DIR / "meshes" / "segmentation.nii.gz",
        CASE_DIR / "meshes" / "lumen_mask.nii.gz",
        CASE_DIR / "meshes" / "aortic_root.stl",
        CASE_DIR / "meshes" / "ascending_aorta.stl",
        CASE_DIR / "meshes" / "leaflets.stl",
        CASE_DIR / "meshes" / "annulus_ring.stl",
        CASE_DIR / "meshes" / "pears_outer_aorta.stl",
        CASE_DIR / "meshes" / "pears_support_sleeve_preview.stl",
        CASE_DIR / "meshes" / "centerline.json",
        CASE_DIR / "meshes" / "annulus_plane.json",
        CASE_DIR / "meshes" / "aortic_root_model.json",
        CASE_DIR / "meshes" / "leaflet_model.json",
        CASE_DIR / "meshes" / "measurements.json",
        CASE_DIR / "meshes" / "planning_report.pdf",
        CASE_DIR / "artifacts" / "pears_model.json",
        CASE_DIR / "artifacts" / "pears_coronary_windows.json",
        CASE_DIR / "artifacts" / "pipeline_result.json",
    ]
    missing = [str(path) for path in required if not path.exists() or path.stat().st_size <= 0]
    if missing:
        raise RuntimeError(f"Missing pipeline outputs: {missing}")

    try:
        import trimesh
    except Exception:
        print("trimesh unavailable; skipping STL triangle count")
        return

    for name in ["aortic_root.stl", "ascending_aorta.stl", "leaflets.stl", "annulus_ring.stl", "pears_support_sleeve_preview.stl"]:
        path = CASE_DIR / "meshes" / name
        mesh = trimesh.load(str(path))
        print(f"{name}: {len(mesh.faces):,} tris")


def validate_manifest() -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(REPO_ROOT)
    cmd = [sys.executable, "-u", "-m", "gpu_provider.admin_validate_mao_result"]
    print("Validating manifest and QA:")
    print(" ".join(cmd))
    result = subprocess.run(cmd, cwd=str(REPO_ROOT), env=env)
    if result.returncode != 0:
        raise RuntimeError(f"Validation failed with code {result.returncode}")

def main():
    print(f"=== Processing {CASE_ID} ===")
    print(f"Repo root: {REPO_ROOT}")
    print(f"Downloading from Cloudflare source: {SOURCE_URL}")

    CASE_DIR.mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "imaging_hidden").mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "meshes").mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "artifacts").mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "qa").mkdir(parents=True, exist_ok=True)

    print("Downloading NIfTI file...")
    try:
        download_with_powershell(SOURCE_URL, NIFTI_DEST)
    except RuntimeError as e:
        print(f"ERROR: Download failed - {e}")
        sys.exit(1)

    print(f"Downloaded: {NIFTI_DEST.stat().st_size / (1024*1024):.1f} MB")
    run_pipeline()
    verify_outputs()
    validate_manifest()
    print("=== Processing complete ===")

if __name__ == "__main__":
    main()
