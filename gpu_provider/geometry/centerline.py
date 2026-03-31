from __future__ import annotations

import heapq
import math
from dataclasses import dataclass
from typing import Any

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


def _dijkstra_to_target(
    start: int,
    end: int,
    adj: list[list[tuple[int, float, float]]],
) -> tuple[np.ndarray, np.ndarray]:
    n = len(adj)
    dist = np.full((n,), np.inf, dtype=np.float64)
    prev = np.full((n,), -1, dtype=np.int32)
    dist[start] = 0.0
    heap: list[tuple[float, int]] = [(0.0, start)]
    while heap:
        cur_d, u = heapq.heappop(heap)
        if cur_d > dist[u] + 1e-9:
            continue
        if u == end:
            break
        for v, step, radius_weight in adj[u]:
            edge_cost = float(step / max(0.35, radius_weight))
            nd = cur_d + edge_cost
            if nd + 1e-9 < dist[v]:
                dist[v] = nd
                prev[v] = u
                heapq.heappush(heap, (nd, v))
    return dist, prev


def _reconstruct_path(end: int, prev: np.ndarray) -> list[int]:
    path: list[int] = []
    cur = int(end)
    while cur >= 0:
        path.append(cur)
        cur = int(prev[cur])
    path.reverse()
    return path


def _principal_axis(points: np.ndarray, spacing_mm: tuple[float, float, float]) -> np.ndarray:
    pts = np.asarray(points, dtype=np.float64)
    if pts.shape[0] < 3:
        return np.array([0.0, 0.0, 1.0], dtype=np.float64)
    pts_mm = pts * np.asarray(spacing_mm, dtype=np.float64)[None, :]
    centered = pts_mm - pts_mm.mean(axis=0, keepdims=True)
    try:
        _, _, vh = np.linalg.svd(centered, full_matrices=False)
        axis = np.asarray(vh[0], dtype=np.float64)
    except Exception:
        span = pts_mm.max(axis=0) - pts_mm.min(axis=0)
        axis = np.zeros((3,), dtype=np.float64)
        axis[int(np.argmax(span))] = 1.0
    axis_n = float(np.linalg.norm(axis))
    if axis_n <= 1e-8:
        return np.array([0.0, 0.0, 1.0], dtype=np.float64)
    return axis / axis_n


def _pick_anchor_indices(
    points: np.ndarray,
    degree: list[int],
    radii_mm: np.ndarray,
    spacing_mm: tuple[float, float, float],
) -> tuple[int, int]:
    pts = np.asarray(points, dtype=np.float64)
    axis = _principal_axis(pts, spacing_mm)
    pts_mm = pts * np.asarray(spacing_mm, dtype=np.float64)[None, :]
    proj = (pts_mm - pts_mm.mean(axis=0, keepdims=True)) @ axis
    endpoints = np.asarray([i for i, d in enumerate(degree) if d <= 1], dtype=np.int32)
    candidates = endpoints if endpoints.size >= 2 else np.arange(pts.shape[0], dtype=np.int32)
    cand_proj = proj[candidates]
    low_cut = float(np.percentile(cand_proj, 15.0))
    high_cut = float(np.percentile(cand_proj, 85.0))
    low_candidates = candidates[cand_proj <= low_cut]
    high_candidates = candidates[cand_proj >= high_cut]
    if low_candidates.size == 0:
        low_candidates = candidates[np.argsort(cand_proj)[: max(1, min(6, candidates.size))]]
    if high_candidates.size == 0:
        high_candidates = candidates[np.argsort(cand_proj)[-max(1, min(6, candidates.size)) :]]

    start = int(low_candidates[np.argmax(radii_mm[low_candidates])])
    end = int(high_candidates[np.argmax(radii_mm[high_candidates])])
    if start == end:
        order = np.argsort(cand_proj)
        start = int(candidates[order[0]])
        end = int(candidates[order[-1]])
    return start, end


def extract_topology_centerline_path(
    skeleton_mask: np.ndarray,
    distance_map_mm: np.ndarray,
    spacing_mm: tuple[float, float, float],
) -> tuple[np.ndarray, str]:
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

    adj_basic, degree = _skeleton_graph(points, spacing_mm)
    point_radii = distance_map_mm[points[:, 0], points[:, 1], points[:, 2]].astype(np.float64)
    start, end = _pick_anchor_indices(points, degree, point_radii, spacing_mm)
    adj: list[list[tuple[int, float, float]]] = [[] for _ in range(len(adj_basic))]
    for i, edges in enumerate(adj_basic):
        for j, step in edges:
            radius_weight = float((point_radii[i] + point_radii[j]) * 0.5)
            adj[i].append((j, float(step), radius_weight))
    dist, prev = _dijkstra_to_target(start, end, adj)
    if not np.isfinite(dist[end]):
        far_a, _, _ = _dijkstra_farthest(start, [[(j, s) for (j, s, _r) in edges] for edges in adj])
        far_b, _, prev_longest = _dijkstra_farthest(far_a, [[(j, s) for (j, s, _r) in edges] for edges in adj])
        path_idx = _reconstruct_path(far_b, prev_longest)
        method = "skeleton_longest_path_fallback"
    else:
        path_idx = _reconstruct_path(end, prev)
        method = "minimum_cost_skeleton_path"
    if len(path_idx) < 2:
        return np.zeros((0, 3), dtype=np.float64), "skeleton_path_failed"
    return points[np.asarray(path_idx, dtype=np.int32)].astype(np.float64), method


