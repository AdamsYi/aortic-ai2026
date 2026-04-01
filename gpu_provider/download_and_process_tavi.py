#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np
import requests

TAVI_URL = "https://zenodo.org/records/15094600/files/tavi_data.zip"
WIN_BASE = Path(r"C:\AorticAI\gpu_provider")


def log(msg: str) -> None:
    print(msg, flush=True)


def resolve_base() -> Path:
    if WIN_BASE.exists():
        return WIN_BASE
    return Path(__file__).resolve().parent


def download_file(url: str, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    log(f"[download] {url}")
    with requests.get(url, stream=True, timeout=120) as resp:
        resp.raise_for_status()
        total = int(resp.headers.get("content-length") or 0)
        downloaded = 0
        next_pct = 0
        with out_path.open("wb") as f:
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                f.write(chunk)
                downloaded += len(chunk)
                if total > 0:
                    pct = int(downloaded * 100 / total)
                    if pct >= next_pct:
                        log(f"[download] {pct}% ({downloaded}/{total} bytes)")
                        next_pct = min(100, pct + 5)
                else:
                    log(f"[download] {downloaded} bytes")
    log(f"[download] saved: {out_path}")


def pick_ct_and_mask(names: list[str]) -> tuple[str, str]:
    ct_candidates: list[str] = []
    mask_candidates: list[str] = []
    for name in names:
        low = name.lower()
        if low.endswith("/") or "/__macosx/" in low:
            continue
        stem = Path(low).name
        is_nifti = stem.endswith(".nii") or stem.endswith(".nii.gz")
        if not is_nifti:
            continue
        is_mask = any(tag in stem for tag in ("seg", "mask", "label"))
        is_ct = any(tag in stem for tag in ("ct", "image", "img")) and not is_mask
        if is_ct:
            ct_candidates.append(name)
        if is_mask:
            mask_candidates.append(name)
    if not ct_candidates:
        raise RuntimeError("No CT file found in zip (expected name contains ct/image/img).")
    if not mask_candidates:
        raise RuntimeError("No mask file found in zip (expected name contains seg/mask/label).")
    return ct_candidates[0], mask_candidates[0]


def extract_case(zip_path: Path, case_dir: Path) -> tuple[Path, Path]:
    case_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = zf.namelist()
        log(f"[zip] total entries: {len(names)}")
        ct_name, mask_name = pick_ct_and_mask(names)
        log(f"[zip] CT selected: {ct_name}")
        log(f"[zip] MASK selected: {mask_name}")
        zf.extract(ct_name, case_dir)
        zf.extract(mask_name, case_dir)
    ct_path = case_dir / ct_name
    mask_path = case_dir / mask_name
    if not ct_path.exists() or not mask_path.exists():
        raise RuntimeError("Failed to extract CT/mask from zip.")
    return ct_path, mask_path


def remap_mask(mask_path: Path, out_path: Path) -> None:
    nii = nib.load(str(mask_path))
    data = np.asarray(nii.get_fdata())
    labels, counts = np.unique(data, return_counts=True)
    log("[mask] unique labels and voxel counts:")
    for label, count in zip(labels.tolist(), counts.tolist()):
        log(f"  label={label} voxels={count}")

    out = np.zeros(data.shape, dtype=np.uint8)
    non_bg = [(float(l), int(c)) for l, c in zip(labels.tolist(), counts.tolist()) if float(l) != 0.0]
    if not non_bg:
        raise RuntimeError("Mask has no foreground labels.")

    if len(non_bg) == 1:
        out[data != 0] = 1
        log("[mask] binary mask detected; mapped all non-zero voxels to label 1 (aortic_root)")
    else:
        dominant_label = max(non_bg, key=lambda x: x[1])[0]
        log(f"[mask] multi-class detected; dominant non-background label={dominant_label}.")
        out[data == dominant_label] = 1
        out[(data != 0) & (data != dominant_label)] = 1
        log("[mask] conservative strategy applied: all non-zero labels collapsed to 1 (aortic_root)")

    remapped = nib.Nifti1Image(out, nii.affine, nii.header)
    nib.save(remapped, str(out_path))
    log(f"[mask] remapped mask saved: {out_path}")


def run_cmd(cmd: list[str], cwd: Path) -> None:
    log(f"[run] {' '.join(cmd)}")
    proc = subprocess.Popen(cmd, cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    assert proc.stdout is not None
    for line in proc.stdout:
        print(line.rstrip(), flush=True)
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f"Command failed with exit code {code}: {' '.join(cmd)}")


def read_measurements(result_json_path: Path) -> dict[str, Any]:
    payload = json.loads(result_json_path.read_text(encoding="utf-8"))
    m = payload.get("measurements")
    if isinstance(m, dict):
        return m
    m2 = payload.get("measurements_structured")
    if isinstance(m2, dict):
        return m2
    raise RuntimeError("result_real.json missing measurements payload.")


def get_annulus_diameter_mm(measurements: dict[str, Any]) -> float | None:
    ann = measurements.get("annulus")
    if isinstance(ann, dict):
        val = ann.get("equivalent_diameter_mm")
        if isinstance(val, (int, float)):
            return float(val)
    flat = measurements.get("annulus_equivalent_diameter_mm")
    if isinstance(flat, (int, float)):
        return float(flat)
    return None


def print_key_measurements(measurements: dict[str, Any]) -> None:
    ann = measurements.get("annulus", {}) if isinstance(measurements.get("annulus"), dict) else {}
    sin = measurements.get("sinus_of_valsalva", {}) if isinstance(measurements.get("sinus_of_valsalva"), dict) else {}
    stj = measurements.get("stj", {}) if isinstance(measurements.get("stj"), dict) else {}
    cor = measurements.get("coronary_heights_mm", {}) if isinstance(measurements.get("coronary_heights_mm"), dict) else {}

    annulus_diameter = ann.get("equivalent_diameter_mm", measurements.get("annulus_equivalent_diameter_mm", "N/A"))
    sinus_diameter = sin.get("max_diameter_mm", measurements.get("sinus_of_valsalva_diameter_mm", "N/A"))
    stj_diameter = stj.get("diameter_mm", measurements.get("stj_diameter_mm", "N/A"))
    lca = cor.get("left", measurements.get("coronary_height_left_mm", "N/A"))
    rca = cor.get("right", measurements.get("coronary_height_right_mm", "N/A"))

    log("[measurements] key values:")
    log(f"  annulus_diameter: {annulus_diameter}")
    log(f"  sinus_diameter: {sinus_diameter}")
    log(f"  stj_diameter: {stj_diameter}")
    log(f"  coronary_heights: LCA={lca}, RCA={rca}")


def save_and_commit(base_dir: Path, result_json: Path) -> None:
    case_dir = (base_dir.parent / "cases" / "default_clinical_case").resolve()
    run_cmd(
        [
            sys.executable,
            "save_as_default_case.py",
            "--input",
            str(result_json),
            "--case-dir",
            str(case_dir),
        ],
        cwd=base_dir,
    )
    run_cmd(["git", "add", "-A"], cwd=base_dir.parent)
    run_cmd(["git", "commit", "-m", "feat: update default case from real TAVI dataset pipeline output"], cwd=base_dir.parent)
    run_cmd(["git", "push"], cwd=base_dir.parent)


def main() -> int:
    base_dir = resolve_base()
    demo_dir = base_dir / "demo_data"
    zip_path = demo_dir / "tavi_data.zip"
    case_dir = demo_dir / "case01"
    output_dir = base_dir / "demo_pipeline_output"
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        log("[step 1/7] Downloading real TAVI dataset...")
        download_file(TAVI_URL, zip_path)

        log("[step 2/7] Extracting first CT + mask pair...")
        ct_path, mask_path = extract_case(zip_path, case_dir)
        log(f"[case01] CT: {ct_path}")
        log(f"[case01] MASK: {mask_path}")

        log("[step 3/7] Inspecting mask labels...")
        remapped_mask = case_dir / "mask_remapped.nii.gz"
        remap_mask(mask_path, remapped_mask)

        log("[step 4/7] Running pipeline_runner.py (skip segmentation)...")
        result_json = output_dir / "result_real.json"
        run_cmd(
            [
                sys.executable,
                "pipeline_runner.py",
                "--input",
                str(ct_path),
                "--input-mask",
                str(remapped_mask),
                "--skip-segmentation",
                "--output-mask",
                str(output_dir / "mask_real.nii.gz"),
                "--output-json",
                str(result_json),
                "--device",
                "cpu",
                "--quality",
                "fast",
                "--job-id",
                "zenodo_tavi_01",
                "--study-id",
                "real_01",
            ],
            cwd=base_dir,
        )

        log("[step 5/7] Reading result_real.json...")
        measurements = read_measurements(result_json)
        print_key_measurements(measurements)

        log("[step 6/7] Validating annulus range (15-35 mm)...")
        annulus = get_annulus_diameter_mm(measurements)
        if annulus is None:
            log("[warn] annulus diameter missing; stop auto-save.")
            log(json.dumps(measurements, ensure_ascii=False, indent=2))
            return 2
        if not (15.0 <= annulus <= 35.0):
            log(f"[warn] annulus diameter out of range: {annulus:.2f} mm")
            log("[warn] Not saving as default case. Full measurements below:")
            log(json.dumps(measurements, ensure_ascii=False, indent=2))
            return 3

        log("[step 7/7] Saving as default case and pushing...")
        save_and_commit(base_dir, result_json)
        log("[done] Real TAVI pipeline output saved to default case and pushed.")
        return 0
    except Exception as exc:
        log(f"[error] {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
