#!/usr/bin/env python3
"""Validate the mao_mianqiang_preop provider outputs without publishing them."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from .geometry.mesh_qa import audit_case_meshes, report_to_manifest


CASE_ID = "mao_mianqiang_preop"


def repo_root() -> Path:
    for candidate in [Path(r"C:\AorticAI"), Path(r"C:\aortic-ai"), Path(r"C:\aortic_ai")]:
        if candidate.exists():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO_ROOT = repo_root()
CASE_DIR = REPO_ROOT / "cases" / CASE_ID
ARTIFACTS_DIR = CASE_DIR / "artifacts"
MESH_DIR = CASE_DIR / "meshes"
QA_DIR = CASE_DIR / "qa"
MANIFEST_PATH = ARTIFACTS_DIR / "case_manifest.json"
RESULT_JSON = ARTIFACTS_DIR / "pipeline_result.json"


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    parsed = json.loads(path.read_text(encoding="utf-8"))
    return parsed if isinstance(parsed, dict) else {}


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def first_dict(*values: Any) -> dict[str, Any] | None:
    for value in values:
        if isinstance(value, dict):
            return value
    return None


def export_json_artifacts(result: dict[str, Any]) -> dict[str, str]:
    exported: dict[str, str] = {"case_manifest": "artifacts/case_manifest.json"}

    direct_exports: list[tuple[str, str, dict[str, Any] | None]] = [
        (
            "measurements",
            "measurements.json",
            first_dict(result.get("measurements"), result.get("measurements_structured")),
        ),
        ("planning", "planning.json", first_dict(result.get("planning"), result.get("planning_metrics"))),
        ("centerline", "centerline.json", first_dict(result.get("centerline"))),
        ("annulus_plane", "annulus_plane.json", first_dict(result.get("annulus_plane"))),
        (
            "aortic_root_model",
            "aortic_root_model.json",
            first_dict(result.get("aortic_root_model"), result.get("aortic_root_computational_model")),
        ),
        ("leaflet_model", "leaflet_model.json", first_dict(result.get("leaflet_model"))),
    ]

    for key, filename, payload in direct_exports:
        target = ARTIFACTS_DIR / filename
        source = MESH_DIR / filename
        if source.exists():
            target.write_text(source.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
        elif payload is not None:
            write_json(target, payload)
        if target.exists() and target.stat().st_size > 0:
            exported[key] = f"artifacts/{filename}"

    return exported


def existing_index(entries: list[tuple[str, Path, str]]) -> dict[str, str]:
    return {key: rel for key, path, rel in entries if path.exists() and path.stat().st_size > 0}


def failure_entry(path: Path, logical_name: str) -> dict[str, Any]:
    return {
        "tri_count": 0,
        "non_manifold_edges": None,
        "watertight": None,
        "aspect_ratio_p95": None,
        "mesh_kind": "solid" if logical_name in {"annulus_ring", "leaflets"} else "tube_segment",
        "boundary_loop_count": None,
        "boundary_loops_all_closed": None,
        "passes_gate": False,
        "failure_reasons": [f"mesh_file_missing:{path.name}"],
    }


def audit_meshes() -> tuple[dict[str, dict[str, Any]], bool]:
    mesh_paths = {
        "aortic_root": MESH_DIR / "aortic_root.stl",
        "ascending_aorta": MESH_DIR / "ascending_aorta.stl",
        "leaflets": MESH_DIR / "leaflets.stl",
        "annulus_ring": MESH_DIR / "annulus_ring.stl",
    }
    present = {name: path for name, path in mesh_paths.items() if path.exists() and path.stat().st_size > 0}
    report = report_to_manifest(audit_case_meshes(present)) if present else {}
    for name, path in mesh_paths.items():
        if name not in report:
            report[name] = failure_entry(path, name)
    return report, all(bool(entry.get("passes_gate")) for entry in report.values())


def update_manifest(
    manifest: dict[str, Any],
    result: dict[str, Any],
    artifact_index: dict[str, str],
    mesh_index: dict[str, str],
    report_index: dict[str, str],
    mesh_report: dict[str, dict[str, Any]],
    mesh_gate_all_pass: bool,
    missing_required: list[str],
) -> dict[str, Any]:
    data_quality = manifest.setdefault("data_quality", {})
    if not isinstance(data_quality, dict):
        data_quality = {}
        manifest["data_quality"] = data_quality

    stale_prefixes = (
        "derived_artifacts_pending_provider_processing",
        "mesh_qa_failed:",
        "missing_required_artifact:",
    )
    failure_reasons = [
        str(item)
        for item in data_quality.get("failure_reasons", [])
        if isinstance(item, str) and not str(item).startswith(stale_prefixes)
    ]
    for reason in [*missing_required, *mesh_failure_reasons(mesh_report)]:
        if reason not in failure_reasons:
            failure_reasons.append(reason)

    display_ready = not failure_reasons and mesh_gate_all_pass
    data_quality["passes_sizing_gate"] = display_ready
    data_quality["allowed_procedures"] = ["PEARS"] if display_ready else []
    data_quality["failure_reasons"] = failure_reasons
    stale_advisories = {
        "derived_artifacts_pending_provider_processing",
        "clinical_review_required_before_sizing",
    }
    advisories = [
        str(item)
        for item in data_quality.get("advisories", [])
        if isinstance(item, str) and str(item) not in stale_advisories
    ]
    if not display_ready and "clinical_review_required_before_sizing" not in advisories:
        advisories.append("clinical_review_required_before_sizing")
    data_quality["advisories"] = advisories

    manifest["status"] = "completed" if display_ready else "incomplete"
    manifest["display_ready"] = display_ready
    manifest["review_status"] = "ready" if display_ready else "review_required"
    manifest["pipeline_version"] = str(result.get("pipeline_version") or manifest.get("pipeline_version") or "unknown")
    manifest["last_modified"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    manifest["artifact_index"] = artifact_index
    manifest["mesh_index"] = mesh_index
    manifest["report_index"] = report_index
    manifest["qa_index"] = {
        "quality_gates": "qa/quality_gates.json",
        "mesh_qa": "qa/mesh_qa.json",
    }
    manifest["mesh_qa"] = mesh_report
    manifest["capabilities"] = {
        "cpr": capability("centerline" in artifact_index, "centerline" if "centerline" in artifact_index else "missing_centerline"),
        "coronary_ostia": capability(False, "coronary_ostia_not_detected"),
        "leaflet_geometry": capability(mesh_gate_all_pass and "leaflet_model" in artifact_index, "mesh_qa_failed" if not mesh_gate_all_pass else "leaflet_model"),
        "pears_geometry": capability(mesh_gate_all_pass and "aortic_root_model" in artifact_index, "mesh_qa_failed" if not mesh_gate_all_pass else "aortic_root_model"),
    }
    manifest["uncertainty_summary"] = {
        "clinician_review_required": not display_ready,
        "pipeline_risk_flags": len(result.get("risk_flags", [])) if isinstance(result.get("risk_flags"), list) else 0,
        "mesh_gate_all_pass": mesh_gate_all_pass,
        "missing_required_count": len(missing_required),
    }
    if not display_ready:
        manifest["note"] = "Provider artifacts exist, but the case is locked because required outputs or mesh QA gates failed."
    else:
        manifest["note"] = "Provider artifacts passed required output checks and mesh QA gates."
    return manifest


def mesh_failure_reasons(mesh_report: dict[str, dict[str, Any]]) -> list[str]:
    reasons: list[str] = []
    for name, entry in mesh_report.items():
        if entry.get("passes_gate") is True:
            continue
        if f"mesh_qa_failed:{name}" not in reasons:
            reasons.append(f"mesh_qa_failed:{name}")
    return reasons


def capability(available: bool, source_or_reason: str) -> dict[str, Any]:
    return {
        "available": available,
        "inferred": available,
        "legacy": False,
        "source": source_or_reason if available else "unavailable",
        "reason": None if available else source_or_reason,
    }


def main() -> None:
    if not CASE_DIR.exists():
        raise SystemExit(f"case_dir_missing:{CASE_DIR}")
    if not RESULT_JSON.exists():
        raise SystemExit(f"pipeline_result_missing:{RESULT_JSON}")

    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    QA_DIR.mkdir(parents=True, exist_ok=True)

    result = read_json(RESULT_JSON)
    manifest = read_json(MANIFEST_PATH)
    artifact_index = export_json_artifacts(result)
    mesh_index = existing_index(
        [
            ("segmentation_mask_nifti", MESH_DIR / "segmentation.nii.gz", "meshes/segmentation.nii.gz"),
            ("lumen_mask_nifti", MESH_DIR / "lumen_mask.nii.gz", "meshes/lumen_mask.nii.gz"),
            ("aortic_root_stl", MESH_DIR / "aortic_root.stl", "meshes/aortic_root.stl"),
            ("ascending_aorta_stl", MESH_DIR / "ascending_aorta.stl", "meshes/ascending_aorta.stl"),
            ("leaflets_stl", MESH_DIR / "leaflets.stl", "meshes/leaflets.stl"),
            ("annulus_ring_stl", MESH_DIR / "annulus_ring.stl", "meshes/annulus_ring.stl"),
        ]
    )
    report_index = existing_index(
        [
            ("report_pdf", MESH_DIR / "planning_report.pdf", "meshes/planning_report.pdf"),
        ]
    )
    mesh_report, mesh_gate_all_pass = audit_meshes()

    required = {
        "segmentation_mask_nifti": mesh_index.get("segmentation_mask_nifti"),
        "lumen_mask_nifti": mesh_index.get("lumen_mask_nifti"),
        "aortic_root_stl": mesh_index.get("aortic_root_stl"),
        "ascending_aorta_stl": mesh_index.get("ascending_aorta_stl"),
        "leaflets_stl": mesh_index.get("leaflets_stl"),
        "annulus_ring_stl": mesh_index.get("annulus_ring_stl"),
        "measurements": artifact_index.get("measurements"),
        "planning": artifact_index.get("planning"),
        "centerline": artifact_index.get("centerline"),
        "annulus_plane": artifact_index.get("annulus_plane"),
        "aortic_root_model": artifact_index.get("aortic_root_model"),
        "leaflet_model": artifact_index.get("leaflet_model"),
        "report_pdf": report_index.get("report_pdf"),
    }
    missing_required = [f"missing_required_artifact:{name}" for name, value in required.items() if not value]

    quality_gates = {
        "case_id": CASE_ID,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mesh_gate_all_pass": mesh_gate_all_pass,
        "missing_required": missing_required,
        "display_ready": not missing_required and mesh_gate_all_pass,
        "mesh_qa": mesh_report,
    }
    write_json(QA_DIR / "mesh_qa.json", mesh_report)
    write_json(QA_DIR / "quality_gates.json", quality_gates)

    manifest = update_manifest(
        manifest,
        result,
        artifact_index,
        mesh_index,
        report_index,
        mesh_report,
        mesh_gate_all_pass,
        missing_required,
    )
    write_json(MANIFEST_PATH, manifest)

    print(json.dumps({
        "case_id": CASE_ID,
        "display_ready": manifest.get("display_ready"),
        "status": manifest.get("status"),
        "review_status": manifest.get("review_status"),
        "mesh_gate_all_pass": mesh_gate_all_pass,
        "missing_required": missing_required,
        "mesh_qa": mesh_report,
    }, indent=2, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
