from __future__ import annotations

import heapq
import math
from dataclasses import dataclass

import numpy as np
from scipy import interpolate, ndimage

from .common import (
    crop_to_bbox,
    cumulative_arclength,
    mask_bounding_box,
    normalize,
    paste_bbox,
    points_voxel_to_world,
    points_world_to_voxel,
    tangents_from_polyline,
)

try:
    from skimage import morphology
except Exception:  # pragma: no cover
    morphology = None


@dataclass
class CenterlineResult:
    method: str
    points_voxel: np.ndarray
    points_world: np.ndarray
    tangents_world: np.ndarray
    s_mm: np.ndarray
    radii_mm: np.ndarray
    distance_map_mm: np.ndarray
    skeleton_mask: np.ndarray


def _neighbor_offsets() -> list[tuple[int, int, int]]:
    out: list[tuple[int, int, int]] = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                if dx == 0 and dy == 0 and dz == 0:
                    continue
                out.append((dx, dy, dz))
    return out


OFFSETS = _neighbor_offsets()


def compute_distance_transform(lumen_mask: np.ndarray, spacing_mm: tuple[float, float, float]) -> np.ndarray:
    return ndimage.distance_transform_edt(lumen_mask.astype(bool), sampling=spacing_mm).astype(np.float32)


def skeletonize_volume(lumen_mask: np.ndarray, distance_map_mm: np.ndarray) -> tuple[np.ndarray, str]:
    mask = np.asarray(lumen_mask, dtype=bool)
    if not np.any(mask):
        return np.zeros_like(mask, dtype=bool), "empty"

    skeleton = np.zeros_like(mask, dtype=bool)
    method = "distance_ridge"
    if morphology is not None:
        try:
            skeleton = morphology.skeletonize(mask, method="lee")
            method = "distance_transform_skeleton"
        except Exception:
            skeleton = np.zeros_like(mask, dtype=bool)

    if not np.any(skeleton):
        local_max = ndimage.maximum_filter(distance_map_mm, size=3, mode="nearest")
        skeleton = mask & (distance_map_mm >= (local_max - 1e-4)) & (distance_map_mm > 0.0)
        method = "distance_ridge"

    skeleton = ndimage.binary_opening(skeleton, structure=np.ones((3, 3, 3), dtype=bool), iterations=1)
    if not np.any(skeleton):
        skeleton = mask & (distance_map_mm > np.percentile(distance_map_mm[mask], 70.0))
        method = "distance_core_fallback"
    return np.asarray(skeleton, dtype=bool), method


def _skeleton_graph(points: np.ndarray, spacing_mm: tuple[float, float, float]) -> tuple[list[list[tuple[int, float]]], list[int]]:
    pts = np.asarray(points, dtype=np.int32)
    lut = {tuple(int(v) for v in p): i for i, p in enumerate(pts)}
    adj: list[list[tuple[int, float]]] = [[] for _ in range(pts.shape[0])]
    degree = [0 for _ in range(pts.shape[0])]
    for i, p in enumerate(pts):
        px, py, pz = int(p[0]), int(p[1]), int(p[2])
        for ox, oy, oz in OFFSETS:
            key = (px + ox, py + oy, pz + oz)
            j = lut.get(key)
            if j is None or j <= i:
                continue
            step = math.sqrt((ox * spacing_mm[0]) ** 2 + (oy * spacing_mm[1]) ** 2 + (oz * spacing_mm[2]) ** 2)
            adj[i].append((j, step))
            adj[j].append((i, step))
            degree[i] += 1
            degree[j] += 1
    return adj, degree


