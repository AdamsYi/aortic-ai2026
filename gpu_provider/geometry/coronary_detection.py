from __future__ import annotations

from typing import Any

import nibabel as nib
import numpy as np
from scipy import ndimage

from .common import mm_to_vox_xy, mm_to_vox_z, plane_signed_distance
from .profile_analysis import SectionMetrics

try:
    from skimage.filters import frangi
except Exception:  # pragma: no cover
    frangi = None

try:
    from skimage import morphology
except Exception:  # pragma: no cover
    morphology = None


def _frangi_volume(ct_hu: np.ndarray) -> np.ndarray:
    vol = np.asarray(ct_hu, dtype=np.float32)
    vol_n = np.clip((vol - 50.0) / 450.0, 0.0, 1.0)
    if frangi is None:
        return vol_n
    try:
        return frangi(vol_n, sigmas=(0.8, 1.2, 1.8), alpha=0.5, beta=0.5, gamma=12.0, black_ridges=False).astype(np.float32)
    except Exception:
        return vol_n


def _component_skeleton_length(mask: np.ndarray) -> int:
    comp = np.asarray(mask, dtype=bool)
    if not np.any(comp):
        return 0
    if morphology is None:
        return int(comp.sum())
    try:
        skel = morphology.skeletonize(comp, method="lee")
        return int(np.count_nonzero(skel))
    except Exception:
        return int(comp.sum())


def _empty_side(status: str) -> dict[str, Any]:
    return {
        "status": status,
        "height_mm": None,
        "confidence": 0.0,
        "ostium_world": None,
        "ostium_voxel": None,
    }


def _finalize_side(candidate: dict[str, Any] | None) -> dict[str, Any]:
    if candidate is None:
        return _empty_side("not_found")
    confidence = float(candidate.get("confidence", 0.0))
    out = dict(candidate)
    out["status"] = "detected" if confidence >= 0.55 else "uncertain"
    return out


