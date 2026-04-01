#!/usr/bin/env python3
"""
Fetch a real public CTA/CT demo file for AorticAI.

Rules:
- Real public data only.
- No synthetic fallback.
- If all sources fail, print reason and exit non-zero.

Data source and citation:
- Zenodo TotalSegmentator record 6802614
- Zenodo fallback record 10047292
- TotalSegmentator GitHub release archive (fallback)
"""

from __future__ import annotations

import argparse
import io
import os
import zipfile
from pathlib import Path
from typing import Iterable

import requests


ZENODO_RECORD_API = "https://zenodo.org/api/records/6802614"
ZENODO_FALLBACK_RECORD_API = "https://zenodo.org/api/records/10047292"
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
    parser.add_argument(
        "--url",
        default=None,
        help="Direct URL to a .nii.gz or .zip-containing-nifti file (overrides auto-discovery).",
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


def iter_zip_nifti_candidates(zf: zipfile.ZipFile) -> Iterable[str]:
    names = [name for name in zf.namelist() if is_nifti_filename(name)]
    names.sort(key=lambda name: score_nifti_name(name))
    for name in names:
        yield name


def decode_downloaded_payload(url_hint: str, payload: bytes) -> tuple[str, bytes] | None:
    if len(payload) < 1024:
        return None
    lower = url_hint.lower()
    if is_nifti_filename(lower):
        return url_hint, payload
    if lower.endswith(".zip"):
        try:
            with zipfile.ZipFile(io.BytesIO(payload)) as zf:
                for name in iter_zip_nifti_candidates(zf):
                    data = zf.read(name)
                    if len(data) >= 1024:
                        return f"{url_hint}!{name}", data
        except Exception:
            return None
        return None

    # Unknown extension: try ZIP sniff as graceful fallback.
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as zf:
            for name in iter_zip_nifti_candidates(zf):
                data = zf.read(name)
                if len(data) >= 1024:
                    return f"{url_hint}!{name}", data
    except Exception:
        pass
    return None


def fetch_direct_url(url: str) -> tuple[str, bytes] | None:
    try:
        resp = requests.get(url, timeout=TIMEOUT_SECONDS)
        resp.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        print(f"[fail] direct URL failed ({error_kind(exc)}): {exc}")
        return None
    decoded = decode_downloaded_payload(url, resp.content)
    if decoded is None:
        print("[fail] direct URL payload is not a usable NIfTI or ZIP-containing NIfTI.")
        return None
    return decoded


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
            size_rank = 0 if "small" in lower else 1
            zip_candidates.append((size_rank, size, item))
    if nifti_candidates:
        nifti_candidates.sort(key=lambda row: (row[0][0], row[0][1], row[1]))
        return nifti_candidates[0][2]
    if zip_candidates:
        zip_candidates.sort(key=lambda row: (row[0], row[1]))
        return zip_candidates[0][2]
    return None


def try_download_zenodo_nifti(record_api: str, label: str) -> tuple[str, bytes] | None:
    print(f"[{label}] Query Zenodo API: {record_api}")
    try:
        resp = requests.get(record_api, timeout=TIMEOUT_SECONDS)
        resp.raise_for_status()
        payload = resp.json()
    except Exception as exc:  # noqa: BLE001
        print(f"[fail] {label} API failed ({error_kind(exc)}): {exc}")
        return None

    files = payload.get("files")
    if not isinstance(files, list) or not files:
        print(f"[fail] {label} API returned no files.")
        return None

    chosen = pick_zenodo_file(files)
    if not chosen:
        print(f"[fail] {label} has no .nii/.nii.gz or zip candidates.")
        return None

    key = str(chosen.get("key") or "unknown")
    links = chosen.get("links") if isinstance(chosen.get("links"), dict) else {}
    direct_url = str(links.get("self") or links.get("download") or "").strip()
    if not direct_url:
        print(f"[fail] {label} candidate has no direct URL: {key}")
        return None

    print(f"[download] {label} file: {key}")
    decoded = fetch_direct_url(direct_url)
    if decoded is None:
        return None
    source_path, content = decoded
    return f"{label}:{key}->{source_path}", content


def try_download_zenodo_nifti_primary() -> tuple[str, bytes] | None:
    return try_download_zenodo_nifti(ZENODO_RECORD_API, "zenodo-6802614")


def try_download_zenodo_nifti_alt() -> tuple[str, bytes] | None:
    return try_download_zenodo_nifti(ZENODO_FALLBACK_RECORD_API, "zenodo-10047292")


def try_download_github_archive() -> tuple[str, bytes] | None:
    print(f"[github] Try fallback: {GITHUB_FALLBACK_ZIP}")
    direct = fetch_direct_url(GITHUB_FALLBACK_ZIP)
    if direct is None:
        return None
    source, content = direct
    return f"github:{source}", content


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
    print("- Zenodo fallback record 10047292")
    print("- GitHub TotalSegmentator release archive fallback")
    print("Please follow dataset license/citation requirements before usage.")

    result: tuple[str, bytes] | None = None
    if args.url:
        print(f"[direct] Using user-specified URL: {args.url}")
        result = fetch_direct_url(args.url)
        if result is None:
            print("未找到可用公开数据，请手动提供CT文件")
            return 1

    if result is None:
        result = try_download_zenodo_nifti_primary()
    if result is None:
        result = try_download_zenodo_nifti_alt()
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
