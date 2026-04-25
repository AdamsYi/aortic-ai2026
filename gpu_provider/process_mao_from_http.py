#!/usr/bin/env python3
"""
Download and process mao_mianqiang_preop NIfTI from Mac HTTP server.
Run this directly on Windows GPU node.
"""
import os
import sys
import subprocess
from pathlib import Path

CASE_ID = "mao_mianqiang_preop"
# Mac HTTP server URL (local network)
HTTP_URL = "http://192.168.11.42:8888/cases/mao_mianqiang_preop/imaging_hidden/ct_preop.nii.gz"
# Detect actual repo path (Windows uses C:\AorticAI, not C:\aortic-ai)
for candidate in [r"C:\AorticAI", r"C:\aortic-ai", r"C:\aortic_ai"]:
    if Path(candidate).exists():
        REPO_ROOT = Path(candidate)
        break
else:
    REPO_ROOT = Path(r"C:\AorticAI")  # Default fallback
CASE_DIR = REPO_ROOT / "cases" / CASE_ID
NIFTI_DEST = CASE_DIR / "imaging_hidden" / "ct_preop.nii.gz"

def download_with_powershell(url: str, dest: Path) -> None:
    """Use PowerShell Invoke-WebRequest for HTTP download."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    
    ps_cmd = (
        "$ProgressPreference = 'SilentlyContinue'; "
        f"Invoke-WebRequest -Uri '{url}' -OutFile '{dest}' -UseBasicParsing"
    )
    result = subprocess.run(["powershell", "-Command", ps_cmd], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"PowerShell download failed: {result.stderr}")
    if not dest.exists():
        raise RuntimeError(f"Download failed - file not created")

def main():
    print(f"=== Processing {CASE_ID} ===")
    print(f"Downloading from Mac HTTP server: {HTTP_URL}")
    
    # Create directories
    CASE_DIR.mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "imaging_hidden").mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "meshes").mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "artifacts").mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "qa").mkdir(parents=True, exist_ok=True)
    
    # Download from HTTP server
    print("Downloading NIfTI file...")
    try:
        download_with_powershell(HTTP_URL, NIFTI_DEST)
    except RuntimeError as e:
        print(f"ERROR: Download failed - {e}")
        sys.exit(1)
    
    print(f"Downloaded: {NIFTI_DEST.stat().st_size / (1024*1024):.1f} MB")

    # Run processing using process_local_nifti (but skip file copy)
    gpu_provider_dir = REPO_ROOT / "gpu_provider"
    os.chdir(gpu_provider_dir)

    # Run geometry extraction using subprocess (same as process_local_nifti)
    print("\nRunning geometry extraction pipeline...")

    # Step 1: Root model
    print("Step 1: Extracting aortic root...")
    result = subprocess.run([
        sys.executable, "-m", "geometry.root_model",
        "--case-id", CASE_ID,
        "--nifti", str(NIFTI_DEST)
    ])
    if result.returncode != 0:
        print("Root extraction failed!")
        sys.exit(1)

    # Step 2: Leaflet model
    print("Step 2: Extracting leaflets...")
    result = subprocess.run([
        sys.executable, "-m", "geometry.leaflet_model",
        "--case-id", CASE_ID
    ])
    if result.returncode != 0:
        print("Leaflet extraction failed!")
        sys.exit(1)

    # Step 3: Lumen mesh
    print("Step 3: Generating lumen mesh...")
    result = subprocess.run([
        sys.executable, "-m", "geometry.lumen_mesh",
        "--case-id", CASE_ID
    ])
    if result.returncode != 0:
        print("Lumen mesh generation failed!")
        sys.exit(1)

    # Step 4: Landmarks
    print("Step 4: Detecting landmarks...")
    result = subprocess.run([
        sys.executable, "-m", "geometry.landmarks",
        "--case-id", CASE_ID,
        "--nifti", str(NIFTI_DEST)
    ])
    if result.returncode != 0:
        print("Landmark detection failed!")
        sys.exit(1)

    print("\n=== Processing complete! ===")

if __name__ == "__main__":
    main()
