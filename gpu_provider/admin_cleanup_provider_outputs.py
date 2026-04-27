#!/usr/bin/env python3
"""Clean Windows provider workspace noise while keeping current Mao outputs."""

from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path


def repo_root() -> Path:
    for candidate in [Path(r"C:\AorticAI"), Path(r"C:\aortic-ai"), Path(r"C:\aortic_ai")]:
        if candidate.exists():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO_ROOT = repo_root()


def run_git_restore(rel_path: str) -> None:
    result = subprocess.run(
        ["git", "restore", "--", rel_path],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode == 0:
        print(f"restored_tracked={rel_path}", flush=True)
    else:
        message = (result.stderr or result.stdout or "").strip()
        print(f"restore_skipped={rel_path} reason={message}", flush=True)


def archive_path() -> Path:
    target = REPO_ROOT / "runs" / "provider_cleanup_archive" / time.strftime("%Y%m%d_%H%M%S")
    target.mkdir(parents=True, exist_ok=True)
    return target


def move_if_exists(path: Path, archive_dir: Path) -> None:
    if not path.exists():
        return
    rel = path.relative_to(REPO_ROOT)
    dest = archive_dir / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        suffix = 1
        while dest.with_name(f"{dest.name}.{suffix}").exists():
            suffix += 1
        dest = dest.with_name(f"{dest.name}.{suffix}")
    shutil.move(str(path), str(dest))
    print(f"archived={rel} -> {dest.relative_to(REPO_ROOT)}", flush=True)


def main() -> None:
    archive_dir = archive_path()
    run_git_restore("cases/mao_mianqiang_preop/artifacts/case_manifest.json")

    explicit_junk = [
        REPO_ROOT / "pipeline_out.log",
        REPO_ROOT / "promote_out.log",
        REPO_ROOT / "promote_case.bat",
        REPO_ROOT / "resample_mask.py",
        REPO_ROOT / "run_pipeline.bat",
        REPO_ROOT / "run_pipeline2.bat",
        REPO_ROOT / "gpu_provider" / "build_real_multiclass_mask_fix.py",
        REPO_ROOT / "gpu_provider" / "cta_run",
        REPO_ROOT / "gpu_provider" / "demo_pipeline_output",
        REPO_ROOT / "gpu_provider" / "imagecas_output",
    ]
    for path in explicit_junk:
        move_if_exists(path, archive_dir)

    cases_dir = REPO_ROOT / "cases"
    for path in sorted(cases_dir.glob("imagecas_*")) if cases_dir.exists() else []:
        move_if_exists(path, archive_dir)

    status = subprocess.run(
        ["git", "status", "--short"],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    print("git_status_after_cleanup=" + ((status.stdout or "").strip() or "clean"), flush=True)
    print(f"archive_dir={archive_dir}", flush=True)


if __name__ == "__main__":
    main()
