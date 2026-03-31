from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import nibabel as nib
import numpy as np

from gpu_provider.geometry.centerline import compute_centerline, compute_centerline_quality
from gpu_provider.geometry.landmarks import detect_landmarks_from_profile, pick_section_bundle
from gpu_provider.geometry.leaflet_model import build_leaflet_model
from gpu_provider.geometry.measurements import build_measurements
from gpu_provider.geometry.profile_analysis import attach_arclength_to_sections, build_radius_profile, sample_cross_sections
from gpu_provider.geometry.root_model import build_aortic_root_model


def _synthetic_multiclass(shape: tuple[int, int, int]) -> tuple[np.ndarray, np.ndarray]:
    sx, sy, sz = shape
    cx = sx / 2.0
    cy = sy / 2.0

    x, y = np.meshgrid(np.arange(sx, dtype=np.float32), np.arange(sy, dtype=np.float32), indexing="ij")
    labels = np.zeros(shape, dtype=np.uint8)
    ct = np.full(shape, -120.0, dtype=np.float32)

    for z in range(sz):
        z_ratio = z / max(1, sz - 1)
        if z_ratio < 0.35:
            r_x, r_y = 14.0, 13.0
        elif z_ratio < 0.58:
            r_x, r_y = 17.0, 16.0
        else:
            r_x, r_y = 15.0, 14.0
        eq = ((x - cx) ** 2) / (r_x**2) + ((y - cy) ** 2) / (r_y**2)
        lumen = eq <= 1.0
        shell = (eq > 0.72) & (eq <= 0.92)
        labels[:, :, z][lumen] = 1 if z < int(sz * 0.58) else 3
        labels[:, :, z][shell & (z >= int(sz * 0.26)) & (z <= int(sz * 0.48))] = 2
        ct[:, :, z][lumen] = 320.0
        ct[:, :, z][shell] = 180.0

    labels[:, :, int(sz * 0.58) :] = np.where(labels[:, :, int(sz * 0.58) :] == 1, 3, labels[:, :, int(sz * 0.58) :])
    return labels, ct


class PipelineIntegrationTests(unittest.TestCase):
    def test_geometry_chain_runs_on_synthetic_volume(self) -> None:
        shape = (96, 96, 128)
        spacing = (0.625, 0.625, 0.625)
        affine = np.diag([spacing[0], spacing[1], spacing[2], 1.0]).astype(np.float64)
        multiclass, ct = _synthetic_multiclass(shape)

        with tempfile.TemporaryDirectory(prefix="aortic-pipeline-int-") as td:
            td_path = Path(td)
            ct_path = td_path / "synthetic_ct.nii.gz"
            nib.save(nib.Nifti1Image(ct.astype(np.float32), affine), str(ct_path))

            root_mask = multiclass == 1
            leaflet_mask = multiclass == 2
            ascending_mask = multiclass == 3
            lumen_mask = root_mask | ascending_mask

            centerline = compute_centerline(lumen_mask, affine, spacing, sample_step_mm=1.25)
            quality = compute_centerline_quality(centerline, lumen_mask, spacing)
            self.assertIn("quality_flag", quality)

            sections = sample_cross_sections(
                lumen_mask=lumen_mask,
                centerline_world=centerline.points_world,
                centerline_voxel=centerline.points_voxel,
                tangents_world=centerline.tangents_world,
                centerline_radii_mm=centerline.radii_mm,
                affine=affine,
                plane_thickness_mm=0.8,
                voxel_volume_mm3=float(np.prod(spacing)),
                step_stride=2,
            )
            sections = attach_arclength_to_sections(sections, centerline.s_mm)
            _ = build_radius_profile(sections)
            landmarks = detect_landmarks_from_profile(sections, centerline.points_world, centerline.s_mm)
            landmark_sections = pick_section_bundle(sections, landmarks)

            root_model = build_aortic_root_model(
                sections=landmark_sections,
                landmarks=landmarks,
                centerline_world=centerline.points_world,
                centerline_voxel=centerline.points_voxel,
                centerline_s_mm=centerline.s_mm,
                centerline_method=centerline.method,
                affine=affine,
                root_mask=root_mask,
                leaflet_mask=leaflet_mask,
                ascending_mask=ascending_mask,
            )
            leaflet_model = build_leaflet_model(root_model, leaflet_mask=leaflet_mask, affine=affine, spacing_mm=spacing)
            measurements_structured, planning_metrics, risk_flags, measurements_payload = build_measurements(
                ct_hu=ct,
                lumen_mask=lumen_mask,
                valve_region_mask=(root_mask | leaflet_mask),
                landmark_sections=landmark_sections,
                ascending_sections=sections,
                annulus_plane=root_model.annulus_plane,
                root_model=root_model,
                leaflet_model=leaflet_model,
                spacing_mm=spacing,
                affine=affine,
                voxel_volume_mm3=float(np.prod(spacing)),
                centerline_result=centerline,
            )

            annulus_eq = (
                measurements_structured.get("annulus", {}).get("equivalent_diameter_mm")
                if isinstance(measurements_structured, dict)
                else None
            )
            self.assertIsNotNone(annulus_eq)
            self.assertGreater(float(annulus_eq), 0.0)

            coronary_detection = measurements_payload.get("coronary_detection", {})
            self.assertIn("clinician_review_required", coronary_detection)
            self.assertIsInstance(coronary_detection.get("clinician_review_required"), bool)
            self.assertIsInstance(risk_flags, list)

            self.assertIn("tavi", planning_metrics)
            self.assertIn("vsrr", planning_metrics)
            self.assertIn("pears", planning_metrics)


if __name__ == "__main__":
    unittest.main()
