from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from .lumen_mesh import SurfaceMesh
from .root_model import AorticRootModel


@dataclass
class LeafletModel:
    mesh: SurfaceMesh
    coaptation_height_mm: float | None
    root_symmetry_index: float | None
    hinge_lines: list[dict[str, Any]]
    commissures: list[dict[str, Any]]


def _arc_points(ring: np.ndarray, start_idx: int, end_idx: int) -> np.ndarray:
    n = ring.shape[0]
    if n == 0:
        return np.zeros((0, 3), dtype=np.float64)
    idxs = []
    cur = start_idx % n
    idxs.append(cur)
    while cur != end_idx % n:
        cur = (cur + 1) % n
        idxs.append(cur)
        if len(idxs) > n:
            break
    return ring[np.asarray(idxs, dtype=np.int32)]


def build_leaflet_model(root_model: AorticRootModel) -> LeafletModel:
    annulus_ring = np.asarray(root_model.annulus_ring.get("contour_world", []), dtype=np.float64)
    commissures = root_model.commissures
    if annulus_ring.shape[0] < 12 or len(commissures) < 3:
        return LeafletModel(
            mesh=SurfaceMesh(np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.int32), np.zeros((0, 3), dtype=np.float64)),
            coaptation_height_mm=None,
            root_symmetry_index=None,
            hinge_lines=[],
            commissures=commissures,
        )

    annulus_center = np.asarray(root_model.annulus_ring.get("center_world", [0.0, 0.0, 0.0]), dtype=np.float64)
    stj_center = np.asarray(root_model.stj_ring.get("center_world", annulus_center.tolist()), dtype=np.float64)
    axis = stj_center - annulus_center
    axis_len = float(np.linalg.norm(axis))
    axis_dir = axis / axis_len if axis_len > 1e-8 else np.array([0.0, 0.0, 1.0], dtype=np.float64)
    coaptation_center = annulus_center + axis_dir * (0.48 * axis_len)
    coaptation_height_mm = float(np.linalg.norm(coaptation_center - annulus_center)) if axis_len > 1e-8 else None

    comm_indices = [int(c.get("index", i * 21)) for i, c in enumerate(commissures)]
    hinge_lines: list[dict[str, Any]] = []
    vertices: list[np.ndarray] = []
    faces: list[list[int]] = []

    for i in range(3):
        j = (i + 1) % 3
        arc = _arc_points(annulus_ring, comm_indices[i], comm_indices[j])
        if arc.shape[0] < 3:
            continue
        apex = (np.asarray(commissures[i]["world"], dtype=np.float64) + np.asarray(commissures[j]["world"], dtype=np.float64) + coaptation_center) / 3.0
        start_idx = len(vertices)
        for p in arc:
            vertices.append(np.asarray(p, dtype=np.float64))
        apex_idx = len(vertices)
        vertices.append(apex)
        for k in range(start_idx, apex_idx - 1):
            faces.append([k, k + 1, apex_idx])
        hinge_lines.append(
            {
                "leaflet_id": i + 1,
                "start_world": [float(x) for x in arc[0]],
                "end_world": [float(x) for x in arc[-1]],
                "point_count": int(arc.shape[0]),
            }
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

    sinus_pts = np.asarray([p.get("world", [0.0, 0.0, 0.0]) for p in root_model.sinus_peaks], dtype=np.float64)
    if sinus_pts.shape[0] >= 2:
        radii = np.linalg.norm(sinus_pts - annulus_center[None, :], axis=1)
        root_symmetry_index = float(np.std(radii) / max(1e-6, np.mean(radii)))
    else:
        root_symmetry_index = None

    return LeafletModel(
        mesh=SurfaceMesh(vertices_arr, faces_arr, normals),
        coaptation_height_mm=coaptation_height_mm,
        root_symmetry_index=root_symmetry_index,
        hinge_lines=hinge_lines,
        commissures=commissures,
    )
