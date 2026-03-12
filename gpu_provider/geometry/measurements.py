from __future__ import annotations

from typing import Any

import numpy as np

from .common import ellipse_perimeter_from_diameters
from .coronary_detection import detect_coronary_ostia
from .landmarks import LandmarkDetectionResult
from .leaflet_model import LeafletModel
from .profile_analysis import SectionMetrics
from .root_model import AorticRootModel


def _mean_diameter(sections: list[SectionMetrics]) -> float | None:
    vals = [float(sec.equivalent_diameter_mm) for sec in sections if sec is not None and np.isfinite(sec.equivalent_diameter_mm)]
    if not vals:
        return None
    return float(np.mean(vals))


def _sanity_checks(measurements: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    annulus_eq = measurements.get("annulus", {}).get("equivalent_diameter_mm")
    stj_d = measurements.get("stj", {}).get("diameter_mm")
    left_h = measurements.get("coronary_heights_mm", {}).get("left")
    right_h = measurements.get("coronary_heights_mm", {}).get("right")
    if annulus_eq is not None and annulus_eq < 15.0:
        errors.append("annulus_diameter_below_15mm")
    if stj_d is not None and stj_d < 15.0:
        errors.append("stj_below_15mm")
    if left_h is not None and left_h < 2.0:
        errors.append("left_coronary_height_below_2mm")
    if right_h is not None and right_h < 2.0:
        errors.append("right_coronary_height_below_2mm")
    if annulus_eq is not None and stj_d is not None and stj_d > annulus_eq * 2.4:
        errors.append("stj_annulus_ratio_inconsistent")
    return {"accepted": len(errors) == 0, "errors": errors}


def compute_calcium_burden(ct_hu: np.ndarray, region_mask: np.ndarray, voxel_volume_mm3: float, threshold_hu: float = 130.0) -> dict[str, Any]:
    calc = np.asarray(region_mask, dtype=bool) & (np.asarray(ct_hu, dtype=np.float32) >= float(threshold_hu))
    vox = int(calc.sum())
    return {
        "threshold_hu": float(threshold_hu),
        "calc_voxels": vox,
        "calc_volume_ml": float((vox * voxel_volume_mm3) / 1000.0),
    }


def build_measurements(
    ct_hu: np.ndarray,
    lumen_mask: np.ndarray,
    valve_region_mask: np.ndarray,
    landmark_sections: dict[str, SectionMetrics | None],
    ascending_sections: list[SectionMetrics],
    annulus_plane: dict[str, Any],
    root_model: AorticRootModel,
    leaflet_model: LeafletModel,
    spacing_mm: tuple[float, float, float],
    affine: np.ndarray,
    voxel_volume_mm3: float,
    centerline_result: Any,
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    annulus = landmark_sections.get("annulus")
    sinus = landmark_sections.get("sinus")
    stj = landmark_sections.get("stj")
    ascending = landmark_sections.get("ascending")
    if annulus is None or sinus is None or stj is None or ascending is None:
        raise RuntimeError("geometry_measurements_incomplete")

    coronary = detect_coronary_ostia(
        ct_hu=ct_hu,
        lumen_mask=lumen_mask,
        annulus_plane=annulus_plane,
        landmark_sections=landmark_sections,
        spacing_mm=spacing_mm,
        affine=affine,
    )
    calcium = compute_calcium_burden(ct_hu, valve_region_mask, voxel_volume_mm3, threshold_hu=130.0)

    annulus_metrics = {
        "diameter_short_mm": float(annulus.min_diameter_mm),
        "diameter_long_mm": float(annulus.max_diameter_mm),
        "area_mm2": float(annulus.area_mm2),
        "perimeter_mm": float(annulus.perimeter_mm) if annulus.perimeter_mm is not None else None,
        "equivalent_diameter_mm": float(annulus.equivalent_diameter_mm),
    }

    lvot_sections = [sec for sec in ascending_sections if sec.s_mm < annulus.s_mm and (annulus.s_mm - sec.s_mm) <= 8.0]
    lvot = lvot_sections[-1] if lvot_sections else annulus
    ascending_plateau = [sec for sec in ascending_sections if sec.s_mm >= stj.s_mm and (sec.s_mm - stj.s_mm) >= 8.0]
    ascending_d = _mean_diameter(ascending_plateau[: max(3, min(8, len(ascending_plateau)))]) or float(ascending.equivalent_diameter_mm)

    measurements = {
        "annulus": annulus_metrics,
        "lvot": {
            "diameter_mm": float(lvot.equivalent_diameter_mm),
            "area_mm2": float(lvot.area_mm2),
        },
        "sinus_of_valsalva": {
            "max_diameter_mm": float(sinus.max_diameter_mm),
            "equivalent_diameter_mm": float(sinus.equivalent_diameter_mm),
        },
        "stj": {
            "diameter_mm": float(stj.equivalent_diameter_mm),
            "diameter_short_mm": float(stj.min_diameter_mm),
            "diameter_long_mm": float(stj.max_diameter_mm),
        },
        "ascending_aorta": {
            "diameter_mm": float(ascending_d),
        },
        "coronary_heights_mm": {
            "left": float(coronary["left"]["height_mm"]) if coronary.get("left") else None,
            "right": float(coronary["right"]["height_mm"]) if coronary.get("right") else None,
        },
        "calcium_burden": calcium,
        "leaflet_geometry": {
            "coaptation_height_mm": leaflet_model.coaptation_height_mm,
            "root_symmetry_index": leaflet_model.root_symmetry_index,
        },
    }

    planning_metrics = {
        "vsrr": {
            "annulus_diameter_mm": annulus_metrics["equivalent_diameter_mm"],
            "sinus_diameter_mm": float(sinus.max_diameter_mm),
            "stj_diameter_mm": float(stj.equivalent_diameter_mm),
            "lvot_diameter_mm": float(lvot.equivalent_diameter_mm),
            "recommended_graft_size_mm": float(max(20.0, round(annulus_metrics["equivalent_diameter_mm"] - 2.0, 1))),
            "coaptation_height_mm": leaflet_model.coaptation_height_mm,
        },
        "pears": {
            "root_external_reference_diameter_mm": float(sinus.max_diameter_mm),
            "support_segment_length_mm": float(max(0.0, ascending.s_mm - annulus.s_mm)),
            "annulus_plane": annulus_plane,
        },
        "tavi": {
            "annulus_area_mm2": annulus_metrics["area_mm2"],
            "annulus_perimeter_mm": annulus_metrics["perimeter_mm"],
            "annulus_diameter_short_mm": annulus_metrics["diameter_short_mm"],
            "annulus_diameter_long_mm": annulus_metrics["diameter_long_mm"],
            "coronary_height_left_mm": measurements["coronary_heights_mm"]["left"],
            "coronary_height_right_mm": measurements["coronary_heights_mm"]["right"],
            "sinus_width_mm": float(sinus.max_diameter_mm),
            "stj_diameter_mm": float(stj.equivalent_diameter_mm),
            "valve_calcium_burden": calcium,
        },
    }

    risk_flags: list[dict[str, Any]] = []
    left_h = measurements["coronary_heights_mm"]["left"]
    right_h = measurements["coronary_heights_mm"]["right"]
    if (left_h is not None and left_h < 10.0) or (right_h is not None and right_h < 10.0):
        risk_flags.append({"id": "low_coronary_height", "severity": "high", "message": "Coronary ostial height below 10 mm"})
    if float(sinus.max_diameter_mm) < 30.0:
        risk_flags.append({"id": "small_sinus", "severity": "moderate", "message": "Sinus of Valsalva diameter appears small (<30 mm)"})
    if float(calcium["calc_volume_ml"]) > 0.35:
        risk_flags.append({"id": "heavy_valve_calcification", "severity": "high", "message": "Valve/root calcium burden is elevated (HU>130)"})

    sanity = _sanity_checks(measurements)
    for err in sanity["errors"]:
        risk_flags.append({"id": err, "severity": "critical", "message": err.replace("_", " ")})

    measurements_json_payload = {
        "measurements": measurements,
        "planning_metrics": planning_metrics,
        "risk_flags": risk_flags,
        "sanity_checks": sanity,
        "annulus_plane": annulus_plane,
        "aortic_root_model": {
            "annulus_ring": root_model.annulus_ring,
            "commissures": root_model.commissures,
            "sinus_peaks": root_model.sinus_peaks,
            "stj_ring": root_model.stj_ring,
            "ascending_axis": root_model.ascending_axis,
        },
        "coronary_detection": coronary,
    }
    return measurements, planning_metrics, risk_flags, measurements_json_payload
