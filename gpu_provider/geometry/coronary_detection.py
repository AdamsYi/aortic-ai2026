from __future__ import annotations

from typing import Any

import nibabel as nib
import numpy as np
from scipy import ndimage

from .common import mm_to_vox_xy, mm_to_vox_z, plane_signed_distance
from .landmarks import LandmarkDetectionResult
from .profile_analysis import SectionMetrics

try:
    from skimage.filters import frangi
except Exception:  # pragma: no cover
    frangi = None


def _frangi_volume(ct_hu: np.ndarray) -> np.ndarray:
    vol = np.asarray(ct_hu, dtype=np.float32)
    vol_n = np.clip((vol - 50.0) / 450.0, 0.0, 1.0)
    if frangi is None:
        return vol_n
    try:
        return frangi(vol_n, sigmas=(0.8, 1.2, 1.8), alpha=0.5, beta=0.5, gamma=12.0, black_ridges=False).astype(np.float32)
    except Exception:
        return vol_n


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
        return {"left": None, "right": None, "detected": [], "method": "frangi_branch_origin"}

    nz = lumen_mask.shape[2]
    z0 = max(0, int(round(min(annulus.center_voxel[2], sinus.center_voxel[2])) - mm_to_vox_z(4.0, spacing_mm)))
    z1 = min(nz - 1, int(round(max(stj.center_voxel[2], sinus.center_voxel[2])) + mm_to_vox_z(18.0, spacing_mm)))
    roi = np.zeros_like(lumen_mask, dtype=bool)
    roi[:, :, z0 : z1 + 1] = True

    shell = ndimage.binary_dilation(lumen_mask, iterations=mm_to_vox_xy(2.0, spacing_mm)) & (~lumen_mask)
    search = roi & shell
    coords = np.argwhere(search)
    if coords.shape[0] == 0:
        return {"left": None, "right": None, "detected": [], "method": "frangi_branch_origin"}

    min_xyz = np.maximum(coords.min(axis=0) - np.array([12, 12, 2]), 0)
    max_xyz = np.minimum(coords.max(axis=0) + np.array([12, 12, 2]), np.array(lumen_mask.shape) - 1)
    xs = slice(int(min_xyz[0]), int(max_xyz[0]) + 1)
    ys = slice(int(min_xyz[1]), int(max_xyz[1]) + 1)
    zs = slice(int(min_xyz[2]), int(max_xyz[2]) + 1)

    ct_crop = ct_hu[xs, ys, zs]
    shell_crop = shell[xs, ys, zs]
    roi_crop = roi[xs, ys, zs]
    vesselness_crop = _frangi_volume(ct_crop)
    cand_crop = roi_crop & shell_crop & (ct_crop >= 160.0)
    if np.any(cand_crop):
        cand_scores = vesselness_crop[cand_crop]
        thr = float(np.percentile(cand_scores, 85.0)) if np.any(cand_scores > 0) else 0.05
        cand_crop &= vesselness_crop >= max(0.03, thr)

    lab, num = ndimage.label(cand_crop)
    if num == 0:
        return {"left": None, "right": None, "detected": [], "method": "frangi_branch_origin"}

    annulus_origin = np.asarray(annulus_plane.get("origin_world", annulus.center_world), dtype=np.float64)
    annulus_normal = np.asarray(annulus_plane.get("normal_world", annulus.tangent_world), dtype=np.float64)
    annulus_u = np.asarray(annulus_plane.get("basis_u_world", annulus.basis_u_world), dtype=np.float64)

    detected: list[dict[str, Any]] = []
    for cid in range(1, num + 1):
        pts = np.argwhere(lab == cid)
        if pts.shape[0] < 10:
            continue
        pts = pts + np.array([int(min_xyz[0]), int(min_xyz[1]), int(min_xyz[2])], dtype=np.int32)
        world = nib.affines.apply_affine(affine, pts.astype(np.float64))
        plane_h = np.asarray([plane_signed_distance(p, annulus_origin, annulus_normal) for p in world], dtype=np.float64)
        if float(np.max(plane_h)) < 0.5:
            continue
        local_pts = pts - np.array([int(min_xyz[0]), int(min_xyz[1]), int(min_xyz[2])], dtype=np.int32)
        score = vesselness_crop[local_pts[:, 0], local_pts[:, 1], local_pts[:, 2]]
        best_idx = int(np.argmax(score)) if score.size else 0
        ostium_world = world[best_idx]
        ostium_voxel = pts[best_idx].astype(np.float64)
        height_mm = float(max(0.0, plane_signed_distance(ostium_world, annulus_origin, annulus_normal)))
        lateral = float(np.dot(ostium_world - annulus_origin, annulus_u))
        detected.append(
            {
                "component_id": int(cid),
                "voxels": int(pts.shape[0]),
                "height_mm": height_mm,
                "lateral_score": lateral,
                "vesselness_score": float(score[best_idx]) if score.size else 0.0,
                "ostium_world": [float(x) for x in ostium_world],
                "ostium_voxel": [float(x) for x in ostium_voxel],
            }
        )

    if not detected:
        return {"left": None, "right": None, "detected": [], "method": "frangi_branch_origin"}

    detected.sort(key=lambda x: (-x["voxels"], x["height_mm"]))
    top = detected[:6]
    left = min(top, key=lambda x: x["lateral_score"])
    right = max(top, key=lambda x: x["lateral_score"])
    if left["component_id"] == right["component_id"]:
        right = top[1] if len(top) > 1 else None

    return {
        "left": left,
        "right": right,
        "detected": top,
        "method": "frangi_branch_origin",
    }