def _dijkstra_farthest(start: int, adj: list[list[tuple[int, float]]]) -> tuple[int, np.ndarray, np.ndarray]:
    n = len(adj)
    dist = np.full((n,), np.inf, dtype=np.float64)
    prev = np.full((n,), -1, dtype=np.int32)
    dist[start] = 0.0
    heap: list[tuple[float, int]] = [(0.0, start)]
    while heap:
        cur_d, u = heapq.heappop(heap)
        if cur_d > dist[u] + 1e-9:
            continue
        for v, w in adj[u]:
            nd = cur_d + float(w)
            if nd + 1e-9 < dist[v]:
                dist[v] = nd
                prev[v] = u
                heapq.heappush(heap, (nd, v))
    end = int(np.nanargmax(np.where(np.isfinite(dist), dist, -1.0)))
    return end, dist, prev


def _reconstruct_path(end: int, prev: np.ndarray) -> list[int]:
    path: list[int] = []
    cur = int(end)
    while cur >= 0:
        path.append(cur)
        cur = int(prev[cur])
    path.reverse()
    return path


def extract_longest_skeleton_path(skeleton_mask: np.ndarray, spacing_mm: tuple[float, float, float]) -> tuple[np.ndarray, str]:
    if not np.any(skeleton_mask):
        return np.zeros((0, 3), dtype=np.float64), "skeleton_empty"

    lab, num = ndimage.label(skeleton_mask)
    if num > 1:
        counts = np.bincount(lab.ravel())
        counts[0] = 0
        keep = int(np.argmax(counts))
        skeleton_mask = lab == keep

    points = np.argwhere(skeleton_mask)
    if points.shape[0] < 2:
        return np.zeros((0, 3), dtype=np.float64), "skeleton_too_small"

    adj, degree = _skeleton_graph(points, spacing_mm)
    endpoints = [i for i, d in enumerate(degree) if d <= 1]
    if not endpoints:
        start = 0
    else:
        start = endpoints[0]
    far_a, _, _ = _dijkstra_farthest(start, adj)
    far_b, _, prev = _dijkstra_farthest(far_a, adj)
    path_idx = _reconstruct_path(far_b, prev)
    if len(path_idx) < 2:
        return np.zeros((0, 3), dtype=np.float64), "skeleton_path_failed"
    return points[np.asarray(path_idx, dtype=np.int32)].astype(np.float64), "skeleton_longest_path"


def distance_ridge_track(lumen_mask: np.ndarray, distance_map_mm: np.ndarray) -> np.ndarray:
    nz = int(lumen_mask.shape[2])
    raw: list[list[float]] = []
    prev_xy: np.ndarray | None = None
    for z in range(nz):
        sl = lumen_mask[:, :, z]
        if not np.any(sl):
            continue
        dist_sl = distance_map_mm[:, :, z] * sl.astype(np.float32)
        if float(dist_sl.max()) <= 0.0:
            continue
        cand = np.argwhere(dist_sl >= float(dist_sl.max()) - 1e-4)
        if cand.shape[0] == 0:
            continue
        if prev_xy is None:
            pick = cand.mean(axis=0)
        else:
            d = np.linalg.norm(cand.astype(np.float64) - prev_xy[None, :], axis=1)
            pick = cand[int(np.argmin(d))].astype(np.float64)
        prev_xy = np.asarray(pick, dtype=np.float64)
        raw.append([float(pick[0]), float(pick[1]), float(z)])
    if len(raw) < 2:
        return np.zeros((0, 3), dtype=np.float64)
    pts = np.asarray(raw, dtype=np.float64)
    x_s = ndimage.gaussian_filter1d(pts[:, 0], sigma=1.0)
    y_s = ndimage.gaussian_filter1d(pts[:, 1], sigma=1.0)
    return np.column_stack([x_s, y_s, pts[:, 2]]).astype(np.float64)


