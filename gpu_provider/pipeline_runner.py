#!/usr/bin/env python3
"""
Geometry-driven CTA aortic planning pipeline (research-grade, no placeholders):
1) DICOM(.zip/.dcm series) -> NIfTI via dcm2niix (if needed)
2) Multiclass segmentation via TotalSegmentator-based builder
3) Lumen extraction and cleanup
4) Surface mesh generation (marching cubes + smoothing)
5) Distance-transform skeleton centerline extraction
6) Geometry profile analysis and landmark detection
7) Structured aortic root model + parametric leaflet model
8) Clinical measurements, STL/VTK/JSON/PDF export
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from dataclasses import asdict
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np

try:
    from .geometry.centerline import compute_centerline, compute_centerline_quality
    from .geometry.common import sanitize_for_json, voxel_volume_mm3
    from .geometry.digital_twin import build_digital_twin_simulation
    from .geometry.landmarks import detect_landmarks_from_profile, pick_section_bundle
    from .geometry.leaflet_model import build_leaflet_model, leaflet_model_payload
    from .geometry.lumen_mesh import (
        extract_lumen_mask,
        generate_surface_mesh,
        mesh_meta,
        save_mask_nifti,
        write_ascii_stl,
    )
    from .geometry.measurements import build_measurements
    from .geometry.profile_analysis import attach_arclength_to_sections, build_radius_profile, sample_cross_sections
    from .geometry.root_model import attach_digital_twin_simulation, attach_leaflet_geometry, build_aortic_root_model
except ImportError:
    from geometry.centerline import compute_centerline, compute_centerline_quality
    from geometry.common import sanitize_for_json, voxel_volume_mm3
    from geometry.digital_twin import build_digital_twin_simulation
    from geometry.landmarks import detect_landmarks_from_profile, pick_section_bundle
    from geometry.leaflet_model import build_leaflet_model, leaflet_model_payload
    from geometry.lumen_mesh import (
        extract_lumen_mask,
        generate_surface_mesh,
        mesh_meta,
        save_mask_nifti,
        write_ascii_stl,
    )
    from geometry.measurements import build_measurements
    from geometry.profile_analysis import attach_arclength_to_sections, build_radius_profile, sample_cross_sections
    from geometry.root_model import attach_digital_twin_simulation, attach_leaflet_geometry, build_aortic_root_model

try:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas as pdf_canvas
except Exception:  # pragma: no cover
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


def write_planning_report_pdf(out_path: Path, title: str, lines: list[str]) -> None:
    if pdf_canvas is None or A4 is None:
        _write_minimal_pdf(out_path, title, lines)
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
        c.drawString(36, y, str(line)[:180])
        y -= 12
    c.save()


def _pdf_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _write_minimal_pdf(out_path: Path, title: str, lines: list[str]) -> None:
    page_width = 595
    page_height = 842
    margin_x = 40
    margin_top = 42
    line_height = 13
    first_line_y = page_height - margin_top
    usable_lines = max(8, int((page_height - 2 * margin_top) // line_height) - 1)
    all_lines = [title, ""] + [str(line) for line in lines]
    pages = [all_lines[i : i + usable_lines] for i in range(0, len(all_lines), usable_lines)] or [[title]]

    object_ids: list[tuple[int, int]] = []
    next_obj = 3
    for _ in pages:
        object_ids.append((next_obj, next_obj + 1))
        next_obj += 2
    font_obj = next_obj

    objects: list[bytes] = []
    kids_refs = " ".join(f"{page_id} 0 R" for page_id, _ in object_ids)
    objects.append(f"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".encode("ascii"))
    objects.append(f"2 0 obj\n<< /Type /Pages /Count {len(pages)} /Kids [{kids_refs}] >>\nendobj\n".encode("ascii"))

    for page_lines, (page_id, content_id) in zip(pages, object_ids):
        text_ops = ["BT", f"/F1 10 Tf", f"{margin_x} {first_line_y} Td", f"{line_height} TL"]
        for idx, line in enumerate(page_lines):
            if idx == 0:
                text_ops.append(f"({_pdf_escape(line)}) Tj")
            else:
                text_ops.append("T*")
                text_ops.append(f"({_pdf_escape(line)}) Tj")
        text_ops.append("ET")
        content_stream = "\n".join(text_ops).encode("latin-1", errors="replace")
        objects.append(
            (
                f"{page_id} 0 obj\n"
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {page_width} {page_height}] "
                f"/Resources << /Font << /F1 {font_obj} 0 R >> >> /Contents {content_id} 0 R >>\n"
                f"endobj\n"
            ).encode("ascii")
        )
        objects.append(
            f"{content_id} 0 obj\n<< /Length {len(content_stream)} >>\nstream\n".encode("ascii")
            + content_stream
            + b"\nendstream\nendobj\n"
        )

    objects.append(f"{font_obj} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n".encode("ascii"))

    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for obj in objects:
        offsets.append(len(pdf))
        pdf.extend(obj)
    xref_offset = len(pdf)
    pdf.extend(f"xref\n0 {len(offsets)}\n".encode("ascii"))
    pdf.extend(b"0000000000 65535 f \n")
    for off in offsets[1:]:
        pdf.extend(f"{off:010d} 00000 n \n".encode("ascii"))
    pdf.extend(
        (
            f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    out_path.write_bytes(bytes(pdf))


def _record_artifact(manifest: list[dict[str, Any]], artifact_type: str, filename: str, content_type: str, path: Path) -> None:
    manifest.append(
        {
            "artifact_type": artifact_type,
            "filename": filename,
            "content_type": content_type,
            "path": str(path),
        }
    )


def _flatten_measurements(measurements_payload: dict[str, Any]) -> dict[str, Any]:
    annulus = measurements_payload.get("annulus", {})
    lvot = measurements_payload.get("lvot", {})
    sinus = measurements_payload.get("sinus_of_valsalva", {})
    stj = measurements_payload.get("stj", {})
    asc = measurements_payload.get("ascending_aorta", {})
    cor = measurements_payload.get("coronary_heights_mm", {})
    cal = measurements_payload.get("calcium_burden", {})
    return {
        "annulus_diameter_mm": annulus.get("equivalent_diameter_mm"),
        "annulus_diameter_short_mm": annulus.get("diameter_short_mm"),
        "annulus_diameter_long_mm": annulus.get("diameter_long_mm"),
        "annulus_area_mm2": annulus.get("area_mm2"),
        "annulus_perimeter_mm": annulus.get("perimeter_mm"),
        "sinus_of_valsalva_diameter_mm": sinus.get("max_diameter_mm") or sinus.get("equivalent_diameter_mm"),
        "stj_diameter_mm": stj.get("diameter_mm"),
        "ascending_aorta_diameter_mm": asc.get("diameter_mm"),
        "lvot_diameter_mm": lvot.get("diameter_mm"),
        "coronary_height_left_mm": cor.get("left"),
        "coronary_height_right_mm": cor.get("right"),
        "valve_calcium_burden": cal,
    }


def _section_to_line(section: Any) -> dict[str, Any] | None:
    if section is None:
        return None
    return {
        "line_world": section.line_world,
        "line_voxel": section.line_voxel,
        "index": int(section.index),
        "s_mm": float(section.s_mm),
    }


def run_geometry_pipeline(
    ct_path: Path,
    mask_path: Path,
    builder_meta: dict[str, Any],
    input_meta: dict[str, Any] | None,
    output_dir: Path,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    timers: dict[str, float] = {}
    t_pipeline = time.time()

    ct_nii = nib.load(str(ct_path))
    mask_nii = nib.load(str(mask_path))
    ct_hu = ct_nii.get_fdata().astype(np.float32)
    multiclass = mask_nii.get_fdata().astype(np.uint8)

    affine = mask_nii.affine.astype(np.float64)
    spacing = tuple(float(v) for v in mask_nii.header.get_zooms()[:3])
    voxel_mm3 = voxel_volume_mm3(spacing)
    voxel_ml = voxel_mm3 / 1000.0

    labels = {
        "0": "background",
        "1": "aortic_root",
        "2": "valve_leaflets",
        "3": "ascending_aorta",
    }
    root_mask = multiclass == 1
    leaflet_mask = multiclass == 2
    ascending_mask = multiclass == 3

    artifacts_manifest: list[dict[str, Any]] = []
    _record_artifact(artifacts_manifest, "segmentation_mask_nifti", mask_path.name, "application/gzip", mask_path)

    t0 = time.time()
    lumen_mask = extract_lumen_mask(multiclass, spacing)
    lumen_mask_path = output_dir / "lumen_mask.nii.gz"
    save_mask_nifti(lumen_mask, affine, lumen_mask_path)
    timers["lumen_cleanup_seconds"] = round(time.time() - t0, 4)
    _record_artifact(artifacts_manifest, "lumen_mask_nifti", lumen_mask_path.name, "application/gzip", lumen_mask_path)

    t0 = time.time()
    lumen_mesh = generate_surface_mesh(
        lumen_mask,
        affine,
        laplacian_iterations=0,
        taubin_iterations=0,
    )
    timers["mesh_seconds"] = round(time.time() - t0, 4)

    t0 = time.time()
    root_mesh = generate_surface_mesh(
        root_mask if np.any(root_mask) else lumen_mask,
        affine,
        laplacian_iterations=1,
        taubin_iterations=1,
        laplacian_lambda=0.16,
        taubin_lambda=0.18,
        taubin_mu=-0.2,
    )
    root_stl_path = output_dir / "aortic_root.stl"
    write_ascii_stl(root_mesh, root_stl_path, "aortic_root")
    asc_mesh = generate_surface_mesh(
        ascending_mask if np.any(ascending_mask) else lumen_mask,
        affine,
        laplacian_iterations=1,
        taubin_iterations=1,
        laplacian_lambda=0.14,
        taubin_lambda=0.16,
        taubin_mu=-0.18,
    )
    asc_stl_path = output_dir / "ascending_aorta.stl"
    write_ascii_stl(asc_mesh, asc_stl_path, "ascending_aorta")
    timers["surface_export_seconds"] = round(time.time() - t0, 4)
    _record_artifact(artifacts_manifest, "aortic_root_stl", root_stl_path.name, "model/stl", root_stl_path)
    _record_artifact(artifacts_manifest, "ascending_aorta_stl", asc_stl_path.name, "model/stl", asc_stl_path)

    t0 = time.time()
    centerline = compute_centerline(lumen_mask, affine, spacing, sample_step_mm=1.25)
    centerline_quality = compute_centerline_quality(centerline, lumen_mask, spacing)
    timers["centerline_seconds"] = round(time.time() - t0, 4)

    t0 = time.time()
    sections = sample_cross_sections(
        lumen_mask=lumen_mask,
        centerline_world=centerline.points_world,
        centerline_voxel=centerline.points_voxel,
        tangents_world=centerline.tangents_world,
        centerline_radii_mm=centerline.radii_mm,
        affine=affine,
        plane_thickness_mm=max(0.8, min(spacing)),
        voxel_volume_mm3=voxel_mm3,
        step_stride=2,
    )
    sections = attach_arclength_to_sections(sections, centerline.s_mm)
    profile = build_radius_profile(sections)
    timers["profile_seconds"] = round(time.time() - t0, 4)

    t0 = time.time()
    landmarks = detect_landmarks_from_profile(sections, centerline.points_world, centerline.s_mm)
    landmark_sections = pick_section_bundle(sections, landmarks)
    timers["landmark_seconds"] = round(time.time() - t0, 4)

    t0 = time.time()
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
    root_model = attach_leaflet_geometry(root_model, leaflet_model_payload(leaflet_model))
    leaflet_stl_path = output_dir / "leaflets.stl"
    write_ascii_stl(leaflet_model.mesh, leaflet_stl_path, "leaflets")
    timers["root_model_seconds"] = round(time.time() - t0, 4)
    _record_artifact(artifacts_manifest, "leaflets_stl", leaflet_stl_path.name, "model/stl", leaflet_stl_path)
    leaflet_model_json_path = output_dir / "leaflet_model.json"
    leaflet_model_json_path.write_text(json.dumps(sanitize_for_json(leaflet_model_payload(leaflet_model)), separators=(",", ":")), encoding="utf-8")
    _record_artifact(artifacts_manifest, "leaflet_model_json", leaflet_model_json_path.name, "application/json", leaflet_model_json_path)

    t0 = time.time()
    measurements_structured, planning_metrics, risk_flags, measurements_json_payload = build_measurements(
        ct_hu=ct_hu,
        lumen_mask=lumen_mask,
        valve_region_mask=(root_mask | leaflet_mask),
        landmark_sections=landmark_sections,
        ascending_sections=sections,
        annulus_plane=root_model.annulus_plane,
        root_model=root_model,
        leaflet_model=leaflet_model,
        spacing_mm=spacing,
        affine=affine,
        voxel_volume_mm3=voxel_mm3,
        centerline_result=centerline,
    )
    timers["measurement_seconds"] = round(time.time() - t0, 4)
    measurements_json_payload["centerline_quality"] = centerline_quality
    if centerline_quality.get("quality_flag") == "poor":
        risk_flags.append({
            "id": "centerline_quality_poor",
            "severity": "high",
            "message": "Centerline quality is poor — all derived measurements may be unreliable",
        })
    root_model.phase_metadata = {
        "input_kind": str((input_meta or {}).get("input_kind") or "nifti"),
        "conversion": str((input_meta or {}).get("conversion") or "none"),
        "reported_phase": str((builder_meta.get("phase") or (input_meta or {}).get("phase") or "unknown")),
        "selection_strategy": "single_phase_as_provided",
        "ecg_gated": bool(builder_meta.get("ecg_gated", False)),
    }
    root_model.provenance = {
        **root_model.provenance,
        "segmentation": "TotalSegmentator(open)+multiclass_aortic_builder",
        "centerline_method": centerline.method,
        "measurement_method": "geometry_model_driven_v3",
        "quality": builder_meta.get("quality", "high"),
        "device": builder_meta.get("device", "gpu"),
    }

    annulus_plane_payload = dict(root_model.annulus_plane)
    annulus_plane_payload.setdefault("index", int(landmarks.annulus_index))
    annulus_plane_payload.setdefault("s_mm", float(centerline.s_mm[min(max(0, landmarks.annulus_index), len(centerline.s_mm) - 1)]))
    annulus_plane_path = output_dir / "annulus_plane.json"
    annulus_plane_path.write_text(json.dumps(sanitize_for_json(annulus_plane_payload), separators=(",", ":")), encoding="utf-8")
    _record_artifact(artifacts_manifest, "annulus_plane_json", annulus_plane_path.name, "application/json", annulus_plane_path)

    centerline_payload = {
        "method": centerline.method,
        "point_count": int(centerline.points_world.shape[0]),
        "points": [
            {
                "index": int(i),
                "s_mm": float(centerline.s_mm[i]),
                "world": [float(v) for v in centerline.points_world[i]],
                "voxel": [float(v) for v in centerline.points_voxel[i]],
                "tangent_world": [float(v) for v in centerline.tangents_world[i]],
                "radius_mm": float(centerline.radii_mm[i]) if i < centerline.radii_mm.shape[0] else None,
            }
            for i in range(centerline.points_world.shape[0])
        ],
        "orthogonal_profile": profile,
        "annulus_plane": annulus_plane_payload,
        "stj_plane": landmarks.stj_plane,
        "centerline_quality": centerline_quality,
    }
    centerline_json_path = output_dir / "centerline.json"
    centerline_json_path.write_text(json.dumps(sanitize_for_json(centerline_payload), separators=(",", ":")), encoding="utf-8")
    _record_artifact(artifacts_manifest, "centerline_json", centerline_json_path.name, "application/json", centerline_json_path)

    digital_twin_simulation = build_digital_twin_simulation(root_model, planning_metrics)
    root_model = attach_digital_twin_simulation(root_model, digital_twin_simulation)

    aortic_root_model_path = output_dir / "aortic_root_model.json"
    aortic_root_model_path.write_text(json.dumps(sanitize_for_json(asdict(root_model)), separators=(",", ":")), encoding="utf-8")
    _record_artifact(artifacts_manifest, "aortic_root_model_json", aortic_root_model_path.name, "application/json", aortic_root_model_path)

    measurements_json_path = output_dir / "measurements.json"
    measurements_json_payload["digital_twin_simulation"] = digital_twin_simulation
    if isinstance(measurements_json_payload.get("aortic_root_model"), dict):
        measurements_json_payload["aortic_root_model"]["digital_twin_simulation"] = digital_twin_simulation
        measurements_json_payload["aortic_root_model"]["phase_metadata"] = root_model.phase_metadata
        measurements_json_payload["aortic_root_model"]["provenance"] = root_model.provenance
    measurements_json_path.write_text(json.dumps(sanitize_for_json(measurements_json_payload), separators=(",", ":")), encoding="utf-8")
    _record_artifact(artifacts_manifest, "measurements_json", measurements_json_path.name, "application/json", measurements_json_path)

    report_lines = [
        f"Study ID: {ct_path.name}",
        f"Centerline method: {centerline.method}",
        f"Annulus short/long diameter: {measurements_structured['annulus']['diameter_short_mm']} / {measurements_structured['annulus']['diameter_long_mm']} mm",
        f"Annulus area/perimeter: {measurements_structured['annulus']['area_mm2']} mm2 / {measurements_structured['annulus']['perimeter_mm']} mm",
        f"Sinus max diameter: {measurements_structured['sinus_of_valsalva']['max_diameter_mm']} mm",
        f"STJ diameter: {measurements_structured['stj']['diameter_mm']} mm",
        f"Ascending aorta diameter: {measurements_structured['ascending_aorta']['diameter_mm']} mm",
        f"LVOT diameter: {measurements_structured['lvot']['diameter_mm']} mm",
        f"Coronary height left/right: {measurements_structured['coronary_heights_mm']['left']} / {measurements_structured['coronary_heights_mm']['right']} mm",
        f"Calcium burden (HU>130): {measurements_structured['calcium_burden']['calc_volume_ml']} mL",
        f"Leaflet coaptation height estimate: {measurements_structured['leaflet_geometry']['coaptation_height_mm']} mm",
        "",
        "Risk flags:",
    ]
    if risk_flags:
        report_lines.extend([f"- {flag['id']}: {flag['message']}" for flag in risk_flags])
    else:
        report_lines.append("- none")
    planning_report_pdf = output_dir / "planning_report.pdf"
    write_planning_report_pdf(planning_report_pdf, "Aortic Geometry Planning Report", report_lines)
    _record_artifact(artifacts_manifest, "planning_report_pdf", planning_report_pdf.name, "application/pdf", planning_report_pdf)

    total_runtime = round(time.time() - t_pipeline, 4)
    flat_measurements = _flatten_measurements(measurements_structured)
    volumes_ml = {
        "aortic_root": float(root_mask.sum() * voxel_ml),
        "valve_leaflets": float(leaflet_mask.sum() * voxel_ml),
        "ascending_aorta": float(ascending_mask.sum() * voxel_ml),
        "lumen": float(lumen_mask.sum() * voxel_ml),
    }

    payload = {
        "labels": labels,
        "spacing_mm": {"dx": spacing[0], "dy": spacing[1], "dz": spacing[2]},
        "volume_reconstruction": {
            "dims": {"x": int(multiclass.shape[0]), "y": int(multiclass.shape[1]), "z": int(multiclass.shape[2])},
            "spacing_mm": {"dx": spacing[0], "dy": spacing[1], "dz": spacing[2]},
            "voxel_volume_mm3": voxel_mm3,
        },
        "geometry_model": {
            "type": "aortic_root_computational_model_v2",
            "lumen_mask": lumen_mask_path.name,
            "lumen_surface_mesh": mesh_meta(lumen_mesh),
            "root_model_json": aortic_root_model_path.name,
        },
        "centerline": {
            "method": centerline.method,
            "point_count": int(centerline.points_world.shape[0]),
            "annulus_index": int(landmarks.annulus_index),
            "stj_index": int(landmarks.stj_index),
            "sinus_peak_index": int(landmarks.sinus_peak_index),
            "ascending_reference_index": int(landmarks.ascending_reference_index),
            "skeletonization": "distance_transform",
            "quality": centerline_quality,
        },
        "landmarks": {
            "annulus_plane": annulus_plane_payload,
            "stj_plane": landmarks.stj_plane,
            "sinus_peak_point_world": landmarks.sinus_peak_point_world,
            "ascending_reference_point_world": landmarks.ascending_reference_point_world,
        },
        "aortic_root_computational_model": {
            "type": root_model.model_type,
            "annulus_ring": root_model.annulus_ring,
            "hinge_curve": root_model.hinge_curve,
            "commissures": root_model.commissures,
            "sinus_peaks": root_model.sinus_peaks,
            "sinotubular_junction": root_model.sinotubular_junction,
            "coronary_ostia": root_model.coronary_ostia,
            "ascending_axis": root_model.ascending_axis,
            "ascending_aorta_axis": root_model.ascending_aorta_axis,
            "centerline": root_model.centerline,
            "structure_metadata": root_model.structure_metadata,
            "raw_landmarks": root_model.raw_landmarks,
            "regularized_landmarks": root_model.regularized_landmarks,
            "raw_measurements": root_model.raw_measurements,
            "regularized_measurements": root_model.regularized_measurements,
            "phase_metadata": root_model.phase_metadata,
            "provenance": root_model.provenance,
            "leaflet_geometry": root_model.leaflet_geometry,
            "leaflet_meshes": root_model.leaflet_meshes,
            "digital_twin_simulation": root_model.digital_twin_simulation,
            "anatomical_constraints": root_model.anatomical_constraints,
            "confidence_scores": root_model.confidence_scores,
        },
        "measurements": flat_measurements,
        "measurements_structured": measurements_structured,
        "measurements_structured_raw": measurements_json_payload.get("measurements_raw", {}),
        "measurements_structured_regularized": measurements_json_payload.get("measurements_regularized", measurements_structured),
        "measurement_contract": measurements_json_payload.get("measurement_contract", {}),
        "volumes_ml": volumes_ml,
        "risk_flags": risk_flags,
        "sanity_checks": measurements_json_payload.get("sanity_checks", {}),
        "planning_metrics": planning_metrics,
        "planning_evidence": measurements_json_payload.get("planning_evidence", {}),
        "digital_twin_simulation": digital_twin_simulation,
        "exports": {
            "measurements_json": measurements_json_path.name,
            "planning_report_pdf": planning_report_pdf.name,
            "segmentation_mask_nifti": mask_path.name,
            "lumen_mask_nifti": lumen_mask_path.name,
            "aortic_root_stl": root_stl_path.name,
            "ascending_aorta_stl": asc_stl_path.name,
            "leaflets_stl": leaflet_stl_path.name,
            "leaflet_model_json": leaflet_model_json_path.name,
            "centerline_json": centerline_json_path.name,
            "annulus_plane_json": annulus_plane_path.name,
            "aortic_root_model_json": aortic_root_model_path.name,
        },
        "mesh": {
            "lumen_surface": mesh_meta(lumen_mesh),
            "aortic_root": mesh_meta(root_mesh, root_stl_path),
            "ascending_aorta": mesh_meta(asc_mesh, asc_stl_path),
            "leaflets": mesh_meta(leaflet_model.mesh, leaflet_stl_path),
        },
        "geometry_sections": {
            "annulus": _section_to_line(landmark_sections.get("annulus")),
            "sinus": _section_to_line(landmark_sections.get("sinus")),
            "stj": _section_to_line(landmark_sections.get("stj")),
            "ascending": _section_to_line(landmark_sections.get("ascending")),
        },
        "builder_meta": builder_meta,
        "notes": [
            "Measurements are geometry-derived from lumen mesh, skeleton centerline, and landmarked root model.",
            "GPU is used only for segmentation; all geometry stages run on CPU.",
            "Valve leaflet output is reconstructed from segmented leaflet ROI plus anatomical regularization for planning support rather than standalone diagnosis.",
            "Raw and regularized landmark/measurement sets are both preserved for auditability.",
        ],
        "stage_timings_seconds": timers,
    }
    payload["pipeline"] = {
        "input_prep": {"input_kind": "nifti", "conversion": "none"},
        "segmentation": "TotalSegmentator(open)+multiclass_aortic_builder",
        "lumen_model": "mask_cleanup+marching_cubes+taubin",
        "centerline": centerline.method,
        "measurement_method": "geometry_model_driven_v3",
        "computational_model": root_model.model_type,
        "quality": builder_meta.get("quality", "high"),
        "device": builder_meta.get("device", "gpu"),
        "runtime_seconds": total_runtime,
    }

    return sanitize_for_json(payload), artifacts_manifest


def build_synthetic_multiclass_for_skip(ct_shape: tuple[int, int, int]) -> np.ndarray:
    sx, sy, sz = ct_shape
    cx = sx / 2.0
    cy = sy / 2.0
    x, y = np.meshgrid(np.arange(sx, dtype=np.float32), np.arange(sy, dtype=np.float32), indexing="ij")

    labels = np.zeros(ct_shape, dtype=np.uint8)
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
    labels[:, :, int(sz * 0.58) :] = np.where(labels[:, :, int(sz * 0.58) :] == 1, 3, labels[:, :, int(sz * 0.58) :])
    return labels


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output-mask", required=True)
    ap.add_argument("--output-json", required=True)
    ap.add_argument("--device", default="gpu", choices=["cpu", "gpu", "mps"])
    ap.add_argument("--quality", default="high", choices=["high", "fast"])
    ap.add_argument("--job-id", default="")
    ap.add_argument("--study-id", default="")
    ap.add_argument("--skip-segmentation", action="store_true")
    ap.add_argument("--input-mask", default="")
    args = ap.parse_args()

    in_path = Path(args.input).resolve()
    out_mask = Path(args.output_mask).resolve()
    out_json = Path(args.output_json).resolve()
    output_dir = out_json.parent
    out_mask.parent.mkdir(parents=True, exist_ok=True)
    out_json.parent.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    with tempfile.TemporaryDirectory(prefix="aortic-pipeline-") as td:
        work_dir = Path(td)
        nifti_input, prep_meta = prepare_nifti_input(in_path, work_dir)
        builder_meta: dict[str, Any] = {}

        if args.skip_segmentation:
            input_mask_path = Path(args.input_mask).resolve() if args.input_mask else None
            if input_mask_path and input_mask_path.exists():
                shutil.copy2(input_mask_path, out_mask)
                builder_meta = {
                    "segmentation_mode": "skipped_external_mask",
                    "input_mask": str(input_mask_path),
                    "device": "cpu",
                    "quality": "fast",
                }
            else:
                ct_nii = nib.load(str(nifti_input))
                labels = build_synthetic_multiclass_for_skip(tuple(int(v) for v in ct_nii.shape[:3]))
                nib.save(nib.Nifti1Image(labels.astype(np.uint8), ct_nii.affine), str(out_mask))
                builder_meta = {
                    "segmentation_mode": "skipped_synthetic_mask",
                    "reason": "skip_segmentation_without_input_mask",
                    "device": "cpu",
                    "quality": "fast",
                }
        else:
            builder_py = Path(__file__).resolve().with_name("build_real_multiclass_mask.py")
            if not builder_py.exists():
                raise FileNotFoundError("build_real_multiclass_mask.py not found in gpu_provider/")
            builder_meta_path = work_dir / "builder_meta.json"
            cmd = [
                sys.executable,
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
        builder_meta.setdefault("device", args.device)
        builder_meta.setdefault("quality", args.quality)
        result_payload, artifacts_meta = run_geometry_pipeline(
            ct_path=nifti_input,
            mask_path=out_mask,
            builder_meta=builder_meta,
            input_meta=prep_meta,
            output_dir=output_dir,
        )

        elapsed = round(time.time() - t0, 4)
        pipeline_info = result_payload.get("pipeline", {})
        pipeline_info["input_prep"] = prep_meta
        pipeline_info["quality"] = args.quality
        pipeline_info["device"] = args.device
        pipeline_info["runtime_seconds"] = elapsed
        result_payload["pipeline"] = pipeline_info
        payload = {
            "job_id": args.job_id,
            "study_id": args.study_id,
            **result_payload,
            "artifacts_manifest": artifacts_meta,
        }
        out_json.write_text(json.dumps(sanitize_for_json(payload), indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
