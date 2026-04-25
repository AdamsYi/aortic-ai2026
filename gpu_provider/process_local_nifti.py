#!/usr/bin/env python3
"""
Process a local NIfTI file that was transferred via external means (scp, HTTP, etc.)

Usage:
    python -m gpu_provider.process_local_nifti --case-id mao_mianqiang_preop --nifti C:\aortic-ai\cases\mao_mianqiang_preop\imaging_hidden\ct_preop.nii.gz
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
CASES_ROOT = REPO_ROOT / "cases"


def main():
    parser = argparse.ArgumentParser(description="Process local NIfTI file")
    parser.add_argument("--case-id", required=True, help="Case identifier")
    parser.add_argument("--nifti", required=True, help="Path to NIfTI file")
    args = parser.parse_args()

    case_id = args.case_id
    nifti_path = Path(args.nifti)

    if not nifti_path.exists():
        print(f"ERROR: NIfTI file not found: {nifti_path}")
        sys.exit(1)

    case_dir = CASES_ROOT / case_id
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "imaging_hidden").mkdir(parents=True, exist_ok=True)
    (case_dir / "meshes").mkdir(parents=True, exist_ok=True)
    (case_dir / "artifacts").mkdir(parents=True, exist_ok=True)
    (case_dir / "qa").mkdir(parents=True, exist_ok=True)

    # Copy NIfTI to case directory
    dest_nifti = case_dir / "imaging_hidden" / "ct_preop.nii.gz"
    print(f"Copying NIfTI to: {dest_nifti}")
    
    # Use shutil.copy for efficient copy
    import shutil
    shutil.copy(str(nifti_path), str(dest_nifti))
    
    print(f"NIfTI size: {dest_nifti.stat().st_size / (1024*1024):.1f} MB")

    # Run geometry extraction
    print("\nRunning geometry extraction pipeline...")
    os.chdir(REPO_ROOT / "gpu_provider")
    
    # Step 1: Root model
    print("Step 1: Extracting aortic root...")
    result = subprocess.run([
        sys.executable, "-m", "geometry.root_model",
        "--case-id", case_id,
        "--nifti", str(dest_nifti)
    ])
    if result.returncode != 0:
        print("Root extraction failed!")
        sys.exit(1)

    # Step 2: Leaflet model
    print("Step 2: Extracting leaflets...")
    result = subprocess.run([
        sys.executable, "-m", "geometry.leaflet_model",
        "--case-id", case_id
    ])
    if result.returncode != 0:
        print("Leaflet extraction failed!")
        sys.exit(1)

    # Step 3: Lumen mesh
    print("Step 3: Generating lumen mesh...")
    result = subprocess.run([
        sys.executable, "-m", "geometry.lumen_mesh",
        "--case-id", case_id
    ])
    if result.returncode != 0:
        print("Lumen mesh generation failed!")
        sys.exit(1)

    # Step 4: Landmarks
    print("Step 4: Detecting landmarks...")
    result = subprocess.run([
        sys.executable, "-m", "geometry.landmarks",
        "--case-id", case_id
    ])
    if result.returncode != 0:
        print("Landmark detection failed!")
        sys.exit(1)

    print("\n=== Geometry extraction completed successfully! ===")
    print(f"Meshes: {case_dir / 'meshes'}")
    
    # Create/update manifest
    manifest = {
        "case_id": case_id,
        "case_role": ["showcase", "clinical"],
        "display_name": {"zh-CN": "毛棉强 根部瘤 术前 CTA", "en": "Mao Mianqiang Pre-op CTA"},
        "placeholder": False,
        "not_real_cta": False,
        "case_type": "real_pipeline_case",
        "data_source": "real_ct_pipeline_output",
        "build_version": "gpu_extracted_20260425",
        "imaging_index": {"raw_ct": "imaging_hidden/ct_preop.nii.gz"},
        "mesh_index": {
            "aortic_root_stl": "meshes/aortic_root.stl",
            "ascending_aorta_stl": "meshes/ascending_aorta.stl",
            "leaflets_stl": "meshes/leaflets.stl",
            "annulus_ring_stl": "meshes/annulus_ring.stl"
        }
    }
    
    manifest_path = case_dir / "artifacts" / "case_manifest.json"
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    
    print(f"Manifest: {manifest_path}")
    print("\nNext: Run 'commit_case' to push to git")


if __name__ == "__main__":
    main()
