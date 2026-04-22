#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np

from gpu_provider.fetch_imagecas import (
    enumerate_cases,
    extract_study_meta,
    evaluate_gate,
    log,
    parse_case_ids,
    process_selected_case,
    resolve_base,
    resolve_repo_root,
    select_cases,
)
from gpu_provider.geometry.lumen_mesh import _finalize_surface_mesh, generate_surface_mesh
from gpu_provider.geometry.mesh_qa import MESH_KIND_MAP, audit_mesh


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case-ids", required=True, help="comma-separated ImageCAS ids")
    parser.add_argument(
        "--extracted-dir",
        default="",
        help="override extracted ImageCAS split root (default: demo_data/imagecas_1-200_extracted)",
    )
    return parser.parse_args()


def load_multiclass(mask_path: Path) -> tuple[np.ndarray, np.ndarray]:
    nii = nib.load(str(mask_path))
    data = np.asarray(nii.get_fdata(), dtype=np.int16)
    return data, np.asarray(nii.affine, dtype=np.float64)


def count_edges(faces: np.ndarray) -> tuple[int, int]:
    counts: Counter[tuple[int, int]] = Counter()
    for tri in np.asarray(faces, dtype=np.int32):
        a, b, c = map(int, tri)
        for u, v in ((a, b), (b, c), (c, a)):
            edge = (u, v) if u < v else (v, u)
            counts[edge] += 1
    non_manifold_edges = int(sum(1 for value in counts.values() if value > 2))
    boundary_edges = int(sum(1 for value in counts.values() if value == 1))
    return non_manifold_edges, boundary_edges


def summarize_case_meshes(case_id: int, base_dir: Path, repo_root: Path) -> list[dict[str, Any]]:
    output_dir = base_dir / "imagecas_output" / f"imagecas_{case_id:04d}"
    mask_path = output_dir / "segmentation_mask.nii.gz"
    if not mask_path.exists():
        return []
    multiclass, affine = load_multiclass(mask_path)
    case_slug = f"imagecas_{case_id:04d}"
    case_dir = repo_root / "cases" / case_slug
    rows: list[dict[str, Any]] = []
    for mesh_name, label_value, stl_name, raw_params in (
        ("aortic_root", 1, "aortic_root.stl", {"laplacian_lambda": 0.16, "taubin_lambda": 0.18, "taubin_mu": -0.2}),
        ("ascending_aorta", 3, "ascending_aorta.stl", {"laplacian_lambda": 0.14, "taubin_lambda": 0.16, "taubin_mu": -0.18}),
    ):
        mask = multiclass == label_value
        if not np.any(mask):
            continue
        raw = generate_surface_mesh(
            mask,
            affine,
            laplacian_iterations=1,
            taubin_iterations=1,
            **raw_params,
        )
        raw_nme, raw_boundary = count_edges(raw.faces)
        cleaned = _finalize_surface_mesh(raw)
        clean_nme, clean_boundary = count_edges(cleaned.faces)
        stl_path = case_dir / "meshes" / stl_name
        qa_entry = audit_mesh(stl_path, mesh_name).to_manifest_dict() if stl_path.exists() else None
        rows.append(
            {
                "case_id": case_id,
                "mesh_name": mesh_name,
                "mesh_kind": MESH_KIND_MAP.get(mesh_name, "solid"),
                "tri_count": int(cleaned.faces.shape[0]),
                "non_manifold_edges_raw": raw_nme,
                "non_manifold_edges_clean": clean_nme,
                "boundary_edges": clean_boundary,
                "passes_gate": None if qa_entry is None else qa_entry.get("passes_gate"),
                "qa_failure_reasons": [] if qa_entry is None else qa_entry.get("failure_reasons", []),
                "boundary_edges_raw": raw_boundary,
                "tri_count_raw": int(raw.faces.shape[0]),
            }
        )
    return rows


def main() -> int:
    args = parse_args()
    base_dir = resolve_base()
    repo_root = resolve_repo_root(base_dir)
    extracted_dir = Path(args.extracted_dir) if args.extracted_dir else base_dir / "demo_data" / "imagecas_1-200_extracted"
    if not extracted_dir.exists():
        raise SystemExit(f"extracted_dir_missing | {extracted_dir}")

    all_cases = enumerate_cases(extracted_dir)
    selected_cases = select_cases(all_cases, parse_case_ids(args.case_ids), None, len(all_cases))
    summary_rows: list[dict[str, Any]] = []

    for case_id, img_path, label_path in selected_cases:
        meta = extract_study_meta(img_path, mask_path=label_path, label_semantics="coronary_tree")
        gate = evaluate_gate(meta)
        row_prefix = {
            "case_id": case_id,
            "data_quality_passed": bool(gate.passes_sizing_gate),
            "allowed_procedures": list(gate.allowed_procedures),
            "failure_reasons": list(gate.failure_reasons),
            "advisories": list(gate.advisories),
            "slice_thickness_mm": meta.slice_thickness_mm,
            "blood_pool_hu_mean": meta.blood_pool_hu_mean,
            "fov_z_mm": None if meta.fov_mm is None or len(meta.fov_mm) < 3 else float(meta.fov_mm[2]),
        }
        log(
            f"[scan] case_id={case_id} gate={gate.passes_sizing_gate} "
            f"allowed={gate.allowed_procedures} reasons={gate.failure_reasons}"
        )
        _meta_dict, gate_dict, _manifest = process_selected_case(
            base_dir=base_dir,
            repo_root=repo_root,
            case_id=case_id,
            img_path=img_path,
            label_path=label_path,
            dry_run=False,
        )
        if not gate_dict.get("passes_sizing_gate"):
            summary_rows.append(
                {
                    **row_prefix,
                    "mesh_name": None,
                    "mesh_kind": None,
                    "tri_count": None,
                    "non_manifold_edges_raw": None,
                    "non_manifold_edges_clean": None,
                    "boundary_edges": None,
                    "passes_gate": None,
                }
            )
            continue
        for mesh_row in summarize_case_meshes(case_id, base_dir, repo_root):
            summary_rows.append({**row_prefix, **mesh_row})

    print("--- imagecas_mesh_scan_summary_json ---")
    print(json.dumps(summary_rows, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
