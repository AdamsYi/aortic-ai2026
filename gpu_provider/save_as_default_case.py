#!/usr/bin/env python3
"""
save_as_default_case.py

Takes real pipeline output (result.json) and updates the default clinical case
artifacts to reflect real CT pipeline measurements.

Usage:
  python save_as_default_case.py --input demo_pipeline_output/result.json \
      --case-dir ../cases/default_clinical_case
"""
from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Save real pipeline output as default showcase case.")
    parser.add_argument("--input", required=True, help="Path to pipeline result.json")
    parser.add_argument("--case-dir", required=True, help="Path to default_clinical_case directory")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be done without writing")
    return parser.parse_args()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data: dict, dry_run: bool = False) -> None:
    if dry_run:
        print(f"  [dry-run] would write {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  [wrote] {path}")


def update_case_manifest(manifest: dict, result: dict) -> dict:
    """Update case_manifest.json to reflect real pipeline run."""
    m = dict(manifest)
    m["data_source"] = "real_ct_pipeline_output"
    m["case_type"] = "real_pipeline_case"
    m["clinical_use"] = "showcase_real_measurements"
    m["not_real_cta"] = False
    m["placeholder"] = False
    m["last_modified"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    m["pipeline_version"] = str(result.get("pipeline_version", "unknown"))
    m["note"] = "此病例为真实CT管线输出，测量值来自自动化解剖模型。"

    risk_flags = result.get("risk_flags", [])
    clinician_review = any(
        f.get("severity") in {"critical", "high"}
        for f in risk_flags
        if isinstance(f, dict)
    )
    if "uncertainty_summary" not in m:
        m["uncertainty_summary"] = {}
    m["uncertainty_summary"]["clinician_review_required"] = clinician_review
    m["uncertainty_summary"]["pipeline_risk_flags"] = len(risk_flags)

    m.pop("note_demo_only", None)
    return m


def main() -> int:
    args = parse_args()
    result_path = Path(args.input)
    case_dir = Path(args.case_dir)

    if not result_path.exists():
        print(f"ERROR: result.json not found: {result_path}")
        return 1
    if not case_dir.exists():
        print(f"ERROR: case directory not found: {case_dir}")
        return 1

    result = load_json(result_path)
    artifacts_dir = case_dir / "artifacts"
    dry = args.dry_run

    if dry:
        print("[dry-run mode] No files will be written.")

    updated = 0

    meas = result.get("measurements") or result.get("measurements_structured")
    if isinstance(meas, dict):
        save_json(artifacts_dir / "measurements.json", meas, dry)
        updated += 1
        print(f"  measurements: {len(meas)} fields")
    else:
        print("  [skip] No measurements in result.json")

    plan = result.get("planning") or result.get("planning_metrics")
    if isinstance(plan, dict):
        save_json(artifacts_dir / "planning.json", plan, dry)
        updated += 1
    else:
        print("  [skip] No planning in result.json")

    cline = result.get("centerline")
    if isinstance(cline, dict):
        save_json(artifacts_dir / "centerline.json", cline, dry)
        updated += 1
    else:
        print("  [skip] No centerline in result.json")

    annulus = result.get("annulus_plane")
    if isinstance(annulus, dict):
        save_json(artifacts_dir / "annulus_plane.json", annulus, dry)
        updated += 1
    else:
        print("  [skip] No annulus_plane in result.json")

    root_model = result.get("aortic_root_model")
    if isinstance(root_model, dict):
        save_json(artifacts_dir / "aortic_root_model.json", root_model, dry)
        updated += 1
    else:
        print("  [skip] No aortic_root_model in result.json")

    leaflets = result.get("leaflet_model")
    if isinstance(leaflets, dict):
        save_json(artifacts_dir / "leaflet_model.json", leaflets, dry)
        updated += 1
    else:
        print("  [skip] No leaflet_model in result.json")

    manifest_path = artifacts_dir / "case_manifest.json"
    if manifest_path.exists():
        manifest = load_json(manifest_path)
        updated_manifest = update_case_manifest(manifest, result)
        save_json(manifest_path, updated_manifest, dry)
        updated += 1
    else:
        print(f"  [warn] case_manifest.json not found at {manifest_path}")

    output_dir = result_path.parent
    mesh_dir = case_dir / "meshes"
    stl_map = {
        "aortic_root.stl": "aortic_root.stl",
        "ascending_aorta.stl": "ascending_aorta.stl",
        "leaflets.stl": "leaflets.stl",
    }
    for src_name, dst_name in stl_map.items():
        src = output_dir / src_name
        if src.exists():
            dst = mesh_dir / dst_name
            if not dry:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                print(f"  [copied] {src_name} → meshes/{dst_name}")
            else:
                print(f"  [dry-run] would copy {src_name} → meshes/{dst_name}")
            updated += 1

    print(f"\n[done] Updated {updated} artifacts in {case_dir}")
    if updated == 0:
        print("WARNING: No artifacts were updated. Check result.json structure.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
