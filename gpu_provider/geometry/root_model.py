from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from .landmarks import LandmarkDetectionResult
from .profile_analysis import SectionMetrics


@dataclass
class AorticRootModel:
    annulus_ring: dict[str, Any]
    commissures: list[dict[str, Any]]
    sinus_peaks: list[dict[str, Any]]
    stj_ring: dict[str, Any]
    ascending_axis: dict[str, Any]
    centerline: dict[str, Any]


def _ring_payload(section: SectionMetrics) -> dict[str, Any]:
    return {
        "index": int(section.index),
        "s_mm": float(section.s_mm),
        "center_world": [float(x) for x in section.center_world],
        "center_voxel": [float(x) for x in section.center_voxel],
        "contour_world": [[float(v) for v in p] for p in section.contour_world],
        "contour_voxel": [[float(v) for v in p] for p in section.contour_voxel],
        "max_diameter_mm": float(section.max_diameter_mm),
        "min_diameter_mm": float(section.min_diameter_mm),
        "area_mm2": float(section.area_mm2),
        "perimeter_mm": float(section.perimeter_mm) if section.perimeter_mm is not None else None,
    }


def _sample_ring_points(section: SectionMetrics, offsets: list[int], label_prefix: str) -> list[dict[str, Any]]:
    ring = section.contour_world
    if ring.shape[0] == 0:
        return []
    pts: list[dict[str, Any]] = []
    for i, off in enumerate(offsets):
        idx = int(off % ring.shape[0])
        vox = section.contour_voxel[idx]
        wrd = ring[idx]
        pts.append(
            {
                "id": f"{label_prefix}_{i + 1}",
                "index": idx,
                "world": [float(x) for x in wrd],
                "voxel": [float(x) for x in vox],
            }
        )
    return pts


def build_aortic_root_model(
    sections: dict[str, SectionMetrics | None],
    landmarks: LandmarkDetectionResult,
    centerline_world: np.ndarray,
    centerline_voxel: np.ndarray,
    centerline_s_mm: np.ndarray,
) -> AorticRootModel:
    annulus = sections.get("annulus")
    sinus = sections.get("sinus")
    stj = sections.get("stj")
    ascending = sections.get("ascending")
    if annulus is None or sinus is None or stj is None or ascending is None:
        raise RuntimeError("geometry_root_model_incomplete")

    comm_offsets = [0, 21, 42]
    sinus_offsets = [10, 31, 52]
    commissures = _sample_ring_points(stj, comm_offsets, "commissure")
    sinus_peaks = _sample_ring_points(sinus, sinus_offsets, "sinus_peak")

    ascending_axis = {
        "start_world": [float(x) for x in stj.center_world],
        "end_world": [float(x) for x in ascending.center_world],
        "start_voxel": [float(x) for x in stj.center_voxel],
        "end_voxel": [float(x) for x in ascending.center_voxel],
    }
    centerline = {
        "point_count": int(centerline_world.shape[0]),
        "points_world": [[float(v) for v in p] for p in centerline_world],
        "points_voxel": [[float(v) for v in p] for p in centerline_voxel],
        "s_mm": [float(v) for v in centerline_s_mm],
    }
    return AorticRootModel(
        annulus_ring=_ring_payload(annulus),
        commissures=commissures,
        sinus_peaks=sinus_peaks,
        stj_ring=_ring_payload(stj),
        ascending_axis=ascending_axis,
        centerline=centerline,
    )
