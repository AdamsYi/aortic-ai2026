from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import nibabel as nib
import numpy as np
from scipy import ndimage

from .common import normalize, orth_basis_from_tangent
from .profile_analysis import SectionMetrics


@dataclass
class AorticRootComputationalModel:
    model_type: str
    annulus_ring: dict[str, Any]
    hinge_curve: dict[str, Any]
    commissures: list[dict[str, Any]]
    sinus_peaks: list[dict[str, Any]]
    sinotubular_junction: dict[str, Any]
    coronary_ostia: dict[str, Any]
    ascending_axis: dict[str, Any]
    ascending_aorta_axis: dict[str, Any]
    centerline: dict[str, Any]
    structure_metadata: dict[str, Any]
    raw_landmarks: dict[str, Any]
    regularized_landmarks: dict[str, Any]
    raw_measurements: dict[str, Any]
    regularized_measurements: dict[str, Any]
    phase_metadata: dict[str, Any]
    provenance: dict[str, Any]
    anatomical_constraints: dict[str, Any]
    confidence_scores: dict[str, Any]
    reference_sections: dict[str, Any]
    annulus_plane: dict[str, Any]
    leaflet_geometry: dict[str, Any]
    leaflet_meshes: list[dict[str, Any]]
    digital_twin_simulation: dict[str, Any]


AorticRootModel = AorticRootComputationalModel


def _structure_meta(
    method: str,
    confidence: float | None,
    status: str = "detected",
    source_fields: list[str] | None = None,
    notes: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "status": status,
        "detection_method": method,
        "confidence": float(confidence) if confidence is not None else None,
        "source_fields": source_fields or [],
        "notes": notes or [],
    }


def _landmark_bundle(
    annulus_ring: dict[str, Any],
    hinge_curve: dict[str, Any],
    commissures: list[dict[str, Any]],
    sinus_peaks: list[dict[str, Any]],
    stj_ring: dict[str, Any],
    coronary_ostia: dict[str, Any],
    ascending_axis: dict[str, Any],
    centerline: dict[str, Any],
    annulus_plane: dict[str, Any],
) -> dict[str, Any]:
    return {
        "annulus_ring": annulus_ring,
        "hinge_curve": hinge_curve,
        "commissures": commissures,
        "sinus_peaks": sinus_peaks,
        "sinotubular_junction": stj_ring,
        "coronary_ostia": coronary_ostia,
        "ascending_aorta_axis": ascending_axis,
        "centerline": centerline,
        "annulus_plane": annulus_plane,
    }


def _sample_curve_points(world: np.ndarray, voxel: np.ndarray, max_points: int = 96) -> tuple[list[list[float]], list[list[float]]]:
    if world.shape[0] == 0:
        return [], []
    step = max(1, int(np.ceil(world.shape[0] / max_points)))
    world_s = world[::step]
    voxel_s = voxel[::step]
    return [[float(v) for v in p] for p in world_s], [[float(v) for v in p] for p in voxel_s]


