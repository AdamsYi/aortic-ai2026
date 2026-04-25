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

    # Try curl.exe with insecure flag (R2 is public-read, SSL not required for download)
    import shutil
    curl_exe = shutil.which("curl.exe") or shutil.which("curl")
    if curl_exe:
        print(f"Using curl: {curl_exe}")
        # --insecure: skip cert verification (R2 public bucket)
        # --retry 3: retry on transient failures
        curl_cmd = [curl_exe, "-L", "-o", str(dest), url, "--insecure", "--retry", "3"]
        result = subprocess.run(curl_cmd, capture_output=True, text=True)
        if result.returncode == 0 and dest.exists():
            print(f"curl download succeeded: {dest.stat().st_size / (1024*1024):.1f} MB")
            return
        print(f"curl failed with code {result.returncode}")
        print(f"curl stderr: {result.stderr[-300:] if result.stderr else '(empty)'}")

    # Fallback: PowerShell with custom HTTPS handler that bypasses cert validation
    ps_script = f'''
$oldPolicy = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = {{$true}}
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
try {{
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri '{url}' -OutFile '{dest}' -UseBasicParsing
}} finally {{
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $oldPolicy
}}
'''
    print("Using PowerShell with cert bypass callback...")
    result = subprocess.run(["powershell", "-Command", ps_script], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"PowerShell failed: {result.stderr[:300]}")
        raise RuntimeError(f"Download failed - both curl and PowerShell failed")
    if not dest.exists():
        raise RuntimeError(f"Download failed - file not created")

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