def fit_centerline_spline(points_voxel: np.ndarray, affine: np.ndarray, step_mm: float = 1.2) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    pts_vox = np.asarray(points_voxel, dtype=np.float64)
    if pts_vox.shape[0] < 2:
        pts_world = points_voxel_to_world(pts_vox, affine)
        return pts_vox, pts_world, cumulative_arclength(pts_world)

    affine_inv = np.linalg.inv(affine)
    pts_world = points_voxel_to_world(pts_vox, affine)
    s = cumulative_arclength(pts_world)
    total = float(s[-1])
    if not np.isfinite(total) or total <= 1e-6:
        return pts_vox, pts_world, s

    sample_count = max(2, int(math.ceil(total / max(0.4, step_mm))) + 1)
    s_new = np.linspace(0.0, total, sample_count, dtype=np.float64)

    if pts_world.shape[0] >= 4:
        try:
            k = min(3, pts_world.shape[0] - 1)
            tck, _ = interpolate.splprep([pts_world[:, 0], pts_world[:, 1], pts_world[:, 2]], u=s / total, s=0.8, k=k)
            xs, ys, zs = interpolate.splev(s_new / total, tck)
            world_new = np.column_stack([xs, ys, zs]).astype(np.float64)
            vox_new = points_world_to_voxel(world_new, affine_inv)
            return vox_new, world_new, s_new
        except Exception:
            pass

    vox_new = np.column_stack([
        np.interp(s_new, s, pts_vox[:, 0]),
        np.interp(s_new, s, pts_vox[:, 1]),
        np.interp(s_new, s, pts_vox[:, 2]),
    ]).astype(np.float64)
    world_new = points_voxel_to_world(vox_new, affine)
    return vox_new, world_new, s_new


def sample_radii(distance_map_mm: np.ndarray, points_voxel: np.ndarray) -> np.ndarray:
    if points_voxel.shape[0] == 0:
        return np.zeros((0,), dtype=np.float64)
    coords = np.vstack([points_voxel[:, 0], points_voxel[:, 1], points_voxel[:, 2]])
    radii = ndimage.map_coordinates(distance_map_mm.astype(np.float32), coords, order=1, mode="nearest")
    return np.asarray(radii, dtype=np.float64)


def compute_centerline(
    lumen_mask: np.ndarray,
    affine: np.ndarray,
    spacing_mm: tuple[float, float, float],
    sample_step_mm: float = 1.2,
) -> CenterlineResult:
    bbox = mask_bounding_box(
        lumen_mask,
        margin_vox=(
            max(3, int(round(6.0 / max(0.3, float(spacing_mm[0]))))),
            max(3, int(round(6.0 / max(0.3, float(spacing_mm[1]))))),
            max(2, int(round(6.0 / max(0.3, float(spacing_mm[2]))))),
        ),
    )
    lumen_crop = crop_to_bbox(lumen_mask, bbox)
    distance_map_crop_mm = compute_distance_transform(lumen_crop, spacing_mm)
    skeleton_crop, method = skeletonize_volume(lumen_crop, distance_map_crop_mm)
    path_vox, path_method = extract_longest_skeleton_path(skeleton_crop, spacing_mm)

    if path_vox.shape[0] < 2:
        path_vox = distance_ridge_track(lumen_crop, distance_map_crop_mm)
        method = f"{method}+distance_ridge_track"
    else:
        method = f"{method}+{path_method}"

    if path_vox.shape[0] < 2:
        raise RuntimeError("geometry_centerline_failed")

    bbox_offset = np.array(
        [bbox[0].start or 0, bbox[1].start or 0, bbox[2].start or 0],
        dtype=np.float64,
    )
    path_vox = path_vox + bbox_offset

    points_voxel, points_world, s_mm = fit_centerline_spline(path_vox, affine, step_mm=sample_step_mm)
    tangents_world = tangents_from_polyline(points_world)
    distance_map_mm = paste_bbox(distance_map_crop_mm, bbox, lumen_mask.shape, dtype=np.float32)
    radii_mm = sample_radii(distance_map_mm, points_voxel)
    skeleton_mask = paste_bbox(skeleton_crop, bbox, lumen_mask.shape, dtype=bool)

    return CenterlineResult(
        method=method,
        points_voxel=points_voxel,
        points_world=points_world,
        tangents_world=tangents_world,
        s_mm=s_mm,
        radii_mm=radii_mm,
        distance_map_mm=distance_map_mm,
        skeleton_mask=skeleton_mask,
    )
