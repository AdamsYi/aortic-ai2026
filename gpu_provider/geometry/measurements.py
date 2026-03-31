from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict
from typing import Any

import numpy as np

from .coronary_detection import detect_coronary_ostia
from .leaflet_model import LeafletModel
from .profile_analysis import SectionMetrics
from .root_model import AorticRootModel, attach_coronary_ostia


def _mean_diameter(sections: list[SectionMetrics]) -> float | None:
    vals = [float(sec.equivalent_diameter_mm) for sec in sections if sec is not None and np.isfinite(sec.equivalent_diameter_mm)]
    if not vals:
        return None
    return float(np.mean(vals))


def _nearest_reference_valve_size(area_derived_diameter_mm: float | None) -> dict[str, Any]:
    sizes = [20, 23, 26, 29]
    if area_derived_diameter_mm is None:
        return {"reference_nominal_sizes_mm": sizes, "nearest_nominal_size_mm": None}
    nearest = min(sizes, key=lambda s: abs(float(s) - float(area_derived_diameter_mm)))
    return {
        "reference_nominal_sizes_mm": sizes,
        "nearest_nominal_size_mm": int(nearest),
        "area_derived_diameter_mm": float(area_derived_diameter_mm),
        "method": "nearest_reference_nominal_size_non_vendor_specific",
    }


def _sanitize_coronary_height(coronary_side: dict[str, Any] | None) -> float | None:
    if not coronary_side:
        return None
    if str(coronary_side.get("status") or "not_found") != "detected":
        return None
    height = coronary_side.get("height_mm")
    return float(height) if height is not None else None


def _regularize_measurements(raw_measurements: dict[str, Any], root_model: AorticRootModel) -> tuple[dict[str, Any], dict[str, Any]]:
    measurements = deepcopy(raw_measurements)
    annulus_eq = measurements["annulus"]["equivalent_diameter_mm"]
    sinus_d = measurements["sinus_of_valsalva"]["max_diameter_mm"]
    stj_d = measurements["stj"]["diameter_mm"]

    corrected = {
        "sinus_was_raised_to_annulus": False,
        "stj_was_limited_to_sinus": False,
        "stj_was_raised_to_annulus": False,
        "commissure_angles_flagged": False,
    }
    if sinus_d is not None and annulus_eq is not None and sinus_d < annulus_eq:
        measurements["sinus_of_valsalva"]["max_diameter_mm"] = float(annulus_eq)
        measurements["sinus_of_valsalva"]["constraint_corrected_from_mm"] = float(sinus_d)
        measurements["sinus_of_valsalva"]["uncertainty_flag"] = "ANATOMY_CONSTRAINT_VIOLATION"
        measurements["sinus_of_valsalva"]["constraint_note"] = "sinus_raised_to_annulus_value"
        corrected["sinus_was_raised_to_annulus"] = True
        sinus_d = float(annulus_eq)
    if stj_d is not None and sinus_d is not None and stj_d > sinus_d:
        measurements["stj"]["diameter_mm"] = float(sinus_d)
        measurements["stj"]["constraint_corrected_from_mm"] = float(stj_d)
        measurements["stj"]["uncertainty_flag"] = "ANATOMY_CONSTRAINT_VIOLATION"
        measurements["stj"]["constraint_note"] = "stj_limited_to_sinus_value"
        corrected["stj_was_limited_to_sinus"] = True
        stj_d = float(sinus_d)
    if stj_d is not None and annulus_eq is not None and stj_d < annulus_eq:
        measurements["stj"]["diameter_mm"] = float(annulus_eq)
        measurements["stj"]["constraint_corrected_from_mm"] = float(stj_d)
        measurements["stj"]["uncertainty_flag"] = "ANATOMY_CONSTRAINT_VIOLATION"
        measurements["stj"]["constraint_note"] = "stj_raised_to_annulus_value"
        corrected["stj_was_raised_to_annulus"] = True

    comm_checks = root_model.anatomical_constraints.get("checks", []) if isinstance(root_model.anatomical_constraints, dict) else []
    for item in comm_checks:
        if item.get("id") == "commissure_angles_approx_120" and not bool(item.get("accepted")):
            corrected["commissure_angles_flagged"] = True
            break
    return measurements, corrected


