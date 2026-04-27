from __future__ import annotations

import json
import math
import shutil
from pathlib import Path
from typing import Any

import numpy as np

from .common import sanitize_for_json
from .lumen_mesh import SurfaceMesh, compute_face_normals, write_ascii_stl

try:
    import trimesh  # type: ignore
except Exception:  # pragma: no cover
    trimesh = None  # type: ignore


PEARS_VISUAL_MODULE_VERSION = "pears_visual_planner_v1"
PEARS_MAX_SLICE_THICKNESS_MM = 0.75


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    parsed = json.loads(path.read_text(encoding="utf-8"))
    return parsed if isinstance(parsed, dict) else {}


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(sanitize_for_json(payload), indent=2, ensure_ascii=False), encoding="utf-8")


def _finite_number(value: Any) -> float | None:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    return num if math.isfinite(num) else None


def _vec3(value: Any) -> np.ndarray | None:
    if isinstance(value, dict):
        value = [value.get("x"), value.get("y"), value.get("z")]
    if not isinstance(value, list | tuple) or len(value) < 3:
        return None
    coords = [_finite_number(entry) for entry in value[:3]]
    if any(entry is None for entry in coords):
        return None
    return np.asarray(coords, dtype=np.float64)


def _unit(value: np.ndarray, fallback: np.ndarray | None = None) -> np.ndarray:
    norm = float(np.linalg.norm(value))
    if norm > 1e-8:
        return value / norm
    if fallback is not None:
        return _unit(fallback)
    return np.asarray([1.0, 0.0, 0.0], dtype=np.float64)


