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
REPO_ROOT = Path(r"C:\aortic-ai")
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
    
    # Run processing
    os.chdir(REPO_ROOT / "gpu_provider")
    sys.argv = ["process_local_nifti", "--case-id", CASE_ID, "--nifti", str(NIFTI_DEST)]
    
    # Import and run process_local_nifti.main()
    from process_local_nifti import main as process_main
    process_main()

if __name__ == "__main__":
    main()
