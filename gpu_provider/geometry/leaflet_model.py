from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import nibabel as nib
import numpy as np

from .common import normalize
from .lumen_mesh import SurfaceMesh, generate_surface_mesh
from .root_model import AorticRootModel


@dataclass
class LeafletSurface:
    leaflet_id: int
    name: str
    mesh: SurfaceMesh
    voxel_count: int
    geometric_height_mm: float | None
    effective_height_mm: float | None
    free_edge_height_mm: float | None
    raw_geometric_height_mm: float | None
    raw_effective_height_mm: float | None
    raw_free_edge_height_mm: float | None
    hinge_point_count: int
    status: str
    regularized: bool


@dataclass
class LeafletModel:
    mesh: SurfaceMesh
    leaflet_surfaces: list[LeafletSurface]
    coaptation_height_mm: float | None
    coaptation_surface_area_mm2: float | None
    coaptation_level_mm: float | None
    raw_coaptation_height_mm: float | None
    effective_height_mean_mm: float | None
    geometric_height_mean_mm: float | None
    root_symmetry_index: float | None
    hinge_lines: list[dict[str, Any]]
    commissures: list[dict[str, Any]]
    status: str
    regularization: dict[str, Any]


def _combine_meshes(meshes: list[SurfaceMesh]) -> SurfaceMesh:
    if not meshes:
        return SurfaceMesh(np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.int32), np.zeros((0, 3), dtype=np.float64))
    vertices: list[np.ndarray] = []
    faces: list[np.ndarray] = []
    normals: list[np.ndarray] = []
    offset = 0
    for mesh in meshes:
        if mesh.vertices_world.size == 0 or mesh.faces.size == 0:
            continue
        vertices.append(np.asarray(mesh.vertices_world, dtype=np.float64))
        faces.append(np.asarray(mesh.faces, dtype=np.int32) + offset)
        normals.append(np.asarray(mesh.normals_world, dtype=np.float64))
        offset += int(mesh.vertices_world.shape[0])
    if not vertices:
        return SurfaceMesh(np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.int32), np.zeros((0, 3), dtype=np.float64))
    return SurfaceMesh(
        vertices_world=np.vstack(vertices),
        faces=np.vstack(faces),
        normals_world=np.vstack(normals) if normals else np.zeros((0, 3), dtype=np.float64),
    )


def _circular_between(angle_deg: np.ndarray, start_deg: float, end_deg: float) -> np.ndarray:
    ang = np.mod(angle_deg, 360.0)
    start = float(start_deg) % 360.0
    end = float(end_deg) % 360.0
    if start <= end:
        return (ang >= start) & (ang <= end)
    return (ang >= start) | (ang <= end)


def _cropped_mask_and_affine(mask_coords: np.ndarray, full_shape: tuple[int, int, int], affine: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if mask_coords.shape[0] == 0:
        return np.zeros((0, 0, 0), dtype=bool), affine
    mins = np.maximum(0, mask_coords.min(axis=0) - np.array([1, 1, 1], dtype=np.int32))
    maxs = np.minimum(np.asarray(full_shape, dtype=np.int32), mask_coords.max(axis=0) + np.array([2, 2, 2], dtype=np.int32))
    cropped = np.zeros(tuple((maxs - mins).tolist()), dtype=bool)
    local = mask_coords - mins[None, :]
    cropped[local[:, 0], local[:, 1], local[:, 2]] = True
    world_origin = nib.affines.apply_affine(affine, mins.astype(np.float64))
    cropped_affine = affine.copy().astype(np.float64)
    cropped_affine[:3, 3] = world_origin
    return cropped, cropped_affine


def _mesh_for_coords(mask_coords: np.ndarray, full_shape: tuple[int, int, int], affine: np.ndarray) -> SurfaceMesh:
    if mask_coords.shape[0] < 8:
        return SurfaceMesh(np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.int32), np.zeros((0, 3), dtype=np.float64))
    cropped, cropped_affine = _cropped_mask_and_affine(mask_coords, full_shape, affine)
    return generate_surface_mesh(
        cropped,
        cropped_affine,
        laplacian_iterations=1,
        taubin_iterations=1,
        laplacian_lambda=0.18,
        taubin_lambda=0.22,
        taubin_mu=-0.24,
    )


