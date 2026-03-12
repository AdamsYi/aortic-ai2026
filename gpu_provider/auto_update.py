from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent


def _run(cmd: list[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd or REPO_ROOT),
        capture_output=True,
        text=True,
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"command_failed:{' '.join(cmd)}\nstdout={proc.stdout[-800:]}\nstderr={proc.stderr[-800:]}")
    return proc


def get_local_head() -> str:
    return _run(["git", "rev-parse", "HEAD"]).stdout.strip()


def fetch_remote() -> str:
    _run(["git", "fetch", "origin", "main"])
    return _run(["git", "rev-parse", "origin/main"]).stdout.strip()


def check_for_updates() -> dict[str, Any]:
    local_head = get_local_head()
    remote_head = fetch_remote()
    return {
        "repo_root": str(REPO_ROOT),
        "local_head": local_head,
        "remote_head": remote_head,
        "update_available": bool(local_head != remote_head),
    }


def sync_requirements(python_executable: str | None = None) -> None:
    py = python_executable or sys.executable
    _run([py, "-m", "pip", "install", "-r", "requirements.txt"], cwd=REPO_ROOT)


def reset_to_origin_main(sync_deps: bool = True, python_executable: str | None = None) -> dict[str, Any]:
    before = get_local_head()
    remote = fetch_remote()
    _run(["git", "reset", "--hard", "origin/main"], cwd=REPO_ROOT)
    after = get_local_head()
    if sync_deps:
        sync_requirements(python_executable=python_executable)
    return {
        "repo_root": str(REPO_ROOT),
        "before": before,
        "after": after,
        "remote_head": remote,
        "updated": bool(before != after),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--skip-deps", action="store_true")
    args = parser.parse_args()

    if args.apply:
        result = reset_to_origin_main(sync_deps=not args.skip_deps)
    else:
        result = check_for_updates()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
