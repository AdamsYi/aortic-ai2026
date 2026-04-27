#!/usr/bin/env python3
"""Export Mao provider result artifacts for local publication."""

from __future__ import annotations

import base64
import hashlib
import tempfile
import zipfile
from pathlib import Path


CASE_ID = "mao_mianqiang_preop"
BEGIN_MARKER = "BEGIN_MAO_RESULT_BUNDLE_BASE64"
END_MARKER = "END_MAO_RESULT_BUNDLE_BASE64"


def repo_root() -> Path:
    for candidate in [Path(r"C:\AorticAI"), Path(r"C:\aortic-ai"), Path(r"C:\aortic_ai")]:
        if candidate.exists():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO_ROOT = repo_root()
CASE_DIR = REPO_ROOT / "cases" / CASE_ID


REQUIRED_RELATIVE_PATHS = (
    "artifacts/case_manifest.json",
    "artifacts/pipeline_result.json",
    "artifacts/pears_model.json",
    "artifacts/pears_coronary_windows.json",
    "meshes/segmentation.nii.gz",
    "meshes/lumen_mask.nii.gz",
    "meshes/aortic_root.stl",
    "meshes/ascending_aorta.stl",
    "meshes/leaflets.stl",
    "meshes/annulus_ring.stl",
    "meshes/pears_outer_aorta.stl",
    "meshes/pears_support_sleeve_preview.stl",
    "meshes/centerline.json",
    "meshes/annulus_plane.json",
    "meshes/measurements.json",
    "meshes/planning_report.pdf",
    "meshes/aortic_root_model.json",
    "meshes/leaflet_model.json",
)

OPTIONAL_RELATIVE_PATHS = (
    "artifacts/builder_meta.json",
    "artifacts/measurements.json",
    "artifacts/planning.json",
    "artifacts/centerline.json",
    "artifacts/annulus_plane.json",
    "artifacts/aortic_root_model.json",
    "artifacts/leaflet_model.json",
    "qa/quality_gates.json",
    "qa/mesh_qa.json",
    "qa/pears_visual_qa.json",
)


def checked_files() -> list[Path]:
    if not CASE_DIR.exists():
        raise SystemExit(f"case_dir_missing:{CASE_DIR}")

    missing = [rel for rel in REQUIRED_RELATIVE_PATHS if not (CASE_DIR / rel).is_file()]
    if missing:
        raise SystemExit("missing_required_export_artifacts:" + ",".join(missing))

    files = [CASE_DIR / rel for rel in REQUIRED_RELATIVE_PATHS]
    files.extend(CASE_DIR / rel for rel in OPTIONAL_RELATIVE_PATHS if (CASE_DIR / rel).is_file())
    return files


def main() -> None:
    files = checked_files()
    with tempfile.NamedTemporaryFile(prefix="mao-result-", suffix=".zip", delete=False) as tmp:
        bundle_path = Path(tmp.name)

    try:
        with zipfile.ZipFile(bundle_path, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            for path in files:
                arcname = Path(CASE_ID) / path.relative_to(CASE_DIR)
                bundle.write(path, arcname.as_posix())

        data = bundle_path.read_bytes()
        encoded = base64.b64encode(data).decode("ascii")
        print(f"case_id={CASE_ID}", flush=True)
        print(f"bundle_bytes={len(data)}", flush=True)
        print(f"bundle_sha256={hashlib.sha256(data).hexdigest()}", flush=True)
        print(f"bundle_file_count={len(files)}", flush=True)
        print(BEGIN_MARKER, flush=True)
        for offset in range(0, len(encoded), 76):
            print(encoded[offset : offset + 76], flush=True)
        print(END_MARKER, flush=True)
    finally:
        bundle_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