def _pca_plane(points_world: np.ndarray, fallback_normal: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    pts = np.asarray(points_world, dtype=np.float64)
    origin = np.mean(pts, axis=0)
    centered = pts - origin[None, :]
    cov = np.cov(centered.T) if pts.shape[0] >= 3 else np.eye(3, dtype=np.float64)
    eigvals, eigvecs = np.linalg.eigh(cov)
    order = np.argsort(eigvals)
    normal = normalize(eigvecs[:, order[0]])
    if float(np.dot(normal, fallback_normal)) < 0:
        normal = -normal
    u = normalize(eigvecs[:, order[-1]] - np.dot(eigvecs[:, order[-1]], normal) * normal)
    if float(np.linalg.norm(u)) < 1e-6:
        u, _ = orth_basis_from_tangent(normal)
    v = normalize(np.cross(normal, u))
    return origin, normal, u, v, eigvals[order]


def _project_to_plane(points_world: np.ndarray, origin_world: np.ndarray, normal_world: np.ndarray) -> np.ndarray:
    pts = np.asarray(points_world, dtype=np.float64)
    origin = np.asarray(origin_world, dtype=np.float64)
    normal = normalize(normal_world)
    distances = np.dot(pts - origin[None, :], normal)
    return pts - distances[:, None] * normal[None, :]


def _ring_payload(section: SectionMetrics, plane_override: dict[str, Any] | None = None, label: str = "ring") -> dict[str, Any]:
    if plane_override:
        origin_world = np.asarray(plane_override.get("origin_world", section.center_world), dtype=np.float64)
        normal_world = normalize(np.asarray(plane_override.get("normal_world", section.tangent_world), dtype=np.float64))
        basis_u_world = normalize(np.asarray(plane_override.get("basis_u_world", section.basis_u_world), dtype=np.float64))
        basis_v_world = normalize(np.asarray(plane_override.get("basis_v_world", section.basis_v_world), dtype=np.float64))
        contour_world = _project_to_plane(section.contour_world, origin_world, normal_world)
        contour_voxel = np.asarray(plane_override.get("ring_points_voxel", section.contour_voxel), dtype=np.float64)
    else:
        origin_world = np.asarray(section.center_world, dtype=np.float64)
        normal_world = normalize(np.asarray(section.tangent_world, dtype=np.float64))
        basis_u_world = np.asarray(section.basis_u_world, dtype=np.float64)
        basis_v_world = np.asarray(section.basis_v_world, dtype=np.float64)
        contour_world = np.asarray(section.contour_world, dtype=np.float64)
        contour_voxel = np.asarray(section.contour_voxel, dtype=np.float64)
    return {
        "label": label,
        "index": int(section.index),
        "s_mm": float(section.s_mm),
        "center_world": [float(x) for x in origin_world],
        "center_voxel": [float(x) for x in section.center_voxel],
        "normal_world": [float(x) for x in normal_world],
        "basis_u_world": [float(x) for x in basis_u_world],
        "basis_v_world": [float(x) for x in basis_v_world],
        "contour_world": [[float(v) for v in p] for p in contour_world],
        "contour_voxel": [[float(v) for v in p] for p in contour_voxel],
        "radial_angles_rad": [float(v) for v in section.radial_angles_rad],
        "radial_profile_mm": [float(v) for v in section.radial_profile_mm],
        "max_diameter_mm": float(section.max_diameter_mm),
        "min_diameter_mm": float(section.min_diameter_mm),
        "equivalent_diameter_mm": float(section.equivalent_diameter_mm),
        "area_mm2": float(section.area_mm2),
        "perimeter_mm": float(section.perimeter_mm) if section.perimeter_mm is not None else None,
        "detection_method": str(plane_override.get("method")) if plane_override else "orthogonal_section",
        "confidence": float(plane_override.get("confidence", 1.0)) if plane_override else 1.0,
    }


def _roi_points_near_annulus(
    contact_mask: np.ndarray,
    annulus: SectionMetrics,
    affine: np.ndarray,
    axial_window_mm: tuple[float, float] = (-8.0, 12.0),
    radial_limit_mm: float = 30.0,
    offset_voxel: tuple[int, int, int] = (0, 0, 0),
) -> tuple[np.ndarray, np.ndarray]:
    coords = np.argwhere(contact_mask)
    if coords.shape[0] == 0:
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.float64)
    coords = coords + np.asarray(offset_voxel, dtype=np.int32)[None, :]
    world = nib.affines.apply_affine(affine, coords.astype(np.float64))
    center = np.asarray(annulus.center_world, dtype=np.float64)
    tangent = normalize(np.asarray(annulus.tangent_world, dtype=np.float64))
    rel = world - center[None, :]
    axial = rel @ tangent
    radial_vec = rel - axial[:, None] * tangent[None, :]
    radial = np.linalg.norm(radial_vec, axis=1)
    keep = (axial >= axial_window_mm[0]) & (axial <= axial_window_mm[1]) & (radial <= radial_limit_mm)
    return world[keep], coords[keep].astype(np.float64)


