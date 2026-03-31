from __future__ import annotations

import unittest

import numpy as np

from gpu_provider.geometry.centerline import CenterlineResult, compute_centerline_quality
from gpu_provider.geometry.coronary_detection import _empty_side, _finalize_side
from gpu_provider.geometry.measurements import _regularize_measurements
from gpu_provider.geometry.profile_analysis import SectionMetrics
from gpu_provider.geometry.root_model import AorticRootModel, detect_commissures_and_sinus_peaks


def _make_section(radial_profile_mm: np.ndarray) -> SectionMetrics:
    angles = np.linspace(0.0, 2.0 * np.pi, radial_profile_mm.shape[0], endpoint=False, dtype=np.float64)
    contour_world = np.stack(
        [
            np.cos(angles) * radial_profile_mm,
            np.sin(angles) * radial_profile_mm,
            np.zeros_like(angles),
        ],
        axis=1,
    )
    contour_voxel = contour_world.copy()
    center = np.array([0.0, 0.0, 0.0], dtype=np.float64)
    tangent = np.array([0.0, 0.0, 1.0], dtype=np.float64)
    basis_u = np.array([1.0, 0.0, 0.0], dtype=np.float64)
    basis_v = np.array([0.0, 1.0, 0.0], dtype=np.float64)
    return SectionMetrics(
        index=0,
        s_mm=0.0,
        area_mm2=100.0,
        perimeter_mm=40.0,
        equivalent_radius_mm=float(np.mean(radial_profile_mm)),
        equivalent_diameter_mm=float(np.mean(radial_profile_mm) * 2.0),
        max_diameter_mm=float(np.max(radial_profile_mm) * 2.0),
        min_diameter_mm=float(np.min(radial_profile_mm) * 2.0),
        center_world=center,
        center_voxel=center.copy(),
        tangent_world=tangent,
        basis_u_world=basis_u,
        basis_v_world=basis_v,
        line_world={"x1": -1.0, "y1": 0.0, "z1": 0.0, "x2": 1.0, "y2": 0.0, "z2": 0.0},
        line_voxel={"x1": -1.0, "y1": 0.0, "z1": 0.0, "x2": 1.0, "y2": 0.0, "z2": 0.0},
        contour_world=contour_world,
        contour_voxel=contour_voxel,
        radial_angles_rad=angles,
        radial_profile_mm=np.asarray(radial_profile_mm, dtype=np.float64),
        voxel_count=200,
    )


def _make_root_model() -> AorticRootModel:
    return AorticRootModel(
        model_type="test",
        annulus_ring={},
        hinge_curve={},
        commissures=[],
        sinus_peaks=[],
        sinotubular_junction={},
        coronary_ostia={},
        ascending_axis={},
        ascending_aorta_axis={},
        centerline={},
        structure_metadata={},
        raw_landmarks={},
        regularized_landmarks={},
        raw_measurements={},
        regularized_measurements={},
        phase_metadata={},
        provenance={},
        anatomical_constraints={},
        confidence_scores={},
        reference_sections={},
        annulus_plane={},
        leaflet_geometry={},
        leaflet_meshes=[],
        digital_twin_simulation={},
    )


class Sprint8GpuPipelineSafetyTests(unittest.TestCase):
    def test_empty_side_detection_failed_requires_clinician_review(self) -> None:
        side = _empty_side("detection_failed")
        self.assertTrue(side["clinician_review_required"])

    def test_finalize_side_none_returns_detection_failed(self) -> None:
        side = _finalize_side(None)
        self.assertEqual(side["status"], "detection_failed")
        self.assertTrue(side["clinician_review_required"])

    def test_finalize_side_low_confidence_returns_detection_failed(self) -> None:
        side = _finalize_side({"confidence": 0.1, "height_mm": 11.0})
        self.assertEqual(side["status"], "detection_failed")
        self.assertTrue(side["clinician_review_required"])

    def test_regularize_measurements_flags_sinus_below_annulus(self) -> None:
        regularized, _ = _regularize_measurements(
            {
                "annulus": {"equivalent_diameter_mm": 28.0},
                "sinus_of_valsalva": {"max_diameter_mm": 24.0},
                "stj": {"diameter_mm": 26.0},
            },
            _make_root_model(),
        )
        self.assertEqual(
            regularized["sinus_of_valsalva"]["uncertainty_flag"],
            "ANATOMY_CONSTRAINT_VIOLATION",
        )

    def test_root_model_fallback_preserves_actual_commissure_spacing_stats(self) -> None:
        radial = np.full((72,), 10.0, dtype=np.float64)
        radial[0] = 16.0
        radial[5] = 15.0
        radial[10] = 14.0
        sinus_section = _make_section(radial)
        stj_radial = np.full((72,), 8.0, dtype=np.float64)
        stj_section = _make_section(stj_radial)
        for idx, angle_deg in ((12, 35.0), (36, 170.0), (60, 300.0)):
            angle_rad = np.deg2rad(angle_deg)
            point = np.array([np.cos(angle_rad) * 8.0, np.sin(angle_rad) * 8.0, 0.0], dtype=np.float64)
            stj_section.contour_world[idx] = point
            stj_section.contour_voxel[idx] = point
        annulus_plane = {
            "origin_world": [0.0, 0.0, 0.0],
            "basis_u_world": [1.0, 0.0, 0.0],
            "basis_v_world": [0.0, 1.0, 0.0],
        }

        _, _, geometry_stats, _ = detect_commissures_and_sinus_peaks(sinus_section, stj_section, annulus_plane)

        self.assertTrue(geometry_stats["regularized"])
        self.assertEqual(
            geometry_stats["regularization_reason"],
            "primary_spacing_error_exceeded_35_deg",
        )
        self.assertNotEqual(
            geometry_stats["commissure_angle_spacing_deg"],
            [120.0, 120.0, 120.0],
        )

    def test_compute_centerline_quality_reports_uncertainty_flag(self) -> None:
        result = CenterlineResult(
            method="test",
            points_voxel=np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]], dtype=np.float64),
            points_world=np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]], dtype=np.float64),
            tangents_world=np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], dtype=np.float64),
            s_mm=np.array([0.0, 1.0], dtype=np.float64),
            radii_mm=np.array([0.2, 0.3], dtype=np.float64),
            distance_map_mm=np.zeros((2, 2, 2), dtype=np.float32),
            skeleton_mask=np.zeros((2, 2, 2), dtype=bool),
        )

        quality = compute_centerline_quality(
            result=result,
            lumen_mask=np.zeros((2, 2, 2), dtype=bool),
            spacing_mm=(1.0, 1.0, 1.0),
        )

        self.assertEqual(quality["quality_flag"], "poor")
        self.assertEqual(quality["uncertainty_flag"], "DETECTION_FAILED")


if __name__ == "__main__":
    unittest.main()
