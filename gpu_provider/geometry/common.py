from __future__ import annotations

import math
from dataclasses import asdict, is_dataclass
from typing import Any

import nibabel as nib
import numpy as np
from scipy import ndimage


def normalize(v: np.ndarray) -> np.ndarray:
    arr = np.asarray(v, dtype=np.float64)
    n = float(np.linalg.norm(arr))
    if not np.isfinite(n) or n <= 1e-8:
        return np.array([0.0, 0.0, 1.0], dtype=np.float64)
    return (arr / n).astype(np.float64)


def mm_to_vox_xy(mm: float, spacing_mm: tuple[float, float, float]) -> int:
    step = max(0.2, float(min(spacing_mm[0], spacing_mm[1])))
    return max(1, int(round(float(mm) / step)))


def mm_to_vox_z(mm: float, spacing_mm: tuple[float, float, float]) -> int:
    step = max(0.2, float(spacing_mm[2]))
    return max(1, int(round(float(mm) / step)))


def voxel_volume_mm3(spacing_mm: tuple[float, float, float]) -> float:
    return float(spacing_mm[0] * spacing_mm[1] * spacing_mm[2])


def points_voxel_to_world(points_ijk: np.ndarray, affine: np.ndarray) -> np.ndarray:
    pts = np.asarray(points_ijk, dtype=np.float64)
    if pts.size == 0:
        return np.zeros((0, 3), dtype=np.float64)
    return nib.affines.apply_affine(affine, pts)


def points_world_to_voxel(points_xyz: np.ndarray, affine_inv: np.ndarray) -> np.ndarray:
    pts = np.asarray(points_xyz, dtype=np.float64)
    if pts.size == 0:
        return np.zeros((0, 3), dtype=np.float64)
    return nib.affines.apply_affine(affine_inv, pts)


def keep_largest_component(mask: np.ndarray) -> np.ndarray:
    if not np.any(mask):
        return np.asarray(mask, dtype=bool)
    lab, num = ndimage.label(mask)
    if num <= 1:
        return np.asarray(mask, dtype=bool)
    counts = np.bincount(lab.ravel())
    counts[0] = 0
    keep = int(np.argmax(counts))
    return lab == keep


def remove_small_components(mask: np.ndarray, min_voxels: int) -> np.ndarray:
    if not np.any(mask):
        return np.asarray(mask, dtype=bool)
    lab, _ = ndimage.label(mask)
    counts = np.bincount(lab.ravel())
    keep = np.where(counts >= max(1, int(min_voxels)))[0]
    keep = keep[keep != 0]
    if keep.size == 0:
        return np.zeros_like(mask, dtype=bool)
    return np.isin(lab, keep)


def mask_bounding_box(mask: np.ndarray, margin_vox: int | tuple[int, int, int] = 0) -> tuple[slice, slice, slice]:
    arr = np.asarray(mask, dtype=bool)
    if not np.any(arr):
        return (slice(0, arr.shape[0]), slice(0, arr.shape[1]), slice(0, arr.shape[2]))
    coords = np.argwhere(arr)
    mins = coords.min(axis=0).astype(int)
    maxs = coords.max(axis=0).astype(int) + 1
    if isinstance(margin_vox, int):
        margin = np.array([margin_vox, margin_vox, margin_vox], dtype=int)
    else:
        margin = np.asarray(margin_vox, dtype=int)
    mins = np.maximum(0, mins - margin)
    maxs = np.minimum(np.asarray(arr.shape, dtype=int), maxs + margin)
    return tuple(slice(int(mins[i]), int(maxs[i])) for i in range(3))


def crop_to_bbox(arr: np.ndarray, bbox: tuple[slice, slice, slice]) -> np.ndarray:
    return np.asarray(arr[bbox])


def paste_bbox(cropped: np.ndarray, bbox: tuple[slice, slice, slice], shape: tuple[int, int, int], dtype: Any | None = None) -> np.ndarray:
    out = np.zeros(shape, dtype=dtype or cropped.dtype)
    out[bbox] = cropped
    return out


def smooth_binary_mask(mask: np.ndarray, spacing_mm: tuple[float, float, float], sigma_mm: float = 0.8) -> np.ndarray:
    if not np.any(mask):
        return np.asarray(mask, dtype=bool)
    dt_in = ndimage.distance_transform_edt(mask, sampling=spacing_mm)
    dt_out = ndimage.distance_transform_edt(~mask, sampling=spacing_mm)
    sdf = dt_in - dt_out
    sigma = [max(0.25, float(sigma_mm) / max(0.2, float(s))) for s in spacing_mm]
    sdf_s = ndimage.gaussian_filter(sdf, sigma=sigma)
    return sdf_s > 0.0


def affine_to_spacing(nii: nib.Nifti1Image) -> tuple[float, float, float]:
    zooms = nii.header.get_zooms()[:3]
    return tuple(float(z) for z in zooms)


def orth_basis_from_tangent(tangent_world: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    t = normalize(tangent_world)
    ref = np.array([0.0, 0.0, 1.0], dtype=np.float64)
    if abs(float(np.dot(t, ref))) > 0.9:
        ref = np.array([1.0, 0.0, 0.0], dtype=np.float64)
    u = normalize(np.cross(t, ref))
    v = normalize(np.cross(t, u))
    return u, v


def cumulative_arclength(points_world: np.ndarray) -> np.ndarray:
    pts = np.asarray(points_world, dtype=np.float64)
    if pts.shape[0] == 0:
        return np.zeros((0,), dtype=np.float64)
    if pts.shape[0] == 1:
        return np.array([0.0], dtype=np.float64)
    seg = np.linalg.norm(pts[1:] - pts[:-1], axis=1)
    out = np.zeros((pts.shape[0],), dtype=np.float64)
    out[1:] = np.cumsum(seg)
    return out


def tangents_from_polyline(points_world: np.ndarray) -> np.ndarray:
    pts = np.asarray(points_world, dtype=np.float64)
    if pts.shape[0] == 0:
        return np.zeros((0, 3), dtype=np.float64)
    if pts.shape[0] == 1:
        return np.array([[0.0, 0.0, 1.0]], dtype=np.float64)
    out = np.zeros_like(pts)
    for i in range(pts.shape[0]):
        i0 = max(0, i - 1)
        i1 = min(pts.shape[0] - 1, i + 1)
        out[i] = normalize(pts[i1] - pts[i0])
    return out


def ellipse_perimeter_from_diameters(long_diameter_mm: float | None, short_diameter_mm: float | None) -> float | None:
    if long_diameter_mm is None or short_diameter_mm is None:
        return None
    if long_diameter_mm <= 0 or short_diameter_mm <= 0:
        return None
    a = max(long_diameter_mm, short_diameter_mm) * 0.5
    b = min(long_diameter_mm, short_diameter_mm) * 0.5
    term = max(0.0, (3.0 * a + b) * (a + 3.0 * b))
    return float(math.pi * (3.0 * (a + b) - math.sqrt(term)))


def plane_signed_distance(point_world: np.ndarray, origin_world: np.ndarray, normal_world: np.ndarray) -> float:
    p = np.asarray(point_world, dtype=np.float64)
    o = np.asarray(origin_world, dtype=np.float64)
    n = normalize(normal_world)
    return float(np.dot(p - o, n))


def sanitize_for_json(value: Any) -> Any:
    if is_dataclass(value):
        return sanitize_for_json(asdict(value))
    if isinstance(value, dict):
        return {str(k): sanitize_for_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize_for_json(v) for v in value]
    if isinstance(value, tuple):
        return [sanitize_for_json(v) for v in value]
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return float(value)
    return value
