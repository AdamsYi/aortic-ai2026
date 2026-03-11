#!/usr/bin/env python3
"""
Research-grade CTA aortic planning pipeline (real processing, no placeholders):
1) DICOM(.zip/.dcm series) -> NIfTI via dcm2niix (if needed)
2) Multiclass segmentation via TotalSegmentator-based builder
3) Aortic centerline extraction (VMTK if available, otherwise robust centroid fallback)
4) Centerline-orthogonal cross-sectional measurements
5) Annulus/STJ/sinus/LVOT/ascending metrics + coronary ostia height estimate + calcium burden
6) Aortic root STL export (marching cubes)
7) Planning report export (PDF)
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Optional

import nibabel as nib
import numpy as np
from scipy import ndimage

try:
    from skimage import measure as sk_measure
except Exception:  # pragma: no cover - handled at runtime
    sk_measure = None

try:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas as pdf_canvas
except Exception:  # pragma: no cover - handled at runtime
    A4 = None
    pdf_canvas = None


def run_cmd(cmd: list[str]) -> tuple[str, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"Command failed ({proc.returncode}): {' '.join(cmd)}\n"
            f"stderr_tail={proc.stderr[-1200:]}"
        )
    return proc.stdout or "", proc.stderr or ""


def find_bin(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise FileNotFoundError(f"Required binary not found: {name}")
    return found


def mm_to_vox_z(mm: float, spacing_mm: tuple[float, float, float]) -> int:
    s = max(0.2, float(spacing_mm[2]))
    return max(1, int(round(mm / s)))


def mm_to_vox_xy(mm: float, spacing_mm: tuple[float, float, float]) -> int:
    s = max(0.2, float(min(spacing_mm[0], spacing_mm[1])))
    return max(1, int(round(mm / s)))


def normalize(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    if n <= 1e-8 or not np.isfinite(n):
        return np.array([0.0, 0.0, 1.0], dtype=np.float64)
    return (v / n).astype(np.float64)


def ellipse_perimeter_from_diameters(major_mm: float | None, minor_mm: float | None) -> float | None:
    if major_mm is None or minor_mm is None:
        return None
    if major_mm <= 0 or minor_mm <= 0:
        return None
    a = max(major_mm, minor_mm) * 0.5
    b = min(major_mm, minor_mm) * 0.5
    term = max(0.0, (3 * a + b) * (a + 3 * b))
    return float(math.pi * (3 * (a + b) - math.sqrt(term)))


def eq_diameter_from_area(area_mm2: float | None) -> float | None:
    if area_mm2 is None or area_mm2 <= 0:
        return None
    return float(2.0 * math.sqrt(area_mm2 / math.pi))


def prepare_nifti_input(input_path: Path, work_dir: Path) -> tuple[Path, dict[str, Any]]:
    suffix = input_path.name.lower()
    meta: dict[str, Any] = {"input_kind": "unknown", "conversion": "none"}
    if suffix.endswith(".nii") or suffix.endswith(".nii.gz"):
        meta["input_kind"] = "nifti"
        return input_path, meta

    dcm2niix = find_bin("dcm2niix")
    dicom_dir = work_dir / "dicom_input"
    dicom_dir.mkdir(parents=True, exist_ok=True)

    if suffix.endswith(".zip"):
        meta["input_kind"] = "dicom_zip"
        with zipfile.ZipFile(input_path, "r") as zf:
            zf.extractall(dicom_dir)
    else:
        meta["input_kind"] = "dicom_file_or_series"
        shutil.copy2(input_path, dicom_dir / input_path.name)

    out_dir = work_dir / "nifti"
    out_dir.mkdir(parents=True, exist_ok=True)
    run_cmd([dcm2niix, "-z", "y", "-o", str(out_dir), str(dicom_dir)])
    nii_files = sorted(out_dir.glob("*.nii.gz")) + sorted(out_dir.glob("*.nii"))
    if not nii_files:
        raise RuntimeError("dcm2niix produced no NIfTI output.")
    meta["conversion"] = "dcm2niix"
    meta["dcm2niix_output"] = str(nii_files[0].name)
    return nii_files[0], meta


def parse_builder_meta(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def points_voxel_to_world(ijk: np.ndarray, affine: np.ndarray) -> np.ndarray:
    if ijk.size == 0:
        return np.zeros((0, 3), dtype=np.float64)
    return nib.affines.apply_affine(affine, ijk.astype(np.float64))


def points_world_to_voxel(xyz: np.ndarray, affine_inv: np.ndarray) -> np.ndarray:
    if xyz.size == 0:
        return np.zeros((0, 3), dtype=np.float64)
    return nib.affines.apply_affine(affine_inv, xyz.astype(np.float64))


def parse_vtp_points_ascii(vtp_path: Path) -> np.ndarray:
    try:
        tree = ET.parse(str(vtp_path))
        root = tree.getroot()
        points_node = root.find(".//Points")
        if points_node is None:
            return np.zeros((0, 3), dtype=np.float64)
        da = points_node.find("DataArray")
        if da is None or da.text is None:
            return np.zeros((0, 3), dtype=np.float64)
        vals = np.fromstring(da.text, sep=" ", dtype=np.float64)
        if vals.size < 3:
            return np.zeros((0, 3), dtype=np.float64)
        vals = vals[: (vals.size // 3) * 3]
        return vals.reshape((-1, 3))
    except Exception:
        return np.zeros((0, 3), dtype=np.float64)


def extract_centerline_vmtk(
    aorta_union: np.ndarray,
    affine: np.ndarray,
    work_dir: Path,
) -> tuple[np.ndarray, str]:
    if (work_dir / "disable_vmtk.flag").exists():
        return np.zeros((0, 3), dtype=np.float64), "disabled"

    vmtk_mc = shutil.which("vmtkmarchingcubes")
    vmtk_cl = shutil.which("vmtkcenterlines")
    if not vmtk_mc or not vmtk_cl:
        return np.zeros((0, 3), dtype=np.float64), "vmtk_not_found"

    try:
        mask_path = work_dir / "aorta_union.nii.gz"
        surf_path = work_dir / "aorta_surface.vtp"
        cl_path = work_dir / "aorta_centerline.vtp"
        nib.save(nib.Nifti1Image(aorta_union.astype(np.uint8), affine), str(mask_path))

        run_cmd([vmtk_mc, "-ifile", str(mask_path), "-ofile", str(surf_path), "-l", "0.5"])
        run_cmd([vmtk_cl, "-ifile", str(surf_path), "-seedselector", "openprofiles", "-ofile", str(cl_path)])

        pts_world = parse_vtp_points_ascii(cl_path)
        if pts_world.shape[0] < 8:
            return np.zeros((0, 3), dtype=np.float64), "vmtk_centerline_empty"
        return pts_world, "vmtk_openprofiles"
    except Exception as exc:
        return np.zeros((0, 3), dtype=np.float64), f"vmtk_failed:{exc}"


def extract_centerline_centroid(aorta_union: np.ndarray) -> np.ndarray:
    nz = int(aorta_union.shape[2])
    raw: list[list[float]] = []
    for z in range(nz):
        sl = aorta_union[:, :, z]
        pts = np.argwhere(sl)
        if pts.shape[0] < 10:
            continue
        cx = float(pts[:, 0].mean())
        cy = float(pts[:, 1].mean())
        raw.append([cx, cy, float(z)])

    if len(raw) < 2:
        return np.zeros((0, 3), dtype=np.float64)

    arr = np.asarray(raw, dtype=np.float64)

    z_all = np.arange(int(arr[0, 2]), int(arr[-1, 2]) + 1, dtype=np.float64)
    x_interp = np.interp(z_all, arr[:, 2], arr[:, 0])
    y_interp = np.interp(z_all, arr[:, 2], arr[:, 1])
    x_s = ndimage.gaussian_filter1d(x_interp, sigma=1.2)
    y_s = ndimage.gaussian_filter1d(y_interp, sigma=1.2)
    out = np.column_stack([x_s, y_s, z_all]).astype(np.float64)

    dedup = [out[0]]
    for i in range(1, out.shape[0]):
        if float(np.linalg.norm(out[i] - dedup[-1])) >= 0.2:
            dedup.append(out[i])
    return np.asarray(dedup, dtype=np.float64)


def resample_polyline(vox_pts: np.ndarray, world_pts: np.ndarray, step_mm: float = 1.5) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if vox_pts.shape[0] < 2:
        if vox_pts.shape[0] == 1:
            return vox_pts.copy(), world_pts.copy(), np.array([0.0], dtype=np.float64)
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.float64), np.zeros((0,), dtype=np.float64)

    dif = world_pts[1:] - world_pts[:-1]
    seg_len = np.linalg.norm(dif, axis=1)
    s = np.zeros((world_pts.shape[0],), dtype=np.float64)
    s[1:] = np.cumsum(seg_len)
    total = float(s[-1])
    if total <= 1e-6:
        return vox_pts.copy(), world_pts.copy(), s

    n = max(2, int(math.ceil(total / max(0.5, step_mm))) + 1)
    sr = np.linspace(0.0, total, n, dtype=np.float64)

    out_vox = np.zeros((n, 3), dtype=np.float64)
    out_world = np.zeros((n, 3), dtype=np.float64)
    for dim in range(3):
        out_vox[:, dim] = np.interp(sr, s, vox_pts[:, dim])
        out_world[:, dim] = np.interp(sr, s, world_pts[:, dim])

    return out_vox, out_world, sr


def tangents_from_polyline(world_pts: np.ndarray) -> np.ndarray:
    n = world_pts.shape[0]
    if n == 0:
        return np.zeros((0, 3), dtype=np.float64)
    if n == 1:
        return np.array([[0.0, 0.0, 1.0]], dtype=np.float64)

    t = np.zeros_like(world_pts, dtype=np.float64)
    for i in range(n):
        i0 = max(0, i - 1)
        i1 = min(n - 1, i + 1)
        t[i] = normalize(world_pts[i1] - world_pts[i0])
    return t


def orth_basis_from_tangent(t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    ref = np.array([0.0, 0.0, 1.0], dtype=np.float64)
    if abs(float(np.dot(t, ref))) > 0.9:
        ref = np.array([1.0, 0.0, 0.0], dtype=np.float64)
    u = np.cross(t, ref)
    u = normalize(u)
    v = normalize(np.cross(t, u))
    return u, v


def section_metrics_from_points(
    points_world: np.ndarray,
    center_world: np.ndarray,
    tangent_world: np.ndarray,
    voxel_volume_mm3: float,
    plane_thickness_mm: float,
    radius_mm: float,
    affine_inv: np.ndarray,
) -> dict[str, Any] | None:
    if points_world.shape[0] < 20:
        return None

    t = normalize(tangent_world)
    d = (points_world - center_world[None, :]) @ t
    sel = np.abs(d) <= (plane_thickness_mm * 0.5)
    if int(np.count_nonzero(sel)) < 16:
        sel = np.abs(d) <= max(1.4, plane_thickness_mm)
    if int(np.count_nonzero(sel)) < 16:
        return None

    pts = points_world[sel]
    u, v = orth_basis_from_tangent(t)
    rel = pts - center_world[None, :]
    uu = rel @ u
    vv = rel @ v

    r2 = uu * uu + vv * vv
    keep = r2 <= (radius_mm * radius_mm)
    if int(np.count_nonzero(keep)) < 12:
        return None

    uu = uu[keep]
    vv = vv[keep]
    n = int(uu.shape[0])

    area_mm2 = float((n * voxel_volume_mm3) / max(0.8, plane_thickness_mm))
    eq_diam_mm = eq_diameter_from_area(area_mm2)

    u0 = uu - float(uu.mean())
    v0 = vv - float(vv.mean())
    cov = np.array(
        [
            [float(np.mean(u0 * u0)), float(np.mean(u0 * v0))],
            [float(np.mean(u0 * v0)), float(np.mean(v0 * v0))],
        ],
        dtype=np.float64,
    )
    eigvals, eigvecs = np.linalg.eigh(cov)
    order = np.argsort(eigvals)[::-1]
    eigvals = eigvals[order]
    eigvecs = eigvecs[:, order]
    l1 = max(0.0, float(eigvals[0]))
    l2 = max(0.0, float(eigvals[1])) if eigvals.shape[0] > 1 else 0.0
    major_mm = float(4.0 * math.sqrt(l1)) if l1 > 0 else (eq_diam_mm or 0.0)
    minor_mm = float(4.0 * math.sqrt(l2)) if l2 > 0 else (eq_diam_mm or 0.0)
    perimeter_mm = ellipse_perimeter_from_diameters(major_mm, minor_mm)

    vec_uv = eigvecs[:, 0] if eigvecs.shape[1] > 0 else np.array([1.0, 0.0], dtype=np.float64)
    dir_world = normalize(u * vec_uv[0] + v * vec_uv[1])
    half = 0.5 * major_mm
    p1w = center_world - dir_world * half
    p2w = center_world + dir_world * half
    p1v = nib.affines.apply_affine(affine_inv, p1w)
    p2v = nib.affines.apply_affine(affine_inv, p2w)

    return {
        "area_mm2": area_mm2,
        "eq_diameter_mm": eq_diam_mm,
        "major_diameter_mm": major_mm,
        "minor_diameter_mm": minor_mm,
        "perimeter_mm": perimeter_mm,
        "line_world": {
            "x1": float(p1w[0]),
            "y1": float(p1w[1]),
            "z1": float(p1w[2]),
            "x2": float(p2w[0]),
            "y2": float(p2w[1]),
            "z2": float(p2w[2]),
        },
        "line_voxel": {
            "x1": float(p1v[0]),
            "y1": float(p1v[1]),
            "z1": float(p1v[2]),
            "x2": float(p2v[0]),
            "y2": float(p2v[1]),
            "z2": float(p2v[2]),
        },
        "count": n,
    }


def nearest_centerline_index_by_z(vox_pts: np.ndarray, z_val: float) -> int:
    if vox_pts.shape[0] == 0:
        return -1
    dz = np.abs(vox_pts[:, 2] - float(z_val))
    return int(np.argmin(dz))


def move_idx_by_distance(s_mm: np.ndarray, start_idx: int, step_sign: int, distance_mm: float) -> int:
    if s_mm.size == 0:
        return -1
    i = int(start_idx)
    if i < 0 or i >= s_mm.size:
        return -1
    target = float(distance_mm)
    acc = 0.0
    while 0 <= i + step_sign < s_mm.size and acc < target:
        a = i
        b = i + step_sign
        acc += abs(float(s_mm[b] - s_mm[a]))
        i = b
    return int(i)


def directed_distance_from_annulus(s_mm: np.ndarray, annulus_idx: int, idx: int, direction: int) -> float:
    if s_mm.size == 0 or annulus_idx < 0 or idx < 0:
        return float("nan")
    if direction >= 0:
        return float(s_mm[idx] - s_mm[annulus_idx])
    return float(s_mm[annulus_idx] - s_mm[idx])


def detect_coronary_ostia_heights(
    ct_hu: np.ndarray,
    root_mask: np.ndarray,
    annulus_z: int,
    stj_z: int,
    direction: int,
    spacing: tuple[float, float, float],
    cl_vox: np.ndarray,
    cl_world: np.ndarray,
    cl_s_mm: np.ndarray,
    annulus_idx: int,
    affine: np.ndarray,
) -> dict[str, Any]:
    nx, ny, nz = root_mask.shape
    if annulus_z < 0 or stj_z < 0:
        return {
            "left_height_mm": None,
            "right_height_mm": None,
            "detected": [],
            "method": "shell_threshold_fallback",
        }

    shell = ndimage.binary_dilation(root_mask, iterations=mm_to_vox_xy(2.0, spacing)) & (~root_mask)
    vessel = shell & (ct_hu > 180.0)

    z_pad = mm_to_vox_z(25.0, spacing)
    z_band = np.zeros((nz,), dtype=bool)
    if direction >= 0:
        lo = max(0, min(annulus_z, stj_z) - 1)
        hi = min(nz - 1, max(annulus_z, stj_z) + z_pad)
    else:
        lo = max(0, min(annulus_z, stj_z) - z_pad)
        hi = min(nz - 1, max(annulus_z, stj_z) + 1)
    z_band[lo : hi + 1] = True
    vessel &= z_band[None, None, :]

    lab, num = ndimage.label(vessel)
    if num == 0:
        return {
            "left_height_mm": None,
            "right_height_mm": None,
            "detected": [],
            "method": "shell_threshold_fallback",
        }

    affine_inv = np.linalg.inv(affine)
    candidates: list[dict[str, Any]] = []
    for cid in range(1, num + 1):
        pts = np.argwhere(lab == cid)
        n = int(pts.shape[0])
        if n < 20:
            continue
        c_vox = pts.mean(axis=0).astype(np.float64)
        c_world = nib.affines.apply_affine(affine, c_vox)
        if cl_world.shape[0] == 0:
            continue
        dist = np.linalg.norm(cl_world - c_world[None, :], axis=1)
        idx = int(np.argmin(dist))
        h = directed_distance_from_annulus(cl_s_mm, annulus_idx, idx, direction)
        if not np.isfinite(h):
            continue
        if h < 0.5 or h > 45.0:
            continue
        candidates.append(
            {
                "component_id": cid,
                "voxels": n,
                "height_mm": float(h),
                "center_voxel": [float(c_vox[0]), float(c_vox[1]), float(c_vox[2])],
                "center_world": [float(c_world[0]), float(c_world[1]), float(c_world[2])],
                "centerline_idx": idx,
            }
        )

    if not candidates:
        return {
            "left_height_mm": None,
            "right_height_mm": None,
            "detected": [],
            "method": "shell_threshold_fallback",
        }

    # Keep the most plausible two ostia: low height and sizable component.
    candidates.sort(key=lambda x: (x["height_mm"], -x["voxels"]))
    top = candidates[:4]
    top.sort(key=lambda x: x["center_world"][0])

    left = top[0] if len(top) >= 1 else None
    right = top[-1] if len(top) >= 2 else None

    return {
        "left_height_mm": float(left["height_mm"]) if left else None,
        "right_height_mm": float(right["height_mm"]) if right else None,
        "detected": top,
        "method": "shell_threshold_fallback",
    }


def compute_calcium_burden(
    ct_hu: np.ndarray,
    valve_region_mask: np.ndarray,
    voxel_volume_mm3: float,
    threshold_hu: float = 130.0,
) -> dict[str, Any]:
    calc_mask = valve_region_mask & (ct_hu >= threshold_hu)
    vox = int(calc_mask.sum())
    vol_ml = float((vox * voxel_volume_mm3) / 1000.0)
    return {
        "threshold_hu": float(threshold_hu),
        "calc_voxels": vox,
        "calc_volume_ml": vol_ml,
    }


def write_ascii_stl_from_mask(mask: np.ndarray, affine: np.ndarray, out_path: Path) -> dict[str, Any]:
    if sk_measure is None:
        raise RuntimeError("scikit-image is required for marching cubes STL export")
    if not mask.any():
        raise RuntimeError("root mask is empty; cannot export STL")

    verts, faces, _normals, _values = sk_measure.marching_cubes(mask.astype(np.float32), level=0.5, spacing=(1.0, 1.0, 1.0))
    verts_world = points_voxel_to_world(verts, affine)

    with out_path.open("w", encoding="utf-8") as f:
        f.write("solid aortic_root\n")
        for tri in faces:
            v1 = verts_world[int(tri[0])]
            v2 = verts_world[int(tri[1])]
            v3 = verts_world[int(tri[2])]
            n = np.cross(v2 - v1, v3 - v1)
            n = normalize(n)
            f.write(f"  facet normal {n[0]:.7e} {n[1]:.7e} {n[2]:.7e}\n")
            f.write("    outer loop\n")
            f.write(f"      vertex {v1[0]:.7e} {v1[1]:.7e} {v1[2]:.7e}\n")
            f.write(f"      vertex {v2[0]:.7e} {v2[1]:.7e} {v2[2]:.7e}\n")
            f.write(f"      vertex {v3[0]:.7e} {v3[1]:.7e} {v3[2]:.7e}\n")
            f.write("    endloop\n")
            f.write("  endfacet\n")
        f.write("endsolid aortic_root\n")

    return {
        "vertices": int(verts_world.shape[0]),
        "faces": int(faces.shape[0]),
        "path": str(out_path),
    }


def write_planning_report_pdf(out_path: Path, title: str, lines: list[str]) -> None:
    if pdf_canvas is None or A4 is None:
        out_path.write_text(
            "PDF generation requires reportlab.\n\n" + "\n".join(lines),
            encoding="utf-8",
        )
        return

    c = pdf_canvas.Canvas(str(out_path), pagesize=A4)
    width, height = A4
    y = height - 42
    c.setFont("Helvetica-Bold", 14)
    c.drawString(36, y, title)
    y -= 22
    c.setFont("Helvetica", 9)
    for line in lines:
        if y < 48:
            c.showPage()
            c.setFont("Helvetica", 9)
            y = height - 42
        c.drawString(36, y, line[:180])
        y -= 12
    c.save()


def sanitize_for_json(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): sanitize_for_json(val) for k, val in v.items()}
    if isinstance(v, list):
        return [sanitize_for_json(x) for x in v]
    if isinstance(v, np.generic):
        return v.item()
    if isinstance(v, np.ndarray):
        return v.tolist()
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return float(v)
    return v


def measure_from_multiclass(
    ct_path: Path,
    mask_path: Path,
    builder_meta: dict[str, Any],
    output_dir: Path,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    ct_nii = nib.load(str(ct_path))
    m_nii = nib.load(str(mask_path))
    ct_hu = ct_nii.get_fdata().astype(np.float32)
    m = m_nii.get_fdata().astype(np.uint8)

    affine = m_nii.affine.astype(np.float64)
    affine_inv = np.linalg.inv(affine)
    spacing = tuple(float(v) for v in m_nii.header.get_zooms()[:3])
    dx, dy, dz = spacing
    voxel_volume_mm3 = float(dx * dy * dz)
    voxel_ml = voxel_volume_mm3 / 1000.0

    root = m == 1
    leaf = m == 2
    asc = m == 3
    aorta_union = root | asc

    artifacts_meta: list[dict[str, Any]] = [
        {
            "artifact_type": "segmentation_mask_nifti",
            "filename": mask_path.name,
            "content_type": "application/gzip",
            "path": str(mask_path),
        }
    ]

    centerline_work = output_dir / "centerline_tmp"
    centerline_work.mkdir(parents=True, exist_ok=True)

    cl_world_vmtk, cl_method = extract_centerline_vmtk(aorta_union, affine, centerline_work)
    if cl_world_vmtk.shape[0] >= 8:
        cl_vox_seed = points_world_to_voxel(cl_world_vmtk, affine_inv)
        cl_vox_raw = cl_vox_seed
        cl_world_raw = cl_world_vmtk
    else:
        cl_vox_raw = extract_centerline_centroid(aorta_union)
        cl_world_raw = points_voxel_to_world(cl_vox_raw, affine)
        if cl_world_raw.shape[0] < 2:
            raise RuntimeError("centerline extraction failed: insufficient points")
        cl_method = "centroid_fallback"

    cl_vox, cl_world, cl_s_mm = resample_polyline(cl_vox_raw, cl_world_raw, step_mm=1.5)
    cl_t = tangents_from_polyline(cl_world)
    if cl_world.shape[0] < 2:
        raise RuntimeError("centerline resampling failed")

    seed_z = int(builder_meta.get("seed_z", round(float(cl_vox[0, 2]))))
    stj_z = int(builder_meta.get("stj_z", round(float(cl_vox[min(len(cl_vox) - 1, len(cl_vox) // 2), 2]))))
    annulus_idx = nearest_centerline_index_by_z(cl_vox, seed_z)
    stj_idx = nearest_centerline_index_by_z(cl_vox, stj_z)

    if annulus_idx < 0:
        annulus_idx = 0
    if stj_idx < 0:
        stj_idx = min(len(cl_vox) - 1, annulus_idx + 8)

    direction = 1 if stj_idx >= annulus_idx else -1

    root_points_world = points_voxel_to_world(np.argwhere(root), affine)
    leaf_points_world = points_voxel_to_world(np.argwhere(leaf), affine)
    asc_points_world = points_voxel_to_world(np.argwhere(asc), affine)
    lvot_proxy_points_world = points_voxel_to_world(np.argwhere(root | leaf), affine)
    aorta_points_world = points_voxel_to_world(np.argwhere(aorta_union), affine)

    plane_thickness_mm = max(0.8, min(spacing))

    def section_at_idx(points: np.ndarray, idx: int, radius_mm: float) -> dict[str, Any] | None:
        if idx < 0 or idx >= cl_world.shape[0]:
            return None
        return section_metrics_from_points(
            points_world=points,
            center_world=cl_world[idx],
            tangent_world=cl_t[idx],
            voxel_volume_mm3=voxel_volume_mm3,
            plane_thickness_mm=plane_thickness_mm,
            radius_mm=radius_mm,
            affine_inv=affine_inv,
        )

    annulus_sec = section_at_idx(root_points_world, annulus_idx, radius_mm=38.0)
    if annulus_sec is None:
        annulus_sec = section_at_idx(lvot_proxy_points_world, annulus_idx, radius_mm=38.0)

    # Sinus/STJ search in annulus-STJ segment (centerline orthogonal)
    lo = min(annulus_idx, stj_idx)
    hi = max(annulus_idx, stj_idx)
    sinus_best: tuple[int, dict[str, Any]] | None = None
    stj_best: tuple[int, dict[str, Any]] | None = None

    for i in range(lo, hi + 1):
        sec = section_at_idx(root_points_world, i, radius_mm=45.0)
        if sec is None:
            continue
        if sinus_best is None or float(sec["eq_diameter_mm"] or 0.0) > float(sinus_best[1]["eq_diameter_mm"] or 0.0):
            sinus_best = (i, sec)
        if stj_best is None or float(sec["eq_diameter_mm"] or 1e9) < float(stj_best[1]["eq_diameter_mm"] or 1e9):
            stj_best = (i, sec)

    if stj_best is not None:
        stj_idx = int(stj_best[0])

    stj_sec = section_at_idx(root_points_world, stj_idx, radius_mm=42.0)
    sinus_idx = sinus_best[0] if sinus_best is not None else stj_idx
    sinus_sec = sinus_best[1] if sinus_best is not None else stj_sec

    # Ascending diameter at 20-60mm distal from STJ
    asc_scan_start = move_idx_by_distance(cl_s_mm, stj_idx, direction, 20.0)
    asc_scan_end = move_idx_by_distance(cl_s_mm, stj_idx, direction, 60.0)
    asc_lo = min(asc_scan_start, asc_scan_end)
    asc_hi = max(asc_scan_start, asc_scan_end)
    ascending_best: tuple[int, dict[str, Any]] | None = None
    for i in range(max(0, asc_lo), min(cl_world.shape[0] - 1, asc_hi) + 1):
        sec = section_at_idx(asc_points_world, i, radius_mm=42.0)
        if sec is None:
            continue
        if ascending_best is None or float(sec["eq_diameter_mm"] or 0.0) > float(ascending_best[1]["eq_diameter_mm"] or 0.0):
            ascending_best = (i, sec)

    if ascending_best is None:
        fallback_idx = move_idx_by_distance(cl_s_mm, stj_idx, direction, 30.0)
        ascending_best = (fallback_idx, section_at_idx(asc_points_world, fallback_idx, radius_mm=42.0) or {})
    asc_idx = int(ascending_best[0])
    asc_sec = ascending_best[1] if isinstance(ascending_best[1], dict) and ascending_best[1] else None

    # LVOT diameter: proximal 6mm from annulus
    lvot_idx = move_idx_by_distance(cl_s_mm, annulus_idx, -direction, 6.0)
    lvot_sec = section_at_idx(lvot_proxy_points_world, lvot_idx, radius_mm=36.0)

    annulus_z = int(round(float(cl_vox[annulus_idx, 2])))
    stj_z_now = int(round(float(cl_vox[stj_idx, 2])))

    ostia = detect_coronary_ostia_heights(
        ct_hu=ct_hu,
        root_mask=root,
        annulus_z=annulus_z,
        stj_z=stj_z_now,
        direction=direction,
        spacing=spacing,
        cl_vox=cl_vox,
        cl_world=cl_world,
        cl_s_mm=cl_s_mm,
        annulus_idx=annulus_idx,
        affine=affine,
    )

    valve_roi = root | leaf
    calcium = compute_calcium_burden(ct_hu=ct_hu, valve_region_mask=valve_roi, voxel_volume_mm3=voxel_volume_mm3, threshold_hu=130.0)

    annulus_d = float(annulus_sec["eq_diameter_mm"]) if annulus_sec and annulus_sec.get("eq_diameter_mm") else None
    annulus_area = float(annulus_sec["area_mm2"]) if annulus_sec and annulus_sec.get("area_mm2") else None
    annulus_perim = float(annulus_sec["perimeter_mm"]) if annulus_sec and annulus_sec.get("perimeter_mm") else None
    sinus_d = float(sinus_sec["eq_diameter_mm"]) if sinus_sec and sinus_sec.get("eq_diameter_mm") else None
    stj_d = float(stj_sec["eq_diameter_mm"]) if stj_sec and stj_sec.get("eq_diameter_mm") else None
    asc_d = float(asc_sec["eq_diameter_mm"]) if asc_sec and asc_sec.get("eq_diameter_mm") else None
    lvot_d = float(lvot_sec["eq_diameter_mm"]) if lvot_sec and lvot_sec.get("eq_diameter_mm") else None

    left_h = ostia.get("left_height_mm")
    right_h = ostia.get("right_height_mm")
    calc_ml = float(calcium["calc_volume_ml"])

    risk_flags: list[dict[str, Any]] = []
    if (left_h is not None and left_h < 10.0) or (right_h is not None and right_h < 10.0):
        risk_flags.append(
            {
                "id": "low_coronary_height",
                "severity": "high",
                "message": "Coronary ostial height below 10 mm",
            }
        )
    if sinus_d is not None and sinus_d < 30.0:
        risk_flags.append(
            {
                "id": "small_sinus",
                "severity": "moderate",
                "message": "Sinus of Valsalva diameter appears small (<30 mm)",
            }
        )
    if calc_ml > 0.35:
        risk_flags.append(
            {
                "id": "heavy_valve_calcification",
                "severity": "high",
                "message": "Valve/root calcium burden is elevated (HU>130)",
            }
        )

    # Profile for orthogonal measurements along centerline.
    profile: list[dict[str, Any]] = []
    stride = max(1, int(round(3.0 / max(1e-3, plane_thickness_mm))))
    for i in range(0, cl_world.shape[0], stride):
        sec = section_at_idx(aorta_points_world, i, radius_mm=48.0)
        if sec is None:
            continue
        d_ann = directed_distance_from_annulus(cl_s_mm, annulus_idx, i, direction)
        profile.append(
            {
                "index": int(i),
                "distance_from_annulus_mm": float(d_ann),
                "eq_diameter_mm": float(sec["eq_diameter_mm"]) if sec.get("eq_diameter_mm") is not None else None,
                "area_mm2": float(sec["area_mm2"]) if sec.get("area_mm2") is not None else None,
            }
        )

    # Annulus plane visualization package.
    annulus_center = cl_world[annulus_idx]
    annulus_normal = normalize(cl_t[annulus_idx])
    annulus_u, annulus_v = orth_basis_from_tangent(annulus_normal)
    half_plane = 15.0
    corners_world = [
        (annulus_center + annulus_u * half_plane + annulus_v * half_plane),
        (annulus_center - annulus_u * half_plane + annulus_v * half_plane),
        (annulus_center - annulus_u * half_plane - annulus_v * half_plane),
        (annulus_center + annulus_u * half_plane - annulus_v * half_plane),
    ]
    corners_vox = points_world_to_voxel(np.asarray(corners_world), affine_inv)

    annulus_plane = {
        "origin_world": [float(x) for x in annulus_center],
        "origin_voxel": [float(x) for x in cl_vox[annulus_idx]],
        "normal_world": [float(x) for x in annulus_normal],
        "basis_u_world": [float(x) for x in annulus_u],
        "basis_v_world": [float(x) for x in annulus_v],
        "corners_world": [[float(v) for v in p] for p in corners_world],
        "corners_voxel": [[float(v) for v in p] for p in corners_vox],
        "index": int(annulus_idx),
        "z": int(annulus_z),
    }

    centerline_payload = {
        "method": cl_method,
        "point_count": int(cl_world.shape[0]),
        "points": [
            {
                "index": int(i),
                "s_mm": float(cl_s_mm[i]),
                "world": [float(cl_world[i, 0]), float(cl_world[i, 1]), float(cl_world[i, 2])],
                "voxel": [float(cl_vox[i, 0]), float(cl_vox[i, 1]), float(cl_vox[i, 2])],
                "tangent_world": [float(cl_t[i, 0]), float(cl_t[i, 1]), float(cl_t[i, 2])],
            }
            for i in range(cl_world.shape[0])
        ],
        "orthogonal_profile": profile,
        "annulus_plane": annulus_plane,
    }

    centerline_json_path = output_dir / "centerline.json"
    centerline_json_path.write_text(json.dumps(sanitize_for_json(centerline_payload), indent=2), encoding="utf-8")
    artifacts_meta.append(
        {
            "artifact_type": "centerline_json",
            "filename": centerline_json_path.name,
            "content_type": "application/json",
            "path": str(centerline_json_path),
        }
    )

    annulus_plane_path = output_dir / "annulus_plane.json"
    annulus_plane_path.write_text(json.dumps(sanitize_for_json(annulus_plane), indent=2), encoding="utf-8")
    artifacts_meta.append(
        {
            "artifact_type": "annulus_plane_json",
            "filename": annulus_plane_path.name,
            "content_type": "application/json",
            "path": str(annulus_plane_path),
        }
    )

    measurements = {
        "annulus_diameter_mm": annulus_d,
        "annulus_area_mm2": annulus_area,
        "annulus_perimeter_mm": annulus_perim,
        "sinus_of_valsalva_diameter_mm": sinus_d,
        "stj_diameter_mm": stj_d,
        "ascending_aorta_diameter_mm": asc_d,
        "lvot_diameter_mm": lvot_d,
        "coronary_height_left_mm": float(left_h) if left_h is not None else None,
        "coronary_height_right_mm": float(right_h) if right_h is not None else None,
        "valve_calcium_burden": calcium,
    }

    planning_metrics = {
        "vsrr": {
            "annulus_diameter_mm": annulus_d,
            "sinus_diameter_mm": sinus_d,
            "stj_diameter_mm": stj_d,
            "lvot_diameter_mm": lvot_d,
            "recommended_graft_size_mm": float(max(20.0, round((annulus_d or 26.0) - 2.5, 1))) if annulus_d else None,
        },
        "pears": {
            "root_external_reference_diameter_mm": sinus_d,
            "sinus_distribution_reference_mm": sinus_d,
            "annulus_plane": annulus_plane,
        },
        "tavi": {
            "annulus_area_mm2": annulus_area,
            "annulus_perimeter_mm": annulus_perim,
            "coronary_height_left_mm": float(left_h) if left_h is not None else None,
            "coronary_height_right_mm": float(right_h) if right_h is not None else None,
            "sinus_width_mm": sinus_d,
            "stj_diameter_mm": stj_d,
            "valve_calcium_burden": calcium,
        },
    }

    # STL mesh export for PEARS planning.
    stl_path = output_dir / "aortic_root.stl"
    stl_meta = write_ascii_stl_from_mask(root.astype(bool), affine, stl_path)
    artifacts_meta.append(
        {
            "artifact_type": "aortic_root_stl",
            "filename": stl_path.name,
            "content_type": "model/stl",
            "path": str(stl_path),
        }
    )

    measurements_json_path = output_dir / "measurements.json"
    measurements_json_payload = {
        "measurements": measurements,
        "planning_metrics": planning_metrics,
        "risk_flags": risk_flags,
        "annulus_plane": annulus_plane,
        "centerline_method": cl_method,
        "orthogonal_profile": profile,
    }
    measurements_json_path.write_text(json.dumps(sanitize_for_json(measurements_json_payload), indent=2), encoding="utf-8")
    artifacts_meta.append(
        {
            "artifact_type": "measurements_json",
            "filename": measurements_json_path.name,
            "content_type": "application/json",
            "path": str(measurements_json_path),
        }
    )

    report_lines = [
        f"Study ID: {ct_path.name}",
        f"Centerline method: {cl_method}",
        f"Annulus diameter: {annulus_d}",
        f"Annulus area: {annulus_area}",
        f"Annulus perimeter: {annulus_perim}",
        f"Sinus of Valsalva diameter: {sinus_d}",
        f"STJ diameter: {stj_d}",
        f"Ascending aorta diameter: {asc_d}",
        f"LVOT diameter: {lvot_d}",
        f"Coronary height left: {left_h}",
        f"Coronary height right: {right_h}",
        f"Valve calcium burden (HU>130, ml): {calc_ml}",
        "",
        "Risk flags:",
    ]
    if risk_flags:
        report_lines.extend([f"- {x['id']}: {x['message']}" for x in risk_flags])
    else:
        report_lines.append("- none")

    report_pdf_path = output_dir / "planning_report.pdf"
    write_planning_report_pdf(report_pdf_path, "Aortic Planning Report", report_lines)
    artifacts_meta.append(
        {
            "artifact_type": "planning_report_pdf",
            "filename": report_pdf_path.name,
            "content_type": "application/pdf",
            "path": str(report_pdf_path),
        }
    )

    labels = {
        "0": "background",
        "1": "aortic_root",
        "2": "valve_leaflets",
        "3": "ascending_aorta",
    }

    payload = {
        "labels": labels,
        "spacing_mm": {"dx": dx, "dy": dy, "dz": dz},
        "volume_reconstruction": {
            "dims": {"x": int(m.shape[0]), "y": int(m.shape[1]), "z": int(m.shape[2])},
            "spacing_mm": {"dx": dx, "dy": dy, "dz": dz},
            "voxel_volume_mm3": voxel_volume_mm3,
        },
        "centerline": {
            "method": cl_method,
            "point_count": int(cl_world.shape[0]),
            "annulus_index": int(annulus_idx),
            "stj_index": int(stj_idx),
            "direction": int(direction),
        },
        "landmarks": {
            "annulus_plane": annulus_plane,
            "stj_point_world": [float(x) for x in cl_world[stj_idx]],
            "sinus_peak_point_world": [float(x) for x in cl_world[sinus_idx]],
            "ascending_reference_point_world": [float(x) for x in cl_world[asc_idx]],
        },
        "measurements": measurements,
        "volumes_ml": {
            "aortic_root": float(root.sum() * voxel_ml),
            "valve_leaflets": float(leaf.sum() * voxel_ml),
            "ascending_aorta": float(asc.sum() * voxel_ml),
        },
        "risk_flags": risk_flags,
        "planning_metrics": planning_metrics,
        "exports": {
            "measurements_json": measurements_json_path.name,
            "planning_report_pdf": report_pdf_path.name,
            "segmentation_mask_nifti": mask_path.name,
            "aortic_root_stl": stl_path.name,
            "centerline_json": centerline_json_path.name,
            "annulus_plane_json": annulus_plane_path.name,
        },
        "notes": [
            "Orthogonal sections are computed on centerline-normal planes.",
            "Coronary ostia heights are estimated from shell-threshold vessel candidates and should be clinician-verified.",
            "Valve calcium burden threshold set to HU > 130.",
        ],
        "mesh": stl_meta,
    }

    return sanitize_for_json(payload), artifacts_meta


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output-mask", required=True)
    ap.add_argument("--output-json", required=True)
    ap.add_argument("--device", default="gpu", choices=["cpu", "gpu", "mps"])
    ap.add_argument("--quality", default="high", choices=["high", "fast"])
    ap.add_argument("--job-id", default="")
    ap.add_argument("--study-id", default="")
    args = ap.parse_args()

    in_path = Path(args.input).resolve()
    out_mask = Path(args.output_mask).resolve()
    out_json = Path(args.output_json).resolve()
    output_dir = out_json.parent
    out_mask.parent.mkdir(parents=True, exist_ok=True)
    out_json.parent.mkdir(parents=True, exist_ok=True)

    builder_py = Path(__file__).resolve().with_name("build_real_multiclass_mask.py")
    if not builder_py.exists():
        raise FileNotFoundError("build_real_multiclass_mask.py not found in gpu_provider/")

    t0 = time.time()
    with tempfile.TemporaryDirectory(prefix="aortic-pipeline-") as td:
        work_dir = Path(td)
        nifti_input, prep_meta = prepare_nifti_input(in_path, work_dir)

        builder_meta_path = work_dir / "builder_meta.json"
        cmd = [
            "python",
            str(builder_py),
            "--input",
            str(nifti_input),
            "--output",
            str(out_mask),
            "--meta",
            str(builder_meta_path),
            "--device",
            args.device,
            "--quality",
            args.quality,
        ]
        run_cmd(cmd)

        builder_meta = parse_builder_meta(builder_meta_path)
        result_payload, artifacts_meta = measure_from_multiclass(
            ct_path=nifti_input,
            mask_path=out_mask,
            builder_meta=builder_meta,
            output_dir=output_dir,
        )

        elapsed = time.time() - t0
        payload = {
            "job_id": args.job_id,
            "study_id": args.study_id,
            "pipeline": {
                "input_prep": prep_meta,
                "segmentation": "TotalSegmentator(open)+multiclass_aortic_builder",
                "centerline": result_payload.get("centerline", {}).get("method", "unknown"),
                "measurement_method": "centerline_orthogonal_sections_v2",
                "quality": args.quality,
                "device": args.device,
                "runtime_seconds": round(float(elapsed), 4),
            },
            "builder_meta": builder_meta,
            **result_payload,
            "artifacts_manifest": artifacts_meta,
        }
        out_json.write_text(json.dumps(sanitize_for_json(payload), indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