def _pick_lumen_extreme_seed(
    lumen_mask: np.ndarray,
    distance_map_mm: np.ndarray,
    spacing_mm: tuple[float, float, float],
    side: str,
) -> np.ndarray:
    coords = np.argwhere(lumen_mask)
    if coords.shape[0] == 0:
        return np.zeros((3,), dtype=np.int32)
    axis = _principal_axis(coords, spacing_mm)
    coords_mm = coords * np.asarray(spacing_mm, dtype=np.float64)[None, :]
    proj = (coords_mm - coords_mm.mean(axis=0, keepdims=True)) @ axis
    q = 8.0 if side == "low" else 92.0
    thr = float(np.percentile(proj, q))
    if side == "low":
        candidates = coords[proj <= thr]
    else:
        candidates = coords[proj >= thr]
    if candidates.shape[0] == 0:
        candidates = coords
    cand_r = distance_map_mm[candidates[:, 0], candidates[:, 1], candidates[:, 2]]
    return np.asarray(candidates[int(np.argmax(cand_r))], dtype=np.int32)


def minimum_cost_lumen_path(
    lumen_mask: np.ndarray,
    distance_map_mm: np.ndarray,
    spacing_mm: tuple[float, float, float],
) -> tuple[np.ndarray, str]:
    if not np.any(lumen_mask):
        return np.zeros((0, 3), dtype=np.float64), "lumen_empty"
    shape = lumen_mask.shape
    start = _pick_lumen_extreme_seed(lumen_mask, distance_map_mm, spacing_mm, "low")
    end = _pick_lumen_extreme_seed(lumen_mask, distance_map_mm, spacing_mm, "high")
    start_idx = int(np.ravel_multi_index(tuple(int(v) for v in start), shape))
    end_idx = int(np.ravel_multi_index(tuple(int(v) for v in end), shape))
    total = int(np.prod(shape))
    dist = np.full((total,), np.inf, dtype=np.float64)
    prev = np.full((total,), -1, dtype=np.int32)
    dist[start_idx] = 0.0
    heap: list[tuple[float, int]] = [(0.0, start_idx)]

    while heap:
        cur_d, flat = heapq.heappop(heap)
        if cur_d > dist[flat] + 1e-9:
            continue
        if flat == end_idx:
            break
        x, y, z = np.unravel_index(flat, shape)
        for ox, oy, oz in OFFSETS:
            nx = x + ox
            ny = y + oy
            nz = z + oz
            if nx < 0 or ny < 0 or nz < 0 or nx >= shape[0] or ny >= shape[1] or nz >= shape[2]:
                continue
            if not bool(lumen_mask[nx, ny, nz]):
                continue
            nflat = int(np.ravel_multi_index((nx, ny, nz), shape))
            step = math.sqrt((ox * spacing_mm[0]) ** 2 + (oy * spacing_mm[1]) ** 2 + (oz * spacing_mm[2]) ** 2)
            local_radius = float((distance_map_mm[x, y, z] + distance_map_mm[nx, ny, nz]) * 0.5)
            nd = cur_d + (step / max(0.35, local_radius))
            if nd + 1e-9 < dist[nflat]:
                dist[nflat] = nd
                prev[nflat] = flat
                heapq.heappush(heap, (nd, nflat))

    if not np.isfinite(dist[end_idx]):
        return np.zeros((0, 3), dtype=np.float64), "minimum_cost_lumen_path_failed"

    path_flat: list[int] = []
    cur = end_idx
    while cur >= 0:
        path_flat.append(cur)
        cur = int(prev[cur])
    path_flat.reverse()
    points = np.asarray([np.unravel_index(idx, shape) for idx in path_flat], dtype=np.float64)
    return points, "minimum_cost_lumen_path"


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


def compute_centerline_quality(
    result: CenterlineResult,
    lumen_mask: np.ndarray,
    spacing_mm: tuple[float, float, float],
) -> dict[str, Any]:
    del lumen_mask, spacing_mm
    point_count = int(result.points_world.shape[0])
    total_length_mm = float(result.s_mm[-1]) if result.s_mm.size > 0 else 0.0
    mean_radius_mm = float(np.mean(result.radii_mm)) if result.radii_mm.size > 0 else 0.0
    min_radius_mm = float(np.min(result.radii_mm)) if result.radii_mm.size > 0 else 0.0

    tangents = np.asarray(result.tangents_world, dtype=np.float64)
    if tangents.shape[0] >= 2:
        norms = np.linalg.norm(tangents, axis=1)
        valid = norms > 1e-8
        tangents_n = np.zeros_like(tangents, dtype=np.float64)
        tangents_n[valid] = tangents[valid] / norms[valid, None]
        pairwise = np.sum(tangents_n[:-1] * tangents_n[1:], axis=1)
        smoothness_score = float(np.clip(np.mean(pairwise), 0.0, 1.0)) if pairwise.size > 0 else 0.0
    else:
        smoothness_score = 0.0

    if point_count >= 20 and smoothness_score >= 0.95 and min_radius_mm >= 1.0:
        quality_flag = "good"
        uncertainty_flag = "NONE"
    elif point_count >= 10 and smoothness_score >= 0.85:
        quality_flag = "acceptable"
        uncertainty_flag = "LOW_CONFIDENCE"
    else:
        quality_flag = "poor"
        uncertainty_flag = "DETECTION_FAILED"

    return {
        "point_count": point_count,
        "total_length_mm": total_length_mm,
        "mean_radius_mm": mean_radius_mm,
        "min_radius_mm": min_radius_mm,
        "smoothness_score": smoothness_score,
        "method": result.method,
        "quality_flag": quality_flag,
        "uncertainty_flag": uncertainty_flag,
    }


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
    path_vox, path_method = extract_topology_centerline_path(skeleton_crop, distance_map_crop_mm, spacing_mm)

    if path_vox.shape[0] < 2:
        path_vox, path_method = minimum_cost_lumen_path(lumen_crop, distance_map_crop_mm, spacing_mm)
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
