#!/usr/bin/env python3
"""fetch_imagecas.py — selective ingest of ImageCAS (Zeng et al. 2023) CTAs.

Runs on the Windows GPU provider machine. For each candidate case:
  1. Pull `<i>.img.nii.gz` + `<i>.label.nii.gz` via Kaggle API (per-file)
  2. Extract study_meta from the NIfTI header + HU stats
  3. Run the SCCT 2021 data-quality gate (gpu_provider/geometry/data_quality.py)
  4. On the FIRST passing case: run pipeline_runner.py end-to-end and
     write a full case bundle into <repo>/cases/imagecas_<id>/ (artifacts,
     meshes, qa, manifest).

Prereqs (once on Windows):
  1. pip install kaggle nibabel
  2. Create Kaggle account → Account → Create New API Token → save
     kaggle.json to C:\\Users\\<you>\\.kaggle\\kaggle.json (chmod 600 on POSIX).
  3. Accept dataset rules at https://www.kaggle.com/datasets/xiaoweixumedicalai/imagecas

Usage (on Windows):
  python fetch_imagecas.py                    # try case_ids 1..20, pick first passing
  python fetch_imagecas.py --case-ids 1,2,3   # explicit IDs
  python fetch_imagecas.py --dry-run          # gate-check only, no pipeline

References:
  Zeng et al., ImageCAS, Comput Med Imaging Graph 2023.
  Kaggle: xiaoweixumedicalai/imagecas
  License: CC-BY 4.0 (per Kaggle dataset page).
"""
from __future__ import annotations

import argparse
import json
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import List, Optional

# DNS fallback (borrowed from download_and_process_tavi.py — same rationale
# on the Windows box: system DNS is flaky, nslookup via 8.8.8.8 works).
_orig_getaddrinfo = socket.getaddrinfo