def _sanity_checks(measurements: dict[str, Any], root_model: AorticRootModel) -> dict[str, Any]:
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
    if root_model.anatomical_constraints and not bool(root_model.anatomical_constraints.get("accepted", True)):
        for item in root_model.anatomical_constraints.get("violations", []):
            errors.append(str(item))
    return {"accepted": len(errors) == 0, "errors": errors}


def compute_calcium_burden(ct_hu: np.ndarray, region_mask: np.ndarray, voxel_volume_mm3: float, threshold_hu: float = 130.0) -> dict[str, Any]:
    calc = np.asarray(region_mask, dtype=bool) & (np.asarray(ct_hu, dtype=np.float32) >= float(threshold_hu))
    vox = int(calc.sum())
    return {
        "threshold_hu": float(threshold_hu),
        "calc_voxels": vox,
        "calc_volume_ml": float((vox * voxel_volume_mm3) / 1000.0),
        "method": "contrast_ct_hu_threshold_proxy",
    }


def _measurement_contract() -> dict[str, Any]:
    return {
        "annulus": {
            "method": "double_oblique_centerline_orthogonal_plane",
            "evidence_rule": "SCCT_TAVI_CT_consensus_double_oblique_annulus",
            "source_fields": ["centerline", "annulus_plane", "annulus_ring.contour_world"],
        },
        "lvot": {
            "method": "double_oblique_centerline_orthogonal_plane",
            "evidence_rule": "subannular_section_within_8mm_of_annulus",
            "source_fields": ["centerline", "orthogonal_sections"],
        },
        "sinus_of_valsalva": {
            "method": "sinus_radius_profile_peak",
            "evidence_rule": "root_profile_peak_distal_to_annulus",
            "source_fields": ["sinus_peaks", "sinus_section"],
        },
        "stj": {
            "method": "centerline_profile_first_local_minimum_after_sinus",
            "evidence_rule": "stj_ge_annulus_and_le_sinus",
            "source_fields": ["centerline_profile", "stj_section", "anatomical_constraints"],
        },
        "ascending_aorta": {
            "method": "ascending_plateau_mean_diameter",
            "evidence_rule": "post_stj_plateau_average",
            "source_fields": ["centerline_profile", "ascending_sections"],
        },
        "coronary_heights_mm": {
            "method": "ostium_to_annulus_plane_distance",
            "evidence_rule": "only_emit_when_ostium_status_detected",
            "source_fields": ["coronary_ostia", "annulus_plane"],
        },
        "calcium_burden": {
            "method": "contrast_ct_hu_threshold_proxy",
            "evidence_rule": "research_use_only_not_agatston_equivalent",
            "source_fields": ["ct_hu", "root_or_valve_roi"],
        },
        "leaflet_geometry": {
            "method": "leaflet_mesh_reconstruction_plus_regularization",
            "evidence_rule": "emit_status_uncertain_when_leaflet_roi_incomplete",
            "source_fields": ["leaflet_mask", "annulus_plane", "commissures", "hinge_curve"],
        },
    }


