from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy import ndimage

from .common import normalize
from .profile_analysis import SectionMetrics, nearest_section_by_index


@dataclass
class LandmarkDetectionResult:
    annulus_index: int
    sinus_peak_index: int
    stj_index: int
    ascending_reference_index: int
    annulus_plane: dict[str, Any]
    stj_plane: dict[str, Any]
    sinus_peak_point_world: list[float]
    ascending_reference_point_world: list[float]
    radius_curve_mm: list[float]
    radius_derivative: list[float]


def _plane_payload(section: SectionMetrics) -> dict[str, Any]:
    return {
        "origin_world": [float(x) for x in section.center_world],
        "origin_voxel": [float(x) for x in section.center_voxel],
        "normal_world": [float(x) for x in normalize(section.tangent_world)],
        "basis_u_world": [float(x) for x in section.basis_u_world],
        "basis_v_world": [float(x) for x in section.basis_v_world],
        "corners_world": [[float(v) for v in p] for p in section.contour_world[::16]],
        "corners_voxel": [[float(v) for v in p] for p in section.contour_voxel[::16]],
        "index": int(section.index),
        "s_mm": float(section.s_mm),
    }


def _local_extrema(values: np.ndarray, mode: str) -> list[int]:
    idxs: list[int] = []
    for i in range(1, values.shape[0] - 1):
        prev_v = float(values[i - 1])
        cur_v = float(values[i])
        next_v = float(values[i + 1])
        if mode == "min" and cur_v <= prev_v and cur_v <= next_v:
            idxs.append(i)
        if mode == "max" and cur_v >= prev_v and cur_v >= next_v:
            idxs.append(i)
    return idxs


def detect_landmarks_from_profile(
    sections: list[SectionMetrics],
    centerline_world: np.ndarray,
    centerline_s_mm: np.ndarray,
) -> LandmarkDetectionResult:
    if len(sections) < 5:
        raise RuntimeError("geometry_landmark_detection_failed")

    radii = np.asarray([float(sec.equivalent_radius_mm) for sec in sections], dtype=np.float64)
    s = np.asarray([float(sec.s_mm) for sec in sections], dtype=np.float64)
    radii_s = ndimage.gaussian_filter1d(radii, sigma=max(1.0, len(radii) / 30.0))
    deriv = np.gradient(radii_s, s) if len(radii_s) > 2 else np.zeros_like(radii_s)

    maxima = _local_extrema(radii_s, "max")
    minima = _local_extrema(radii_s, "min")
    sinus_peak_pos = int(maxima[np.argmax(radii_s[maxima])] if maxima else int(np.argmax(radii_s)))

    annulus_candidates = [i for i in minima if i < sinus_peak_pos]
    if annulus_candidates:
        annulus_pos = annulus_candidates[-1]
    else:
        search_hi = max(1, sinus_peak_pos)
        annulus_pos = int(np.argmin(radii_s[: search_hi + 1]))

    stj_candidates = [i for i in minima if i > sinus_peak_pos]
    if stj_candidates:
        stj_pos = stj_candidates[0]
    else:
        stj_pos = int(sinus_peak_pos + np.argmin(radii_s[sinus_peak_pos:]))

    tail = range(min(len(sections) - 1, stj_pos + 3), len(sections))
    stable = []
    for i in tail:
        if abs(float(deriv[i])) <= np.percentile(np.abs(deriv[tail]), 40.0) if stable is not None else True:
            stable.append(i)
    if stable:
        ascending_pos = stable[min(len(stable) // 2, len(stable) - 1)]
    else:
        ascending_pos = min(len(sections) - 1, stj_pos + max(2, len(sections) // 8))

    annulus_sec = sections[annulus_pos]
    sinus_sec = sections[sinus_peak_pos]
    stj_sec = sections[stj_pos]
    asc_sec = sections[ascending_pos]

    return LandmarkDetectionResult(
        annulus_index=int(annulus_sec.index),
        sinus_peak_index=int(sinus_sec.index),
        stj_index=int(stj_sec.index),
        ascending_reference_index=int(asc_sec.index),
        annulus_plane=_plane_payload(annulus_sec),
        stj_plane=_plane_payload(stj_sec),
        sinus_peak_point_world=[float(x) for x in sinus_sec.center_world],
        ascending_reference_point_world=[float(x) for x in asc_sec.center_world],
        radius_curve_mm=[float(x) for x in radii_s],
        radius_derivative=[float(x) for x in deriv],
    )


def pick_section_bundle(sections: list[SectionMetrics], result: LandmarkDetectionResult) -> dict[str, SectionMetrics | None]:
    return {
        "annulus": nearest_section_by_index(sections, result.annulus_index),
        "sinus": nearest_section_by_index(sections, result.sinus_peak_index),
        "stj": nearest_section_by_index(sections, result.stj_index),
        "ascending": nearest_section_by_index(sections, result.ascending_reference_index),
    }