def _dns_fallback_getaddrinfo(host, port, *args, **kwargs):
    try:
        return _orig_getaddrinfo(host, port, *args, **kwargs)
    except socket.gaierror:
        try:
            r = subprocess.run(
                ["nslookup", host, "8.8.8.8"],
                capture_output=True, text=True, timeout=10,
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


WIN_BASE = Path(r"C:\AorticAI\gpu_provider")
KAGGLE_DATASET = "xiaoweixumedicalai/imagecas"


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[imagecas {ts}] {msg}", flush=True)


def resolve_base() -> Path:
    """Return gpu_provider/ dir — prefers the fixed Windows path when present."""
    if WIN_BASE.exists():
        return WIN_BASE
    return Path(__file__).resolve().parent


def resolve_repo_root(base_dir: Path) -> Path:
    """Repo root = parent of gpu_provider/."""
    return base_dir.parent


def run_cmd(cmd: List[str], cwd: Optional[Path] = None, check: bool = True) -> int:
    log(f"$ {' '.join(str(c) for c in cmd)}")
    proc = subprocess.Popen(
        cmd,
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
    if check and code != 0:
        raise RuntimeError(f"command failed ({code}): {' '.join(cmd)}")
    return code


def kaggle_download_file(dataset: str, filename: str, out_dir: Path) -> Path:
    """Pull a single file from a Kaggle dataset; unzip in place."""
    out_dir.mkdir(parents=True, exist_ok=True)
    run_cmd(
        [
            sys.executable, "-m", "kaggle", "datasets", "download",
            "-d", dataset, "-f", filename, "-p", str(out_dir), "--force",
        ]
    )
    # Kaggle CLI saves the file either as <filename> or <filename>.zip
    direct = out_dir / filename
    wrapped = out_dir / (filename + ".zip")
    if direct.exists():
        return direct
    if wrapped.exists():
        import zipfile

        with zipfile.ZipFile(wrapped) as zf:
            zf.extractall(out_dir)
        wrapped.unlink()
        if direct.exists():
            return direct
    # Some CLI versions drop numeric-only files as "imagecas-<N>.zip"
    candidates = list(out_dir.glob(Path(filename).stem + "*"))
    for c in candidates:
        if c.suffix in (".nii", ".gz") and c.name.startswith(Path(filename).stem):
            return c
    raise FileNotFoundError(f"kaggle fetch did not produce {filename} in {out_dir}")


def fetch_case(dataset: str, case_id: int, out_dir: Path) -> tuple[Path, Path]:
    """Pull <case_id>.img.nii.gz and <case_id>.label.nii.gz."""
    img_name = f"{case_id}.img.nii.gz"
    lbl_name = f"{case_id}.label.nii.gz"
    img_path = kaggle_download_file(dataset, img_name, out_dir)
    lbl_path = kaggle_download_file(dataset, lbl_name, out_dir)
    return img_path, lbl_path


def write_preview_manifest(
    case_stage_dir: Path,
    case_id: int,
    meta_dict: dict,
    gate_dict: dict,
) -> None:
    preview = {
        "case_id": f"imagecas_{case_id:04d}",
        "source_dataset": "ImageCAS (Zeng et al. 2023, CC-BY-4.0)",
        "scan_date_unknown": True,
        "study_meta": meta_dict,
        "data_quality": gate_dict,
        "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    out = case_stage_dir / "preview_manifest.json"
    out.write_text(json.dumps(preview, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"wrote preview manifest: {out}")


def stage_first_passing_case(
    candidates: List[int],
    dataset: str,
    stage_root: Path,
) -> Optional[tuple[int, Path, Path, dict, dict]]:
    """Try candidates in order; return (case_id, ct, mask, meta, gate) for first pass."""
    from geometry.data_quality import extract_study_meta, evaluate_gate

    for cid in candidates:
        case_stage = stage_root / f"imagecas_{cid:04d}"
        try:
            log(f"── trying case {cid} → {case_stage} ──")
            ct_path, mask_path = fetch_case(dataset, cid, case_stage)
            meta = extract_study_meta(ct_path, mask_path)
            gate = evaluate_gate(meta)
            log(f"study_meta: {meta.to_manifest_dict()}")
            log(f"gate: passes={gate.passes_sizing_gate} reasons={gate.failure_reasons}")
            write_preview_manifest(
                case_stage, cid, meta.to_manifest_dict(), gate.to_manifest_dict()
            )
            if gate.passes_sizing_gate:
                return cid, ct_path, mask_path, meta.to_manifest_dict(), gate.to_manifest_dict()
            log(f"case {cid} did NOT pass gate → trying next")
        except Exception as exc:
            log(f"case {cid} fetch/inspect failed: {exc}")
            continue
    return None


def run_pipeline_on_case(
    base_dir: Path,
    ct_path: Path,
    mask_path: Path,
    case_id: int,
    output_dir: Path,
) -> Path:
    """Invoke pipeline_runner.py --skip-segmentation on fetched (ct, mask)."""
    output_dir.mkdir(parents=True, exist_ok=True)
    result_json = output_dir / "result.json"
    run_cmd(
        [
            sys.executable, "pipeline_runner.py",
            "--input", str(ct_path),
            "--input-mask", str(mask_path),
            "--skip-segmentation",
            "--output-mask", str(output_dir / "mask.nii.gz"),
            "--output-json", str(result_json),
            "--device", "cpu",
            "--quality", "high",
            "--job-id", f"imagecas_{case_id:04d}",
            "--study-id", f"imagecas_{case_id:04d}",
        ],
        cwd=base_dir,
    )
    if not result_json.exists():
        raise RuntimeError(f"pipeline produced no {result_json}")
    return result_json


def emit_case_bundle(
    repo_root: Path,
    case_id: int,
    result_json: Path,
    ct_path: Path,
    meta_dict: dict,
    gate_dict: dict,
) -> Path:
    """Write a minimal case bundle under cases/imagecas_<id>/.

    Full promotion to default_clinical_case is a separate step — this keeps
    the new case isolated so human review can happen before it replaces
    the showcase.
    """
    case_slug = f"imagecas_{case_id:04d}"
    case_dir = repo_root / "cases" / case_slug
    artifacts = case_dir / "artifacts"
    imaging = case_dir / "imaging_hidden"
    artifacts.mkdir(parents=True, exist_ok=True)
    imaging.mkdir(parents=True, exist_ok=True)

    # Copy the raw CT into imaging_hidden (mirrors default_clinical_case layout)
    dest_ct = imaging / f"{case_slug}_ct.nii.gz"
    shutil.copy2(ct_path, dest_ct)

    # The pipeline result.json carries measurements + planning + model blobs.
    # Split it across the artifact files the Worker expects to read.
    result = json.loads(result_json.read_text(encoding="utf-8"))

    def maybe_write(key: str, target: Path) -> None:
        val = result.get(key)
        if val is None:
            return
        target.write_text(json.dumps(val, indent=2, ensure_ascii=False), encoding="utf-8")
        log(f"wrote {target}")

    maybe_write("measurements_structured", artifacts / "measurements.json")
    if not (artifacts / "measurements.json").exists():
        maybe_write("measurements", artifacts / "measurements.json")
    maybe_write("planning", artifacts / "planning.json")
    maybe_write("centerline", artifacts / "centerline.json")
    maybe_write("annulus_plane", artifacts / "annulus_plane.json")
    maybe_write("aortic_root_model", artifacts / "aortic_root_model.json")
    maybe_write("leaflet_model", artifacts / "leaflet_model.json")

    manifest = {
        "case_id": case_slug,
        "case_role": ["ingested", "imagecas"],
        "display_name": {
            "zh-CN": f"ImageCAS 病例 #{case_id}",
            "en": f"ImageCAS case #{case_id}",
        },
        "placeholder": False,
        "not_real_cta": False,
        "case_type": "real_pipeline_case",
        "data_source": "real_ct_pipeline_output",
        "clinical_use": "research_preclinical_planning",
        "note": "Ingested from ImageCAS (Zeng et al. 2023, CC-BY-4.0).",
        "source_dataset": "ImageCAS",
        "pipeline_version": str(result.get("pipeline_version", "unknown")),
        "scan_date": None,
        "last_modified": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "study_meta": meta_dict,
        "data_quality": gate_dict,
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
    }
    (artifacts / "case_manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    log(f"wrote {artifacts / 'case_manifest.json'}")
    return case_dir


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--case-ids",
        default=",".join(str(i) for i in range(1, 21)),
        help="comma-separated ImageCAS case ids to try (default: 1..20)",
    )
    parser.add_argument(
        "--stage-dir",
        default=None,
        help="Where to stash downloaded NIfTIs (default: <base>/imagecas_stage)",
    )
    parser.add_argument("--dry-run", action="store_true",
                        help="stop after gate evaluation — no pipeline, no case bundle")
    args = parser.parse_args()

    base_dir = resolve_base()
    repo_root = resolve_repo_root(base_dir)
    stage_root = Path(args.stage_dir) if args.stage_dir else base_dir / "imagecas_stage"
    stage_root.mkdir(parents=True, exist_ok=True)

    # Ensure geometry package importable when running from base_dir
    sys.path.insert(0, str(base_dir))

    case_ids = [int(x.strip()) for x in args.case_ids.split(",") if x.strip()]
    log(f"base_dir={base_dir}  repo_root={repo_root}  stage_root={stage_root}")
    log(f"candidates={case_ids}  dry_run={args.dry_run}")

    picked = stage_first_passing_case(case_ids, KAGGLE_DATASET, stage_root)
    if picked is None:
        log("no candidate passed the SCCT gate — increase --case-ids or relax thresholds")
        return 2

    cid, ct_path, mask_path, meta_dict, gate_dict = picked
    log(f"✓ selected imagecas_{cid:04d} — running full pipeline")

    if args.dry_run:
        log("--dry-run set; skipping pipeline + bundle emission")
        return 0

    output_dir = base_dir / "imagecas_output" / f"imagecas_{cid:04d}"
    result_json = run_pipeline_on_case(base_dir, ct_path, mask_path, cid, output_dir)
    case_dir = emit_case_bundle(
        repo_root, cid, result_json, ct_path, meta_dict, gate_dict
    )
    log(f"✓ case bundle emitted: {case_dir}")
    log("next: git add cases/imagecas_*/ && git commit && git push")
    return 0


if __name__ == "__main__":
    sys.exit(main())