def _fallback_leaflet_model(root_model: AorticRootModel) -> LeafletModel:
    annulus_ring = np.asarray(root_model.annulus_ring.get("contour_world", []), dtype=np.float64)
    commissures = root_model.commissures
    if annulus_ring.shape[0] < 12 or len(commissures) < 3:
        return LeafletModel(
            mesh=SurfaceMesh(np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.int32), np.zeros((0, 3), dtype=np.float64)),
            leaflet_surfaces=[],
            coaptation_height_mm=None,
            coaptation_surface_area_mm2=None,
            effective_height_mean_mm=None,
            geometric_height_mean_mm=None,
            root_symmetry_index=None,
            hinge_lines=[],
            commissures=commissures,
            status="not_available",
        )

    annulus_center = np.asarray(root_model.annulus_ring.get("center_world", [0.0, 0.0, 0.0]), dtype=np.float64)
    stj_center = np.asarray(root_model.sinotubular_junction.get("center_world", annulus_center.tolist()), dtype=np.float64)
    axis = stj_center - annulus_center
    axis_len = float(np.linalg.norm(axis))
    axis_dir = axis / axis_len if axis_len > 1e-8 else np.array([0.0, 0.0, 1.0], dtype=np.float64)
    coaptation_center = annulus_center + axis_dir * (0.48 * axis_len)

    vertices: list[np.ndarray] = []
    faces: list[list[int]] = []
    hinge_lines: list[dict[str, Any]] = []
    leaflet_surfaces: list[LeafletSurface] = []
    for i in range(3):
        comm_a = commissures[i]
        comm_b = commissures[(i + 1) % 3]
        a = int(comm_a.get("index", i * 24)) % annulus_ring.shape[0]
        b = int(comm_b.get("index", ((i + 1) * 24))) % annulus_ring.shape[0]
        if b <= a:
            arc = np.vstack([annulus_ring[a:], annulus_ring[: b + 1]])
        else:
            arc = annulus_ring[a : b + 1]
        if arc.shape[0] < 3:
            continue
        apex = (np.asarray(comm_a["world"], dtype=np.float64) + np.asarray(comm_b["world"], dtype=np.float64) + coaptation_center) / 3.0
        start = len(vertices)
        for p in arc:
            vertices.append(p)
        apex_idx = len(vertices)
        vertices.append(apex)
        for k in range(start, apex_idx - 1):
            faces.append([k, k + 1, apex_idx])
        hinge_lines.append({"leaflet_id": i + 1, "point_count": int(arc.shape[0]), "status": "fallback"})
        leaflet_surfaces.append(
            LeafletSurface(
                leaflet_id=i + 1,
                name=f"leaflet_{i + 1}",
                mesh=SurfaceMesh(np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.int32), np.zeros((0, 3), dtype=np.float64)),
                voxel_count=0,
                geometric_height_mm=float(axis_len * 0.48) if axis_len > 0 else None,
                effective_height_mm=float(axis_len * 0.42) if axis_len > 0 else None,
                free_edge_height_mm=float(axis_len * 0.48) if axis_len > 0 else None,
                raw_geometric_height_mm=float(axis_len * 0.48) if axis_len > 0 else None,
                raw_effective_height_mm=float(axis_len * 0.42) if axis_len > 0 else None,
                raw_free_edge_height_mm=float(axis_len * 0.48) if axis_len > 0 else None,
                hinge_point_count=int(arc.shape[0]),
                status="fallback",
                regularized=False,
            )
        )

    vertices_arr = np.asarray(vertices, dtype=np.float64) if vertices else np.zeros((0, 3), dtype=np.float64)
    faces_arr = np.asarray(faces, dtype=np.int32) if faces else np.zeros((0, 3), dtype=np.int32)
    normals = np.zeros((faces_arr.shape[0], 3), dtype=np.float64)
    if faces_arr.shape[0] > 0:
        v1 = vertices_arr[faces_arr[:, 0]]
        v2 = vertices_arr[faces_arr[:, 1]]
        v3 = vertices_arr[faces_arr[:, 2]]
        nn = np.cross(v2 - v1, v3 - v1)
        norm = np.linalg.norm(nn, axis=1)
        norm[norm <= 1e-8] = 1.0
        normals = nn / norm[:, None]
    heights = [s.effective_height_mm for s in leaflet_surfaces if s.effective_height_mm is not None]
    geo = [s.geometric_height_mm for s in leaflet_surfaces if s.geometric_height_mm is not None]
    return LeafletModel(
        mesh=SurfaceMesh(vertices_arr, faces_arr, normals),
        leaflet_surfaces=leaflet_surfaces,
        coaptation_height_mm=float(min(heights)) if heights else None,
        coaptation_surface_area_mm2=None,
        coaptation_level_mm=float(min(heights)) if heights else None,
        raw_coaptation_height_mm=float(min(heights)) if heights else None,
        effective_height_mean_mm=float(np.mean(heights)) if heights else None,
        geometric_height_mean_mm=float(np.mean(geo)) if geo else None,
        root_symmetry_index=None,
        hinge_lines=hinge_lines,
        commissures=commissures,
        status="fallback",
        regularization={"applied": False, "mode": "fallback_parametric"},
    )


