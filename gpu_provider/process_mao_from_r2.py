#!/usr/bin/env python3
"""
Download and process mao_mianqiang_preop NIfTI from R2.
Run this directly on Windows GPU node.
"""
import os
import sys
import ssl
import requests
from pathlib import Path

# Disable SSL verification for R2 (public bucket, Windows SSL compatibility)
ssl._create_default_https_context = ssl._create_unverified_context

CASE_ID = "mao_mianqiang_preop"
R2_URL = "https://pub-aortic-ct-raw.r2.cloudflarestorage.com/mao_mianqiang_preop/ct_preop.nii.gz"
REPO_ROOT = Path(r"C:\aortic-ai")
CASE_DIR = REPO_ROOT / "cases" / CASE_ID
NIFTI_DEST = CASE_DIR / "imaging_hidden" / "ct_preop.nii.gz"

def main():
    print(f"=== Processing {CASE_ID} ===")
    print(f"Downloading from R2: {R2_URL}")
    
    # Create directories
    CASE_DIR.mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "imaging_hidden").mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "meshes").mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "artifacts").mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "qa").mkdir(parents=True, exist_ok=True)
    
    # Download from R2
    print("Downloading NIfTI file...")
    resp = requests.get(R2_URL, stream=True)
    if resp.status_code != 200:
        print(f"ERROR: R2 download failed: HTTP {resp.status_code}")
        print(f"Response: {resp.text[:500]}")
        sys.exit(1)
    
    total = int(resp.headers.get('content-length', 0))
    downloaded = 0
    
    with open(NIFTI_DEST, 'wb') as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)
            downloaded += len(chunk)
            if total > 0:
                pct = downloaded / total * 100
                mb = downloaded / (1024*1024)
                total_mb = total / (1024*1024)
                print(f"\r  Progress: {pct:.1f}% ({mb:.1f}/{total_mb:.1f} MB)", end='', flush=True)
    
    print(f"\nDownloaded: {NIFTI_DEST.stat().st_size / (1024*1024):.1f} MB")
    
    # Run processing
    os.chdir(REPO_ROOT / "gpu_provider")
    sys.argv = ["process_local_nifti", "--case-id", CASE_ID, "--nifti", str(NIFTI_DEST)]
    
    # Import and run process_local_nifti.main()
    from process_local_nifti import main as process_main
    process_main()

if __name__ == "__main__":
    main()
