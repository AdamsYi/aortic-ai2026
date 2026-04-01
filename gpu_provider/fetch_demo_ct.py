#!/usr/bin/env python3
"""
Fetch one public demo CTA NIfTI for pipeline smoke use on Windows GPU node.
Fallback: generate a synthetic aortic-root-like CTA volume when public downloads fail.
"""

from __future__ import annotations

import gzip
import io
from pathlib import Path
from typing import Iterable, Tuple

import nibabel as nib
import numpy as np
import requests


OUT_PATH = Path(__file__).resolve().parent / "demo_data" / "demo_ct.nii.gz"
TIMEOUT_SECONDS = 60


def ensure_parent() -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)


def candidate_urls() -> Iterable[Tuple[str, str]]:
    # Prefer direct NIfTI examples when publicly reachable.
    yield (
        "totalsegmentator_example_ct",
        "https://github.com/wasserth/TotalSegmentator/releases/download/v2.0.0-weights/s01.nii.gz",
    )
    yield (
        "zenodo_totalsegmentator_case_ct",
        "https://zenodo.org/records/6802614/files/s01.nii.gz?download=1",
    )


def is_nifti_like(data: bytes) -> bool:
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as gz:
            raw = gz.read(512)
        return len(raw) >= 352 and raw[344:348] in (b"n+1\0", b"ni1\0")
    except Exception:
        return False


def try_download() -> bool:
    for name, url in candidate_urls():
        try:
            print(f"[fetch] trying {name}: {url}")
            resp = requests.get(url, timeout=TIMEOUT_SECONDS, stream=True)
            resp.raise_for_status()
            content = resp.content
            if len(content) < 1024:
                print(f"[fetch] {name} too small ({len(content)} bytes), skip")
                continue
            if not is_nifti_like(content):
                print(f"[fetch] {name} is not a NIfTI payload, skip")
                continue
            OUT_PATH.write_bytes(content)
            print(f"[fetch] downloaded from {name}")
            return True
        except Exception as exc:
            print(f"[fetch] {name} failed: {exc}")
    return False


def generate_synthetic_ct() -> None:
    print("[fallback] generating synthetic CTA volume...")
    shape = (384, 384, 300)
    spacing = (0.625, 0.625, 1.0)
    cx, cy, cz = (shape[0] // 2, shape[1] // 2, shape[2] // 2)

    x = ((np.arange(shape[0], dtype=np.float32) - cx) * spacing[0])[:, None, None]
    y = ((np.arange(shape[1], dtype=np.float32) - cy) * spacing[1])[None, :, None]
    z = ((np.arange(shape[2], dtype=np.float32) - cz) * spacing[2])[None, None, :]

    # Base background + soft tissue field
    vol = np.full(shape, -800.0, dtype=np.float32)
    soft = np.exp(-((x / 90.0) ** 2 + (y / 90.0) ** 2 + (z / 140.0) ** 2))
    vol += 860.0 * soft

    # Root lumen core (ellipsoid)
    lumen_core = ((x / 16.0) ** 2 + (y / 16.0) ** 2 + (z / 26.0) ** 2) <= 1.0

    # Sinus bulges (3 lobes around root)
    angles = [0.0, 2.0 * np.pi / 3.0, 4.0 * np.pi / 3.0]
    sinus = np.zeros(shape, dtype=bool)
    for a in angles:
        sx = x - 11.0 * np.cos(a)
        sy = y - 11.0 * np.sin(a)
        lobe = ((sx / 15.5) ** 2 + (sy / 15.5) ** 2 + (z / 18.0) ** 2) <= 1.0
        sinus |= lobe

    lumen = lumen_core | sinus
    wall = (((x / 22.5) ** 2 + (y / 22.5) ** 2 + (z / 33.0) ** 2) <= 1.0) & (~lumen)

    vol[lumen] = 300.0
    vol[wall] = 60.0

    # Add realistic CT-like noise
    rng = np.random.default_rng(20260331)
    vol += rng.normal(0.0, 30.0, size=shape).astype(np.float32)

    vol = np.clip(vol, -1024.0, 1200.0).astype(np.float32)
    affine = np.array(
        [
            [spacing[0], 0.0, 0.0, 0.0],
            [0.0, spacing[1], 0.0, 0.0],
            [0.0, 0.0, spacing[2], 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
        dtype=np.float32,
    )
    img = nib.Nifti1Image(vol, affine)
    nib.save(img, str(OUT_PATH))
    print("[fallback] synthetic CTA generated")


def verify_output() -> None:
    size_mb = OUT_PATH.stat().st_size / (1024.0 * 1024.0)
    img = nib.load(str(OUT_PATH))
    shape = img.shape
    zooms = img.header.get_zooms()[:3]
    print(f"[verify] output: {OUT_PATH}")
    print(f"[verify] size_mb: {size_mb:.2f}")
    print(f"[verify] shape: {shape}")
    print(f"[verify] spacing: {zooms}")


def main() -> None:
    ensure_parent()
    ok = try_download()
    if not ok:
        generate_synthetic_ct()
    verify_output()


if __name__ == "__main__":
    main()
