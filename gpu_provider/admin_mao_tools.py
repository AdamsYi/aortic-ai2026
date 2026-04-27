#!/usr/bin/env python3
"""Narrow admin tools for the mao_mianqiang_preop first-case workflow."""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path


CASE_ID = "mao_mianqiang_preop"


def repo_root() -> Path:
    for candidate in [Path(r"C:\AorticAI"), Path(r"C:\aortic-ai"), Path(r"C:\aortic_ai")]:
        if candidate.exists():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO_ROOT = repo_root()
CASE_DIR = REPO_ROOT / "cases" / CASE_ID
INPUT_CT = CASE_DIR / "imaging_hidden" / "ct_preop.nii.gz"
MESH_DIR = CASE_DIR / "meshes"
ARTIFACTS_DIR = CASE_DIR / "artifacts"
OUTPUT_MASK = MESH_DIR / "segmentation.nii.gz"
OUTPUT_JSON = ARTIFACTS_DIR / "pipeline_result.json"
PIPELINE_LOG = CASE_DIR / "pipeline.log"
SEGMENTATION_LOG = CASE_DIR / "segmentation_only.log"
SEGMENTATION_SUPERVISOR_LOG = CASE_DIR / "segmentation_only_supervisor.log"
PIPELINE_SUPERVISOR_LOG = CASE_DIR / "pipeline_supervisor.log"


def managed_output_files() -> list[Path]:
    return [
        MESH_DIR / "segmentation.nii.gz",
        MESH_DIR / "lumen_mask.nii.gz",
        MESH_DIR / "aortic_root.stl",
        MESH_DIR / "ascending_aorta.stl",
        MESH_DIR / "leaflets.stl",
        MESH_DIR / "annulus_ring.stl",
        MESH_DIR / "pears_outer_aorta.stl",
        MESH_DIR / "pears_support_sleeve_preview.stl",
        MESH_DIR / "centerline.json",
        MESH_DIR / "annulus_plane.json",
        MESH_DIR / "aortic_root_model.json",
        MESH_DIR / "leaflet_model.json",
        MESH_DIR / "measurements.json",
        MESH_DIR / "planning_report.pdf",
        ARTIFACTS_DIR / "pears_model.json",
        ARTIFACTS_DIR / "pears_coronary_windows.json",
        ARTIFACTS_DIR / "pipeline_result.json",
    ]


class CommandFailed(RuntimeError):
    pass


def timeout_seconds() -> int:
    raw = os.getenv("AORTICAI_MAO_TIMEOUT_SEC", "3600").strip()
    try:
        return max(60, int(raw))
    except ValueError:
        return 3600


def ensure_case_dirs() -> None:
    CASE_DIR.mkdir(parents=True, exist_ok=True)
    MESH_DIR.mkdir(parents=True, exist_ok=True)
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    (CASE_DIR / "qa").mkdir(parents=True, exist_ok=True)


def stream_process(cmd: list[str], *, cwd: Path, log_file: Path, timeout: int) -> int:
    ensure_case_dirs()
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(REPO_ROOT)
    print("$ " + " ".join(cmd), flush=True)
    print(f"timeout_seconds={timeout}", flush=True)

    proc = subprocess.Popen(
        cmd,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    lines: queue.Queue[str | None] = queue.Queue()

    def reader() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            lines.put(line)
        lines.put(None)

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    deadline = time.monotonic() + timeout
    reader_done = False
    with log_file.open("w", encoding="utf-8", errors="replace") as log:
        while True:
            try:
                line = lines.get(timeout=0.5)
            except queue.Empty:
                line = ""

            if line is None:
                reader_done = True
            elif line:
                print(line, end="" if line.endswith("\n") else "\n", flush=True)
                log.write(line)
                log.flush()

            code = proc.poll()
            if code is not None and reader_done:
                log.write(f"\n[EXIT CODE: {code}]\n")
                return int(code)

            if time.monotonic() > deadline:
                print(f"\nTIMEOUT: killing process after {timeout}s", flush=True)
                proc.terminate()
                try:
                    proc.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=20)
                log.write(f"\n[TIMEOUT AFTER {timeout}s]\n")
                raise CommandFailed(f"process_timed_out_after_{timeout}s")


