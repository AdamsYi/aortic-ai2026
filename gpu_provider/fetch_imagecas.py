#!/usr/bin/env python3
"""ImageCAS ingest using the locally extracted Kaggle split."""
from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
import re
from typing import Any, Optional, Sequence

import nibabel as nib
import numpy as np


WIN_BASE = Path(r"C:\AorticAI\gpu_provider")
SOURCE_DATASET = {
    "name": "ImageCAS",
    "host": "Kaggle",
    "kaggle_id": "xiaoweixumedicalai/imagecas",
    "license": "apache-2.0",
    "citation": "Zeng et al., ImageCAS: a large-scale dataset and benchmark for coronary artery segmentation based on CT, 2023.",
}
CASE_ID_RE = re.compile(r"^(\d+)\.img\.nii\.gz$")


def _load_local_module(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"module_spec_missing | {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_LOCAL_BASE = Path(__file__).resolve().parent
_DATA_QUALITY = _load_local_module("imagecas_data_quality", _LOCAL_BASE / "geometry" / "data_quality.py")
_MESH_QA = _load_local_module("imagecas_mesh_qa", _LOCAL_BASE / "geometry" / "mesh_qa.py")
extract_study_meta = _DATA_QUALITY.extract_study_meta
evaluate_gate = _DATA_QUALITY.evaluate_gate
audit_case_meshes = _MESH_QA.audit_case_meshes
report_to_manifest = _MESH_QA.report_to_manifest


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[imagecas {ts}] {msg}", flush=True)


def resolve_base() -> Path:
    return WIN_BASE if WIN_BASE.exists() else Path(__file__).resolve().parent


def resolve_repo_root(base_dir: Path) -> Path:
    return base_dir.parent


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-cases", type=int, default=20)
    parser.add_argument("--case-ids", default="", help="comma-separated ImageCAS ids")
    parser.add_argument("--case-index", type=int, default=None, help="1-based index in the sorted scan list")
    parser.add_argument(
        "--extracted-dir",
        default="",
        help="override extracted ImageCAS split root (default: demo_data/imagecas_1-200_extracted)",
    )
    return parser.parse_args()


def enumerate_cases(extracted_dir: Path) -> list[tuple[int, Path, Path]]:
    pairs: list[tuple[int, Path, Path]] = []
    for img_path in sorted(extracted_dir.rglob("*.img.nii.gz"), key=lambda p: (p.parent.as_posix(), p.name)):
        match = CASE_ID_RE.match(img_path.name)
        if not match:
            continue
        case_id = int(match.group(1))
        label_path = img_path.with_name(f"{case_id}.label.nii.gz")
        if not label_path.exists():
            continue
        pairs.append((case_id, img_path, label_path))
    return sorted(pairs, key=lambda item: item[0])


def parse_case_ids(raw: str) -> list[int]:
    if not raw.strip():
        return []
    return [int(part.strip()) for part in raw.split(",") if part.strip()]


def select_cases(
    cases: Sequence[tuple[int, Path, Path]],
    case_ids: Sequence[int],
    case_index: Optional[int],
    max_cases: int,
) -> list[tuple[int, Path, Path]]:
    if case_ids:
        indexed = {case_id: (case_id, img_path, label_path) for case_id, img_path, label_path in cases}
        missing = [case_id for case_id in case_ids if case_id not in indexed]
        if missing:
            raise RuntimeError(f"case_ids_not_found | {missing}")
        return [indexed[case_id] for case_id in case_ids]
    if case_index is not None:
        if case_index < 1 or case_index > len(cases):
            raise RuntimeError(f"case_index_out_of_range | {case_index} | total={len(cases)}")
        return [cases[case_index - 1]]
    if max_cases < 1:
        raise RuntimeError(f"max_cases_invalid | {max_cases}")
    return list(cases[:max_cases])


def run_cmd(cmd: Sequence[str], cwd: Optional[Path] = None) -> None:
    log(f"$ {' '.join(str(part) for part in cmd)}")
    proc = subprocess.Popen(
        list(cmd),
        cwd=str(cwd) if cwd else None,
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
        raise RuntimeError(f"command_failed | code={code} | cmd={' '.join(str(part) for part in cmd)}")


def run_pipeline_on_case(base_dir: Path, ct_path: Path, case_id: int, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    result_json = output_dir / "result.json"
    run_cmd(
        [
            sys.executable,
            "pipeline_runner.py",
            "--input",
            str(ct_path),
            "--output-mask",
            str(output_dir / "segmentation_mask.nii.gz"),
            "--output-json",
            str(result_json),
            "--device",
            "gpu",
            "--quality",
            "high",
            "--job-id",
            f"imagecas_{case_id:04d}",
            "--study-id",
            f"imagecas_{case_id:04d}",
        ],
        cwd=base_dir,
    )
    if not result_json.exists():
        raise RuntimeError(f"pipeline_result_missing | {result_json}")
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


def summarize_case(case_id: int, meta: Any, gate: Any) -> None:
    z_mm = None
    if meta.fov_mm is not None and len(meta.fov_mm) >= 3:
        z_mm = float(meta.fov_mm[2])
    z_text = "-" if z_mm is None else f"{z_mm:.1f}"
    log(
        f"[gate] case_id={case_id} z_mm={z_text} "
        f"slice_mm={meta.slice_thickness_mm} blood_pool_hu={meta.blood_pool_hu_mean} "
        f"allowed={gate.allowed_procedures} reasons={gate.failure_reasons} advisories={gate.advisories}"
    )
    log(f"[study_meta] case_id={case_id} payload={meta.to_manifest_dict()}")


def infer_blood_pool_source(img_path: Path, label_path: Path) -> str:
    ct_data = np.asarray(nib.load(str(img_path)).get_fdata())
    mask_data = np.asarray(nib.load(str(label_path)).get_fdata()) > 0
    if float(np.mean(mask_data)) < 0.005:
        return "central-fallback"
    hu = ct_data[mask_data]
    hu = hu[(hu >= 0) & (hu <= 600)]
    if hu.size < 1000:
        return "central-fallback"
    return "mask"


def build_minimal_manifest(
    case_slug: str,
    case_id: int,
    ct_rel: str,
    label_rel: str,
    meta_dict: dict[str, Any],
    gate_dict: dict[str, Any],
    data_source: str,
    note: str,
) -> dict[str, Any]:
    return {
        "case_id": case_slug,
        "case_role": ["ingested", "imagecas", "reference"],
        "display_name": {
            "zh-CN": f"ImageCAS 病例 #{case_id}",
            "en": f"ImageCAS case #{case_id}",
        },
        "placeholder": False,
        "not_real_cta": False,
        "case_type": "real_pipeline_case",
        "data_source": data_source,
        "clinical_use": "research_preclinical_planning",
        "note": note,
        "build_version": "imagecas-source",
        "source_dataset": SOURCE_DATASET,
        "scan_date": None,
        "last_modified": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "study_meta": meta_dict,
        "data_quality": gate_dict,
        "artifact_index": {
            "case_manifest": "artifacts/case_manifest.json",
        },
        "imaging_index": {
            "raw_ct": ct_rel,
            "raw_label": label_rel,
        },
    }


def emit_case_bundle(
    repo_root: Path,
    case_id: int,
    ct_path: Path,
    label_path: Path,
    meta_dict: dict[str, Any],
    gate_dict: dict[str, Any],
    result_json: Optional[Path],
    output_dir: Optional[Path],
    pipeline_error: Optional[str],
) -> tuple[Path, dict[str, Any]]:
    case_slug = f"imagecas_{case_id:04d}"
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
    dest_label = imaging / f"{case_slug}_label.nii.gz"
    shutil.copy2(ct_path, dest_ct)
    shutil.copy2(label_path, dest_label)

    manifest = build_minimal_manifest(
        case_slug=case_slug,
        case_id=case_id,
        ct_rel=f"imaging_hidden/{dest_ct.name}",
        label_rel=f"imaging_hidden/{dest_label.name}",
        meta_dict=meta_dict,
        gate_dict=gate_dict,
        data_source="pipeline_geometry_incomplete",
        note="ImageCAS CTA ingested; geometry output incomplete or still under review.",
    )
    result: dict[str, Any] = {}
    mesh_report: dict[str, Any] = {}
    mesh_gate_all_pass = False
    failure_flags: list[Any] = []

    if result_json is not None and result_json.exists() and output_dir is not None:
        result = json.loads(result_json.read_text(encoding="utf-8"))

        def maybe_write(key: str, target: Path) -> bool:
            value = result.get(key)
            if value is None:
                return False
            target.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
            return True

        if maybe_write("measurements_structured", artifacts / "measurements.json"):
            manifest["artifact_index"]["measurements"] = "artifacts/measurements.json"
        elif maybe_write("measurements", artifacts / "measurements.json"):
            manifest["artifact_index"]["measurements"] = "artifacts/measurements.json"
        if maybe_write("planning", artifacts / "planning.json"):
            manifest["artifact_index"]["planning"] = "artifacts/planning.json"
        if maybe_write("centerline", artifacts / "centerline.json"):
            manifest["artifact_index"]["centerline"] = "artifacts/centerline.json"
        if maybe_write("annulus_plane", artifacts / "annulus_plane.json"):
            manifest["artifact_index"]["annulus_plane"] = "artifacts/annulus_plane.json"
        if maybe_write("aortic_root_model", artifacts / "aortic_root_model.json"):
            manifest["artifact_index"]["aortic_root_model"] = "artifacts/aortic_root_model.json"
        if maybe_write("leaflet_model", artifacts / "leaflet_model.json"):
            manifest["artifact_index"]["leaflet_model"] = "artifacts/leaflet_model.json"

        mesh_index: dict[str, str] = {}
        report_index: dict[str, str] = {}
        if _copy_if_exists(output_dir / "aortic_root.stl", meshes / "aortic_root.stl"):
            mesh_index["aortic_root_stl"] = "meshes/aortic_root.stl"
        if _copy_if_exists(output_dir / "ascending_aorta.stl", meshes / "ascending_aorta.stl"):
            mesh_index["ascending_aorta_stl"] = "meshes/ascending_aorta.stl"
        if _copy_if_exists(output_dir / "leaflets.stl", meshes / "leaflets.stl"):
            mesh_index["leaflets_stl"] = "meshes/leaflets.stl"
        if _copy_if_exists(output_dir / "report.pdf", reports / "report.pdf"):
            report_index["report_pdf"] = "reports/report.pdf"

        mesh_report = report_to_manifest(
            audit_case_meshes(
                {
                    "aortic_root": meshes / "aortic_root.stl",
                    "ascending_aorta": meshes / "ascending_aorta.stl",
                    "leaflets": meshes / "leaflets.stl",
                }
            )
        )
        mesh_gate_all_pass = bool(mesh_report) and all(
            bool(entry.get("passes_gate")) for entry in mesh_report.values()
        )
        (qa / "mesh_qa.json").write_text(
            json.dumps(mesh_report, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        failure_flags = result.get("risk_flags", []) if isinstance(result.get("risk_flags"), list) else []
        (qa / "failure_flags.json").write_text(
            json.dumps(failure_flags, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        if mesh_index:
            manifest["mesh_index"] = mesh_index
        if report_index:
            manifest["report_index"] = report_index
        manifest["qa_index"] = {
            "mesh_qa": "qa/mesh_qa.json",
            "failure_flags": "qa/failure_flags.json",
        }
        if pipeline_error is None and gate_dict.get("passes_sizing_gate") and mesh_gate_all_pass:
            manifest["data_source"] = "real_ct_pipeline_output"
            manifest["note"] = "ImageCAS CTA ingested and passed the procedure-tiered sizing gate with geometry bundle exported."
        manifest["pipeline_version"] = str(result.get("pipeline_version", "unknown"))
        manifest["capabilities"] = _build_capabilities(
            result,
            (artifacts / "leaflet_model.json").exists() or "leaflets_stl" in mesh_index,
        )
        manifest["uncertainty_summary"] = {
            "clinician_review_required": bool(failure_flags) or not mesh_gate_all_pass or pipeline_error is not None,
            "pipeline_risk_flags": len(failure_flags),
            "mesh_gate_all_pass": mesh_gate_all_pass,
        }

    quality_gates_payload = {
        "study_meta": meta_dict,
        "data_quality": gate_dict,
        "mesh_qa": mesh_report,
    }
    if pipeline_error is not None:
        quality_gates_payload["pipeline_error"] = pipeline_error
        (qa / "pipeline_error.json").write_text(
            json.dumps({"error": pipeline_error}, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        qa_index = manifest.setdefault("qa_index", {})
        qa_index["pipeline_error"] = "qa/pipeline_error.json"

    (qa / "quality_gates.json").write_text(
        json.dumps(quality_gates_payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    manifest.setdefault("qa_index", {})
    manifest["qa_index"]["quality_gates"] = "qa/quality_gates.json"
    if mesh_report:
        manifest["mesh_qa"] = mesh_report

    (artifacts / "case_manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return case_dir, manifest


def process_selected_case(
    base_dir: Path,
    repo_root: Path,
    case_id: int,
    img_path: Path,
    label_path: Path,
    dry_run: bool,
) -> tuple[dict[str, Any], dict[str, Any], Optional[dict[str, Any]]]:
    blood_pool_source = infer_blood_pool_source(img_path, label_path)
    meta = extract_study_meta(img_path, mask_path=label_path)
    gate = evaluate_gate(meta)
    summarize_case(case_id, meta, gate)
    log(f"[blood_pool_source] case_id={case_id} source={blood_pool_source}")
    meta_dict = meta.to_manifest_dict()
    gate_dict = gate.to_manifest_dict()
    if dry_run:
        return meta_dict, gate_dict, None

    if not gate.passes_sizing_gate:
        case_dir, manifest = emit_case_bundle(
            repo_root=repo_root,
            case_id=case_id,
            ct_path=img_path,
            label_path=label_path,
            meta_dict=meta_dict,
            gate_dict=gate_dict,
            result_json=None,
            output_dir=None,
            pipeline_error="gate_failed_before_geometry",
        )
        log(f"[bundle] gate-failed manifest only -> {case_dir}")
        return meta_dict, gate_dict, manifest

    output_dir = base_dir / "imagecas_output" / f"imagecas_{case_id:04d}"
    pipeline_error: Optional[str] = None
    result_json: Optional[Path] = None
    try:
        result_json = run_pipeline_on_case(base_dir, img_path, case_id, output_dir)
    except Exception as exc:
        pipeline_error = str(exc)
        log(f"[pipeline] case_id={case_id} failed: {pipeline_error}")

    case_dir, manifest = emit_case_bundle(
        repo_root=repo_root,
        case_id=case_id,
        ct_path=img_path,
        label_path=label_path,
        meta_dict=meta_dict,
        gate_dict=gate_dict,
        result_json=result_json,
        output_dir=output_dir,
        pipeline_error=pipeline_error,
    )
    log(f"[bundle] emitted {case_dir}")
    return meta_dict, gate_dict, manifest


def main() -> int:
    args = parse_args()
    base_dir = resolve_base()
    repo_root = resolve_repo_root(base_dir)
    extracted_dir = Path(args.extracted_dir) if args.extracted_dir else base_dir / "demo_data" / "imagecas_1-200_extracted"
    if not extracted_dir.exists():
        raise SystemExit(f"extracted_dir_missing | {extracted_dir}")

    all_cases = enumerate_cases(extracted_dir)
    selected_cases = select_cases(
        all_cases,
        parse_case_ids(args.case_ids),
        args.case_index,
        args.max_cases,
    )
    log(
        f"extracted_dir={extracted_dir} total_cases={len(all_cases)} "
        f"selected={len(selected_cases)} dry_run={args.dry_run}"
    )

    success_manifest: Optional[dict[str, Any]] = None
    for case_id, img_path, label_path in selected_cases:
        _, gate_dict, manifest = process_selected_case(
            base_dir=base_dir,
            repo_root=repo_root,
            case_id=case_id,
            img_path=img_path,
            label_path=label_path,
            dry_run=args.dry_run,
        )
        if args.dry_run:
            continue
        if manifest and manifest.get("data_source") == "real_ct_pipeline_output":
            success_manifest = manifest
            break
        if gate_dict.get("passes_sizing_gate"):
            log(f"[warn] case_id={case_id} passed gate but bundle stayed non-green")

    if args.dry_run:
        return 0
    if success_manifest is None:
        log("[done] no ImageCAS case produced a green bundle in the selected run")
        return 2
    log(
        "[done] first_green_case "
        f"case_id={success_manifest.get('case_id')} "
        f"allowed={success_manifest.get('data_quality', {}).get('allowed_procedures')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
