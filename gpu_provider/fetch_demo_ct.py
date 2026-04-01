#!/usr/bin/env python3
"""
Download a real public CT dataset sample for AorticAI demo pipeline input.

Policy:
- Only real public CT data is allowed.
- No synthetic fallback is allowed.
- On failure, print a clear message and exit non-zero.

Sources (priority order):
1) TotalSegmentator dataset (Zenodo record 6802614)
2) Medical Segmentation Decathlon archives
3) TCIA public chest CT samples

License / citation notes:
- TotalSegmentator: https://zenodo.org/record/6802614
- Medical Segmentation Decathlon: http://medicaldecathlon.com/
- TCIA: https://www.cancerimagingarchive.net/
Users must comply with each dataset license and citation requirements before reuse.
"""

from __future__ import annotations

import gzip
import io
import os
import sys
import zipfile
from pathlib import Path
from typing import Iterable

import requests


WINDOWS_DEFAULT_DIR = Path(r"C:\AorticAI\gpu_provider\demo_data")
TIMEOUT_SECONDS = 120
TARGET_FILENAME = "demo_ct.nii.gz"


def resolve_output_dir() -> Path:
    override = os.getenv("AORTICAI_DEMO_DATA_DIR", "").strip()
    if override:
        return Path(override)
    if os.name != "nt":
        raise RuntimeError("此脚本默认仅用于 Windows GPU 节点。非 Windows 环境请设置 AORTICAI_DEMO_DATA_DIR。")
    return WINDOWS_DEFAULT_DIR


def candidate_urls() -> Iterable[tuple[str, str]]:
    yield (
        "totalsegmentator_zenodo_small_zip",
        "https://zenodo.org/record/6802614/files/Totalsegmentator_dataset_small_v201.zip",
    )
    yield (
        "medical_decathlon_task06_lung",
        "https://msd-for-monai.s3-us-west-2.amazonaws.com/Task06_Lung.tar",
    )
    yield (
        "medical_decathlon_task07_pancreas",
        "https://msd-for-monai.s3-us-west-2.amazonaws.com/Task07_Pancreas.tar",
    )
    yield (
        "tcia_sample_chest_ct",
        "https://wiki.cancerimagingarchive.net/download/attachments/52758026/CT_small.nii.gz",
    )


def is_nifti_gz(content: bytes) -> bool:
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(content)) as gz:
            header = gz.read(352)
        return len(header) >= 348 and header[344:348] in (b"n+1\0", b"ni1\0")
    except Exception:
        return False


def extract_first_nifti_gz_from_zip(content: bytes) -> bytes | None:
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            names = sorted([name for name in zf.namelist() if name.lower().endswith(".nii.gz")])
            for name in names:
                data = zf.read(name)
                if is_nifti_gz(data):
                    return data
    except Exception:
        return None
    return None


def try_fetch_real_ct() -> tuple[str, bytes] | None:
    for source_name, url in candidate_urls():
        try:
            print(f"[fetch] trying source={source_name} url={url}")
            resp = requests.get(url, timeout=TIMEOUT_SECONDS)
            resp.raise_for_status()
            data = resp.content
            if len(data) < 1024:
                print(f"[fetch] source={source_name} skipped: payload too small ({len(data)} bytes)")
                continue
            if is_nifti_gz(data):
                print(f"[fetch] source={source_name} accepted: direct NIfTI")
                return source_name, data
            extracted = extract_first_nifti_gz_from_zip(data)
            if extracted is not None:
                print(f"[fetch] source={source_name} accepted: NIfTI extracted from archive")
                return source_name, extracted
            print(f"[fetch] source={source_name} skipped: no NIfTI content found")
        except Exception as exc:
            print(f"[fetch] source={source_name} failed: {exc}")
    return None


def save_output(target_dir: Path, content: bytes, source_name: str) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    out = target_dir / TARGET_FILENAME
    out.write_bytes(content)
    print(f"[done] source={source_name}")
    print(f"[done] saved={out}")
    print(f"[done] size_mb={out.stat().st_size / (1024 * 1024):.2f}")
    return out


def main() -> int:
    target_dir = resolve_output_dir()
    result = try_fetch_real_ct()
    if result is None:
        print("未找到可用公开数据，请手动提供CT文件")
        return 2
    source_name, content = result
    save_output(target_dir, content, source_name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