def _project_height(point_world: np.ndarray, origin_world: np.ndarray, normal_world: np.ndarray) -> float:
    return float(np.dot(np.asarray(point_world, dtype=np.float64) - np.asarray(origin_world, dtype=np.float64), normalize(np.asarray(normal_world, dtype=np.float64))))


def _regularize_heights(
    raw_geometric_height_mm: float,
    raw_effective_height_mm: float,
    raw_free_edge_height_mm: float,
    commissure_height_mm: float | None,
    stj_height_mm: float,
) -> tuple[float, float, float, bool]:
    if commissure_height_mm is None or not np.isfinite(commissure_height_mm):
        commissure_height_mm = max(8.0, stj_height_mm * 0.82)
    reference = float(max(8.0, commissure_height_mm))
    geo_cap = max(10.0, 0.82 * reference)
    eff_cap = max(6.0, 0.62 * reference)
    geometric = float(min(raw_geometric_height_mm, geo_cap))
    effective = float(min(raw_effective_height_mm, eff_cap, geometric))
    free_edge = float(min(raw_free_edge_height_mm, effective))
    regularized = (
        abs(geometric - raw_geometric_height_mm) > 1e-3
        or abs(effective - raw_effective_height_mm) > 1e-3
        or abs(free_edge - raw_free_edge_height_mm) > 1e-3
    )
    return geometric, effective, free_edge, regularized