def _planning_evidence(regularized_measurements: dict[str, Any], annulus_plane: dict[str, Any]) -> dict[str, Any]:
    return {
        "vsrr": {
            "recommended_graft_size_mm": {
                "method": "mean_of_annulus_and_stj_with_floor",
                "evidence_rule": "research_use_geometry_proxy_for_root_reimplantation",
                "source_fields": [
                    "measurements_regularized.annulus.equivalent_diameter_mm",
                    "measurements_regularized.stj.diameter_mm",
                ],
            },
            "coaptation_reserve_mm": {
                "method": "effective_height_minus_reference_threshold",
                "evidence_rule": "effective_height_targeting_for_valve_repair",
                "source_fields": ["measurements_regularized.leaflet_geometry.effective_height_mean_mm"],
            },
        },
        "tavi": {
            "area_derived_valve_size": {
                "method": "nearest_reference_nominal_size_non_vendor_specific",
                "evidence_rule": "annulus_area_and_perimeter_drive_valve_sizing_but_vendor_table_required_for_clinical_use",
                "source_fields": ["measurements_regularized.annulus.area_mm2", "measurements_regularized.annulus.perimeter_mm"],
            },
            "coronary_risk_flag": {
                "method": "coronary_height_threshold_logic",
                "evidence_rule": "coronary_obstruction_risk_requires_height_plus_sinus_plus_virtual_valve_clearance",
                "source_fields": [
                    "measurements_regularized.coronary_heights_mm.left",
                    "measurements_regularized.coronary_heights_mm.right",
                    "measurements_regularized.sinus_of_valsalva.max_diameter_mm",
                    "measurements_regularized.stj.diameter_mm",
                ],
            },
        },
        "pears": {
            "root_external_geometry": {
                "method": "inner_root_geometry_proxy",
                "evidence_rule": "upgrade_to_outer_wall_geometry_before_device_design_use",
                "source_fields": [
                    "measurements_regularized.annulus.equivalent_diameter_mm",
                    "measurements_regularized.sinus_of_valsalva.max_diameter_mm",
                    "measurements_regularized.stj.diameter_mm",
                ],
            },
            "device_mesh_export": {
                "method": "surface_mesh_export_from_aortic_root_stl",
                "evidence_rule": "research_use_mesh_export_requires_outer_wall_and_coronary_window_planning",
                "source_fields": ["aortic_root_stl", "annulus_plane", "support_segment_length_mm"],
            },
            "annulus_plane_reference": annulus_plane,
        },
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

    if root_model.coronary_ostia.get("left", {}).get("status") == "not_evaluated":
        coronary = detect_coronary_ostia(
            ct_hu=ct_hu,
            lumen_mask=lumen_mask,
            annulus_plane=annulus_plane,
            landmark_sections=landmark_sections,
            spacing_mm=spacing_mm,
            affine=affine,
        )
        root_model = attach_coronary_ostia(root_model, coronary)
    else:
        coronary = root_model.coronary_ostia
    calcium = compute_calcium_burden(ct_hu, valve_region_mask, voxel_volume_mm3, threshold_hu=130.0)

    annulus_model = root_model.annulus_ring
    stj_model = root_model.sinotubular_junction
    sinus_peak_diameter = max(float(item.get("radius_mm", 0.0)) * 2.0 for item in root_model.regularized_landmarks.get("sinus_peaks", root_model.sinus_peaks)) if root_model.regularized_landmarks.get("sinus_peaks") else float(sinus.max_diameter_mm)
    annulus_metrics = {
        "diameter_short_mm": float(annulus_model.get("min_diameter_mm", annulus.min_diameter_mm)),
        "diameter_long_mm": float(annulus_model.get("max_diameter_mm", annulus.max_diameter_mm)),
        "area_mm2": float(annulus_model.get("area_mm2", annulus.area_mm2)),
        "perimeter_mm": float(annulus_model.get("perimeter_mm", annulus.perimeter_mm)) if annulus.perimeter_mm is not None else annulus_model.get("perimeter_mm"),
        "equivalent_diameter_mm": float(annulus_model.get("equivalent_diameter_mm", annulus.equivalent_diameter_mm)),
    }

    lvot_sections = [sec for sec in ascending_sections if sec.s_mm < annulus.s_mm and (annulus.s_mm - sec.s_mm) <= 8.0]
    lvot = lvot_sections[-1] if lvot_sections else annulus
    ascending_plateau = [sec for sec in ascending_sections if sec.s_mm >= stj.s_mm and (sec.s_mm - stj.s_mm) >= 8.0]
    ascending_d = _mean_diameter(ascending_plateau[: max(3, min(8, len(ascending_plateau)))]) or float(ascending.equivalent_diameter_mm)

    raw_measurements = {
        "annulus": annulus_metrics,
        "lvot": {
            "diameter_mm": float(lvot.equivalent_diameter_mm),
            "area_mm2": float(lvot.area_mm2),
        },
        "sinus_of_valsalva": {
            "max_diameter_mm": float(sinus_peak_diameter),
            "equivalent_diameter_mm": float(sinus.equivalent_diameter_mm),
        },
        "stj": {
            "diameter_mm": float(stj_model.get("equivalent_diameter_mm", stj.equivalent_diameter_mm)),
            "diameter_short_mm": float(stj_model.get("min_diameter_mm", stj.min_diameter_mm)),
            "diameter_long_mm": float(stj_model.get("max_diameter_mm", stj.max_diameter_mm)),
        },
        "ascending_aorta": {
            "diameter_mm": float(ascending_d),
        },
        "coronary_heights_mm": {
            "left": _sanitize_coronary_height(coronary.get("left")),
            "right": _sanitize_coronary_height(coronary.get("right")),
        },
        "calcium_burden": calcium,
        "leaflet_geometry": {
            "coaptation_height_mm": leaflet_model.coaptation_height_mm,
            "coaptation_surface_area_mm2": leaflet_model.coaptation_surface_area_mm2,
            "coaptation_level_mm": leaflet_model.coaptation_level_mm,
            "raw_coaptation_height_mm": leaflet_model.raw_coaptation_height_mm,
            "effective_height_mean_mm": leaflet_model.effective_height_mean_mm,
            "geometric_height_mean_mm": leaflet_model.geometric_height_mean_mm,
            "root_symmetry_index": leaflet_model.root_symmetry_index,
            "coaptation_reserve_mm": float(leaflet_model.effective_height_mean_mm - 9.0) if leaflet_model.effective_height_mean_mm is not None else None,
            "regularization": leaflet_model.regularization,
        },
    }
    regularized_measurements, constraint_corrections = _regularize_measurements(raw_measurements, root_model)
    root_model.raw_measurements = raw_measurements
    root_model.regularized_measurements = regularized_measurements

    annulus_stj_mismatch = float(regularized_measurements["annulus"]["equivalent_diameter_mm"] - regularized_measurements["stj"]["diameter_mm"])
    tavi_size = _nearest_reference_valve_size(regularized_measurements["annulus"]["equivalent_diameter_mm"])
    planning_evidence = _planning_evidence(regularized_measurements, annulus_plane)

    planning_metrics = {
        "vsrr": {
            "annulus_diameter_mm": regularized_measurements["annulus"]["equivalent_diameter_mm"],
            "sinus_diameter_mm": float(regularized_measurements["sinus_of_valsalva"]["max_diameter_mm"]),
            "stj_diameter_mm": float(regularized_measurements["stj"]["diameter_mm"]),
            "lvot_diameter_mm": float(lvot.equivalent_diameter_mm),
            "recommended_graft_size_mm": float(max(20.0, round((regularized_measurements["annulus"]["equivalent_diameter_mm"] + regularized_measurements["stj"]["diameter_mm"]) / 2.0, 1))),
            "annulus_stj_mismatch_mm": annulus_stj_mismatch,
            "coaptation_height_mm": leaflet_model.coaptation_height_mm,
            "effective_height_mean_mm": leaflet_model.effective_height_mean_mm,
            "coaptation_reserve_mm": regularized_measurements["leaflet_geometry"]["coaptation_reserve_mm"],
            "recommended_graft_size_metadata": planning_evidence["vsrr"]["recommended_graft_size_mm"],
            "coaptation_reserve_metadata": planning_evidence["vsrr"]["coaptation_reserve_mm"],
        },
        "pears": {
            "root_external_geometry": {
                "annulus_reference_mm": regularized_measurements["annulus"]["equivalent_diameter_mm"],
                "sinus_reference_mm": float(regularized_measurements["sinus_of_valsalva"]["max_diameter_mm"]),
                "stj_reference_mm": float(regularized_measurements["stj"]["diameter_mm"]),
            },
            "root_external_reference_diameter_mm": float(regularized_measurements["sinus_of_valsalva"]["max_diameter_mm"]),
            "support_segment_length_mm": float(max(0.0, ascending.s_mm - annulus.s_mm)),
            "annulus_plane": annulus_plane,
            "root_external_geometry_metadata": planning_evidence["pears"]["root_external_geometry"],
            "device_mesh_export_metadata": planning_evidence["pears"]["device_mesh_export"],
        },
        "tavi": {
            "annulus_area_mm2": regularized_measurements["annulus"]["area_mm2"],
            "annulus_perimeter_mm": regularized_measurements["annulus"]["perimeter_mm"],
            "annulus_diameter_short_mm": regularized_measurements["annulus"]["diameter_short_mm"],
            "annulus_diameter_long_mm": regularized_measurements["annulus"]["diameter_long_mm"],
            "coronary_height_left_mm": regularized_measurements["coronary_heights_mm"]["left"],
            "coronary_height_right_mm": regularized_measurements["coronary_heights_mm"]["right"],
            "sinus_width_mm": float(regularized_measurements["sinus_of_valsalva"]["max_diameter_mm"]),
            "stj_diameter_mm": float(regularized_measurements["stj"]["diameter_mm"]),
            "area_derived_valve_size": tavi_size,
            "coronary_risk_flag": bool(
                regularized_measurements["coronary_heights_mm"]["left"] is None
                or regularized_measurements["coronary_heights_mm"]["right"] is None
                or (regularized_measurements["coronary_heights_mm"]["left"] is not None and regularized_measurements["coronary_heights_mm"]["left"] < 10.0)
                or (regularized_measurements["coronary_heights_mm"]["right"] is not None and regularized_measurements["coronary_heights_mm"]["right"] < 10.0)
            ),
            "valve_calcium_burden": calcium,
            "area_derived_valve_size_metadata": planning_evidence["tavi"]["area_derived_valve_size"],
            "coronary_risk_flag_metadata": planning_evidence["tavi"]["coronary_risk_flag"],
        },
    }

    risk_flags: list[dict[str, Any]] = []
    left_h = regularized_measurements["coronary_heights_mm"]["left"]
    right_h = regularized_measurements["coronary_heights_mm"]["right"]
    if (left_h is not None and left_h < 10.0) or (right_h is not None and right_h < 10.0):
        risk_flags.append({"id": "low_coronary_height", "severity": "high", "message": "Coronary ostial height below 10 mm"})
    if coronary.get("clinician_review_required"):
        risk_flags.append({
            "id": "coronary_detection_requires_review",
            "severity": "critical",
            "message": "Coronary ostial detection requires clinician review before proceeding",
        })
    if coronary.get("left", {}).get("status") == "uncertain" or coronary.get("right", {}).get("status") == "uncertain":
        risk_flags.append({"id": "coronary_ostia_uncertain", "severity": "moderate", "message": "Coronary ostial detection is uncertain"})
    if leaflet_model.status != "detected" or any(item.status != "detected" for item in leaflet_model.leaflet_surfaces):
        risk_flags.append({"id": "leaflet_geometry_uncertain", "severity": "moderate", "message": "Leaflet reconstruction is partial or uncertain"})
    if float(regularized_measurements["sinus_of_valsalva"]["max_diameter_mm"]) < 30.0:
        risk_flags.append({"id": "small_sinus", "severity": "moderate", "message": "Sinus of Valsalva diameter appears small (<30 mm)"})
    if float(calcium["calc_volume_ml"]) > 0.35:
        risk_flags.append({"id": "heavy_valve_calcification", "severity": "high", "message": "Valve/root calcium burden is elevated (HU>130)"})

    sanity = _sanity_checks(regularized_measurements, root_model)
    for err in sanity["errors"]:
        risk_flags.append({"id": err, "severity": "critical", "message": err.replace("_", " ")})

    measurement_contract = _measurement_contract()
    measurements_json_payload = {
        "measurements": regularized_measurements,
        "measurements_raw": raw_measurements,
        "measurements_regularized": regularized_measurements,
        "measurement_contract": measurement_contract,
        "planning_metrics": planning_metrics,
        "planning_evidence": planning_evidence,
        "risk_flags": risk_flags,
        "sanity_checks": sanity,
        "constraint_corrections": constraint_corrections,
        "annulus_plane": annulus_plane,
        "aortic_root_model": asdict(root_model),
        "coronary_detection": coronary,
        "phase_metadata": root_model.phase_metadata,
        "provenance": root_model.provenance,
    }
    return regularized_measurements, planning_metrics, risk_flags, measurements_json_payload