def estimate_hinge_annulus(
    annulus: SectionMetrics,
    root_mask: np.ndarray,
    leaflet_mask: np.ndarray,
    ascending_mask: np.ndarray,
    affine: np.ndarray,
) -> dict[str, Any]:
    cx, cy, cz = [int(round(v)) for v in annulus.center_voxel]
    x0 = max(0, cx - 56)
    x1 = min(root_mask.shape[0], cx + 57)
    y0 = max(0, cy - 56)
    y1 = min(root_mask.shape[1], cy + 57)
    z0 = max(0, cz - 16)
    z1 = min(root_mask.shape[2], cz + 17)
    root_wall_roi = np.asarray((root_mask | ascending_mask)[x0:x1, y0:y1, z0:z1], dtype=bool)
    leaflet_roi = np.asarray(leaflet_mask[x0:x1, y0:y1, z0:z1], dtype=bool)
    contact_roi = ndimage.binary_dilation(leaflet_roi, structure=np.ones((3, 3, 3), dtype=bool), iterations=1) & root_wall_roi
    hinge_world, hinge_voxel = _roi_points_near_annulus(contact_roi, annulus, affine, offset_voxel=(x0, y0, z0))
    method = "hinge_curve_pca"
    if hinge_world.shape[0] < 18:
        method = "leaflet_roi_pca"
        hinge_world, hinge_voxel = _roi_points_near_annulus(leaflet_roi, annulus, affine, axial_window_mm=(-8.0, 14.0), offset_voxel=(x0, y0, z0))

    if hinge_world.shape[0] < 18:
        hinge_curve_world, hinge_curve_voxel = _sample_curve_points(
            np.asarray(annulus.contour_world, dtype=np.float64),
            np.asarray(annulus.contour_voxel, dtype=np.float64),
        )
        return {
            "origin_world": [float(x) for x in annulus.center_world],
            "origin_voxel": [float(x) for x in annulus.center_voxel],
            "normal_world": [float(x) for x in normalize(annulus.tangent_world)],
            "basis_u_world": [float(x) for x in annulus.basis_u_world],
            "basis_v_world": [float(x) for x in annulus.basis_v_world],
            "ring_points_world": [[float(v) for v in p] for p in annulus.contour_world],
            "ring_points_voxel": [[float(v) for v in p] for p in annulus.contour_voxel],
            "hinge_points_world": hinge_curve_world,
            "hinge_points_voxel": hinge_curve_voxel,
            "method": "radius_minimum_fallback",
            "confidence": 0.35,
            "hinge_point_count": int(hinge_world.shape[0]),
            "status": "fallback",
        }

    origin, normal, basis_u, basis_v, eigvals = _pca_plane(hinge_world, np.asarray(annulus.tangent_world, dtype=np.float64))
    projected_ring_world = _project_to_plane(annulus.contour_world, origin, normal)
    affine_inv = np.linalg.inv(affine)
    ring_voxel = nib.affines.apply_affine(affine_inv, projected_ring_world)
    hinge_curve_world, hinge_curve_voxel = _sample_curve_points(hinge_world, hinge_voxel)
    planarity = float(eigvals[1] / max(1e-6, eigvals[2])) if eigvals.shape[0] >= 3 else 0.0
    confidence = float(np.clip(0.45 + 0.25 * min(1.0, hinge_world.shape[0] / 60.0) + 0.30 * (1.0 - min(1.0, planarity)), 0.0, 0.99))
    return {
        "origin_world": [float(x) for x in origin],
        "origin_voxel": [float(x) for x in nib.affines.apply_affine(affine_inv, origin)],
        "normal_world": [float(x) for x in normal],
        "basis_u_world": [float(x) for x in basis_u],
        "basis_v_world": [float(x) for x in basis_v],
        "ring_points_world": [[float(v) for v in p] for p in projected_ring_world],
        "ring_points_voxel": [[float(v) for v in p] for p in ring_voxel],
        "hinge_points_world": hinge_curve_world,
        "hinge_points_voxel": hinge_curve_voxel,
        "method": method,
        "confidence": confidence,
        "hinge_point_count": int(hinge_world.shape[0]),
        "status": "detected",
    }


def _local_extrema(values: np.ndarray, mode: str) -> list[int]:
    idxs: list[int] = []
    for i in range(values.shape[0]):
        prev_i = (i - 1) % values.shape[0]
        next_i = (i + 1) % values.shape[0]
        if mode == "max" and values[i] >= values[prev_i] and values[i] >= values[next_i]:
            idxs.append(i)
        elif mode == "min" and values[i] <= values[prev_i] and values[i] <= values[next_i]:
            idxs.append(i)
    return idxs


def _angular_triplet_score(indices: tuple[int, int, int], angles_deg: np.ndarray, scores: np.ndarray) -> float:
    vals = np.sort(angles_deg[np.asarray(indices, dtype=np.int32)])
    diffs = np.array([vals[1] - vals[0], vals[2] - vals[1], vals[0] + 360.0 - vals[2]], dtype=np.float64)
    spacing_penalty = float(np.sum(np.abs(diffs - 120.0)))
    return float(scores[np.asarray(indices, dtype=np.int32)].sum() - 0.08 * spacing_penalty)


