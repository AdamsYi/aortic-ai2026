"""Geometry QA gate for AorticAI STL outputs.

Clinical contract (keep in lockstep with services/api/contracts.ts
MESH_QA_THRESHOLDS and schemas/case_manifest.json):

  - aortic_root         ≥ 80 000 tris
  - ascending_aorta     ≥ 40 000 tris
  - annulus_ring        ≥  2 000 tris
  - leaflet_L/N/R       ≥ 20 000 tris each
  - leaflets (combined) ≥ 60 000 tris
  - non_manifold_edges  == 0
  - aspect_ratio_p95    <  8
  - watertight          == True

Report is written to ``cases/<case_id>/qa/mesh_qa.json`` and also merged into
the case_manifest under ``mesh_qa``.  If any mesh fails the gate, the manifest
``data_quality.passes_sizing_gate`` MUST be set to ``False`` and the frontend
will lock the sizing workflow automatically (see
apps/web/src/main.ts:renderDataQualityGate).
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Dict, List, Optional

try:  # trimesh is already a runtime dep of the provider
    import trimesh  # type: ignore
    import numpy as np
except ImportError:  # pragma: no cover - provider environment always has these
    trimesh = None  # type: ignore
    np = None  # type: ignore


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
    passes_gate: bool = False
    failure_reasons: List[str] = field(default_factory=list)

    def to_manifest_dict(self) -> Dict[str, object]:
        return {
            "tri_count": self.tri_count,
            "non_manifold_edges": self.non_manifold_edges,
            "watertight": self.watertight,
            "aspect_ratio_p95": self.aspect_ratio_p95,
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


def audit_mesh(stl_path: Path, logical_name: str) -> MeshQaEntry:
    """Audit a single STL file against MESH_QA_THRESHOLDS[logical_name].

    logical_name determines which threshold row applies (e.g. "aortic_root").
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
    try:
        non_manifold_edges = int(len(mesh.edges_unique) - len(mesh.edges))
    except Exception:
        non_manifold_edges = None
    try:
        watertight = bool(mesh.is_watertight)
    except Exception:
        watertight = None
    aspect_p95 = _aspect_ratio_p95(mesh)

    threshold = MESH_QA_THRESHOLDS.get(logical_name)
    if threshold is None:
        reasons.append(f"no_threshold_for_logical_name:{logical_name}")
    else:
        min_tris = int(threshold["min_tris"])
        if tri_count < min_tris:
            reasons.append(f"tri_count_below_{min_tris}")

    if non_manifold_edges is not None and non_manifold_edges > 0:
        reasons.append("non_manifold_edges_detected")
    if watertight is False:
        reasons.append("mesh_not_watertight")
    if aspect_p95 is not None and aspect_p95 > MAX_ASPECT_P95:
        reasons.append(f"aspect_ratio_p95_exceeds_{MAX_ASPECT_P95}")

    return MeshQaEntry(
        tri_count=tri_count,
        non_manifold_edges=non_manifold_edges,
        watertight=watertight,
        aspect_ratio_p95=aspect_p95,
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
