#!/usr/bin/env python3
"""
Process an already-downloaded tavi_data.zip — skips download step.
Uses the zip at demo_data/tavi_data.zip and runs the full pipeline.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Re-use all helpers from download_and_process_tavi
from download_and_process_tavi import (
    extract_case,
    get_annulus_diameter_mm,
    log,
    print_key_measurements,
    read_measurements,
    remap_mask,
    resolve_base,
    run_cmd,
    save_and_commit,
)

WIN_BASE = Path(r"C:\AorticAI\gpu_provider")


def main() -> int:
    base_dir = resolve_base()
    demo_dir = base_dir / "demo_data"
    zip_path = demo_dir / "tavi_data.zip"
    case_dir = demo_dir / "case01"
    output_dir = base_dir / "demo_pipeline_output"
    output_dir.mkdir(parents=True, exist_ok=True)

    if not zip_path.exists():
        log(f"[error] ZIP not found: {zip_path}")
        return 1

    zip_mb = zip_path.stat().st_size / 1024 / 1024
    log(f"[step 0] Using existing ZIP: {zip_path} ({zip_mb:.0f} MB)")

    if zip_mb < 100:
        log("[error] ZIP too small — likely incomplete download. Aborting.")
        return 1

    try:
        log("[step 1/6] Extracting first CT + mask pair...")
        ct_path, mask_path = extract_case(zip_path, case_dir)
        log(f"[case01] CT:   {ct_path}")
        log(f"[case01] MASK: {mask_path}")

        log("[step 2/6] Remapping mask labels...")
        remapped_mask = case_dir / "mask_remapped.nii.gz"
        remap_mask(mask_path, remapped_mask)

        log("[step 3/6] Running pipeline_runner.py (skip segmentation)...")
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

        log("[step 4/6] Reading result_real.json...")
        measurements = read_measurements(result_json)
        print_key_measurements(measurements)

        log("[step 5/6] Validating annulus range (15–35 mm)...")
        annulus = get_annulus_diameter_mm(measurements)
        if annulus is None:
            log("[warn] annulus diameter missing; stop auto-save.")
            log(json.dumps(measurements, ensure_ascii=False, indent=2))
            return 2
        if not (15.0 <= annulus <= 35.0):
            log(f"[warn] annulus diameter out of range: {annulus:.2f} mm")
            log("[warn] Not saving as default case. Full measurements:")
            log(json.dumps(measurements, ensure_ascii=False, indent=2))
            return 3

        log("[step 6/6] Saving as default case and pushing...")
        save_and_commit(base_dir, result_json)
        log("[done] Real TAVI pipeline output saved to default case and pushed.")
        return 0

    except Exception as exc:
        log(f"[error] {exc}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