def build_leaflet_model(
    root_model: AorticRootModel,
    leaflet_mask: np.ndarray,
    affine: np.ndarray,
    spacing_mm: tuple[float, float, float],
) -> LeafletModel:
    leaflet_mask = np.asarray(leaflet_mask, dtype=bool)
    if not np.any(leaflet_mask) or len(root_model.commissures) < 3:
        return _fallback_leaflet_model(root_model)

    coords = np.argwhere(leaflet_mask)
    world = nib.affines.apply_affine(affine, coords.astype(np.float64))
    annulus_origin = np.asarray(root_model.annulus_plane.get("origin_world", root_model.annulus_ring.get("center_world", [0.0, 0.0, 0.0])), dtype=np.float64)
    annulus_normal = normalize(np.asarray(root_model.annulus_plane.get("normal_world", [0.0, 0.0, 1.0]), dtype=np.float64))
    basis_u = normalize(np.asarray(root_model.annulus_plane.get("basis_u_world", [1.0, 0.0, 0.0]), dtype=np.float64))
    basis_v = normalize(np.asarray(root_model.annulus_plane.get("basis_v_world", [0.0, 1.0, 0.0]), dtype=np.float64))
    stj_center = np.asarray(root_model.sinotubular_junction.get("center_world", annulus_origin.tolist()), dtype=np.float64)
    rel = world - annulus_origin[None, :]
    heights = rel @ annulus_normal
    angle_deg = (np.degrees(np.arctan2(rel @ basis_v, rel @ basis_u)) + 360.0) % 360.0
    radial = np.sqrt((rel @ basis_u) ** 2 + (rel @ basis_v) ** 2)
    stj_height = float(max(8.0, np.dot(stj_center - annulus_origin, annulus_normal) + 4.0))

    comm_angles = sorted(float(c.get("angle_deg", i * 120.0)) % 360.0 for i, c in enumerate(root_model.commissures))
    hinge_points = np.asarray(root_model.hinge_curve.get("points_world", []), dtype=np.float64)
    hinge_rel = hinge_points - annulus_origin[None, :] if hinge_points.size else np.zeros((0, 3), dtype=np.float64)
    hinge_angles = (np.degrees(np.arctan2(hinge_rel @ basis_v, hinge_rel @ basis_u)) + 360.0) % 360.0 if hinge_points.size else np.zeros((0,), dtype=np.float64)
    hinge_heights = hinge_rel @ annulus_normal if hinge_points.size else np.zeros((0,), dtype=np.float64)

    surfaces: list[LeafletSurface] = []
    meshes: list[SurfaceMesh] = []
    hinge_lines: list[dict[str, Any]] = []
    all_effective: list[float] = []
    all_geometric: list[float] = []
    aggregate_heights: list[np.ndarray] = []
    aggregate_radial: list[np.ndarray] = []
    commissure_heights = [
        _project_height(np.asarray(comm.get("world", annulus_origin.tolist()), dtype=np.float64), annulus_origin, annulus_normal)
        for comm in root_model.commissures
        if comm.get("world") is not None
    ]
    annulus_eq = float(root_model.annulus_ring.get("equivalent_diameter_mm", 20.0))
    regularization_applied = False

    for i in range(3):
        start_angle = comm_angles[i]
        end_angle = comm_angles[(i + 1) % 3]
        sector = _circular_between(angle_deg, start_angle, end_angle)
        sector &= heights >= -2.0
        sector &= heights <= stj_height
        sector &= radial <= annulus_eq * 1.1
        sector_coords = coords[sector]
        hinge_sector = _circular_between(hinge_angles, start_angle, end_angle) if hinge_points.size else np.zeros((0,), dtype=bool)
        hinge_count = int(np.count_nonzero(hinge_sector)) if hinge_points.size else 0
        name = f"leaflet_{i + 1}"
        if sector_coords.shape[0] < 20:
            surface = LeafletSurface(
                leaflet_id=i + 1,
                name=name,
                mesh=SurfaceMesh(np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.int32), np.zeros((0, 3), dtype=np.float64)),
                voxel_count=int(sector_coords.shape[0]),
                geometric_height_mm=None,
                effective_height_mm=None,
                free_edge_height_mm=None,
                raw_geometric_height_mm=None,
                raw_effective_height_mm=None,
                raw_free_edge_height_mm=None,
                hinge_point_count=hinge_count,
                status="uncertain",
                regularized=False,
            )
            surfaces.append(surface)
            hinge_lines.append({"leaflet_id": i + 1, "point_count": hinge_count, "status": "uncertain"})
            continue

        mesh = _mesh_for_coords(sector_coords, leaflet_mask.shape, affine)
        sector_heights = heights[sector]
        hinge_baseline = float(np.median(hinge_heights[hinge_sector])) if hinge_count > 0 else 0.0
        raw_geometric_height = float(np.max(sector_heights) - hinge_baseline)
        raw_effective_height = float(np.percentile(sector_heights, 85.0) - hinge_baseline)
        raw_free_edge_height = float(np.percentile(sector_heights, 93.0) - hinge_baseline)
        commissure_height = commissure_heights[i] if i < len(commissure_heights) else None
        geometric_height, effective_height, free_edge_height, was_regularized = _regularize_heights(
            raw_geometric_height,
            raw_effective_height,
            raw_free_edge_height,
            commissure_height,
            stj_height,
        )
        regularization_applied = regularization_applied or was_regularized
        aggregate_heights.append(sector_heights)
        aggregate_radial.append(radial[sector])
        hinge_lines.append({"leaflet_id": i + 1, "point_count": hinge_count, "status": "detected"})
        surface = LeafletSurface(
            leaflet_id=i + 1,
            name=name,
            mesh=mesh,
            voxel_count=int(sector_coords.shape[0]),
            geometric_height_mm=geometric_height,
            effective_height_mm=effective_height,
            free_edge_height_mm=free_edge_height,
            raw_geometric_height_mm=raw_geometric_height,
            raw_effective_height_mm=raw_effective_height,
            raw_free_edge_height_mm=raw_free_edge_height,
            hinge_point_count=hinge_count,
            status="detected",
            regularized=was_regularized,
        )
        surfaces.append(surface)
        meshes.append(mesh)
        all_effective.append(effective_height)
        all_geometric.append(geometric_height)

    combined_mesh = _combine_meshes(meshes)
    if aggregate_heights and aggregate_radial:
        agg_heights = np.concatenate(aggregate_heights)
        agg_radial = np.concatenate(aggregate_radial)
        radial_thr = float(np.percentile(agg_radial, 35.0))
        low_h = float(np.percentile(agg_heights, 35.0))
        high_h = float(np.percentile(agg_heights, 80.0))
        central_zone = (agg_radial <= radial_thr) & (agg_heights >= low_h) & (agg_heights <= high_h)
        voxel_area = float(spacing_mm[0] * spacing_mm[1])
        if np.any(central_zone):
            zone_heights = agg_heights[central_zone]
            raw_coaptation_height = float(max(0.5, np.percentile(zone_heights, 90.0) - np.percentile(zone_heights, 20.0)))
            coaptation_level = float(np.median(zone_heights))
            coaptation_height = float(min(raw_coaptation_height, max(1.0, 0.42 * np.mean(all_effective)))) if all_effective else raw_coaptation_height
            coaptation_area = float(np.count_nonzero(central_zone) * voxel_area)
            regularization_applied = regularization_applied or abs(coaptation_height - raw_coaptation_height) > 1e-3
        else:
            raw_coaptation_height = None
            coaptation_level = None
            coaptation_height = float(min(all_effective) * 0.24) if all_effective else None
            coaptation_area = None
    else:
        raw_coaptation_height = None
        coaptation_level = None
        coaptation_height = None
        coaptation_area = None

    symmetry_heights = np.asarray(all_geometric, dtype=np.float64)
    root_symmetry_index = float(np.std(symmetry_heights) / max(1e-6, np.mean(symmetry_heights))) if symmetry_heights.size >= 2 else None

    return LeafletModel(
        mesh=combined_mesh,
        leaflet_surfaces=surfaces,
        coaptation_height_mm=coaptation_height,
        coaptation_surface_area_mm2=coaptation_area,
        coaptation_level_mm=coaptation_level,
        raw_coaptation_height_mm=raw_coaptation_height,
        effective_height_mean_mm=float(np.mean(all_effective)) if all_effective else None,
        geometric_height_mean_mm=float(np.mean(all_geometric)) if all_geometric else None,
        root_symmetry_index=root_symmetry_index,
        hinge_lines=hinge_lines,
        commissures=root_model.commissures,
        status="detected" if all_effective else "uncertain",
        regularization={
            "applied": regularization_applied,
            "commissure_height_reference_mm": float(np.median(commissure_heights)) if commissure_heights else None,
            "stj_height_mm": float(stj_height),
            "raw_coaptation_height_mm": raw_coaptation_height,
        },
    )