def _basis_from_tangent(tangent: np.ndarray, previous_u: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    t = _unit(tangent, np.asarray([0.0, 0.0, 1.0], dtype=np.float64))
    if previous_u is not None:
        u = previous_u - np.dot(previous_u, t) * t
        if np.linalg.norm(u) > 1e-6:
            u = _unit(u)
            return u, _unit(np.cross(t, u), np.asarray([0.0, 1.0, 0.0], dtype=np.float64))
    helper = np.asarray([0.0, 0.0, 1.0], dtype=np.float64)
    if abs(float(np.dot(helper, t))) > 0.92:
        helper = np.asarray([0.0, 1.0, 0.0], dtype=np.float64)
    u = _unit(np.cross(helper, t), np.asarray([1.0, 0.0, 0.0], dtype=np.float64))
    v = _unit(np.cross(t, u), np.asarray([0.0, 1.0, 0.0], dtype=np.float64))
    return u, v


def _section_points_from_record(record: dict[str, Any]) -> np.ndarray:
    raw_points = record.get("contour_world") or record.get("ring_points_world") or []
    points: list[np.ndarray] = []
    if isinstance(raw_points, list):
        for item in raw_points:
            point = _vec3(item)
            if point is not None:
                points.append(point)
    return np.asarray(points, dtype=np.float64) if points else np.zeros((0, 3), dtype=np.float64)


def _diameter_from_record(record: dict[str, Any]) -> float | None:
    for key in ("equivalent_diameter_mm", "max_diameter_mm", "diameter_mm"):
        value = _finite_number(record.get(key))
        if value is not None and value > 0:
            return value
    points = _section_points_from_record(record)
    if points.shape[0] > 2:
        center = points.mean(axis=0)
        return float(np.mean(np.linalg.norm(points - center[None, :], axis=1)) * 2.0)
    return None


def _centerline_points(centerline: dict[str, Any]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    raw_points = centerline.get("points")
    points: list[np.ndarray] = []
    s_vals: list[float] = []
    radii: list[float] = []
    if isinstance(raw_points, list):
        for index, item in enumerate(raw_points):
            if not isinstance(item, dict):
                continue
            point = _vec3(item.get("world"))
            s_mm = _finite_number(item.get("s_mm"))
            radius = _finite_number(item.get("radius_mm"))
            if point is None:
                continue
            points.append(point)
            s_vals.append(float(s_mm) if s_mm is not None else float(index))
            radii.append(float(radius) if radius is not None and radius > 0 else 12.0)
    else:
        raw_world = centerline.get("points_world")
        raw_s = centerline.get("s_mm")
        raw_radii = centerline.get("radii_mm")
        if isinstance(raw_world, list):
            for index, item in enumerate(raw_world):
                point = _vec3(item)
                if point is None:
                    continue
                points.append(point)
                s_vals.append(float(raw_s[index]) if isinstance(raw_s, list) and index < len(raw_s) and _finite_number(raw_s[index]) is not None else float(index))
                radii.append(float(raw_radii[index]) if isinstance(raw_radii, list) and index < len(raw_radii) and _finite_number(raw_radii[index]) is not None else 12.0)
    return (
        np.asarray(points, dtype=np.float64),
        np.asarray(s_vals, dtype=np.float64),
        np.asarray(radii, dtype=np.float64),
    )


def _resample_closed(points: np.ndarray, count: int) -> np.ndarray:
    if points.shape[0] == 0:
        return points
    if points.shape[0] == count:
        return points
    closed = np.vstack([points, points[0]])
    seg = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    dist = np.concatenate([[0.0], np.cumsum(seg)])
    if dist[-1] <= 1e-6:
        return np.repeat(points[:1], count, axis=0)
    targets = np.linspace(0.0, dist[-1], count + 1)[:-1]
    out = []
    for target in targets:
        idx = int(np.searchsorted(dist, target, side="right") - 1)
        idx = min(max(idx, 0), len(seg) - 1)
        local = 0.0 if seg[idx] <= 1e-8 else (target - dist[idx]) / seg[idx]
        out.append(closed[idx] * (1.0 - local) + closed[idx + 1] * local)
    return np.asarray(out, dtype=np.float64)


def build_annulus_ring_mesh(annulus: dict[str, Any], out_path: Path, *, tube_radius_mm: float = 0.75, ring_samples: int = 128, tube_samples: int = 24) -> dict[str, Any]:
    base = _section_points_from_record(annulus)
    if base.shape[0] < 8:
        raise RuntimeError("annulus_contour_insufficient_for_stl")
    base = _resample_closed(base, ring_samples)
    center = base.mean(axis=0)
    vertices: list[np.ndarray] = []
    faces: list[tuple[int, int, int]] = []
    for i in range(ring_samples):
        tangent = base[(i + 1) % ring_samples] - base[(i - 1) % ring_samples]
        radial = base[i] - center
        radial = radial - np.dot(radial, _unit(tangent)) * _unit(tangent)
        radial = _unit(radial, np.asarray([1.0, 0.0, 0.0], dtype=np.float64))
        binormal = _unit(np.cross(_unit(tangent), radial), np.asarray([0.0, 0.0, 1.0], dtype=np.float64))
        for j in range(tube_samples):
            theta = (2.0 * math.pi * j) / tube_samples
            vertices.append(base[i] + math.cos(theta) * tube_radius_mm * radial + math.sin(theta) * tube_radius_mm * binormal)
    for i in range(ring_samples):
        ni = (i + 1) % ring_samples
        for j in range(tube_samples):
            nj = (j + 1) % tube_samples
            a = i * tube_samples + j
            b = ni * tube_samples + j
            c = ni * tube_samples + nj
            d = i * tube_samples + nj
            faces.append((a, b, c))
            faces.append((a, c, d))
    verts_arr = np.asarray(vertices, dtype=np.float64)
    faces_arr = np.asarray(faces, dtype=np.int32)
    mesh = SurfaceMesh(verts_arr, faces_arr, compute_face_normals(verts_arr, faces_arr))
    write_ascii_stl(mesh, out_path, "annulus_ring")
    return _mesh_quality(out_path, "solid")


def build_sleeve_preview_mesh(
    centerline: dict[str, Any],
    annulus: dict[str, Any],
    stj: dict[str, Any],
    ascending: dict[str, Any],
    out_path: Path,
    *,
    circumference_samples: int = 64,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    points, s_vals, radii = _centerline_points(centerline)
    if points.shape[0] < 4:
        raise RuntimeError("centerline_insufficient_for_pears_sleeve")
    annulus_s = _finite_number(annulus.get("s_mm"))
    if annulus_s is None:
        annulus_s = float(s_vals[0])
    stj_s = _finite_number(stj.get("s_mm"))
    ascending_s = _finite_number(ascending.get("s_mm"))
    start_index = int(np.argmin(np.abs(s_vals - annulus_s)))
    distal_target = ascending_s if ascending_s is not None else float(s_vals[-1])
    end_index = int(np.argmin(np.abs(s_vals - distal_target)))
    if end_index <= start_index + 3:
        end_index = len(points) - 1
    section_points = points[start_index : end_index + 1]
    section_s = s_vals[start_index : end_index + 1]
    section_radii = np.clip(radii[start_index : end_index + 1] * 0.95, 3.0, 55.0)
    if section_points.shape[0] < 4:
        raise RuntimeError("pears_sleeve_section_too_short")

    vertices: list[np.ndarray] = []
    faces: list[tuple[int, int, int]] = []
    previous_u: np.ndarray | None = None
    for i, point in enumerate(section_points):
        if i == 0:
            tangent = section_points[1] - point
        elif i == section_points.shape[0] - 1:
            tangent = point - section_points[i - 1]
        else:
            tangent = section_points[i + 1] - section_points[i - 1]
        u, v = _basis_from_tangent(tangent, previous_u)
        previous_u = u
        for j in range(circumference_samples):
            theta = (2.0 * math.pi * j) / circumference_samples
            vertices.append(point + math.cos(theta) * section_radii[i] * u + math.sin(theta) * section_radii[i] * v)
    rows = section_points.shape[0]
    for i in range(rows - 1):
        for j in range(circumference_samples):
            nj = (j + 1) % circumference_samples
            a = i * circumference_samples + j
            b = (i + 1) * circumference_samples + j
            c = (i + 1) * circumference_samples + nj
            d = i * circumference_samples + nj
            faces.append((a, b, c))
            faces.append((a, c, d))
    verts_arr = np.asarray(vertices, dtype=np.float64)
    faces_arr = np.asarray(faces, dtype=np.int32)
    mesh = SurfaceMesh(verts_arr, faces_arr, compute_face_normals(verts_arr, faces_arr))
    write_ascii_stl(mesh, out_path, "pears_support_sleeve_preview")
    stations = _diameter_stations(annulus, stj, ascending, section_s, section_radii)
    return _mesh_quality(out_path, "tube_segment"), stations


def _mesh_quality(path: Path, mesh_kind: str) -> dict[str, Any]:
    if trimesh is None:
        return {
            "tri_count": 0,
            "non_manifold_edges": None,
            "watertight": None,
            "mesh_kind": mesh_kind,
            "failure_reasons": ["trimesh_unavailable"],
        }
    mesh = trimesh.load(str(path), force="mesh")
    try:
        edge_counts = np.bincount(mesh.face_adjacency_edges, minlength=len(mesh.edges_unique))
        non_manifold_edges = int(np.sum(edge_counts >= 2))
    except Exception:
        non_manifold_edges = None
    return {
        "tri_count": int(len(mesh.faces)),
        "non_manifold_edges": non_manifold_edges,
        "watertight": bool(mesh.is_watertight),
        "mesh_kind": mesh_kind,
        "passes_visual_gate": bool(len(mesh.faces) > 0 and (non_manifold_edges in (0, None))),
        "failure_reasons": [] if len(mesh.faces) > 0 and (non_manifold_edges in (0, None)) else ["visual_mesh_invalid"],
    }


def _diameter_stations(annulus: dict[str, Any], stj: dict[str, Any], ascending: dict[str, Any], section_s: np.ndarray, section_radii: np.ndarray) -> list[dict[str, Any]]:
    station_defs = [
        ("annulus", annulus),
        ("stj", stj),
        ("ascending_end_proxy", ascending),
    ]
    stations: list[dict[str, Any]] = []
    for label, record in station_defs:
        s_mm = _finite_number(record.get("s_mm"))
        reference = _diameter_from_record(record)
        if reference is None and s_mm is not None and len(section_s) > 0:
            index = int(np.argmin(np.abs(section_s - s_mm)))
            reference = float(section_radii[index] * 2.0 / 0.95)
        stations.append(
            {
                "label": label,
                "s_mm": s_mm,
                "reference_inner_diameter_mm": round(reference, 2) if reference is not None else None,
                "sleeve_preview_diameter_mm": round(reference * 0.95, 2) if reference is not None else None,
                "confidence": _finite_number(record.get("confidence")) or 0.5,
                "source": "root_model_reference_section",
            }
        )
    return stations


def _coronary_window(side: str, coronary: dict[str, Any]) -> dict[str, Any]:
    side_record = coronary.get(side)
    side_obj = side_record if isinstance(side_record, dict) else {}
    status = str(side_obj.get("status") or "not_found")
    point = _vec3(side_obj.get("point_world") or side_obj.get("ostium_world"))
    height = _finite_number(side_obj.get("height_mm") or side_obj.get("height_above_annulus_mm"))
    if status == "detected" and point is not None:
        return {
            "status": "detected",
            "ostium_world": [float(v) for v in point],
            "height_mm": round(height, 2) if height is not None else None,
            "window_diameter_mm": 5.0,
            "confidence": _finite_number(side_obj.get("confidence")) or 0.75,
            "manual_review_required": True,
        }
    return {
        "status": "manual_required",
        "ostium_world": None,
        "height_mm": None,
        "window_diameter_mm": None,
        "confidence": 0.0,
        "manual_review_required": True,
    }


def _copy_or_combine_outer_aorta(mesh_dir: Path, out_path: Path) -> dict[str, Any]:
    root = mesh_dir / "aortic_root.stl"
    ascending = mesh_dir / "ascending_aorta.stl"
    if trimesh is not None and root.exists() and ascending.exists():
        combined = trimesh.util.concatenate([
            trimesh.load(str(root), force="mesh"),
            trimesh.load(str(ascending), force="mesh"),
        ])
        combined.export(str(out_path))
    elif root.exists():
        shutil.copy2(root, out_path)
    else:
        raise RuntimeError("aortic_root_stl_missing_for_pears_outer_aorta")
    return _mesh_quality(out_path, "tube_segment")


def build_pears_visual_artifacts(
    *,
    output_dir: Path,
    artifacts_dir: Path | None = None,
    study_meta: dict[str, Any] | None = None,
    case_id: str = "mao_mianqiang_preop",
) -> dict[str, Any]:
    artifacts_dir = artifacts_dir or output_dir
    model = _read_json(output_dir / "aortic_root_model.json")
    centerline = _read_json(output_dir / "centerline.json")
    measurements = _read_json(output_dir / "measurements.json")
    annulus = model.get("annulus_ring") if isinstance(model.get("annulus_ring"), dict) else {}
    stj = model.get("sinotubular_junction") if isinstance(model.get("sinotubular_junction"), dict) else {}
    refs = model.get("reference_sections") if isinstance(model.get("reference_sections"), dict) else {}
    ascending = refs.get("ascending") if isinstance(refs.get("ascending"), dict) else {}
    coronary = model.get("coronary_ostia") if isinstance(model.get("coronary_ostia"), dict) else {}
    if not annulus or not centerline:
        raise RuntimeError("pears_visual_required_model_artifacts_missing")

    annulus_stl = output_dir / "annulus_ring.stl"
    sleeve_stl = output_dir / "pears_support_sleeve_preview.stl"
    outer_stl = output_dir / "pears_outer_aorta.stl"
    annulus_qa = build_annulus_ring_mesh(annulus, annulus_stl)
    sleeve_qa, diameter_stations = build_sleeve_preview_mesh(centerline, annulus, stj, ascending, sleeve_stl)
    outer_qa = _copy_or_combine_outer_aorta(output_dir, outer_stl)

    slice_thickness = _finite_number((study_meta or {}).get("slice_thickness_mm"))
    blockers = ["outer_wall_not_segmented", "distal_brachiocephalic_not_localized"]
    warnings = ["surface_source_is_lumen_outer_proxy", "visual_preview_not_for_manufacturing"]
    if slice_thickness is not None and slice_thickness > PEARS_MAX_SLICE_THICKNESS_MM:
        blockers.append("pears_slice_thickness_above_0_75mm")
    left_window = _coronary_window("left", coronary)
    right_window = _coronary_window("right", coronary)
    if left_window["status"] != "detected" or right_window["status"] != "detected":
        blockers.append("coronary_ostia_manual_required")
    if not bool(sleeve_qa.get("passes_visual_gate")):
        blockers.append("pears_sleeve_visual_mesh_failed")
    if not bool(annulus_qa.get("passes_visual_gate")):
        blockers.append("annulus_ring_visual_mesh_failed")

    annulus_d = _diameter_from_record(annulus)
    stj_d = _diameter_from_record(stj)
    asc_d = _diameter_from_record(ascending)
    support_start = _finite_number(annulus.get("s_mm"))
    support_end = _finite_number(ascending.get("s_mm"))
    total_length = round(max(0.0, support_end - support_start), 2) if support_start is not None and support_end is not None else None
    sinus_diameters = [
        _finite_number(item.get("radius_mm")) * 2.0
        for item in (model.get("sinus_peaks") if isinstance(model.get("sinus_peaks"), list) else [])
        if isinstance(item, dict) and _finite_number(item.get("radius_mm")) is not None
    ]
    sinus_d = max(sinus_diameters) if sinus_diameters else None
    if sinus_d is None:
        sinus = refs.get("sinus") if isinstance(refs.get("sinus"), dict) else {}
        sinus_d = _diameter_from_record(sinus)

    pears_model = {
        "case_id": case_id,
        "module_version": PEARS_VISUAL_MODULE_VERSION,
        "source": "gpu_provider_pears_visual",
        "intended_use": "visual_planning_only",
        "manufacturing_ready": False,
        "visual_ready": bool(sleeve_qa.get("passes_visual_gate") and annulus_qa.get("passes_visual_gate")),
        "surface_source": "lumen_outer_proxy",
        "warnings": warnings,
        "blockers": sorted(set(blockers)),
        "quality": {
            "source_cta": {
                "slice_thickness_mm": slice_thickness,
                "pears_max_slice_thickness_mm": PEARS_MAX_SLICE_THICKNESS_MM,
                "passes_pears_sizing_gate": False,
                "reason": "visual_only_stage_not_sizing_gate",
            },
            "mesh": {
                "annulus_ring": annulus_qa,
                "pears_support_sleeve": sleeve_qa,
                "pears_outer_aorta": outer_qa,
            },
        },
        "support_segment": {
            "proximal": {"label": "annulus", "s_mm": support_start, "status": "detected"},
            "distal": {"label": "ascending_end_proxy", "s_mm": support_end, "status": "proxy"},
            "total_mm": total_length,
        },
        "diameter_stations": diameter_stations,
        "coronary_windows": {"left": left_window, "right": right_window},
        "geometry": {
            "annulus": {
                "max_diameter_mm": _finite_number(annulus.get("max_diameter_mm")),
                "equivalent_diameter_mm": annulus_d,
                "confidence": _finite_number(annulus.get("confidence")) or 0.5,
                "method": annulus.get("detection_method") or "root_model_annulus",
            },
            "stj": {
                "max_diameter_mm": _finite_number(stj.get("max_diameter_mm")) or stj_d,
                "diameter_mm": stj_d,
                "equivalent_diameter_mm": _finite_number(stj.get("equivalent_diameter_mm")) or stj_d,
                "confidence": _finite_number(stj.get("confidence")) or 0.5,
                "method": stj.get("detection_method") or "root_model_stj",
            },
            "sinus": {
                "max_diameter_mm": sinus_d,
                "mean_diameter_mm": float(np.mean(sinus_diameters)) if sinus_diameters else sinus_d,
                "confidence": 0.6 if sinus_d is not None else 0.2,
                "method": "sinus_peaks_or_reference_section",
            },
            "sinus_height": {"height_mm": round(total_length, 2) if total_length is not None else None},
            "coronary_heights": {
                "left": {"height_mm": left_window["height_mm"], "status": left_window["status"], "confidence": left_window["confidence"]},
                "right": {"height_mm": right_window["height_mm"], "status": right_window["status"], "confidence": right_window["confidence"]},
            },
            "ascending_max_diameter_mm": asc_d,
        },
        "eligibility": {
            "eligible": False,
            "status": "visual_planning_only",
            "verdict": "PEARS Planning Preview",
            "risk_level": "review_required",
            "summary": "Real CTA-derived PEARS external support preview. Not manufacturing-ready until image gate, coronary windows, and human review pass.",
            "criteria": [
                {"id": "sinus_diameter", "label": "Sinus diameter", "met": sinus_d is not None, "value_mm": sinus_d, "severity": "info", "icon": "i", "message": "Used for visual PEARS preview only."},
                {"id": "coronary_lca", "label": "LCA ostium", "met": left_window["status"] == "detected", "value_mm": left_window["height_mm"], "severity": "data_missing" if left_window["status"] != "detected" else "caution", "icon": "?", "message": "Manual coronary window confirmation required."},
                {"id": "coronary_rca", "label": "RCA ostium", "met": right_window["status"] == "detected", "value_mm": right_window["height_mm"], "severity": "data_missing" if right_window["status"] != "detected" else "caution", "icon": "?", "message": "Manual coronary window confirmation required."},
                {"id": "slice_thickness", "label": "PEARS slice thickness <= 0.75 mm", "met": slice_thickness is not None and slice_thickness <= PEARS_MAX_SLICE_THICKNESS_MM, "value_mm": slice_thickness, "severity": "caution", "icon": "?", "message": "Visual preview may proceed; sizing/manufacturing gate remains locked if above threshold."},
            ],
            "risk_flags": sorted(set(blockers)),
        },
        "surgical_planning": {
            "mesh_sizing": {
                "annulus_reference_mm": annulus_d,
                "annulus_mesh_diameter_mm": round(annulus_d * 0.95, 1) if annulus_d else None,
                "sinus_reference_mm": sinus_d,
                "sinus_mesh_diameter_mm": round(sinus_d * 0.95, 1) if sinus_d else None,
                "stj_reference_mm": stj_d,
                "stj_mesh_diameter_mm": round(stj_d * 0.95, 1) if stj_d else None,
                "ascending_reference_mm": asc_d,
                "ascending_mesh_diameter_mm": round(asc_d * 0.95, 1) if asc_d else None,
            },
            "support_segment": {
                "root_segment_mm": round(max(0.0, (_finite_number(stj.get("s_mm")) or support_start or 0.0) - (support_start or 0.0)), 1) if support_start is not None else None,
                "ascending_segment_mm": round(max(0.0, (support_end or 0.0) - (_finite_number(stj.get("s_mm")) or support_start or 0.0)), 1) if support_end is not None else None,
                "total_mm": total_length,
                "distal_status": "ascending_end_proxy",
            },
            "coronary_windows": {
                "lca": left_window,
                "rca": right_window,
                "note": "Manual ostium review required before any device design use.",
            },
        },
        "data_quality": {
            "annulus_confidence": _finite_number(annulus.get("confidence")) or 0.5,
            "stj_confidence": _finite_number(stj.get("confidence")) or 0.5,
            "sinus_confidence": 0.6 if sinus_d is not None else 0.2,
            "lca_confidence": left_window["confidence"],
            "rca_confidence": right_window["confidence"],
            "slice_thickness_mm": slice_thickness,
            "passes_sizing_gate": False,
        },
        "artifacts": {
            "pears_model": "artifacts/pears_model.json",
            "pears_coronary_windows": "artifacts/pears_coronary_windows.json",
            "pears_outer_aorta_stl": "meshes/pears_outer_aorta.stl",
            "pears_support_sleeve_stl": "meshes/pears_support_sleeve_preview.stl",
            "annulus_ring_stl": "meshes/annulus_ring.stl",
        },
        "references": [
            "Treasure T et al. Heart 2014;100:1582-1586",
            "Exstent PEARS CT acquisition protocol summary in docs/imaging/pears.md",
            "PEARS product replication guide local paper/PEARS产品完整复刻指南.docx",
        ],
    }

    coronary_windows = {
        "case_id": case_id,
        "module_version": PEARS_VISUAL_MODULE_VERSION,
        "intended_use": "visual_planning_only",
        "manufacturing_ready": False,
        "left": left_window,
        "right": right_window,
        "warnings": ["manual_review_required_before_coronary_window_cutting"],
    }
    visual_qa = {
        "case_id": case_id,
        "module_version": PEARS_VISUAL_MODULE_VERSION,
        "visual_ready": pears_model["visual_ready"],
        "manufacturing_ready": False,
        "blockers": pears_model["blockers"],
        "warnings": warnings,
        "mesh": pears_model["quality"]["mesh"],
    }

    _write_json(artifacts_dir / "pears_model.json", pears_model)
    _write_json(artifacts_dir / "pears_coronary_windows.json", coronary_windows)
    qa_dir = output_dir.parent / "qa"
    _write_json(qa_dir / "pears_visual_qa.json", visual_qa)
    measurements["pears_geometry"] = pears_model
    _write_json(output_dir / "measurements.json", measurements)
    return pears_model


__all__ = [
    "PEARS_VISUAL_MODULE_VERSION",
    "build_pears_visual_artifacts",
    "build_annulus_ring_mesh",
    "build_sleeve_preview_mesh",
]
