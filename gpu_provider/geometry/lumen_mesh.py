from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy import ndimage

from .common import (
    crop_to_bbox,
    keep_largest_component,
    mask_bounding_box,
    mm_to_vox_xy,
    paste_bbox,
    points_voxel_to_world,
    remove_small_components,
    smooth_binary_mask,
    voxel_volume_mm3,
)

try:
    from skimage import measure as sk_measure
except Exception:  # pragma: no cover
    sk_measure = None

try:
    import trimesh  # type: ignore
except Exception:  # pragma: no cover
    trimesh = None  # type: ignore


@dataclass
class SurfaceMesh:
    vertices_world: np.ndarray
    faces: np.ndarray
    normals_world: np.ndarray


@dataclass
class MeshArtifacts:
    lumen_mask: np.ndarray
    lumen_volume_ml: float
    surface_mesh: SurfaceMesh


def extract_lumen_mask(multiclass_mask: np.ndarray, spacing_mm: tuple[float, float, float]) -> np.ndarray:
    mask = np.asarray(multiclass_mask)
    lumen = np.isin(mask, [1, 3])
    if not np.any(lumen):
        lumen = mask > 0

    lumen = keep_largest_component(lumen)
    margin = (
        max(3, mm_to_vox_xy(6.0, spacing_mm)),
        max(3, mm_to_vox_xy(6.0, spacing_mm)),
        max(2, int(round(6.0 / max(0.4, float(spacing_mm[2]))))),
    )
    bbox = mask_bounding_box(lumen, margin_vox=margin)
    lumen_crop = crop_to_bbox(lumen, bbox)
    closing_iter = max(1, mm_to_vox_xy(0.8, spacing_mm))
    lumen_crop = ndimage.binary_closing(lumen_crop, structure=np.ones((3, 3, 3), dtype=bool), iterations=closing_iter)
    lumen_crop = ndimage.binary_fill_holes(lumen_crop)
    lumen_crop = remove_small_components(
        lumen_crop,
        min_voxels=max(32, int(round(200.0 / max(1.0, voxel_volume_mm3(spacing_mm))))),
    )
    lumen_crop = smooth_binary_mask(lumen_crop, spacing_mm, sigma_mm=0.25)
    lumen_crop = ndimage.binary_fill_holes(lumen_crop)
    lumen = paste_bbox(lumen_crop, bbox, lumen.shape, dtype=bool)
    lumen = keep_largest_component(lumen)
    return np.asarray(lumen, dtype=bool)


