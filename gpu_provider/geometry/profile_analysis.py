from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import nibabel as nib
import numpy as np

from .common import ellipse_perimeter_from_diameters, orth_basis_from_tangent, points_world_to_voxel


@dataclass
class SectionMetrics:
    index: int
    s_mm: float
    area_mm2: float
    perimeter_mm: float | None
    equivalent_radius_mm: float
    equivalent_diameter_mm: float
    max_diameter_mm: float
    min_diameter_mm: float
    center_world: np.ndarray
    center_voxel: np.ndarray
    tangent_world: np.ndarray
    basis_u_world: np.ndarray
    basis_v_world: np.ndarray
    line_world: dict[str, float]
    line_voxel: dict[str, float]
    contour_world: np.ndarray
    contour_voxel: np.ndarray
    radial_angles_rad: np.ndarray
    radial_profile_mm: np.ndarray
    voxel_count: int


def _build_radial_boundary(
    uu: np.ndarray,
    vv: np.ndarray,
    center_world: np.ndarray,
    u_world: np.ndarray,
    v_world: np.ndarray,
    affine_inv: np.ndarray,
    bins: int = 72,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    angles = np.linspace(0.0, 2.0 * np.pi, bins, endpoint=False, dtype=np.float64)
    if uu.size == 0:
        contour_world = np.repeat(center_world[None, :], bins, axis=0)
        contour_voxel = points_world_to_voxel(contour_world, affine_inv)
        return contour_world, contour_voxel, angles, np.zeros((bins,), dtype=np.float64)

    radii = np.sqrt(uu * uu + vv * vv)
    theta = np.mod(np.arctan2(vv, uu), 2.0 * np.pi)
    idx = np.floor((theta / (2.0 * np.pi)) * bins).astype(np.int32)
    idx = np.clip(idx, 0, bins - 1)
    radial_profile = np.full((bins,), np.nan, dtype=np.float64)
    for b in range(bins):
        sel = radii[idx == b]
        if sel.size:
            radial_profile[b] = float(np.max(sel))
    valid = np.isfinite(radial_profile)
    if not np.any(valid):
        radial_profile[:] = float(np.max(radii)) if radii.size else 0.0
    elif np.count_nonzero(valid) < bins:
        valid_idx = np.flatnonzero(valid)
        radial_profile = np.interp(np.arange(bins), valid_idx, radial_profile[valid_idx], period=bins)
    contour_world = np.asarray(
        [
            center_world + np.cos(ang) * rr * u_world + np.sin(ang) * rr * v_world
            for ang, rr in zip(angles, radial_profile)
        ],
        dtype=np.float64,
    )
    contour_voxel = points_world_to_voxel(contour_world, affine_inv)
    return contour_world, contour_voxel, angles, radial_profile


def section_metrics_from_mask(
    lumen_mask: np.ndarray,
    center_world: np.ndarray,
    center_voxel: np.ndarray,
    tangent_world: np.ndarray,
    affine_inv: np.ndarray,
    spacing_mm: tuple[float, float, float],
    radius_mm: float,
    index: int,
    s_mm: float,
) -> SectionMetrics | None:
    center_world = np.asarray(center_world, dtype=np.float64)
    center_voxel = np.asarray(center_voxel, dtype=np.float64)
    tangent_world = np.asarray(tangent_world, dtype=np.float64)
    u, v = orth_basis_from_tangent(tangent_world)
    step_mm = max(0.7, min(float(spacing_mm[0]), float(spacing_mm[1]), float(spacing_mm[2])))
    radius_mm = float(max(step_mm * 4.0, radius_mm))
    n = max(4, int(np.ceil(radius_mm / step_mm)))

    nx, ny, nz = lumen_mask.shape
    samples_u: list[float] = []
    samples_v: list[float] = []
    for j in range(-n, n + 1):
        dv = j * step_mm
        for i in range(-n, n + 1):
            du = i * step_mm
            if du * du + dv * dv > radius_mm * radius_mm:
                continue
            world = center_world + u * du + v * dv
            voxel = nib.affines.apply_affine(affine_inv, world)
            xv = int(round(float(voxel[0])))
            yv = int(round(float(voxel[1])))
            zv = int(round(float(voxel[2])))
            if xv < 0 or yv < 0 or zv < 0 or xv >= nx or yv >= ny or zv >= nz:
                continue
            if not bool(lumen_mask[xv, yv, zv]):
                continue
            samples_u.append(du)
            samples_v.append(dv)

    if len(samples_u) < 12:
        return None

    uu = np.asarray(samples_u, dtype=np.float64)
    vv = np.asarray(samples_v, dtype=np.float64)
    area_mm2 = float(len(uu) * step_mm * step_mm)
    eq_radius_mm = float(np.sqrt(max(1e-6, area_mm2) / np.pi))
    eq_diameter_mm = float(eq_radius_mm * 2.0)

    mean_u = float(np.mean(uu))
    mean_v = float(np.mean(vv))
    cov = np.array(
        [
            [float(np.mean((uu - mean_u) ** 2)), float(np.mean((uu - mean_u) * (vv - mean_v)))],
            [float(np.mean((uu - mean_u) * (vv - mean_v))), float(np.mean((vv - mean_v) ** 2))],
        ],
        dtype=np.float64,
    )
    eigvals, eigvecs = np.linalg.eigh(cov)
    order = np.argsort(eigvals)[::-1]
    eigvals = eigvals[order]
    eigvecs = eigvecs[:, order]
    l1 = max(0.0, float(eigvals[0])) if eigvals.size else 0.0
    l2 = max(0.0, float(eigvals[1])) if eigvals.size > 1 else 0.0
    max_diameter_mm = float(4.0 * np.sqrt(l1)) if l1 > 0 else eq_diameter_mm
    min_diameter_mm = float(4.0 * np.sqrt(l2)) if l2 > 0 else eq_diameter_mm
    perimeter_mm = ellipse_perimeter_from_diameters(max_diameter_mm, min_diameter_mm)

    axis_uv = eigvecs[:, 0] if eigvecs.shape[1] else np.array([1.0, 0.0], dtype=np.float64)
    axis_world = axis_uv[0] * u + axis_uv[1] * v
    axis_world = axis_world / max(1e-8, float(np.linalg.norm(axis_world)))
    minor_axis_world = eigvecs[0, 1] * u + eigvecs[1, 1] * v if eigvecs.shape[1] > 1 else v
    minor_axis_world = minor_axis_world / max(1e-8, float(np.linalg.norm(minor_axis_world)))

    half_long = max_diameter_mm * 0.5
    p1_world = center_world - axis_world * half_long
    p2_world = center_world + axis_world * half_long
    p1_voxel = nib.affines.apply_affine(affine_inv, p1_world)
    p2_voxel = nib.affines.apply_affine(affine_inv, p2_world)

    contour_world_arr, contour_voxel_arr, radial_angles_rad, radial_profile_mm = _build_radial_boundary(
        uu=uu,
        vv=vv,
        center_world=center_world,
        u_world=u,
        v_world=v,
        affine_inv=affine_inv,
    )

    return SectionMetrics(
        index=int(index),
        s_mm=float(s_mm),
        area_mm2=area_mm2,
        perimeter_mm=perimeter_mm,
        equivalent_radius_mm=eq_radius_mm,
        equivalent_diameter_mm=eq_diameter_mm,
        max_diameter_mm=max_diameter_mm,
        min_diameter_mm=min_diameter_mm,
        center_world=center_world,
        center_voxel=center_voxel,
        tangent_world=tangent_world,
        basis_u_world=np.asarray(u, dtype=np.float64),
        basis_v_world=np.asarray(v, dtype=np.float64),
        line_world={
            "x1": float(p1_world[0]),
            "y1": float(p1_world[1]),
            "z1": float(p1_world[2]),
            "x2": float(p2_world[0]),
            "y2": float(p2_world[1]),
            "z2": float(p2_world[2]),
        },
        line_voxel={
            "x1": float(p1_voxel[0]),
            "y1": float(p1_voxel[1]),
            "z1": float(p1_voxel[2]),
            "x2": float(p2_voxel[0]),
            "y2": float(p2_voxel[1]),
            "z2": float(p2_voxel[2]),
        },
        contour_world=contour_world_arr,
        contour_voxel=contour_voxel_arr,
        radial_angles_rad=radial_angles_rad,
        radial_profile_mm=radial_profile_mm,
        voxel_count=len(samples_u),
    )


def sample_cross_sections(
    lumen_mask: np.ndarray,
    centerline_world: np.ndarray,
    centerline_voxel: np.ndarray,
    tangents_world: np.ndarray,
    centerline_radii_mm: np.ndarray,
    affine: np.ndarray,
    plane_thickness_mm: float,
    voxel_volume_mm3: float,
    step_stride: int = 2,
) -> list[SectionMetrics]:
    del plane_thickness_mm, voxel_volume_mm3
    affine_inv = np.linalg.inv(affine)
    spacing_guess = (
        float(np.linalg.norm(affine[:3, 0])),
        float(np.linalg.norm(affine[:3, 1])),
        float(np.linalg.norm(affine[:3, 2])),
    )
    sections: list[SectionMetrics] = []
    for i in range(0, centerline_world.shape[0], max(1, int(step_stride))):
        local_radius = float(centerline_radii_mm[i]) if i < centerline_radii_mm.shape[0] else 0.0
        radius_mm = max(10.0, min(48.0, local_radius * 2.6 if local_radius > 0 else 28.0))
        sec = section_metrics_from_mask(
            lumen_mask=lumen_mask,
            center_world=centerline_world[i],
            center_voxel=centerline_voxel[i],
            tangent_world=tangents_world[i],
            affine_inv=affine_inv,
            spacing_mm=spacing_guess,
            radius_mm=radius_mm,
            index=i,
            s_mm=float(i),
        )
        if sec is not None:
            sections.append(sec)
    if not sections:
        raise RuntimeError("geometry_profile_sampling_failed")
    return sections


def attach_arclength_to_sections(sections: list[SectionMetrics], centerline_s_mm: np.ndarray) -> list[SectionMetrics]:
    for sec in sections:
        idx = max(0, min(int(sec.index), len(centerline_s_mm) - 1))
        sec.s_mm = float(centerline_s_mm[idx])
    return sections


def build_radius_profile(sections: list[SectionMetrics]) -> list[dict[str, Any]]:
    return [
        {
            "index": int(sec.index),
            "s_mm": float(sec.s_mm),
            "area_mm2": float(sec.area_mm2),
            "perimeter_mm": float(sec.perimeter_mm) if sec.perimeter_mm is not None else None,
            "equivalent_radius_mm": float(sec.equivalent_radius_mm),
            "equivalent_diameter_mm": float(sec.equivalent_diameter_mm),
            "max_diameter_mm": float(sec.max_diameter_mm),
            "min_diameter_mm": float(sec.min_diameter_mm),
        }
        for sec in sections
    ]


def nearest_section_by_index(sections: list[SectionMetrics], idx: int) -> SectionMetrics | None:
    if not sections:
        return None
    return min(sections, key=lambda sec: abs(int(sec.index) - int(idx)))
