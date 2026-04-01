#!/usr/bin/env python3
"""
Fetch a real public CTA/CT demo file for AorticAI.

Rules:
- Real public data only.
- No synthetic fallback.
- If all sources fail, print reason and exit non-zero.

Priority:
1) Zenodo TotalSegmentator record 6802614 (API first)
2) GitHub release archive fallback
"""

from __future__ import annotations

import argparse
import io
import os
import sys
import zipfile
from pathlib import Path
from typing import Iterable

import requests


ZENODO_RECORD_API = "https://zenodo.org/api/records/6802614"
GITHUB_FALLBACK_ZIP = (
    "https://github.com/wasserth/TotalSegmentator/releases/download/"
    "v2.0.0-weights/Totalsegmentator_dataset_small_v201.zip"
)
WINDOWS_DEFAULT_DIR = Path(r"C:\AorticAI\gpu_provider\demo_data")
TARGET_FILENAME = "demo_ct.nii.gz"
TIMEOUT_SECONDS = 120


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download real public CT data (no synthetic fallback)."
    )
    parser.add_argument(
        "--output",
        default=os.getenv("AORTICAI_DEMO_DATA_DIR", str(WINDOWS_DEFAULT_DIR)),
        help="Output directory (default: C:\\AorticAI\\gpu_provider\\demo_data)",
    )
    return parser.parse_args()


def error_kind(exc: Exception) -> str:
    text = str(exc).lower()
    if "name or service not known" in text or "temporary failure in name resolution" in text:
        return "DNS"
    if "timed out" in text or "timeout" in text:
        return "TIMEOUT"
    if "403" in text:
        return "HTTP_403"
    if "404" in text:
        return "HTTP_404"
    return "NETWORK_OR_REMOTE_ERROR"


def is_nifti_filename(name: str) -> bool:
    lower = name.lower()
    return lower.endswith(".nii.gz") or lower.endswith(".nii")


def score_nifti_name(name: str) -> tuple[int, int]:
    lower = name.lower()
    # Prefer files that look like CT source volumes, not labels/masks/segmentations.
    penalty = 0
    if "seg" in lower or "label" in lower or "mask" in lower:
        penalty += 5
    if "ct" in lower:
        penalty -= 2
    return penalty, len(name)


def pick_zenodo_file(files: list[dict]) -> dict | None:
    nifti_candidates = []
    zip_candidates = []
    for item in files:
        key = str(item.get("key") or "")
        size = int(item.get("size") or 0)
        if size <= 0:
            continue
        lower = key.lower()
        if is_nifti_filename(key):
            nifti_candidates.append((score_nifti_name(key), size, item))
        elif lower.endswith(".zip"):
            # Prefer "small" archives, then smaller size.
            size_rank = 0 if "small" in lower else 1
            zip_candidates.append((size_rank, size, item))
    if nifti_candidates:
        nifti_candidates.sort(key=lambda row: (row[0][0], row[0][1], row[1]))
        return nifti_candidates[0][2]
    if zip_candidates:
        zip_candidates.sort(key=lambda row: (row[0], row[1]))
        return zip_candidates[0][2]
    return None


def try_download_zenodo_nifti() -> tuple[str, bytes] | None:
    print(f"[1/2] Query Zenodo API: {ZENODO_RECORD_API}")
    try:
        resp = requests.get(ZENODO_RECORD_API, timeout=TIMEOUT_SECONDS)
        resp.raise_for_status()
        payload = resp.json()
    except Exception as exc:  # noqa: BLE001
        print(f"[fail] Zenodo API failed ({error_kind(exc)}): {exc}")
        return None

    files = payload.get("files")
    if not isinstance(files, list) or not files:
        print("[fail] Zenodo API returned no files.")
        return None

    chosen = pick_zenodo_file(files)
    if not chosen:
        print("[fail] Zenodo files found, but no .nii/.nii.gz CT candidate.")
        return None

    key = str(chosen.get("key") or "unknown")
    chosen_size = int(chosen.get("size") or 0)
    links = chosen.get("links") if isinstance(chosen.get("links"), dict) else {}
    direct_url = str(links.get("self") or links.get("download") or "").strip()
    if not direct_url:
        print(f"[fail] Zenodo candidate has no downloadable URL: {key}")
        return None
    if key.lower().endswith(".zip") and chosen_size > 800 * 1024 * 1024:
        print(
            f"[fail] Zenodo zip too large for quick demo fetch ({chosen_size / (1024 * 1024):.1f} MB): {key}"
        )
        return None

    try:
        print(f"[download] Zenodo file: {key}")
        file_resp = requests.get(direct_url, timeout=TIMEOUT_SECONDS)
        file_resp.raise_for_status()
        content = file_resp.content
        if len(content) < 1024:
            print(f"[fail] Zenodo file too small: {len(content)} bytes")
            return None
        if is_nifti_filename(key):
            return f"zenodo:{key}", content
        if key.lower().endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(content)) as zf:
                for name in iter_zip_nifti_candidates(zf):
                    data = zf.read(name)
                    if len(data) >= 1024:
                        return f"zenodo:{key}!{name}", data
            print(f"[fail] Zenodo zip has no usable CT NIfTI file: {key}")
            return None
        print(f"[fail] Zenodo candidate is neither NIfTI nor ZIP: {key}")
        return None
    except Exception as exc:  # noqa: BLE001
        print(f"[fail] Zenodo file download failed ({error_kind(exc)}): {exc}")
        return None


def iter_zip_nifti_candidates(zf: zipfile.ZipFile) -> Iterable[str]:
    names = [name for name in zf.namelist() if is_nifti_filename(name)]
    names.sort(key=lambda name: score_nifti_name(name))
    for name in names:
        yield name


def try_download_github_archive() -> tuple[str, bytes] | None:
    print(f"[2/2] Try GitHub fallback: {GITHUB_FALLBACK_ZIP}")
    try:
        resp = requests.get(GITHUB_FALLBACK_ZIP, timeout=TIMEOUT_SECONDS)
        resp.raise_for_status()
        archive = resp.content
        if len(archive) < 1024:
            print(f"[fail] GitHub archive too small: {len(archive)} bytes")
            return None
        with zipfile.ZipFile(io.BytesIO(archive)) as zf:
            for name in iter_zip_nifti_candidates(zf):
                data = zf.read(name)
                if len(data) < 1024:
                    continue
                return f"github:{name}", data
        print("[fail] GitHub archive has no usable CT NIfTI file.")
        return None
    except Exception as exc:  # noqa: BLE001
        print(f"[fail] GitHub fallback failed ({error_kind(exc)}): {exc}")
        return None


def save_output(target_dir: Path, content: bytes, source: str) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    out = target_dir / TARGET_FILENAME
    out.write_bytes(content)
    print(f"[ok] source={source}")
    print(f"[ok] output={out}")
    print(f"[ok] size_mb={out.stat().st_size / (1024 * 1024):.2f}")
    return out


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output)

    print("AorticAI demo CT fetcher")
    print("Data source + citation:")
    print("- Zenodo TotalSegmentator record 6802614")
    print("- GitHub TotalSegmentator release archive fallback")
    print("Please follow dataset license/citation requirements before usage.")

    result = try_download_zenodo_nifti()
    if result is None:
        result = try_download_github_archive()

    if result is None:
        print("未找到可用公开数据，请手动提供CT文件")
        return 2

    source, content = result
    save_output(output_dir, content, source)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
