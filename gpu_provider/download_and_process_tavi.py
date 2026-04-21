#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
import socket
import subprocess
import sys
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Optional

import nibabel as nib
import numpy as np
import requests

from geometry.data_quality import extract_study_meta, evaluate_gate
from geometry.mesh_qa import audit_case_meshes, report_to_manifest

# DNS fallback: if system DNS fails, resolve via nslookup with 8.8.8.8
_orig_getaddrinfo = socket.getaddrinfo


def _dns_fallback_getaddrinfo(host, port, *args, **kwargs):
    try:
        return _orig_getaddrinfo(host, port, *args, **kwargs)
    except socket.gaierror:
        try:
            r = subprocess.run(
                ["nslookup", host, "8.8.8.8"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            for line in r.stdout.splitlines():
                if "Address:" in line and "8.8.8.8" not in line and "#" not in line:
                    ip = line.split("Address:")[-1].strip()
                    if ip:
                        return _orig_getaddrinfo(ip, port, *args, **kwargs)
        except Exception:
            pass
        raise


socket.getaddrinfo = _dns_fallback_getaddrinfo

TAVI_URL = "https://zenodo.org/records/15094600/files/tavi_data.zip"
WIN_BASE = Path(r"C:\AorticAI\gpu_provider")
SOURCE_DATASET = "Zenodo TAVI (record 15094600, CC-BY-4.0)"


def log(msg: str) -> None:
    print(msg, flush=True)


def resolve_base() -> Path:
    if WIN_BASE.exists():
        return WIN_BASE
    return Path(__file__).resolve().parent


def resolve_repo_root(base_dir: Path) -> Path:
    return base_dir.parent


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-cases", type=int, default=5)
    parser.add_argument("--case-index", type=int, default=None)
    return parser.parse_args()


def download_file(url: str, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    log(f"[download] {url}")
    with requests.get(url, stream=True, timeout=120) as resp:
        resp.raise_for_status()
        total = int(resp.headers.get("content-length") or 0)
        downloaded = 0
        next_pct = 0
        with out_path.open("wb") as f:
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                f.write(chunk)
                downloaded += len(chunk)
                if total > 0:
                    pct = int(downloaded * 100 / total)
                    if pct >= next_pct:
                        log(f"[download] {pct}% ({downloaded}/{total} bytes)")
                        next_pct = min(100, pct + 5)
                else:
                    log(f"[download] {downloaded} bytes")
    log(f"[download] saved: {out_path}")


def ensure_zip_present(zip_path: Path) -> None:
    if zip_path.exists() and zip_path.stat().st_size > 100 * 1024 * 1024:
        log(f"[download] using existing zip: {zip_path}")
        return
    download_file(TAVI_URL, zip_path)


def _is_nifti_name(name: str) -> bool:
    low = name.lower()
    return low.endswith(".nii") or low.endswith(".nii.gz")


def _is_mask_name(name: str) -> bool:
    low = PurePosixPath(name).name.lower()
    return any(tag in low for tag in ("seg", "mask", "label"))


def _is_ct_name(name: str) -> bool:
    low = PurePosixPath(name).name.lower()
    return any(tag in low for tag in ("ct", "image", "img")) and not _is_mask_name(name)


def _case_group_key(name: str) -> str:
    path = PurePosixPath(name)
    parent = str(path.parent)
    if parent not in ("", "."):
        return parent
    stem = path.name.lower()
    match = re.match(r"^(?:case[_-]?)?(\d+)", stem)
    if match:
        return match.group(1)
    return stem.split(".nii", 1)[0]


def _sort_case_key(value: str) -> tuple[int, int, str]:
    parts = re.findall(r"\d+", value)
    if parts:
        return (0, int(parts[-1]), value)
    return (1, 0, value)


def pick_ct_and_optional_mask(names: list[str]) -> tuple[str, Optional[str]]:
    ct_candidates: list[str] = []
    mask_candidates: list[str] = []
    for name in names:
        low = name.lower()
        if low.endswith("/") or "/__macosx/" in low:
            continue
        if not _is_nifti_name(name):
            continue
        if _is_ct_name(name):
            ct_candidates.append(name)
        if _is_mask_name(name):
            mask_candidates.append(name)
    if not ct_candidates:
        raise RuntimeError("No CT file found in zip group.")
    return ct_candidates[0], mask_candidates[0] if mask_candidates else None


def pick_ct_and_mask(names: list[str]) -> tuple[str, str]:
    ct_name, mask_name = pick_ct_and_optional_mask(names)
    if mask_name is None:
        raise RuntimeError("No mask file found in zip group.")
    return ct_name, mask_name


def enumerate_cases(zip_path: Path) -> list[dict[str, Any]]:
    grouped: dict[str, list[str]] = {}
    with zipfile.ZipFile(zip_path, "r") as zf:
        for name in zf.namelist():
            if name.lower().endswith("/") or not _is_nifti_name(name):
                continue
            key = _case_group_key(name)
            grouped.setdefault(key, []).append(name)
    cases: list[dict[str, Any]] = []
    for index, key in enumerate(sorted(grouped, key=_sort_case_key), start=1):
        try:
            ct_name, mask_name = pick_ct_and_optional_mask(grouped[key])
        except RuntimeError:
            continue
        cases.append(
            {
                "index": index,
                "key": key,
                "ct_name": ct_name,
                "mask_name": mask_name,
            }
        )
    if not cases:
        raise RuntimeError("No case groups with CT candidates found in zip.")
    return cases


def extract_case_entry(
    zip_path: Path,
    case_dir: Path,
    case_entry: dict[str, Any],
) -> tuple[Path, Optional[Path]]:
    case_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extract(case_entry["ct_name"], case_dir)
        mask_name = case_entry.get("mask_name")
        if isinstance(mask_name, str):
            zf.extract(mask_name, case_dir)
    ct_path = case_dir / str(case_entry["ct_name"])
    mask_name = case_entry.get("mask_name")
    mask_path = case_dir / str(mask_name) if isinstance(mask_name, str) else None
    if not ct_path.exists():
        raise RuntimeError("Failed to extract CT from zip.")
    if mask_path is not None and not mask_path.exists():
        raise RuntimeError("Failed to extract mask from zip.")
    return ct_path, mask_path


def extract_case(zip_path: Path, case_dir: Path) -> tuple[Path, Path]:
    cases = enumerate_cases(zip_path)
    ct_path, mask_path = extract_case_entry(zip_path, case_dir, cases[0])
    if mask_path is None:
        raise RuntimeError("First extracted case has no mask.")
    return ct_path, mask_path


def remap_mask(mask_path: Path, out_path: Path) -> None:
    nii = nib.load(str(mask_path))
    data = np.asarray(nii.get_fdata())
    labels, counts = np.unique(data, return_counts=True)
    log("[mask] unique labels and voxel counts:")
    for label, count in zip(labels.tolist(), counts.tolist()):
        log(f"  label={label} voxels={count}")

    out = np.zeros(data.shape, dtype=np.uint8)
    non_bg = [(float(l), int(c)) for l, c in zip(labels.tolist(), counts.tolist()) if float(l) != 0.0]
    if not non_bg:
        raise RuntimeError("Mask has no foreground labels.")

    if len(non_bg) == 1:
        out[data != 0] = 1
        log("[mask] binary mask detected; mapped all non-zero voxels to label 1 (aortic_root)")
    else:
        dominant_label = max(non_bg, key=lambda x: x[1])[0]
        log(f"[mask] multi-class detected; dominant non-background label={dominant_label}.")
        out[data == dominant_label] = 1
        out[(data != 0) & (data != dominant_label)] = 1
        log("[mask] conservative strategy applied: all non-zero labels collapsed to 1 (aortic_root)")

    remapped = nib.Nifti1Image(out, nii.affine, nii.header)
    nib.save(remapped, str(out_path))
    log(f"[mask] remapped mask saved: {out_path}")


def run_cmd(cmd: list[str], cwd: Path) -> None:
    log(f"[run] {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        print(line.rstrip(), flush=True)
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f"Command failed with exit code {code}: {' '.join(cmd)}")


def read_measurements(result_json_path: Path) -> dict[str, Any]:
    payload = json.loads(result_json_path.read_text(encoding="utf-8"))
    m = payload.get("measurements")
    if isinstance(m, dict):
        return m
    m2 = payload.get("measurements_structured")
    if isinstance(m2, dict):
        return m2
    raise RuntimeError("result.json missing measurements payload.")


def get_annulus_diameter_mm(measurements: dict[str, Any]) -> float | None:
    ann = measurements.get("annulus")
    if isinstance(ann, dict):
        val = ann.get("equivalent_diameter_mm")
        if isinstance(val, (int, float)):
            return float(val)
    flat = measurements.get("annulus_equivalent_diameter_mm")
    if isinstance(flat, (int, float)):
        return float(flat)
    return None


def print_key_measurements(measurements: dict[str, Any]) -> None:
    ann = measurements.get("annulus", {}) if isinstance(measurements.get("annulus"), dict) else {}
    sin = measurements.get("sinus_of_valsalva", {}) if isinstance(measurements.get("sinus_of_valsalva"), dict) else {}
    stj = measurements.get("stj", {}) if isinstance(measurements.get("stj"), dict) else {}
    cor = measurements.get("coronary_heights_mm", {}) if isinstance(measurements.get("coronary_heights_mm"), dict) else {}

    annulus_diameter = ann.get("equivalent_diameter_mm", measurements.get("annulus_equivalent_diameter_mm", "N/A"))
    sinus_diameter = sin.get("max_diameter_mm", measurements.get("sinus_of_valsalva_diameter_mm", "N/A"))
    stj_diameter = stj.get("diameter_mm", measurements.get("stj_diameter_mm", "N/A"))
    lca = cor.get("left", measurements.get("coronary_height_left_mm", "N/A"))
    rca = cor.get("right", measurements.get("coronary_height_right_mm", "N/A"))

    log("[measurements] key values:")
    log(f"  annulus_diameter: {annulus_diameter}")
    log(f"  sinus_diameter: {sinus_diameter}")
    log(f"  stj_diameter: {stj_diameter}")
    log(f"  coronary_heights: LCA={lca}, RCA={rca}")


def save_and_commit(base_dir: Path, result_json: Path) -> None:
    case_dir = (base_dir.parent / "cases" / "default_clinical_case").resolve()
    run_cmd(
        [
            sys.executable,
            "save_as_default_case.py",
            "--input",
            str(result_json),
            "--case-dir",
            str(case_dir),
        ],
        cwd=base_dir,
    )
    run_cmd(["git", "add", "-A"], cwd=base_dir.parent)
    run_cmd(["git", "commit", "-m", "feat: update default case from real TAVI dataset pipeline output"], cwd=base_dir.parent)
    run_cmd(["git", "push"], cwd=base_dir.parent)


def run_pipeline_on_case(
    base_dir: Path,
    ct_path: Path,
    mask_path: Path,
    case_index: int,
    output_dir: Path,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    result_json = output_dir / "result.json"
    run_cmd(
        [
            sys.executable,
            "pipeline_runner.py",
            "--input",
            str(ct_path),
            "--input-mask",
            str(mask_path),
            "--skip-segmentation",
            "--output-mask",
            str(output_dir / "mask.nii.gz"),
            "--output-json",
            str(result_json),
            "--device",
            "cpu",
            "--quality",
            "fast",
            "--job-id",
            f"zenodo_tavi_{case_index}",
            "--study-id",
            f"zenodo_tavi_{case_index}",
        ],
        cwd=base_dir,
    )
    if not result_json.exists():
        raise RuntimeError(f"pipeline produced no {result_json}")
    return result_json


def _copy_if_exists(src: Path, dst: Path) -> bool:
    if not src.exists():
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return True


def _build_capabilities(result: dict[str, Any], has_leaflet_assets: bool) -> dict[str, dict[str, Any]]:
    coronary_detection = result.get("coronary_detection")
    coronary_available = isinstance(coronary_detection, dict)
    planning = result.get("planning")
    pears_available = isinstance(planning, dict) and isinstance(planning.get("pears"), dict)
    return {
        "cpr": {
            "available": False,
            "inferred": False,
            "legacy": False,
            "source": "unavailable",
            "reason": "cpr_artifact_missing",
        },
        "coronary_ostia": {
            "available": coronary_available,
            "inferred": False,
            "legacy": False,
            "source": "artifact" if coronary_available else "unavailable",
            "reason": None if coronary_available else "coronary_ostia_not_exported",
        },
        "leaflet_geometry": {
            "available": has_leaflet_assets,
            "inferred": False,
            "legacy": False,
            "source": "artifact" if has_leaflet_assets else "unavailable",
            "reason": None if has_leaflet_assets else "leaflet_artifact_missing",
        },
        "pears_geometry": {
            "available": pears_available,
            "inferred": pears_available,
            "legacy": False,
            "source": "planning_artifact" if pears_available else "unavailable",
            "reason": None if pears_available else "pears_planning_missing",
        },
    }


def emit_case_bundle(
    repo_root: Path,
    case_index: int,
    result_json: Path,
    output_dir: Path,
    ct_path: Path,
    meta_dict: dict[str, Any],
    gate_dict: dict[str, Any],
) -> Path:
    case_slug = f"zenodo_tavi_{case_index}"
    case_dir = repo_root / "cases" / case_slug
    artifacts = case_dir / "artifacts"
    imaging = case_dir / "imaging_hidden"
    meshes = case_dir / "meshes"
    reports = case_dir / "reports"
    qa = case_dir / "qa"
    artifacts.mkdir(parents=True, exist_ok=True)
    imaging.mkdir(parents=True, exist_ok=True)
    meshes.mkdir(parents=True, exist_ok=True)
    reports.mkdir(parents=True, exist_ok=True)
    qa.mkdir(parents=True, exist_ok=True)

    dest_ct = imaging / f"{case_slug}_ct.nii.gz"
    shutil.copy2(ct_path, dest_ct)

    result = json.loads(result_json.read_text(encoding="utf-8"))

    def maybe_write(key: str, target: Path) -> bool:
        val = result.get(key)
        if val is None:
            return False
        target.write_text(json.dumps(val, indent=2, ensure_ascii=False), encoding="utf-8")
        return True

    maybe_write("measurements_structured", artifacts / "measurements.json")
    if not (artifacts / "measurements.json").exists():
        maybe_write("measurements", artifacts / "measurements.json")
    maybe_write("planning", artifacts / "planning.json")
    maybe_write("centerline", artifacts / "centerline.json")
    maybe_write("annulus_plane", artifacts / "annulus_plane.json")
    maybe_write("aortic_root_model", artifacts / "aortic_root_model.json")
    maybe_write("leaflet_model", artifacts / "leaflet_model.json")

    report_pdf = output_dir / "report.pdf"
    root_stl = output_dir / "aortic_root.stl"
    asc_stl = output_dir / "ascending_aorta.stl"
    leaflets_stl = output_dir / "leaflets.stl"

    mesh_index: dict[str, str] = {}
    if _copy_if_exists(root_stl, meshes / "aortic_root.stl"):
        mesh_index["aortic_root_stl"] = "meshes/aortic_root.stl"
    if _copy_if_exists(asc_stl, meshes / "ascending_aorta.stl"):
        mesh_index["ascending_aorta_stl"] = "meshes/ascending_aorta.stl"
    if _copy_if_exists(leaflets_stl, meshes / "leaflets.stl"):
        mesh_index["leaflets_stl"] = "meshes/leaflets.stl"

    report_index: dict[str, str] = {}
    if _copy_if_exists(report_pdf, reports / "report.pdf"):
        report_index["report_pdf"] = "reports/report.pdf"

    mesh_paths = {
        "aortic_root": meshes / "aortic_root.stl",
        "ascending_aorta": meshes / "ascending_aorta.stl",
        "leaflets": meshes / "leaflets.stl",
    }
    mesh_report = report_to_manifest(audit_case_meshes(mesh_paths))
    (qa / "mesh_qa.json").write_text(
        json.dumps(mesh_report, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    quality_gates_payload = {
        "study_meta": meta_dict,
        "data_quality": gate_dict,
        "mesh_qa": mesh_report,
    }
    (qa / "quality_gates.json").write_text(
        json.dumps(quality_gates_payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    failure_flags = result.get("risk_flags", [])
    (qa / "failure_flags.json").write_text(
        json.dumps(failure_flags, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    capabilities = _build_capabilities(result, (artifacts / "leaflet_model.json").exists() or "leaflets_stl" in mesh_index)
    manifest = {
        "case_id": case_slug,
        "case_role": ["ingested", "zenodo_tavi", "reference"],
        "display_name": {
            "zh-CN": f"Zenodo TAVI 病例 #{case_index}",
            "en": f"Zenodo TAVI case #{case_index}",
        },
        "placeholder": False,
        "not_real_cta": False,
        "case_type": "real_pipeline_case",
        "data_source": "real_ct_pipeline_output",
        "clinical_use": "research_preclinical_planning",
        "note": "Ingested from Zenodo TAVI and passed the SCCT 2021 source CTA gate.",
        "build_version": "zenodo-tavi-source",
        "source_dataset": SOURCE_DATASET,
        "pipeline_version": str(result.get("pipeline_version", "unknown")),
        "scan_date": None,
        "last_modified": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "study_meta": meta_dict,
        "data_quality": gate_dict,
        "mesh_qa": mesh_report,
        "artifact_index": {
            "case_manifest": "artifacts/case_manifest.json",
            "planning": "artifacts/planning.json",
            "centerline": "artifacts/centerline.json",
            "annulus_plane": "artifacts/annulus_plane.json",
            "aortic_root_model": "artifacts/aortic_root_model.json",
            "measurements": "artifacts/measurements.json",
            "leaflet_model": "artifacts/leaflet_model.json",
        },
        "imaging_index": {"raw_ct": f"imaging_hidden/{case_slug}_ct.nii.gz"},
        "mesh_index": mesh_index,
        "report_index": report_index,
        "qa_index": {
            "quality_gates": "qa/quality_gates.json",
            "failure_flags": "qa/failure_flags.json",
            "mesh_qa": "qa/mesh_qa.json",
        },
        "capabilities": capabilities,
        "uncertainty_summary": {
            "clinician_review_required": bool(failure_flags),
            "pipeline_risk_flags": len(failure_flags) if isinstance(failure_flags, list) else 0,
        },
    }
    (artifacts / "case_manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return case_dir


def select_cases(cases: list[dict[str, Any]], args: argparse.Namespace) -> list[dict[str, Any]]:
    if args.case_index is not None:
        selected = [case for case in cases if int(case["index"]) == args.case_index]
        if not selected:
            raise RuntimeError(f"case-index {args.case_index} not found in zip")
        return selected
    return cases[: args.max_cases]


def main() -> int:
    args = parse_args()
    base_dir = resolve_base()
    repo_root = resolve_repo_root(base_dir)
    sys.path.insert(0, str(base_dir))

    demo_dir = base_dir / "demo_data"
    zip_path = demo_dir / "tavi_data.zip"
    stage_root = base_dir / "zenodo_tavi_stage"
    output_root = base_dir / "zenodo_tavi_output"
    stage_root.mkdir(parents=True, exist_ok=True)
    output_root.mkdir(parents=True, exist_ok=True)

    try:
        ensure_zip_present(zip_path)
        cases = enumerate_cases(zip_path)
        selected_cases = select_cases(cases, args)
        log(
            f"[zenodo] total_cases={len(cases)} selected={len(selected_cases)} "
            f"dry_run={args.dry_run} case_index={args.case_index} max_cases={args.max_cases}"
        )

        passing_count = 0
        for case in selected_cases:
            case_index = int(case["index"])
            case_key = str(case["key"])
            case_stage = stage_root / f"zenodo_tavi_{case_index}"
            ct_path, mask_path = extract_case_entry(zip_path, case_stage, case)
            meta = extract_study_meta(ct_path, mask_path)
            gate = evaluate_gate(meta)
            meta_dict = meta.to_manifest_dict()
            gate_dict = gate.to_manifest_dict()
            log(f"[gate] case_index={case_index} case_key={case_key} study_meta={meta_dict}")
            log(
                f"[gate] case_index={case_index} passes={gate.passes_sizing_gate} "
                f"reasons={gate.failure_reasons} advisories={gate.advisories}"
            )

            if not gate.passes_sizing_gate:
                log(f"[gate] case {case_index} SKIP: {gate.failure_reasons}")
                continue

            passing_count += 1
            if args.dry_run:
                continue

            if mask_path is None:
                raise RuntimeError(f"case {case_index} passed gate but has no mask")

            remapped_mask = case_stage / "mask_remapped.nii.gz"
            remap_mask(mask_path, remapped_mask)
            output_dir = output_root / f"zenodo_tavi_{case_index}"
            result_json = run_pipeline_on_case(base_dir, ct_path, remapped_mask, case_index, output_dir)
            measurements = read_measurements(result_json)
            print_key_measurements(measurements)
            case_dir = emit_case_bundle(
                repo_root,
                case_index,
                result_json,
                output_dir,
                ct_path,
                meta_dict,
                gate_dict,
            )
            log(f"[done] emitted case bundle: {case_dir}")
            return 0

        if passing_count == 0:
            log("[zenodo] no candidate passed the SCCT gate in the selected scan window")
            return 2
        if args.dry_run:
            log(f"[zenodo] dry-run complete; passing_cases={passing_count}")
            return 0
        log("[zenodo] passing cases were found but no pipeline run was requested")
        return 0
    except Exception as exc:
        log(f"[error] {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