def backup_outputs() -> Path:
    ensure_case_dirs()
    backup_dir = MESH_DIR / ("_backup_" + time.strftime("%Y%m%d_%H%M%S"))
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_files = [*managed_output_files(), PIPELINE_LOG]
    for src in backup_files:
        if src.exists():
            shutil.copy2(src, backup_dir / src.name)
            print(f"backed_up={src.name}", flush=True)
    return backup_dir


def restore_backup(backup_dir: Path) -> None:
    if not backup_dir.exists():
        return
    for path in managed_output_files():
        if path.exists() and path.is_file():
            path.unlink()
    restored = 0
    for backup_file in backup_dir.iterdir():
        if not backup_file.is_file():
            continue
        if backup_file.name == "pipeline.log":
            continue
        if backup_file.name in {"pipeline_result.json"}:
            dest = ARTIFACTS_DIR / backup_file.name
        else:
            dest = MESH_DIR / backup_file.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(backup_file, dest)
        restored += 1
    print(f"rollback_restored_files={restored}", flush=True)


def print_label_counts(mask_path: Path) -> dict[str, int]:
    import nibabel as nib
    import numpy as np

    seg = nib.load(str(mask_path)).get_fdata()
    counts = {
        "root": int((seg == 1).sum()),
        "leaflets": int((seg == 2).sum()),
        "ascending": int((seg == 3).sum()),
        "lumen": int(np.isin(seg, [1, 3]).sum()),
    }
    print("label_counts=" + json.dumps(counts, sort_keys=True), flush=True)
    return counts


def verify_segmentation(mask_path: Path) -> None:
    if not mask_path.exists() or mask_path.stat().st_size <= 0:
        raise CommandFailed(f"missing_segmentation:{mask_path}")
    counts = print_label_counts(mask_path)
    if counts["root"] <= 0 or counts["ascending"] <= 0:
        raise CommandFailed(f"required_aortic_labels_empty:{counts}")


def run_segmentation_only() -> None:
    ensure_case_dirs()
    if not INPUT_CT.exists():
        raise FileNotFoundError(f"input_ct_not_found:{INPUT_CT}")
    meta_path = ARTIFACTS_DIR / "builder_meta.json"
    cmd = [
        sys.executable,
        "-u",
        str(REPO_ROOT / "gpu_provider" / "build_real_multiclass_mask.py"),
        "--input",
        str(INPUT_CT),
        "--output",
        str(OUTPUT_MASK),
        "--meta",
        str(meta_path),
        "--device",
        os.getenv("AORTICAI_MAO_DEVICE", "gpu"),
        "--quality",
        os.getenv("AORTICAI_MAO_QUALITY", "high"),
    ]
    code = stream_process(cmd, cwd=REPO_ROOT, log_file=SEGMENTATION_LOG, timeout=timeout_seconds())
    if code != 0:
        raise CommandFailed(f"segmentation_only_failed_exit_code_{code}")
    verify_segmentation(OUTPUT_MASK)
    if meta_path.exists():
        print(f"builder_meta={meta_path}", flush=True)


