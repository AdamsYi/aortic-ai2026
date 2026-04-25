#!/usr/bin/env python3
"""
Download and process mao_mianqiang_preop NIfTI from R2.
Run this directly on Windows GPU node.
"""
import os
import sys
import subprocess
from pathlib import Path

CASE_ID = "mao_mianqiang_preop"
R2_URL = "https://pub-aortic-ct-raw.r2.cloudflarestorage.com/mao_mianqiang_preop/ct_preop.nii.gz"
REPO_ROOT = Path(r"C:\aortic-ai")
CASE_DIR = REPO_ROOT / "cases" / CASE_ID
NIFTI_DEST = CASE_DIR / "imaging_hidden" / "ct_preop.nii.gz"

def download_with_powershell(url: str, dest: Path) -> None:
    """Use curl.exe or PowerShell for downloading."""
    dest.parent.mkdir(parents=True, exist_ok=True)

    # Try curl.exe first (better SSL support)
    import shutil
    curl_exe = shutil.which("curl.exe") or shutil.which("curl")
    if curl_exe:
        print(f"Using curl: {curl_exe}")
        curl_cmd = [curl_exe, "-L", "-o", str(dest), url, "--ssl-no-revoke", "-v"]
        result = subprocess.run(curl_cmd, capture_output=True, text=True)
        print(f"curl stdout: {result.stdout[:500] if result.stdout else '(empty)'}")
        print(f"curl stderr: {result.stderr[:500] if result.stderr else '(empty)'}")
        if result.returncode == 0 and dest.exists():
            print(f"curl download succeeded: {dest.stat().st_size / (1024*1024):.1f} MB")
            return
        print(f"curl failed with code {result.returncode}, trying PowerShell...")

    # Fallback to PowerShell with TLS 1.2
    ps_cmd = (
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; "
        "$ProgressPreference='SilentlyContinue'; "
        f"Invoke-WebRequest -Uri '{url}' -OutFile '{dest}' -UseBasicParsing"
    )
    print(f"Using PowerShell: {ps_cmd[:100]}...")
    result = subprocess.run(["powershell", "-Command", ps_cmd], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"PowerShell stdout: {result.stdout[:500] if result.stdout else '(empty)'}")
        print(f"PowerShell stderr: {result.stderr[:500] if result.stderr else '(empty)'}")
        raise RuntimeError(f"Download failed - PowerShell: {result.stderr[:200]}")

def main():
    print(f"=== Processing {CASE_ID} ===")
    print(f"Downloading from R2: {R2_URL}")

    # Create directories
    CASE_DIR.mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "imaging_hidden").mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "meshes").mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "artifacts").mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "qa").mkdir(parents=True, exist_ok=True)

    # Download from R2 using PowerShell
    print("Downloading NIfTI file (via PowerShell)...")
    try:
        download_with_powershell(R2_URL, NIFTI_DEST)
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
