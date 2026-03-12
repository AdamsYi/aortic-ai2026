from __future__ import annotations

from typing import Any

import numpy as np

from .root_model import AorticRootModel


def _centerline_length_mm(root_model: AorticRootModel) -> float | None:
    s = root_model.centerline.get("s_mm", [])
    if not s:
        return None
    return float(s[-1])


def build_digital_twin_simulation(
    root_model: AorticRootModel,
    planning_metrics: dict[str, Any],
) -> dict[str, Any]:
    annulus_d = float(root_model.annulus_ring.get("equivalent_diameter_mm", 0.0) or 0.0)
    stj_d = float(root_model.sinotubular_junction.get("equivalent_diameter_mm", 0.0) or 0.0)
    sinus_peaks = root_model.sinus_peaks or []
    sinus_d = max(float(item.get("radius_mm", 0.0)) * 2.0 for item in sinus_peaks) if sinus_peaks else None
    tavi = planning_metrics.get("tavi", {})
    vsrr = planning_metrics.get("vsrr", {})
    pears = planning_metrics.get("pears", {})

    left = root_model.coronary_ostia.get("left", {})
    right = root_model.coronary_ostia.get("right", {})
    nominal_valve = tavi.get("area_derived_valve_size", {}).get("nearest_nominal_size_mm")
    frame_height_mm = 12.0 if nominal_valve is not None else None

    if left.get("status") == "detected" and frame_height_mm is not None:
        left_margin = float(left.get("height_mm") - frame_height_mm * 0.5)
    else:
        left_margin = None
    if right.get("status") == "detected" and frame_height_mm is not None:
        right_margin = float(right.get("height_mm") - frame_height_mm * 0.5)
    else:
        right_margin = None

    return {
        "virtual_graft_implantation": {
            "status": "available",
            "recommended_graft_size_mm": vsrr.get("recommended_graft_size_mm"),
            "support_segment_length_mm": pears.get("support_segment_length_mm"),
            "annulus_to_stj_mismatch_mm": vsrr.get("annulus_stj_mismatch_mm"),
            "axis": root_model.ascending_axis,
        },
        "virtual_valve_placement": {
            "status": "available" if nominal_valve is not None else "unavailable",
            "nominal_valve_size_mm": nominal_valve,
            "frame_height_reference_mm": frame_height_mm,
            "annulus_plane": root_model.annulus_plane,
        },
        "coronary_clearance_simulation": {
            "status": "available" if left_margin is not None or right_margin is not None else "unavailable",
            "left_clearance_margin_mm": left_margin,
            "right_clearance_margin_mm": right_margin,
            "risk": bool(
                (left_margin is not None and left_margin < 4.0)
                or (right_margin is not None and right_margin < 4.0)
            ),
        },
        "flow_path_estimation": {
            "status": "available",
            "root_centerline_length_mm": _centerline_length_mm(root_model),
            "annulus_to_stj_taper_ratio": float(stj_d / annulus_d) if annulus_d > 0 else None,
            "sinus_expansion_ratio": float(sinus_d / annulus_d) if annulus_d > 0 and sinus_d is not None else None,
        },
    }