def verify_pipeline_outputs() -> None:
    import nibabel as nib
    import numpy as np

    missing = [str(path) for path in managed_output_files() if not path.exists() or path.stat().st_size <= 0]
    if missing:
        raise CommandFailed("missing_pipeline_outputs:" + json.dumps(missing))

    verify_segmentation(OUTPUT_MASK)
    lumen = nib.load(str(MESH_DIR / "lumen_mask.nii.gz")).get_fdata()
    lumen_voxels = int(np.count_nonzero(lumen))
    print(f"lumen_voxels={lumen_voxels}", flush=True)
    if lumen_voxels <= 0:
        raise CommandFailed("empty_lumen_mask")

    log_text = PIPELINE_LOG.read_text(encoding="utf-8", errors="replace") if PIPELINE_LOG.exists() else ""
    if "geometry_centerline_failed" in log_text:
        raise CommandFailed("centerline_failed")

    try:
        import trimesh
    except Exception:
        print("trimesh_unavailable=true", flush=True)
        return
    for name in ["aortic_root.stl", "ascending_aorta.stl", "leaflets.stl", "annulus_ring.stl", "pears_support_sleeve_preview.stl"]:
        path = MESH_DIR / name
        mesh = trimesh.load(str(path))
        print(f"{name}_triangles={len(mesh.faces)}", flush=True)


def validate_manifest() -> None:
    cmd = [sys.executable, "-u", "-m", "gpu_provider.admin_validate_mao_result"]
    code = stream_process(cmd, cwd=REPO_ROOT, log_file=CASE_DIR / "validation.log", timeout=600)
    if code != 0:
        raise CommandFailed(f"validation_failed_exit_code_{code}")


def build_pears_visual_only() -> None:
    ensure_case_dirs()
    required = [
        MESH_DIR / "aortic_root.stl",
        MESH_DIR / "ascending_aorta.stl",
        MESH_DIR / "centerline.json",
        MESH_DIR / "aortic_root_model.json",
        MESH_DIR / "measurements.json",
    ]
    missing = [str(path) for path in required if not path.exists() or path.stat().st_size <= 0]
    if missing:
        raise CommandFailed("missing_pears_visual_inputs:" + json.dumps(missing))
    from .geometry.pears_visual import build_pears_visual_artifacts

    manifest_path = ARTIFACTS_DIR / "case_manifest.json"
    study_meta: dict[str, object] = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(manifest, dict) and isinstance(manifest.get("study_meta"), dict):
                study_meta = manifest["study_meta"]
        except Exception:
            study_meta = {}
    pears_model = build_pears_visual_artifacts(
        output_dir=MESH_DIR,
        artifacts_dir=ARTIFACTS_DIR,
        study_meta=study_meta,
        case_id=CASE_ID,
    )
    print("pears_visual_ready=" + str(bool(pears_model.get("visual_ready"))).lower(), flush=True)
    print("manufacturing_ready=false", flush=True)
    print("blockers=" + json.dumps(pears_model.get("blockers", []), ensure_ascii=False), flush=True)
    verify_pipeline_outputs()
    validate_manifest()


def run_pipeline() -> None:
    ensure_case_dirs()
    if not INPUT_CT.exists():
        raise FileNotFoundError(f"input_ct_not_found:{INPUT_CT}")
    backup_dir = backup_outputs()
    cmd = [
        sys.executable,
        "-u",
        str(REPO_ROOT / "gpu_provider" / "pipeline_runner.py"),
        "--input",
        str(INPUT_CT),
        "--output-mask",
        str(OUTPUT_MASK),
        "--output-json",
        str(OUTPUT_JSON),
        "--output-dir",
        str(MESH_DIR),
        "--device",
        os.getenv("AORTICAI_MAO_DEVICE", "gpu"),
        "--quality",
        os.getenv("AORTICAI_MAO_QUALITY", "high"),
        "--pears-visual",
        "--job-id",
        CASE_ID,
        "--study-id",
        CASE_ID,
    ]
    try:
        code = stream_process(cmd, cwd=REPO_ROOT, log_file=PIPELINE_LOG, timeout=timeout_seconds())
        if code != 0:
            raise CommandFailed(f"pipeline_failed_exit_code_{code}")
        verify_pipeline_outputs()
        validate_manifest()
    except Exception:
        print("rollback_initiated=true", flush=True)
        restore_backup(backup_dir)
        raise
    print("pipeline_verification=passed", flush=True)