def leaflet_model_payload(model: LeafletModel) -> dict[str, Any]:
    return {
        "status": model.status,
        "coaptation_height_mm": model.coaptation_height_mm,
        "coaptation_surface_area_mm2": model.coaptation_surface_area_mm2,
        "coaptation_level_mm": model.coaptation_level_mm,
        "raw_coaptation_height_mm": model.raw_coaptation_height_mm,
        "effective_height_mean_mm": model.effective_height_mean_mm,
        "geometric_height_mean_mm": model.geometric_height_mean_mm,
        "root_symmetry_index": model.root_symmetry_index,
        "hinge_lines": model.hinge_lines,
        "commissures": model.commissures,
        "regularization": model.regularization,
        "leaflets": [
            {
                "leaflet_id": item.leaflet_id,
                "name": item.name,
                "voxel_count": item.voxel_count,
                "geometric_height_mm": item.geometric_height_mm,
                "effective_height_mm": item.effective_height_mm,
                "free_edge_height_mm": item.free_edge_height_mm,
                "raw_geometric_height_mm": item.raw_geometric_height_mm,
                "raw_effective_height_mm": item.raw_effective_height_mm,
                "raw_free_edge_height_mm": item.raw_free_edge_height_mm,
                "hinge_point_count": item.hinge_point_count,
                "mesh_vertices": int(item.mesh.vertices_world.shape[0]),
                "mesh_faces": int(item.mesh.faces.shape[0]),
                "status": item.status,
                "regularized": item.regularized,
            }
            for item in model.leaflet_surfaces
        ],
        "mesh": {
            "vertices": int(model.mesh.vertices_world.shape[0]),
            "faces": int(model.mesh.faces.shape[0]),
        },
    }
