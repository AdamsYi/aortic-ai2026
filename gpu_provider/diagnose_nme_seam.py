#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np
from scipy.spatial import cKDTree
import trimesh

from gpu_provider.fetch_imagecas import resolve_base, resolve_repo_root


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case-id", required=True, type=int)
    return parser.parse_args()


def load_multiclass(mask_path: Path) -> tuple[np.ndarray, np.ndarray]:
    nii = nib.load(str(mask_path))
    data = np.asarray(nii.get_fdata(), dtype=np.int16)
    return data, np.asarray(nii.affine, dtype=np.float64)


def voxel_world_points(mask: np.ndarray, affine: np.ndarray, label_value: int) -> np.ndarray:
    coords = np.argwhere(mask == label_value)
    if coords.size == 0:
        return np.zeros((0, 3), dtype=np.float64)
    return nib.affines.apply_affine(affine, coords.astype(np.float64))


def count_edges(faces: np.ndarray) -> tuple[int, int]:
    counts: Counter[tuple[int, int]] = Counter()
    for tri in np.asarray(faces, dtype=np.int64):
        a, b, c = map(int, tri)
        for u, v in ((a, b), (b, c), (c, a)):
            edge = (u, v) if u < v else (v, u)
            counts[edge] += 1
    non_manifold_edges = int(sum(1 for value in counts.values() if value > 2))
    boundary_edges = int(sum(1 for value in counts.values() if value == 1))
    return non_manifold_edges, boundary_edges


def non_manifold_edge_midpoints(mesh: trimesh.Trimesh) -> np.ndarray:
    counts: Counter[tuple[int, int]] = Counter()
    for tri in np.asarray(mesh.faces, dtype=np.int64):
        a, b, c = map(int, tri)
        for u, v in ((a, b), (b, c), (c, a)):
            edge = (u, v) if u < v else (v, u)
            counts[edge] += 1
    midpoints: list[np.ndarray] = []
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    for (u, v), count in counts.items():
        if count > 2:
            midpoints.append((vertices[u] + vertices[v]) * 0.5)
    if not midpoints:
        return np.zeros((0, 3), dtype=np.float64)
    return np.asarray(midpoints, dtype=np.float64)


def standard_cleanup(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    if trimesh is None:
        raise RuntimeError("standard_cleanup_requires_trimesh")
    cleaned = trimesh.Trimesh(
        vertices=np.asarray(mesh.vertices, dtype=np.float64).copy(),
        faces=np.asarray(mesh.faces, dtype=np.int64).copy(),
        process=False,
    )
    cleaned.process(validate=True)
    cleaned.update_faces(cleaned.unique_faces())
    cleaned.update_faces(cleaned.nondegenerate_faces())
    cleaned.remove_unreferenced_vertices()
    if cleaned.face_normals is None or len(cleaned.face_normals) != len(cleaned.faces):
        cleaned.fix_normals()
    return cleaned


def distance_stats(points: np.ndarray, target_points: np.ndarray) -> dict[str, Any]:
    if points.size == 0:
        return {
            "min_mm": None,
            "median_mm": None,
            "p95_mm": None,
            "within_2mm_count": 0,
            "within_2mm_ratio": None,
            "within_5mm_count": 0,
            "within_5mm_ratio": None,
        }
    if target_points.size == 0:
        return {
            "min_mm": None,
            "median_mm": None,
            "p95_mm": None,
            "within_2mm_count": 0,
            "within_2mm_ratio": 0.0,
            "within_5mm_count": 0,
            "within_5mm_ratio": 0.0,
        }
    tree = cKDTree(target_points)
    distances, _ = tree.query(points, k=1, workers=-1)
    distances = np.asarray(distances, dtype=np.float64)
    within_2 = int(np.sum(distances <= 2.0))
    within_5 = int(np.sum(distances <= 5.0))
    total = int(distances.shape[0])
    return {
        "min_mm": float(np.min(distances)),
        "median_mm": float(np.median(distances)),
        "p95_mm": float(np.quantile(distances, 0.95)),
        "within_2mm_count": within_2,
        "within_2mm_ratio": float(within_2 / total),
        "within_5mm_count": within_5,
        "within_5mm_ratio": float(within_5 / total),
    }


def resolve_case_paths(base_dir: Path, repo_root: Path, case_id: int) -> tuple[Path, Path]:
    case_slug = f"imagecas_{case_id:04d}"
    output_dir = base_dir / "imagecas_output" / case_slug
    mask_path = output_dir / "segmentation_mask.nii.gz"
    if not mask_path.exists():
        raise SystemExit(f"segmentation_mask_missing | {mask_path}")
    root_stl_candidates = [
        output_dir / "aortic_root.stl",
        repo_root / "cases" / case_slug / "meshes" / "aortic_root.stl",
    ]
    root_stl_path = next((path for path in root_stl_candidates if path.exists()), None)
    if root_stl_path is None:
        raise SystemExit(f"aortic_root_stl_missing | candidates={root_stl_candidates}")
    return mask_path, root_stl_path


def summarize_case(case_id: int) -> dict[str, Any]:
    base_dir = resolve_base()
    repo_root = resolve_repo_root(base_dir)
    mask_path, root_stl_path = resolve_case_paths(base_dir, repo_root, case_id)
    multiclass, affine = load_multiclass(mask_path)
    leaflet_points = voxel_world_points(multiclass, affine, 2)
    ascending_points = voxel_world_points(multiclass, affine, 3)

    raw_mesh = trimesh.load(root_stl_path, force="mesh", process=False)
    raw_midpoints = non_manifold_edge_midpoints(raw_mesh)
    raw_nme, raw_boundary = count_edges(np.asarray(raw_mesh.faces, dtype=np.int64))
    raw_tri = int(np.asarray(raw_mesh.faces).shape[0])

    cleaned_mesh = standard_cleanup(raw_mesh)
    clean_nme, clean_boundary = count_edges(np.asarray(cleaned_mesh.faces, dtype=np.int64))
    clean_tri = int(np.asarray(cleaned_mesh.faces).shape[0])

    leaflet_stats = distance_stats(raw_midpoints, leaflet_points)
    ascending_stats = distance_stats(raw_midpoints, ascending_points)

    return {
        "case_id": case_id,
        "mask_path": str(mask_path),
        "root_stl_path": str(root_stl_path),
        "leaflet_voxel_count": int(leaflet_points.shape[0]),
        "ascending_voxel_count": int(ascending_points.shape[0]),
        "nme_midpoint_count": int(raw_midpoints.shape[0]),
        "leaflet_distance_mm": leaflet_stats,
        "ascending_distance_mm": ascending_stats,
        "root_mesh_counts": {
            "raw_nme": raw_nme,
            "clean_nme": clean_nme,
            "raw_boundary_edges": raw_boundary,
            "clean_boundary_edges": clean_boundary,
            "raw_tri": raw_tri,
            "clean_tri": clean_tri,
        },
    }


def main() -> int:
    args = parse_args()
    summary = summarize_case(args.case_id)
    print("--- diagnose_nme_seam_summary_json ---")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