def start_background(command: str) -> None:
    ensure_case_dirs()
    if command == "segmentation-only":
        supervisor_log = SEGMENTATION_SUPERVISOR_LOG
    elif command == "run-pipeline":
        supervisor_log = PIPELINE_SUPERVISOR_LOG
    else:
        raise CommandFailed(f"unsupported_background_command:{command}")

    cmd = [sys.executable, "-u", str(Path(__file__).resolve()), command]
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(REPO_ROOT)
    creationflags = 0
    if sys.platform == "win32":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

    with supervisor_log.open("a", encoding="utf-8", errors="replace") as log:
        log.write(f"\n=== start {command} {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
        log.flush()
        proc = subprocess.Popen(
            cmd,
            cwd=str(REPO_ROOT),
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creationflags,
        )

    print(f"started_command={command}", flush=True)
    print(f"pid={proc.pid}", flush=True)
    print(f"supervisor_log={supervisor_log}", flush=True)


def tail_log(lines: int) -> None:
    paths = [
        ("case_dir", CASE_DIR),
        ("input_ct", INPUT_CT),
        ("pipeline_log", PIPELINE_LOG),
        ("segmentation_log", SEGMENTATION_LOG),
        ("validation_log", CASE_DIR / "validation.log"),
        ("pipeline_supervisor_log", PIPELINE_SUPERVISOR_LOG),
        ("segmentation_supervisor_log", SEGMENTATION_SUPERVISOR_LOG),
        ("segmentation", OUTPUT_MASK),
        ("lumen_mask", MESH_DIR / "lumen_mask.nii.gz"),
        ("pipeline_result", OUTPUT_JSON),
        ("aortic_root_stl", MESH_DIR / "aortic_root.stl"),
        ("ascending_aorta_stl", MESH_DIR / "ascending_aorta.stl"),
        ("leaflets_stl", MESH_DIR / "leaflets.stl"),
        ("annulus_ring_stl", MESH_DIR / "annulus_ring.stl"),
        ("pears_outer_aorta_stl", MESH_DIR / "pears_outer_aorta.stl"),
        ("pears_support_sleeve_stl", MESH_DIR / "pears_support_sleeve_preview.stl"),
    ]
    for label, path in paths:
        if path.exists():
            size = path.stat().st_size if path.is_file() else 0
            print(f"{label}={path} exists=true size={size}", flush=True)
        else:
            print(f"{label}={path} exists=false", flush=True)

    for label, log_path in [
        ("pipeline_supervisor_log_tail", PIPELINE_SUPERVISOR_LOG),
        ("segmentation_supervisor_log_tail", SEGMENTATION_SUPERVISOR_LOG),
        ("pipeline_log_tail", PIPELINE_LOG),
        ("segmentation_log_tail", SEGMENTATION_LOG),
        ("validation_log_tail", CASE_DIR / "validation.log"),
    ]:
        if not log_path.exists():
            continue
        print(f"\n=== {label} last {lines} lines ===", flush=True)
        text = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        for line in text[-lines:]:
            print(line, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command",
        choices=[
            "run-pipeline",
            "segmentation-only",
            "build-pears-visual",
            "start-pipeline",
            "start-segmentation-only",
            "tail-log",
        ],
    )
    parser.add_argument("--lines", type=int, default=120)
    args = parser.parse_args()

    if args.command == "run-pipeline":
        run_pipeline()
    elif args.command == "segmentation-only":
        run_segmentation_only()
    elif args.command == "build-pears-visual":
        build_pears_visual_only()
    elif args.command == "start-pipeline":
        start_background("run-pipeline")
    elif args.command == "start-segmentation-only":
        start_background("segmentation-only")
    elif args.command == "tail-log":
        tail_log(max(20, min(1000, args.lines)))


if __name__ == "__main__":
    main()
