#!/usr/bin/env python3
"""
Real CTA pipeline runner (no placeholder output):
1) DICOM(.zip/.dcm series) -> NIfTI via dcm2niix (if needed)
2) Multiclass segmentation via TotalSegmentator-based builder
3) Geometric measurements from segmentation masks
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np


def run_cmd(cmd: list[str]) -> tuple[str, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"Command failed ({proc.returncode}): {' '.join(cmd)}\n"
            f"stderr_tail={proc.stderr[-1200:]}"
        )
    return proc.stdout or "", proc.stderr or ""


def find_bin(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise FileNotFoundError(f"Required binary not found: {name}")
    return found


def prepare_nifti_input(input_path: Path, work_dir: Path) -> tuple[Path, dict[str, Any]]:
    suffix = input_path.name.lower()
    meta: dict[str, Any] = {"input_kind": "unknown", "conversion": "none"}
    if suffix.endswith(".nii") or suffix.endswith(".nii.gz"):
        meta["input_kind"] = "nifti"
        return input_path, meta

    dcm2niix = find_bin("dcm2niix")
    dicom_dir = work_dir / "dicom_input"
    dicom_dir.mkdir(parents=True, exist_ok=True)

    if suffix.endswith(".zip"):
        meta["input_kind"] = "dicom_zip"
        with zipfile.ZipFile(input_path, "r") as zf:
            zf.extractall(dicom_dir)
    else:
        meta["input_kind"] = "dicom_file_or_series"
        shutil.copy2(input_path, dicom_dir / input_path.name)

    out_dir = work_dir / "nifti"
    out_dir.mkdir(parents=True, exist_ok=True)
    run_cmd([dcm2niix, "-z", "y", "-o", str(out_dir), str(dicom_dir)])
    nii_files = sorted(out_dir.glob("*.nii.gz")) + sorted(out_dir.glob("*.nii"))
    if not nii_files:
        raise RuntimeError("dcm2niix produced no NIfTI output.")
    meta["conversion"] = "dcm2niix"
    meta["dcm2niix_output"] = str(nii_files[0].name)
    return nii_files[0], meta


def eq_diameter_from_area(area_mm2: float | None) -> float | None:
    if area_mm2 is None or area_mm2 <= 0:
        return None
    return float(2.0 * np.sqrt(area_mm2 / np.pi))


def first_last_nonzero(arr: np.ndarray, min_px: int = 8) -> tuple[int | None, int | None]:
    idx = np.where(arr > min_px)[0]
    if idx.size == 0:
        return None, None
    return int(idx[0]), int(idx[-1])


def profile_area(mask: np.ndarray) -> np.ndarray:
    # mask shape: [x, y, z]
    return mask.reshape((-1, mask.shape[2])).sum(axis=0).astype(np.float64)


def measure_from_multiclass(ct_path: Path, mask_path: Path) -> dict[str, Any]:
    ct_nii = nib.load(str(ct_path))
    m_nii = nib.load(str(mask_path))
    m = m_nii.get_fdata().astype(np.uint8)
    spacing = tuple(float(v) for v in m_nii.header.get_zooms()[:3])
    dx, dy, dz = spacing
    voxel_ml = (dx * dy * dz) / 1000.0

    root = m == 1
    leaf = m == 2
    asc = m == 3

    area_root_px = profile_area(root)
    area_asc_px = profile_area(asc)

    root_start, root_end = first_last_nonzero(area_root_px)
    asc_start, asc_end = first_last_nonzero(area_asc_px)
    sinus_z = int(np.argmax(area_root_px)) if np.any(area_root_px > 0) else None
    asc_max_z = int(np.argmax(area_asc_px)) if np.any(area_asc_px > 0) else None

    annulus_z = root_start
    stj_z = root_end

    annulus_area = (area_root_px[annulus_z] * dx * dy) if annulus_z is not None else None
    sinus_area = (area_root_px[sinus_z] * dx * dy) if sinus_z is not None else None
    stj_area = (area_root_px[stj_z] * dx * dy) if stj_z is not None else None
    asc_area = (area_asc_px[asc_max_z] * dx * dy) if asc_max_z is not None else None

    annulus_d = eq_diameter_from_area(annulus_area)
    sinus_d = eq_diameter_from_area(sinus_area)
    stj_d = eq_diameter_from_area(stj_area)
    asc_d = eq_diameter_from_area(asc_area)

    annulus_perimeter = (np.pi * annulus_d) if annulus_d is not None else None
    support_len = None
    if root_start is not None and asc_end is not None:
        support_len = abs((asc_end - root_start + 1) * dz)

    # Conservative graft size heuristic (VSRR) based on annulus diameter.
    graft_size = None
    if annulus_d is not None:
        graft_size = float(max(20.0, round(annulus_d - (3.0 if annulus_d >= 30 else 2.0), 1)))

    notes: list[str] = []
    notes.append("Diameters are from segmentation-derived cross-sectional areas (axial index domain).")
    notes.append("For strict centerline-orthogonal sections, configure VMTK section workflow in production.")
    notes.append("Coronary ostial heights and commissure geometry require dedicated cusp/ostia model outputs.")

    return {
        "labels": {
            "0": "background",
            "1": "aortic_root",
            "2": "valve_leaflets",
            "3": "ascending_aorta",
        },
        "spacing_mm": {"dx": dx, "dy": dy, "dz": dz},
        "volumes_ml": {
            "aortic_root": float(root.sum() * voxel_ml),
            "valve_leaflets": float(leaf.sum() * voxel_ml),
            "ascending_aorta": float(asc.sum() * voxel_ml),
        },
        "landmark_slices": {
            "annulus_z": annulus_z,
            "sinus_peak_z": sinus_z,
            "stj_z": stj_z,
            "ascending_peak_z": asc_max_z,
        },
        "measurements": {
            "annulus_diameter_mm": annulus_d,
            "annulus_area_mm2": float(annulus_area) if annulus_area is not None else None,
            "annulus_perimeter_mm": float(annulus_perimeter) if annulus_perimeter is not None else None,
            "sinus_diameter_mm": sinus_d,
            "stj_diameter_mm": stj_d,
            "ascending_aorta_diameter_mm": asc_d,
            "support_length_mm": float(support_len) if support_len is not None else None,
            "coronary_height_left_mm": None,
            "coronary_height_right_mm": None,
            "sinus_width_mm": sinus_d,
        },
        "planning_metrics": {
            "vsrr": {
                "annulus_diameter_mm": annulus_d,
                "sinus_diameter_mm": sinus_d,
                "stj_diameter_mm": stj_d,
                "recommended_graft_size_mm": graft_size,
            },
            "pears": {
                "root_external_reference_diameter_mm": sinus_d,
                "sinus_distribution_reference_mm": sinus_d,
                "support_length_mm": float(support_len) if support_len is not None else None,
            },
            "tavi": {
                "annulus_area_mm2": float(annulus_area) if annulus_area is not None else None,
                "annulus_perimeter_mm": float(annulus_perimeter) if annulus_perimeter is not None else None,
                "coronary_height_left_mm": None,
                "coronary_height_right_mm": None,
                "sinus_width_mm": sinus_d,
                "stj_diameter_mm": stj_d,
            },
        },
        "notes": notes,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output-mask", required=True)
    ap.add_argument("--output-json", required=True)
    ap.add_argument("--device", default="gpu", choices=["cpu", "gpu", "mps"])
    ap.add_argument("--quality", default="high", choices=["high", "fast"])
    ap.add_argument("--job-id", default="")
    ap.add_argument("--study-id", default="")
    args = ap.parse_args()

    in_path = Path(args.input).resolve()
    out_mask = Path(args.output_mask).resolve()
    out_json = Path(args.output_json).resolve()
    out_mask.parent.mkdir(parents=True, exist_ok=True)
    out_json.parent.mkdir(parents=True, exist_ok=True)

    builder_py = Path(__file__).resolve().with_name("build_real_multiclass_mask.py")
    if not builder_py.exists():
        raise FileNotFoundError("build_real_multiclass_mask.py not found in gpu_provider/")

    with tempfile.TemporaryDirectory(prefix="aortic-pipeline-") as td:
        work_dir = Path(td)
        nifti_input, prep_meta = prepare_nifti_input(in_path, work_dir)

        cmd = [
            "python",
            str(builder_py),
            "--input",
            str(nifti_input),
            "--output",
            str(out_mask),
            "--device",
            args.device,
            "--quality",
            args.quality,
        ]
        run_cmd(cmd)

        measurements = measure_from_multiclass(nifti_input, out_mask)
        payload = {
            "job_id": args.job_id,
            "study_id": args.study_id,
            "pipeline": {
                "input_prep": prep_meta,
                "segmentation": "TotalSegmentator(open)+multiclass_aortic_builder",
                "measurement_method": "segmentation_geometry_v1",
                "quality": args.quality,
                "device": args.device,
            },
            **measurements,
        }
        out_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
