#!/usr/bin/env python3
from __future__ import annotations

import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

import nibabel as nib
import numpy as np


REPO_ROOT = Path(__file__).resolve().parent
OUTPUT_PATH = REPO_ROOT / "demo_data" / "demo_aortic_cta.nii.gz"
SMALL_DATASET_URL = (
    "https://github.com/wasserth/TotalSegmentator/releases/download/"
    "v2.0.0-weights/Totalsegmentator_dataset_small_v201.zip"
)


def log(message: str) -> None:
    print(f"[download_demo_ct] {message}")


def is_ct_candidate(path: Path) -> bool:
    lowered = path.name.lower()
    if not (lowered.endswith(".nii") or lowered.endswith(".nii.gz")):
        return False
    blocked = ("mask", "seg", "label", "labels", "ground_truth", "gt")
    return not any(token in lowered for token in blocked)


def download_file(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    log(f"downloading public sample from {url}")
    with urllib.request.urlopen(url) as response, destination.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def choose_volume(extracted_root: Path) -> Path:
    candidates = sorted(path for path in extracted_root.rglob("*") if is_ct_candidate(path))
    if not candidates:
        raise FileNotFoundError("no_public_ct_volume_found")

    ranked: list[tuple[int, Path]] = []
    for candidate in candidates:
        try:
            nii = nib.load(str(candidate))
            if len(nii.shape) < 3:
                continue
            voxel_count = int(np.prod(nii.shape[:3]))
            ranked.append((voxel_count, candidate))
        except Exception:
            continue

    if not ranked:
        raise RuntimeError("public_dataset_contains_no_readable_ct_volume")

    ranked.sort(reverse=True)
    selected = ranked[0][1]
    log(f"selected public CT volume: {selected.relative_to(extracted_root)}")
    return selected


def save_public_sample(source_path: Path, destination: Path) -> None:
    nii = nib.load(str(source_path))
    destination.parent.mkdir(parents=True, exist_ok=True)
    nib.save(nii, str(destination))


def generate_synthetic_cta(destination: Path) -> None:
    log("public download unavailable, generating synthetic CTA fallback")
    shape = (256, 256, 200)
    spacing = np.array([0.625, 0.625, 0.625], dtype=np.float32)
    affine = np.diag([*spacing.tolist(), 1.0])

    x, y, z = np.mgrid[0 : shape[0], 0 : shape[1], 0 : shape[2]]
    x = x.astype(np.float32)
    y = y.astype(np.float32)
    z = z.astype(np.float32)

    center = np.array([shape[0] / 2, shape[1] / 2, shape[2] * 0.52], dtype=np.float32)
    dx = (x - center[0]) / 34.0
    dy = (y - center[1]) / 30.0
    dz = (z - center[2]) / 82.0

    root_shell = (dx * dx + dy * dy + dz * dz) <= 1.0
    lumen = (
        ((x - center[0]) / 22.0) ** 2
        + ((y - center[1]) / 18.0) ** 2
        + ((z - center[2]) / 90.0) ** 2
    ) <= 1.0

    sinus_bulge = (
        ((x - center[0]) / 42.0) ** 2
        + ((y - center[1]) / 38.0) ** 2
        + ((z - (center[2] - 10.0)) / 28.0) ** 2
    ) <= 1.0

    ascending = (
        ((x - center[0]) / 18.0) ** 2
        + ((y - center[1]) / 18.0) ** 2
        + ((z - (center[2] + 50.0)) / 70.0) ** 2
    ) <= 1.0

    volume = np.full(shape, -930.0, dtype=np.float32)
    rng = np.random.default_rng(20260331)
    volume += rng.normal(0.0, 22.0, size=shape).astype(np.float32)

    mediastinum = root_shell | sinus_bulge | ascending
    volume[mediastinum] = 55.0 + rng.normal(0.0, 18.0, size=int(mediastinum.sum())).astype(np.float32)
    vessel = lumen | ascending
    volume[vessel] = 345.0 + rng.normal(0.0, 28.0, size=int(vessel.sum())).astype(np.float32)

    destination.parent.mkdir(parents=True, exist_ok=True)
    image = nib.Nifti1Image(volume.astype(np.int16), affine)
    image.header.set_zooms(tuple(spacing.tolist()))
    nib.save(image, str(destination))


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="aorticai-demo-ct-") as tmp_dir:
        tmp_root = Path(tmp_dir)
        archive_path = tmp_root / "public_demo_ct.zip"
        extract_root = tmp_root / "extracted"
        try:
            download_file(SMALL_DATASET_URL, archive_path)
            with zipfile.ZipFile(archive_path) as archive:
                archive.extractall(extract_root)
            source_path = choose_volume(extract_root)
            save_public_sample(source_path, OUTPUT_PATH)
            source_mode = "public_download"
        except Exception as exc:
            log(f"public sample download failed: {exc}")
            generate_synthetic_cta(OUTPUT_PATH)
            source_mode = "synthetic_fallback"

    nii = nib.load(str(OUTPUT_PATH))
    size_mb = OUTPUT_PATH.stat().st_size / (1024 * 1024)
    log(
        "ready "
        f"path={OUTPUT_PATH} "
        f"shape={nii.shape} "
        f"spacing={nii.header.get_zooms()[:3]} "
        f"size_mb={size_mb:.2f} "
        f"source={source_mode}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