def _select_three_spaced(indices: list[int], values: np.ndarray, angles_rad: np.ndarray, prefer: str) -> list[int]:
    if not indices:
        return [0, values.shape[0] // 3, (2 * values.shape[0]) // 3]
    candidates = list(dict.fromkeys(int(i) for i in indices))
    angles_deg = np.rad2deg(angles_rad)
    if prefer == "max":
        scores = np.asarray(values, dtype=np.float64)
    else:
        scores = -np.asarray(values, dtype=np.float64)
    if len(candidates) >= 3:
        best: tuple[int, int, int] | None = None
        best_score = -1e18
        for i in range(len(candidates) - 2):
            for j in range(i + 1, len(candidates) - 1):
                for k in range(j + 1, len(candidates)):
                    triplet = (candidates[i], candidates[j], candidates[k])
                    score = _angular_triplet_score(triplet, angles_deg, scores)
                    if score > best_score:
                        best_score = score
                        best = triplet
        if best is not None:
            return sorted(int(v) for v in best)
    strongest = int(candidates[int(np.argmax(scores[np.asarray(candidates, dtype=np.int32)]))])
    n = values.shape[0]
    return sorted([strongest, (strongest + n // 3) % n, (strongest + (2 * n // 3)) % n])


def _nearest_ring_index(target_angle: float, angles_rad: np.ndarray) -> int:
    diff = np.angle(np.exp(1j * (angles_rad - target_angle)))
    return int(np.argmin(np.abs(diff)))


def _build_feature_points(
    peak_indices: list[int],
    trough_indices: list[int],
    sinus_section: SectionMetrics,
    stj_section: SectionMetrics,
    annulus_plane: dict[str, Any],
    curvature: np.ndarray,
    method: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    annulus_origin = np.asarray(annulus_plane.get("origin_world", sinus_section.center_world), dtype=np.float64)
    annulus_u = normalize(np.asarray(annulus_plane.get("basis_u_world", sinus_section.basis_u_world), dtype=np.float64))
    annulus_v = normalize(np.asarray(annulus_plane.get("basis_v_world", sinus_section.basis_v_world), dtype=np.float64))
    radial = np.asarray(sinus_section.radial_profile_mm, dtype=np.float64)
    angles = np.asarray(sinus_section.radial_angles_rad, dtype=np.float64)
    stj_angles = np.asarray(stj_section.radial_angles_rad, dtype=np.float64)

    sinus_peaks: list[dict[str, Any]] = []
    for order, idx in enumerate(peak_indices, start=1):
        point_world = sinus_section.contour_world[idx]
        point_voxel = sinus_section.contour_voxel[idx]
        rel = point_world - annulus_origin
        angle_deg = float((np.degrees(np.arctan2(np.dot(rel, annulus_v), np.dot(rel, annulus_u))) + 360.0) % 360.0)
        sinus_peaks.append(
            {
                "id": f"sinus_peak_{order}",
                "index": int(idx),
                "angle_deg": angle_deg,
                "radius_mm": float(radial[idx]),
                "curvature_score": float(curvature[idx]),
                "world": [float(x) for x in point_world],
                "voxel": [float(x) for x in point_voxel],
            }
        )

    commissures: list[dict[str, Any]] = []
    for order, idx in enumerate(trough_indices, start=1):
        target_angle = float(angles[idx])
        stj_idx = _nearest_ring_index(target_angle, stj_angles)
        point_world = stj_section.contour_world[stj_idx]
        point_voxel = stj_section.contour_voxel[stj_idx]
        rel = point_world - annulus_origin
        angle_deg = float((np.degrees(np.arctan2(np.dot(rel, annulus_v), np.dot(rel, annulus_u))) + 360.0) % 360.0)
        commissures.append(
            {
                "id": f"commissure_{order}",
                "index": int(stj_idx),
                "source_sinus_index": int(idx),
                "angle_deg": angle_deg,
                "radius_mm": float(stj_section.radial_profile_mm[stj_idx]),
                "curvature_score": float(-curvature[idx]),
                "world": [float(x) for x in point_world],
                "voxel": [float(x) for x in point_voxel],
                "method": method,
            }
        )
    comm_angles = np.sort(np.asarray([float(item["angle_deg"]) for item in commissures], dtype=np.float64))
    if comm_angles.size == 3:
        diffs = np.array([comm_angles[1] - comm_angles[0], comm_angles[2] - comm_angles[1], comm_angles[0] + 360.0 - comm_angles[2]], dtype=np.float64)
    else:
        diffs = np.array([], dtype=np.float64)
    geometry_stats = {
        "commissure_angle_spacing_deg": [float(v) for v in diffs],
        "commissure_spacing_error_deg": float(np.mean(np.abs(diffs - 120.0))) if diffs.size == 3 else None,
        "sinus_peak_angles_deg": [float(item["angle_deg"]) for item in sinus_peaks],
        "detection_method": method,
    }
    return commissures, sinus_peaks, geometry_stats


def detect_commissures_and_sinus_peaks(
    sinus_section: SectionMetrics,
    stj_section: SectionMetrics,
    annulus_plane: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    radial = ndimage.gaussian_filter1d(np.asarray(sinus_section.radial_profile_mm, dtype=np.float64), sigma=1.1, mode="wrap")
    angles = np.asarray(sinus_section.radial_angles_rad, dtype=np.float64)
    curvature = ndimage.gaussian_filter1d(np.gradient(np.gradient(radial)), sigma=0.8, mode="wrap")

    peak_candidates = _local_extrema(radial, "max")
    peak_indices = _select_three_spaced(peak_candidates, radial, angles, prefer="max")
    peak_indices = sorted(peak_indices)

    trough_indices: list[int] = []
    for i in range(3):
        a = peak_indices[i]
        b = peak_indices[(i + 1) % 3]
        if b <= a:
            interval = list(range(a + 1, radial.shape[0])) + list(range(0, b))
        else:
            interval = list(range(a + 1, b))
        if not interval:
            trough_indices.append((a + radial.shape[0] // 6) % radial.shape[0])
            continue
        trough_local = int(interval[int(np.argmin(radial[np.asarray(interval, dtype=np.int32)]))])
        trough_indices.append(trough_local)
    trough_indices = sorted(int(v) for v in trough_indices)
    commissures, sinus_peaks, geometry_stats = _build_feature_points(
        peak_indices=peak_indices,
        trough_indices=trough_indices,
        sinus_section=sinus_section,
        stj_section=stj_section,
        annulus_plane=annulus_plane,
        curvature=curvature,
        method="sinus_rim_saddle_points",
    )
    raw_bundle = {
        "commissures": [dict(item) for item in commissures],
        "sinus_peaks": [dict(item) for item in sinus_peaks],
        "geometry_stats": dict(geometry_stats),
    }
    if geometry_stats.get("commissure_spacing_error_deg") is not None and float(geometry_stats["commissure_spacing_error_deg"]) > 35.0:
        primary_spacing_error_deg = float(geometry_stats["commissure_spacing_error_deg"])
        anchor_idx = int(peak_indices[int(np.argmax(radial[np.asarray(peak_indices, dtype=np.int32)]))]) if peak_indices else 0
        n = radial.shape[0]
        peak_indices = sorted([anchor_idx, (anchor_idx + n // 3) % n, (anchor_idx + (2 * n // 3)) % n])
        trough_indices = sorted([(peak_indices[0] + n // 6) % n, (peak_indices[1] + n // 6) % n, (peak_indices[2] + n // 6) % n])
        commissures, sinus_peaks, geometry_stats = _build_feature_points(
            peak_indices=peak_indices,
            trough_indices=trough_indices,
            sinus_section=sinus_section,
            stj_section=stj_section,
            annulus_plane=annulus_plane,
            curvature=curvature,
            method="angularly_regularized_saddle_points",
        )
        actual_comm_deg = [float(item.get("angle_deg", 0.0)) for item in commissures]
        peak_target_deg = [float((np.degrees(angles[idx]) + 360.0) % 360.0) for idx in peak_indices]
        comm_target_deg = [float((np.degrees(angles[idx]) + 360.0) % 360.0) for idx in trough_indices]
        for item, angle_deg in zip(sinus_peaks, peak_target_deg):
            item["angle_deg"] = angle_deg
        for item, angle_deg in zip(commissures, comm_target_deg):
            item["angle_deg"] = angle_deg
        sorted_comm_deg = sorted(actual_comm_deg)
        spacings = [
            sorted_comm_deg[1] - sorted_comm_deg[0],
            sorted_comm_deg[2] - sorted_comm_deg[1],
            360.0 - sorted_comm_deg[2] + sorted_comm_deg[0],
        ]
        actual_error = float(np.mean(np.abs(np.asarray(spacings) - 120.0)))
        geometry_stats = {
            "commissure_angle_spacing_deg": [float(v) for v in spacings],
            "commissure_spacing_error_deg": actual_error,
            "sinus_peak_angles_deg": peak_target_deg,
            "detection_method": "angularly_regularized_saddle_points",
            "regularized": True,
            "regularization_applied": True,
            "regularization_reason": "primary_spacing_error_exceeded_35_deg",
            "primary_spacing_error_deg": primary_spacing_error_deg,
        }
    return commissures, sinus_peaks, geometry_stats, raw_bundle


def build_anatomical_constraints(model: AorticRootComputationalModel) -> dict[str, Any]:
    annulus_d = float(model.annulus_ring.get("equivalent_diameter_mm") or 0.0)
    stj_d = float(model.sinotubular_junction.get("equivalent_diameter_mm") or model.sinotubular_junction.get("max_diameter_mm") or 0.0)
    sinus_d = max(float(item.get("radius_mm", 0.0)) * 2.0 for item in model.sinus_peaks) if model.sinus_peaks else 0.0
    comm_angles = np.sort(np.asarray([float(item.get("angle_deg", 0.0)) for item in model.commissures], dtype=np.float64))
    if comm_angles.size == 3:
        comm_spacing = [float(comm_angles[1] - comm_angles[0]), float(comm_angles[2] - comm_angles[1]), float(comm_angles[0] + 360.0 - comm_angles[2])]
    else:
        comm_spacing = []
    left_height = model.coronary_ostia.get("left", {}).get("height_mm")
    right_height = model.coronary_ostia.get("right", {}).get("height_mm")
    leaflet_geometry = model.leaflet_geometry or {}
    coaptation_height = leaflet_geometry.get("coaptation_height_mm")
    effective_height_mean = leaflet_geometry.get("effective_height_mean_mm")
    geometric_height_mean = leaflet_geometry.get("geometric_height_mean_mm")
    checks = [
        {
            "id": "sinus_ge_annulus",
            "accepted": bool(sinus_d >= annulus_d - 0.5),
            "lhs": sinus_d,
            "rhs": annulus_d,
        },
        {
            "id": "stj_le_sinus",
            "accepted": bool(stj_d <= sinus_d + 0.5) if sinus_d > 0 else True,
            "lhs": stj_d,
            "rhs": sinus_d,
        },
        {
            "id": "stj_ge_annulus",
            "accepted": bool(stj_d >= annulus_d - 0.5) if annulus_d > 0 else True,
            "lhs": stj_d,
            "rhs": annulus_d,
        },
        {
            "id": "commissure_angles_approx_120",
            "accepted": bool(len(comm_spacing) == 3 and np.mean(np.abs(np.asarray(comm_spacing) - 120.0)) <= 22.0),
            "spacing_deg": comm_spacing,
        },
        {
            "id": "coronary_height_gt_3",
            "accepted": bool((left_height is None or left_height > 3.0) and (right_height is None or right_height > 3.0)),
            "left_height_mm": left_height,
            "right_height_mm": right_height,
        },
        {
            "id": "coaptation_height_threshold",
            "accepted": bool(
                coaptation_height is None
                or float(coaptation_height) >= 1.0
            ),
            "coaptation_height_mm": coaptation_height,
            "effective_height_mean_mm": effective_height_mean,
        },
        {
            "id": "effective_height_le_geometric_height",
            "accepted": bool(
                effective_height_mean is None
                or geometric_height_mean is None
                or float(effective_height_mean) <= float(geometric_height_mean) + 0.5
            ),
            "effective_height_mean_mm": effective_height_mean,
            "geometric_height_mean_mm": geometric_height_mean,
        },
    ]
    accepted = all(bool(item.get("accepted")) for item in checks)
    violations = [str(item.get("id")) for item in checks if not bool(item.get("accepted"))]
    corrections_applied: list[str] = []
    geometry_method = str(model.reference_sections.get("geometry_stats", {}).get("detection_method") or "")
    if "regularized" in geometry_method:
        corrections_applied.append("commissure_angular_regularization")
    leaflet_regularization = model.leaflet_geometry.get("regularization", {}) if isinstance(model.leaflet_geometry, dict) else {}
    if bool(leaflet_regularization.get("applied")):
        corrections_applied.append("leaflet_height_regularization")
    return {
        "accepted": accepted,
        "checks": checks,
        "violations": violations,
        "corrections_applied": corrections_applied,
    }


def build_confidence_scores(model: AorticRootComputationalModel) -> dict[str, Any]:
    annulus_conf = float(model.annulus_plane.get("confidence", 0.0) or 0.0)
    hinge_conf = float(model.hinge_curve.get("confidence", annulus_conf) or annulus_conf)
    geom_stats = model.reference_sections.get("geometry_stats", {}) if isinstance(model.reference_sections, dict) else {}
    spacing_error = geom_stats.get("commissure_spacing_error_deg")
    if spacing_error is None:
        commissure_conf = None
    else:
        commissure_conf = float(np.clip(1.0 - (float(spacing_error) / 45.0), 0.1, 0.99))
    left_conf = model.coronary_ostia.get("left", {}).get("confidence")
    right_conf = model.coronary_ostia.get("right", {}).get("confidence")
    leaflet_items = model.leaflet_geometry.get("leaflets", []) if isinstance(model.leaflet_geometry, dict) else []
    leaflet_scores: list[float] = []
    for item in leaflet_items:
        status = str(item.get("status") or "uncertain")
        score = 0.2 if status == "not_found" else (0.45 if status == "uncertain" else 0.8)
        if bool(item.get("regularized")):
            score -= 0.1
        leaflet_scores.append(float(np.clip(score, 0.05, 0.95)))
    leaflet_conf = float(np.mean(leaflet_scores)) if leaflet_scores else None
    overall_parts = [annulus_conf, hinge_conf]
    for extra in [commissure_conf, leaflet_conf, left_conf, right_conf]:
        if extra is not None:
            overall_parts.append(float(extra))
    overall = float(np.mean(overall_parts)) if overall_parts else 0.0
    return {
        "annulus_plane": annulus_conf,
        "hinge_curve": hinge_conf,
        "commissures": commissure_conf,
        "coronary_ostia": {
            "left": float(left_conf) if left_conf is not None else None,
            "right": float(right_conf) if right_conf is not None else None,
        },
        "leaflet_geometry": leaflet_conf,
        "overall": overall,
    }


def attach_coronary_ostia(model: AorticRootComputationalModel, coronary_ostia: dict[str, Any]) -> AorticRootComputationalModel:
    model.coronary_ostia = coronary_ostia
    model.raw_landmarks["coronary_ostia"] = coronary_ostia
    model.regularized_landmarks["coronary_ostia"] = coronary_ostia
    model.structure_metadata["coronary_ostia"] = {
        "left": _structure_meta(
            method=str(coronary_ostia.get("method") or "coronary_detection"),
            confidence=coronary_ostia.get("left", {}).get("confidence"),
            status=str(coronary_ostia.get("left", {}).get("status") or "not_found"),
            source_fields=["ct_hu", "lumen_mask", "annulus_plane", "sinus_roi"],
        ),
        "right": _structure_meta(
            method=str(coronary_ostia.get("method") or "coronary_detection"),
            confidence=coronary_ostia.get("right", {}).get("confidence"),
            status=str(coronary_ostia.get("right", {}).get("status") or "not_found"),
            source_fields=["ct_hu", "lumen_mask", "annulus_plane", "sinus_roi"],
        ),
    }
    model.anatomical_constraints = build_anatomical_constraints(model)
    model.confidence_scores = build_confidence_scores(model)
    return model


def attach_leaflet_geometry(model: AorticRootComputationalModel, leaflet_geometry: dict[str, Any]) -> AorticRootComputationalModel:
    model.leaflet_geometry = leaflet_geometry
    leaflets = leaflet_geometry.get("leaflets", []) if isinstance(leaflet_geometry, dict) else []
    model.leaflet_meshes = [
        {
            "leaflet_id": item.get("leaflet_id"),
            "name": item.get("name"),
            "mesh_vertices": item.get("mesh_vertices"),
            "mesh_faces": item.get("mesh_faces"),
            "status": item.get("status"),
        }
        for item in leaflets
    ]
    model.anatomical_constraints = build_anatomical_constraints(model)
    model.confidence_scores = build_confidence_scores(model)
    model.structure_metadata["leaflet_geometry"] = _structure_meta(
        method=str(leaflet_geometry.get("method") or "leaflet_mesh_reconstruction"),
        confidence=model.confidence_scores.get("leaflet_geometry"),
        status=str(leaflet_geometry.get("status") or "uncertain"),
        source_fields=["leaflet_mask", "annulus_plane", "commissures", "hinge_curve"],
        notes=["raw and regularized leaflet heights are both preserved"],
    )
    return model


def attach_digital_twin_simulation(model: AorticRootComputationalModel, digital_twin_simulation: dict[str, Any]) -> AorticRootComputationalModel:
    model.digital_twin_simulation = digital_twin_simulation
    model.anatomical_constraints = build_anatomical_constraints(model)
    model.confidence_scores = build_confidence_scores(model)
    return model


def build_aortic_root_model(
    sections: dict[str, SectionMetrics | None],
    landmarks: LandmarkDetectionResult,
    centerline_world: np.ndarray,
    centerline_voxel: np.ndarray,
    centerline_s_mm: np.ndarray,
    centerline_method: str,
    affine: np.ndarray,
    root_mask: np.ndarray,
    leaflet_mask: np.ndarray,
    ascending_mask: np.ndarray,
) -> AorticRootComputationalModel:
    annulus = sections.get("annulus")
    sinus = sections.get("sinus")
    stj = sections.get("stj")
    ascending = sections.get("ascending")
    if annulus is None or sinus is None or stj is None or ascending is None:
        raise RuntimeError("geometry_root_model_incomplete")

    annulus_plane = estimate_hinge_annulus(
        annulus=annulus,
        root_mask=np.asarray(root_mask, dtype=bool),
        leaflet_mask=np.asarray(leaflet_mask, dtype=bool),
        ascending_mask=np.asarray(ascending_mask, dtype=bool),
        affine=affine,
    )
    annulus_ring = _ring_payload(annulus, plane_override=annulus_plane, label="annulus_ring")
    hinge_curve = {
        "points_world": annulus_plane.get("hinge_points_world", []),
        "points_voxel": annulus_plane.get("hinge_points_voxel", []),
        "point_count": int(len(annulus_plane.get("hinge_points_world", []))),
        "method": annulus_plane.get("method"),
        "confidence": float(annulus_plane.get("confidence", 0.0)),
    }
    stj_ring = _ring_payload(stj, label="sinotubular_junction")
    sinus_ring = _ring_payload(sinus, label="sinus_section")
    ascending_ring = _ring_payload(ascending, label="ascending_reference")
    commissures, sinus_peaks, geometry_stats, raw_geometry_bundle = detect_commissures_and_sinus_peaks(
        sinus_section=sinus,
        stj_section=stj,
        annulus_plane=annulus_plane,
    )

    ascending_axis = {
        "start_world": [float(x) for x in stj.center_world],
        "end_world": [float(x) for x in ascending.center_world],
        "start_voxel": [float(x) for x in stj.center_voxel],
        "end_voxel": [float(x) for x in ascending.center_voxel],
    }
    centerline = {
        "point_count": int(centerline_world.shape[0]),
        "points_world": [[float(v) for v in p] for p in centerline_world],
        "points_voxel": [[float(v) for v in p] for p in centerline_voxel],
        "s_mm": [float(v) for v in centerline_s_mm],
        "method": centerline_method,
    }
    coronary_ostia = {
        "left": {"status": "not_evaluated", "height_mm": None, "confidence": 0.0},
        "right": {"status": "not_evaluated", "height_mm": None, "confidence": 0.0},
    }
    raw_landmarks = _landmark_bundle(
        annulus_ring=annulus_ring,
        hinge_curve=hinge_curve,
        commissures=raw_geometry_bundle.get("commissures", commissures),
        sinus_peaks=raw_geometry_bundle.get("sinus_peaks", sinus_peaks),
        stj_ring=stj_ring,
        coronary_ostia=coronary_ostia,
        ascending_axis=ascending_axis,
        centerline=centerline,
        annulus_plane=annulus_plane,
    )
    regularized_landmarks = _landmark_bundle(
        annulus_ring=annulus_ring,
        hinge_curve=hinge_curve,
        commissures=commissures,
        sinus_peaks=sinus_peaks,
        stj_ring=stj_ring,
        coronary_ostia=coronary_ostia,
        ascending_axis=ascending_axis,
        centerline=centerline,
        annulus_plane=annulus_plane,
    )
    structure_metadata = {
        "annulus_ring": _structure_meta(
            method=str(annulus_plane.get("method") or "orthogonal_section"),
            confidence=annulus_plane.get("confidence"),
            status=str(annulus_plane.get("status") or "detected"),
            source_fields=["lumen_mask", "leaflet_mask", "root_mask", "centerline"],
        ),
        "hinge_curve": _structure_meta(
            method=str(hinge_curve.get("method") or annulus_plane.get("method") or "hinge_curve_pca"),
            confidence=hinge_curve.get("confidence"),
            status=str(annulus_plane.get("status") or "detected"),
            source_fields=["leaflet_mask", "root_mask", "annulus_ring"],
        ),
        "commissures": _structure_meta(
            method=str(geometry_stats.get("detection_method") or "sinus_rim_saddle_points"),
            confidence=float(np.clip(1.0 - (float(geometry_stats.get("commissure_spacing_error_deg") or 0.0) / 45.0), 0.1, 0.99)),
            status="detected",
            source_fields=["sinus_section", "stj_section", "annulus_plane"],
            notes=["raw landmark set preserved separately before angular regularization"],
        ),
        "sinus_peaks": _structure_meta(
            method=str(geometry_stats.get("detection_method") or "sinus_rim_saddle_points"),
            confidence=float(np.clip(1.0 - (float(geometry_stats.get("commissure_spacing_error_deg") or 0.0) / 60.0), 0.1, 0.99)),
            status="detected",
            source_fields=["sinus_section", "annulus_plane"],
        ),
        "sinotubular_junction": _structure_meta(
            method="diameter_profile_local_minimum",
            confidence=1.0,
            status="detected",
            source_fields=["centerline_profile", "orthogonal_sections"],
        ),
        "ascending_aorta_axis": _structure_meta(
            method="landmark_axis_join",
            confidence=1.0,
            status="detected",
            source_fields=["stj_section", "ascending_reference_section"],
        ),
        "centerline": _structure_meta(
            method=str(centerline_method or "geometry_centerline"),
            confidence=1.0,
            status="detected",
            source_fields=["lumen_mask", "distance_transform", "skeleton_mask"],
            notes=["fallback may occur for poor lumen topology"],
        ),
        "coronary_ostia": {
            "left": _structure_meta("not_evaluated", 0.0, status="not_evaluated"),
            "right": _structure_meta("not_evaluated", 0.0, status="not_evaluated"),
        },
        "leaflet_geometry": _structure_meta("not_attached", 0.0, status="not_evaluated"),
    }
    model = AorticRootComputationalModel(
        model_type="AorticRootComputationalModel-v3",
        annulus_ring=annulus_ring,
        hinge_curve=hinge_curve,
        commissures=commissures,
        sinus_peaks=sinus_peaks,
        sinotubular_junction=stj_ring,
        coronary_ostia=coronary_ostia,
        ascending_axis=ascending_axis,
        ascending_aorta_axis=ascending_axis,
        centerline=centerline,
        structure_metadata=structure_metadata,
        raw_landmarks=raw_landmarks,
        regularized_landmarks=regularized_landmarks,
        raw_measurements={},
        regularized_measurements={},
        phase_metadata={},
        provenance={
            "computational_model_contract": "raw_plus_regularized_non_destructive",
            "landmark_strategy": "geometry_model_driven_v3",
            "measurement_strategy": "geometry_model_driven_v3",
            "constraint_policy": "preserve_raw_emit_regularized_copy",
        },
        anatomical_constraints={},
        confidence_scores={},
        reference_sections={
            "annulus": annulus_ring,
            "sinus": sinus_ring,
            "stj": stj_ring,
            "ascending": ascending_ring,
            "geometry_stats": geometry_stats,
            "raw_geometry_stats": raw_geometry_bundle.get("geometry_stats", {}),
        },
        annulus_plane=annulus_plane,
        leaflet_geometry={},
        leaflet_meshes=[],
        digital_twin_simulation={},
    )
    model.anatomical_constraints = build_anatomical_constraints(model)
    model.confidence_scores = build_confidence_scores(model)
    return model
