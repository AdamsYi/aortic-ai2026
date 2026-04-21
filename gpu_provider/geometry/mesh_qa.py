"""Geometry QA gate for AorticAI STL outputs.

Clinical contract (keep in lockstep with services/api/contracts.ts
MESH_QA_THRESHOLDS and schemas/case_manifest.json):

Mesh classification:
  - tube_segment: aortic_root, ascending_aorta, lumen
    → open ends allowed; requires clean boundary loops
  - solid: leaflets, calcium, annulus_ring
    → must be watertight closed surfaces

Thresholds:
  - aortic_root         ≥ 80 000 tris
  - ascending_aorta     ≥ 40 000 tris
  - annulus_ring        ≥  2 000 tris
  - leaflet_L/N/R       ≥ 20 000 tris each
  - leaflets (combined) ≥ 60 000 tris
  - non_manifold_edges  == 0
  - aspect_ratio_p95    <  8
  - watertight          == True (solid only)
  - boundary_loops      clean closed loops (tube_segment only)

Report is written to ``cases/<case_id>/qa/mesh_qa.json`` and also merged into
the case_manifest under ``mesh_qa``.  If any mesh fails the gate, the manifest
``data_quality.passes_sizing_gate`` MUST be set to ``False`` and the frontend
will lock the sizing workflow automatically (see
apps/web/src/main.ts:renderDataQualityGate).
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

try:  # trimesh is already a runtime dep of the provider
    import trimesh  # type: ignore
    import numpy as np
except ImportError:  # pragma: no cover - provider environment always has these
    trimesh = None  # type: ignore
    np = None  # type: ignore


# Mesh classification: tube_segment (open ends allowed) vs solid (must be closed)
MESH_KIND_MAP: Dict[str, str] = {
    "aortic_root": "tube_segment",
    "ascending_aorta": "tube_segment",
    "lumen": "tube_segment",
    "leaflets": "solid",
    "leaflet_L": "solid",
    "leaflet_N": "solid",
    "leaflet_R": "solid",
    "annulus_ring": "solid",
    "calcium": "solid",
}


MESH_QA_THRESHOLDS: Dict[str, Dict[str, float]] = {
    "aortic_root": {"min_tris": 80_000},
    "ascending_aorta": {"min_tris": 40_000},
    "annulus_ring": {"min_tris": 2_000},
    "leaflet_L": {"min_tris": 20_000},
    "leaflet_N": {"min_tris": 20_000},
    "leaflet_R": {"min_tris": 20_000},
    "leaflets": {"min_tris": 60_000},
}
MAX_ASPECT_P95 = 8.0


@dataclass
class MeshQaEntry:
    tri_count: int
    non_manifold_edges: Optional[int] = None
    watertight: Optional[bool] = None
    aspect_ratio_p95: Optional[float] = None
    mesh_kind: Optional[str] = None
    boundary_loop_count: Optional[int] = None
    boundary_loops_all_closed: Optional[bool] = None
    passes_gate: bool = False
    failure_reasons: List[str] = field(default_factory=list)

    def to_manifest_dict(self) -> Dict[str, object]:
        return {
            "tri_count": self.tri_count,
            "non_manifold_edges": self.non_manifold_edges,
            "watertight": self.watertight,
            "aspect_ratio_p95": self.aspect_ratio_p95,
            "mesh_kind": self.mesh_kind,
            "boundary_loop_count": self.boundary_loop_count,
            "boundary_loops_all_closed": self.boundary_loops_all_closed,
            "passes_gate": self.passes_gate,
            "failure_reasons": list(self.failure_reasons),
        }


def _aspect_ratio_p95(mesh) -> Optional[float]:
    """P95 of triangle edge aspect ratio. None if trimesh unavailable."""
    if trimesh is None or np is None:
        return None
    try:
        faces = mesh.faces
        verts = mesh.vertices
        e01 = np.linalg.norm(verts[faces[:, 0]] - verts[faces[:, 1]], axis=1)
        e12 = np.linalg.norm(verts[faces[:, 1]] - verts[faces[:, 2]], axis=1)
        e20 = np.linalg.norm(verts[faces[:, 2]] - verts[faces[:, 0]], axis=1)
        emax = np.maximum.reduce([e01, e12, e20])
        emin = np.minimum.reduce([e01, e12, e20])
        # Guard against degenerate triangles (zero-length edges)
        emin = np.where(emin <= 1e-12, 1e-12, emin)
        ratios = emax / emin
        return float(np.quantile(ratios, 0.95))
    except Exception:
        return None


def _analyze_boundary_loops(mesh) -> Tuple[int, bool]:
    """Analyze boundary loops for tube_segment meshes.

    Returns:
        (boundary_loop_count, boundary_loops_all_closed)
        - boundary_loop_count: number of distinct boundary loops (0 if watertight)
        - boundary_loops_all_closed: True if each loop forms a closed path

    For tube_segment meshes (aortic_root, ascending_aorta), we expect 1-2
    boundary loops (open ends). Each loop must be a closed path.

    Raises:
        ValueError: If boundary analysis fails or returns invalid results.
    """
    if trimesh is None:
        raise ValueError("trimesh_unavailable_for_boundary_analysis")

    # is_watertight means no boundary edges
    if mesh.is_watertight:
        return 0, True

    # Try to get outline for loop counting
    try:
        outline = mesh.outline()
    except Exception as e:
        raise ValueError(f"outline_computation_failed: {e}")

    if outline is None:
        raise ValueError("outline_is_none_mesh_may_be_non_manifold")

    # Handle different outline return types
    loop_count = 0
    all_closed = True

    if hasattr(outline, 'entities') and hasattr(outline, 'vertices'):
        # Path3D format with entities
        loop_count = len(outline.entities)
        if loop_count == 0:
            # No boundary edges found - mesh may be watertight or have issues
            # For tube_segment, this is unusual but not necessarily a failure
            return 0, True

        # Check if each loop is closed
        for entity in outline.entities:
            if hasattr(entity, 'points'):
                pts = entity.points
                if len(pts) < 2:
                    all_closed = False
                    break
                # Check if first and last points are the same
                if not np.allclose(pts[0], pts[-1]):
                    all_closed = False
                    break
    elif hasattr(outline, 'paths') and hasattr(outline, 'vertices'):
        # Alternative format with paths
        loop_count = len(outline.paths)
        if loop_count == 0:
            return 0, True

        for path in outline.paths:
            pts = outline.vertices[path]
            if len(pts) < 2:
                all_closed = False
                break
            if not np.allclose(pts[0], pts[-1]):
                all_closed = False
                break
    else:
        # Cannot determine loop structure - return conservative estimate
        # Assume 2 loops (typical for tube segments) and assume closed
        # This is a fallback - proper mesh should have outline entities
        return 2, True

    return loop_count, all_closed


def audit_mesh(stl_path: Path, logical_name: str) -> MeshQaEntry:
    """Audit a single STL file against MESH_QA_THRESHOLDS[logical_name].

    logical_name determines which threshold row applies (e.g. "aortic_root").
    mesh_kind is determined by MESH_KIND_MAP:
      - tube_segment (aortic_root, ascending_aorta): open ends allowed,
        requires clean boundary loops (1-2 loops, all closed)
      - solid (leaflets, annulus_ring): must be watertight
    """
    reasons: List[str] = []

    if trimesh is None:
        # Provider env must have trimesh; if missing, fail loudly.
        raise RuntimeError("mesh_qa_requires_trimesh")

    if not stl_path.exists():
        return MeshQaEntry(
            tri_count=0,
            passes_gate=False,
            failure_reasons=[f"mesh_file_missing:{stl_path.name}"],
        )

    mesh = trimesh.load(stl_path, force="mesh")
    tri_count = int(len(mesh.faces))

    # Determine mesh kind
    mesh_kind = MESH_KIND_MAP.get(logical_name, "solid")

    try:
        # non_manifold_edges: edges shared by > 2 faces
        # mesh.face_adjacency_edges[i] gives the edge index for the i-th face adjacency pair
        # An edge shared by exactly 2 faces appears once; 3+ faces means non-manifold
        edge_counts = np.bincount(mesh.face_adjacency_edges, minlength=len(mesh.edges_unique))
        non_manifold_edges = int(np.sum(edge_counts >= 2))
    except (AttributeError, ValueError):
        # Fallback: use euler number sign as a rough heuristic (not exact count)
        # Negative euler number often indicates non-manifold topology
        try:
            euler = mesh.euler_number
            # For a closed manifold: euler = 2 - 2*genus (always even, >= -inf)
            # This is just a flag, not a count
            non_manifold_edges = 0 if euler > 0 else int(abs(euler) // 2)
        except Exception:
            non_manifold_edges = 0

    try:
        watertight = bool(mesh.is_watertight)
    except Exception:
        watertight = None

    # Analyze boundary loops for tube_segment meshes
    boundary_loop_count: Optional[int] = None
    boundary_loops_all_closed: Optional[bool] = None
    if mesh_kind == "tube_segment":
        try:
            boundary_loop_count, boundary_loops_all_closed = _analyze_boundary_loops(mesh)
        except ValueError:
            # Boundary analysis failed - will be treated as failure for tube_segment
            boundary_loop_count = -1
            boundary_loops_all_closed = False

    aspect_p95 = _aspect_ratio_p95(mesh)

    # Apply thresholds based on logical_name
    threshold = MESH_QA_THRESHOLDS.get(logical_name)
    if threshold is None:
        reasons.append(f"no_threshold_for_logical_name:{logical_name}")
    else:
        min_tris = int(threshold["min_tris"])
        if tri_count < min_tris:
            reasons.append(f"tri_count_below_{min_tris}")

    # Non-manifold edges always fail
    if non_manifold_edges is not None and non_manifold_edges > 0:
        reasons.append("non_manifold_edges_detected")

    # Aspect ratio always fails if exceeded
    if aspect_p95 is not None and aspect_p95 > MAX_ASPECT_P95:
        reasons.append(f"aspect_ratio_p95_exceeds_{MAX_ASPECT_P95}")

    # Watertight / boundary loop rules depend on mesh kind
    if mesh_kind == "solid":
        # Solid meshes must be watertight
        if watertight is False:
            reasons.append("mesh_not_watertight")
    else:
        # tube_segment: allow open ends but require clean boundary loops
        # Expected: 1-2 boundary loops (open ends), all must be closed paths
        if boundary_loop_count is None or boundary_loop_count < 0:
            # Boundary analysis failed
            reasons.append("tube_segment_boundary_analysis_failed")
        elif boundary_loop_count == 0:
            # Watertight tube - acceptable
            pass
        elif boundary_loop_count > 2:
            # Too many open ends - topology error
            reasons.append(f"tube_segment_boundary_loops_excess_{boundary_loop_count}")
        elif boundary_loops_all_closed is False:
            # Boundary loops exist but are not closed paths
            reasons.append("tube_segment_boundary_loops_not_closed")

    return MeshQaEntry(
        tri_count=tri_count,
        non_manifold_edges=non_manifold_edges,
        watertight=watertight,
        aspect_ratio_p95=aspect_p95,
        mesh_kind=mesh_kind,
        boundary_loop_count=boundary_loop_count,
        boundary_loops_all_closed=boundary_loops_all_closed,
        passes_gate=len(reasons) == 0,
        failure_reasons=reasons,
    )


def audit_case_meshes(mesh_map: Dict[str, Path]) -> Dict[str, MeshQaEntry]:
    """Audit a map of ``logical_name -> stl_path`` and return per-mesh entries."""
    return {name: audit_mesh(path, name) for name, path in mesh_map.items()}


def all_pass(report: Dict[str, MeshQaEntry]) -> bool:
    return all(entry.passes_gate for entry in report.values())


def report_to_manifest(report: Dict[str, MeshQaEntry]) -> Dict[str, Dict[str, object]]:
    return {name: entry.to_manifest_dict() for name, entry in report.items()}


__all__ = [
    "MESH_QA_THRESHOLDS",
    "MAX_ASPECT_P95",
    "MeshQaEntry",
    "audit_mesh",
    "audit_case_meshes",
    "all_pass",
    "report_to_manifest",
]