def detect_coronary_ostia(
    ct_hu: np.ndarray,
    lumen_mask: np.ndarray,
    annulus_plane: dict[str, Any],
    landmark_sections: dict[str, SectionMetrics | None],
    spacing_mm: tuple[float, float, float],
    affine: np.ndarray,
) -> dict[str, Any]:
    annulus = landmark_sections.get("annulus")
    stj = landmark_sections.get("stj")
    sinus = landmark_sections.get("sinus")
    if annulus is None or stj is None or sinus is None:
        return {"left": _empty_side("not_found"), "right": _empty_side("not_found"), "detected": [], "method": "frangi_branch_wall_intersection"}

    centers = np.vstack([annulus.center_voxel, sinus.center_voxel, stj.center_voxel]).astype(np.float64)
    x0 = max(0, int(np.floor(np.min(centers[:, 0]) - 64)))
    x1 = min(lumen_mask.shape[0], int(np.ceil(np.max(centers[:, 0]) + 65)))
    y0 = max(0, int(np.floor(np.min(centers[:, 1]) - 64)))
    y1 = min(lumen_mask.shape[1], int(np.ceil(np.max(centers[:, 1]) + 65)))
    z0 = max(0, int(round(min(annulus.center_voxel[2], sinus.center_voxel[2])) - mm_to_vox_z(4.0, spacing_mm)))
    z1 = min(lumen_mask.shape[2], int(round(max(stj.center_voxel[2], sinus.center_voxel[2])) + mm_to_vox_z(18.0, spacing_mm) + 1))

    lumen_roi = np.asarray(lumen_mask[x0:x1, y0:y1, z0:z1], dtype=bool)
    ct_roi = np.asarray(ct_hu[x0:x1, y0:y1, z0:z1], dtype=np.float32)
    roi_crop = np.ones_like(lumen_roi, dtype=bool)

    shell_inner = ndimage.binary_dilation(lumen_roi, iterations=mm_to_vox_xy(1.5, spacing_mm)) & (~lumen_roi)
    shell_mid = ndimage.binary_dilation(lumen_roi, iterations=mm_to_vox_xy(1.0, spacing_mm))
    shell_outer = ndimage.binary_dilation(lumen_roi, iterations=mm_to_vox_xy(4.5, spacing_mm)) & (~shell_mid)
    search = roi_crop & shell_outer
    coords = np.argwhere(search)
    if coords.shape[0] == 0:
        return {"left": _empty_side("not_found"), "right": _empty_side("not_found"), "detected": [], "method": "frangi_branch_wall_intersection"}

    min_xyz = np.maximum(coords.min(axis=0) - np.array([12, 12, 2]), 0)
    max_xyz = np.minimum(coords.max(axis=0) + np.array([12, 12, 2]), np.array(lumen_roi.shape) - 1)
    xs = slice(int(min_xyz[0]), int(max_xyz[0]) + 1)
    ys = slice(int(min_xyz[1]), int(max_xyz[1]) + 1)
    zs = slice(int(min_xyz[2]), int(max_xyz[2]) + 1)

    ct_crop = ct_roi[xs, ys, zs]
    shell_inner_crop = shell_inner[xs, ys, zs]
    shell_outer_crop = shell_outer[xs, ys, zs]
    roi_crop = roi_crop[xs, ys, zs]
    vesselness_crop = _frangi_volume(ct_crop)
    cand_crop = roi_crop & shell_outer_crop & (ct_crop >= 140.0)
    if np.any(cand_crop):
        cand_scores = vesselness_crop[cand_crop]
        thr = float(np.percentile(cand_scores, 85.0)) if np.any(cand_scores > 0) else 0.05
        cand_crop &= vesselness_crop >= max(0.03, thr)
    cand_crop = ndimage.binary_opening(cand_crop, structure=np.ones((2, 2, 2), dtype=bool))
    cand_crop = ndimage.binary_closing(cand_crop, structure=np.ones((2, 2, 2), dtype=bool))

    lab, num = ndimage.label(cand_crop)
    if num == 0:
        return {"left": _empty_side("not_found"), "right": _empty_side("not_found"), "detected": [], "method": "frangi_branch_wall_intersection"}

    annulus_origin = np.asarray(annulus_plane.get("origin_world", annulus.center_world), dtype=np.float64)
    annulus_normal = np.asarray(annulus_plane.get("normal_world", annulus.tangent_world), dtype=np.float64)
    annulus_u = np.asarray(annulus_plane.get("basis_u_world", annulus.basis_u_world), dtype=np.float64)

    detected: list[dict[str, Any]] = []
    for cid in range(1, num + 1):
        pts = np.argwhere(lab == cid)
        if pts.shape[0] < 10:
            continue
        wall_pts = pts[shell_inner_crop[pts[:, 0], pts[:, 1], pts[:, 2]]]
        local_pts = pts
        pts = pts + np.array([int(min_xyz[0]) + x0, int(min_xyz[1]) + y0, int(min_xyz[2]) + z0], dtype=np.int32)
        world = nib.affines.apply_affine(affine, pts.astype(np.float64))
        plane_h = np.asarray([plane_signed_distance(p, annulus_origin, annulus_normal) for p in world], dtype=np.float64)
        if float(np.max(plane_h)) < 0.5:
            continue
        local_pts = pts - np.array([x0 + int(min_xyz[0]), y0 + int(min_xyz[1]), z0 + int(min_xyz[2])], dtype=np.int32)
        score = vesselness_crop[local_pts[:, 0], local_pts[:, 1], local_pts[:, 2]]
        if wall_pts.shape[0] > 0:
            wall_scores = vesselness_crop[wall_pts[:, 0], wall_pts[:, 1], wall_pts[:, 2]]
            wall_best_local = wall_pts[int(np.argmax(wall_scores))]
            best_local = wall_best_local
            best_global = best_local + np.array([x0 + int(min_xyz[0]), y0 + int(min_xyz[1]), z0 + int(min_xyz[2])], dtype=np.int32)
            ostium_world = nib.affines.apply_affine(affine, best_global.astype(np.float64))
            ostium_voxel = best_global.astype(np.float64)
            best_score = float(np.max(wall_scores)) if wall_scores.size else 0.0
        else:
            best_idx = int(np.argmax(score)) if score.size else 0
            best_global = pts[best_idx]
            ostium_world = world[best_idx]
            ostium_voxel = best_global.astype(np.float64)
            best_score = float(score[best_idx]) if score.size else 0.0
        height_mm = float(max(0.0, plane_signed_distance(ostium_world, annulus_origin, annulus_normal)))
        lateral = float(np.dot(ostium_world - annulus_origin, annulus_u))
        skeleton_len = _component_skeleton_length(lab == cid)
        wall_contact_ratio = float(wall_pts.shape[0] / max(1, local_pts.shape[0]))
        height_score = 1.0 - min(1.0, abs(height_mm - 12.0) / 15.0)
        confidence = float(
            np.clip(
                0.35 * min(1.0, best_score / 0.25 if best_score > 0 else 0.0)
                + 0.20 * min(1.0, pts.shape[0] / 120.0)
                + 0.20 * min(1.0, skeleton_len / 30.0)
                + 0.15 * min(1.0, wall_contact_ratio / 0.08)
                + 0.10 * max(0.0, height_score),
                0.0,
                0.99,
            )
        )
        detected.append(
            {
                "component_id": int(cid),
                "voxels": int(pts.shape[0]),
                "height_mm": height_mm,
                "lateral_score": lateral,
                "vesselness_score": best_score,
                "skeleton_length": int(skeleton_len),
                "wall_contact_ratio": wall_contact_ratio,
                "confidence": confidence,
                "ostium_world": [float(x) for x in ostium_world],
                "ostium_voxel": [float(x) for x in ostium_voxel],
            }
        )

    if not detected:
        return {"left": _empty_side("not_found"), "right": _empty_side("not_found"), "detected": [], "method": "frangi_branch_wall_intersection"}

    detected.sort(key=lambda x: (-float(x["confidence"]), -x["voxels"], x["height_mm"]))
    top = detected[:6]
    left_candidates = [item for item in top if float(item["lateral_score"]) <= 0.0]
    right_candidates = [item for item in top if float(item["lateral_score"]) >= 0.0]
    left = left_candidates[0] if left_candidates else (min(top, key=lambda x: x["lateral_score"]) if top else None)
    right = right_candidates[0] if right_candidates else (max(top, key=lambda x: x["lateral_score"]) if top else None)
    if left is not None and right is not None and left["component_id"] == right["component_id"]:
        right = right_candidates[1] if len(right_candidates) > 1 else (top[1] if len(top) > 1 else None)

    return {
        "left": _finalize_side(left),
        "right": _finalize_side(right),
        "detected": top,
        "method": "frangi_branch_wall_intersection",
    }