def save_mask_nifti(mask: np.ndarray, affine: np.ndarray, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    nib.save(nib.Nifti1Image(mask.astype(np.uint8), affine), str(out_path))


def remove_degenerate_faces(vertices: np.ndarray, faces: np.ndarray, area_eps: float = 1e-5) -> np.ndarray:
    valid: list[np.ndarray] = []
    for tri in np.asarray(faces, dtype=np.int32):
        if len({int(tri[0]), int(tri[1]), int(tri[2])}) < 3:
            continue
        v1 = vertices[int(tri[0])]
        v2 = vertices[int(tri[1])]
        v3 = vertices[int(tri[2])]
        area = 0.5 * float(np.linalg.norm(np.cross(v2 - v1, v3 - v1)))
        if area <= area_eps:
            continue
        valid.append(tri)
    if not valid:
        return np.zeros((0, 3), dtype=np.int32)
    return np.asarray(valid, dtype=np.int32)


def build_vertex_adjacency(vertex_count: int, faces: np.ndarray) -> list[set[int]]:
    adj = [set() for _ in range(int(vertex_count))]
    for tri in np.asarray(faces, dtype=np.int32):
        a, b, c = int(tri[0]), int(tri[1]), int(tri[2])
        adj[a].update([b, c])
        adj[b].update([a, c])
        adj[c].update([a, b])
    return adj


def laplacian_smooth(vertices: np.ndarray, faces: np.ndarray, lam: float = 0.35, iterations: int = 6) -> np.ndarray:
    verts = np.asarray(vertices, dtype=np.float64).copy()
    if verts.shape[0] == 0 or faces.shape[0] == 0:
        return verts
    adj = build_vertex_adjacency(verts.shape[0], faces)
    for _ in range(max(0, int(iterations))):
        updated = verts.copy()
        for i, neigh in enumerate(adj):
            if not neigh:
                continue
            centroid = verts[list(neigh)].mean(axis=0)
            updated[i] = verts[i] + lam * (centroid - verts[i])
        verts = updated
    return verts


def taubin_smooth(vertices: np.ndarray, faces: np.ndarray, iterations: int = 4, lam: float = 0.35, mu: float = -0.37) -> np.ndarray:
    verts = np.asarray(vertices, dtype=np.float64).copy()
    for _ in range(max(0, int(iterations))):
        verts = laplacian_smooth(verts, faces, lam=lam, iterations=1)
        verts = laplacian_smooth(verts, faces, lam=mu, iterations=1)
    return verts


def compute_face_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    if faces.shape[0] == 0:
        return np.zeros((0, 3), dtype=np.float64)
    v1 = vertices[faces[:, 0]]
    v2 = vertices[faces[:, 1]]
    v3 = vertices[faces[:, 2]]
    normals = np.cross(v2 - v1, v3 - v1)
    norms = np.linalg.norm(normals, axis=1)
    norms[norms <= 1e-8] = 1.0
    return normals / norms[:, None]


def generate_surface_mesh(
    mask: np.ndarray,
    affine: np.ndarray,
    laplacian_iterations: int = 4,
    taubin_iterations: int = 6,
    laplacian_lambda: float = 0.22,
    taubin_lambda: float = 0.28,
    taubin_mu: float = -0.31,
) -> SurfaceMesh:
    if sk_measure is None:
        raise RuntimeError("scikit-image is required for marching cubes mesh generation")
    if not np.any(mask):
        return SurfaceMesh(
            vertices_world=np.zeros((0, 3), dtype=np.float64),
            faces=np.zeros((0, 3), dtype=np.int32),
            normals_world=np.zeros((0, 3), dtype=np.float64),
        )

    verts_vox, faces, _normals, _values = sk_measure.marching_cubes(mask.astype(np.float32), level=0.5, spacing=(1.0, 1.0, 1.0))
    verts_world = points_voxel_to_world(verts_vox, affine)
    faces = remove_degenerate_faces(verts_world, np.asarray(faces, dtype=np.int32))
    verts_world = laplacian_smooth(verts_world, faces, lam=laplacian_lambda, iterations=laplacian_iterations)
    verts_world = taubin_smooth(verts_world, faces, iterations=taubin_iterations, lam=taubin_lambda, mu=taubin_mu)
    faces = remove_degenerate_faces(verts_world, faces)
    normals_world = compute_face_normals(verts_world, faces)
    return SurfaceMesh(vertices_world=verts_world, faces=faces, normals_world=normals_world)


def write_vtk_polydata(mesh: SurfaceMesh, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        f.write("# vtk DataFile Version 3.0\n")
        f.write("Aortic lumen surface\n")
        f.write("ASCII\n")
        f.write("DATASET POLYDATA\n")
        f.write(f"POINTS {mesh.vertices_world.shape[0]} float\n")
        for p in mesh.vertices_world:
            f.write(f"{p[0]:.7e} {p[1]:.7e} {p[2]:.7e}\n")
        f.write(f"POLYGONS {mesh.faces.shape[0]} {mesh.faces.shape[0] * 4}\n")
        for tri in mesh.faces:
            f.write(f"3 {int(tri[0])} {int(tri[1])} {int(tri[2])}\n")


def write_ascii_stl(mesh: SurfaceMesh, out_path: Path, solid_name: str) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    header = bytearray(80)
    name_bytes = solid_name.encode("ascii", errors="ignore")[:79]
    header[: len(name_bytes)] = name_bytes
    normals = mesh.normals_world if mesh.normals_world.shape[0] == mesh.faces.shape[0] else compute_face_normals(mesh.vertices_world, mesh.faces)
    with out_path.open("wb") as f:
        f.write(bytes(header))
        f.write(struct.pack("<I", int(mesh.faces.shape[0])))
        for idx, tri in enumerate(mesh.faces):
            n = normals[idx] if idx < normals.shape[0] else np.array([0.0, 0.0, 1.0], dtype=np.float64)
            v1 = mesh.vertices_world[int(tri[0])]
            v2 = mesh.vertices_world[int(tri[1])]
            v3 = mesh.vertices_world[int(tri[2])]
            f.write(
                struct.pack(
                    "<12fH",
                    float(n[0]),
                    float(n[1]),
                    float(n[2]),
                    float(v1[0]),
                    float(v1[1]),
                    float(v1[2]),
                    float(v2[0]),
                    float(v2[1]),
                    float(v2[2]),
                    float(v3[0]),
                    float(v3[1]),
                    float(v3[2]),
                    0,
                )
            )


def mesh_meta(mesh: SurfaceMesh, out_path: Path | None = None) -> dict[str, object]:
    return {
        "vertices": int(mesh.vertices_world.shape[0]),
        "faces": int(mesh.faces.shape[0]),
        "path": str(out_path) if out_path is not None else None,
        "empty_mesh": bool(mesh.faces.shape[0] == 0),
    }


def _finalize_surface_mesh(mesh: SurfaceMesh) -> SurfaceMesh:
    """Apply standard mesh cleanup to remove marching-cubes topology artifacts.

    Equivalent to what Mimics / 3D Slicer / 3mensio pipelines do by default:
    - Merge duplicate vertices
    - Fix winding order
    - Fix normals consistency
    - Remove duplicate/degenerate faces
    - Remove unreferenced vertices
    - Attempt to fix non-manifold edges (fill small holes)

    Does NOT: smooth, decimate, or fill large holes (those change geometry).
    """
    if trimesh is None:
        # trimesh unavailable - return as-is
        return mesh

    if mesh.faces.shape[0] == 0:
        # Empty mesh - nothing to clean
        return mesh

    try:
        # Convert SurfaceMesh to trimesh.Trimesh
        tm = trimesh.Trimesh(
            vertices=mesh.vertices_world,
            faces=mesh.faces,
            face_normals=mesh.normals_world if mesh.normals_world.shape[0] == mesh.faces.shape[0] else None,
            process=False  # we'll process manually
        )

        # Standard cleanup
        tm.process(validate=True)  # merges duplicate vertices, fixes winding
        tm.remove_duplicate_faces()
        tm.remove_degenerate_faces()
        tm.remove_unreferenced_vertices()

        # Try to fix non-manifold edges by filling small holes
        # This handles common marching-cubes artifacts
        try:
            tm.fill_holes(max_size=5)  # Only fill small holes (<=5 edges)
        except Exception:
            pass  # fill_holes may fail on complex topology - continue anyway

        # Re-compute normals if needed
        if tm.face_normals is None:
            tm.fix_normals()

        # Convert back to SurfaceMesh
        return SurfaceMesh(
            vertices_world=np.asarray(tm.vertices, dtype=np.float64),
            faces=np.asarray(tm.faces, dtype=np.int32),
            normals_world=np.asarray(tm.face_normals, dtype=np.float64),
        )
    except Exception:
        # If cleanup fails, return original mesh - let caller decide
        return mesh
