#!/usr/bin/env python3
"""
Build a multiclass aortic mask from CTA using only open TotalSegmentator tasks.

Model stack (open):
- TotalSegmentator task=total (ROI subset: aorta, heart, arch branches)

Output labels:
  0 background
  1 aortic_root
  2 valve_leaflets (CTA-derived leaflet proxy in annulus/root band)
  3 ascending_aorta
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy import ndimage


def _progress(step: str, detail: str = "") -> None:
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    msg = f"[{ts}] [{step}] {detail}" if detail else f"[{ts}] [{step}]"
    print(msg, flush=True)


def run_cmd(cmd: list[str]) -> tuple[str, str]:
    print("[cmd]", " ".join(cmd), flush=True)
    proc = subprocess.run(cmd, text=True, capture_output=True, encoding="utf-8", errors="replace")
    if proc.stdout:
        print(proc.stdout, end="" if proc.stdout.endswith("\n") else "\n", flush=True)
    if proc.stderr:
        print(proc.stderr, end="" if proc.stderr.endswith("\n") else "\n", file=sys.stderr, flush=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"Command failed: {' '.join(cmd)}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
        )
    return proc.stdout, proc.stderr


def _heartbeat(stop_event: threading.Event, label: str) -> None:
    start = time.time()
    while not stop_event.wait(15):
        elapsed = int(time.time() - start)
        print(f"  [heartbeat] {label} still running... {elapsed}s elapsed", flush=True)


def _run_cmd_with_heartbeat(cmd: list[str], label: str) -> tuple[str, str]:
    stop_evt = threading.Event()
    hb = threading.Thread(target=_heartbeat, args=(stop_evt, label), daemon=True)
    start = time.time()
    hb.start()
    try:
        return run_cmd(cmd)
    finally:
        stop_evt.set()
        hb.join(timeout=1)
        elapsed = int(time.time() - start)
        print(f"  [{label}] completed in {elapsed}s", flush=True)


def _run_totalsegmentator(cmd_gpu: list[str], cmd_cpu: list[str]) -> tuple[str, str]:
    """Try GPU first, fall back to CPU if CUDA kernel error."""
    try:
        _progress("totalsegmentator", f"trying GPU: {' '.join(cmd_gpu)}")
        return _run_cmd_with_heartbeat(cmd_gpu, "totalsegmentator")
    except Exception as exc:
        err_str = str(exc).lower()
        if "cuda" in err_str or "kernel image" in err_str or "no kernel" in err_str or "device-side" in err_str:
            _progress("totalsegmentator", "GPU failed (CUDA kernel incompatibility), retrying on CPU...")
            _progress("totalsegmentator", f"CPU cmd: {' '.join(cmd_cpu)}")
            return _run_cmd_with_heartbeat(cmd_cpu, "totalsegmentator")
        raise


def load_mask_optional(path: Path, shape: tuple[int, int, int]) -> np.ndarray:
    if not path.exists():
        return np.zeros(shape, dtype=bool)
    arr = nib.load(str(path)).get_fdata()
    return arr > 0.5


def keep_top_components(mask: np.ndarray, top_k: int = 1) -> np.ndarray:
    if not mask.any():
        return mask
    lab, num = ndimage.label(mask)
    if num <= top_k:
        return mask
    counts = np.bincount(lab.ravel())
    counts[0] = 0
    keep_ids = np.argsort(counts)[-top_k:]
    return np.isin(lab, keep_ids)


def drop_small_components(mask: np.ndarray, min_vox: int) -> np.ndarray:
    if not mask.any():
        return mask
    lab, num = ndimage.label(mask)
    if num == 0:
        return mask
    counts = np.bincount(lab.ravel())
    keep = np.where(counts >= max(1, int(min_vox)))[0]
    keep = keep[keep != 0]
    if keep.size == 0:
        return np.zeros_like(mask, dtype=bool)
    return np.isin(lab, keep)


def mm_to_vox_z(mm: float, spacing_mm: tuple[float, float, float]) -> int:
    s = max(0.2, spacing_mm[2])
    return max(1, int(round(mm / s)))


def mm_to_vox_xy(mm: float, spacing_mm: tuple[float, float, float]) -> int:
    s = max(0.2, min(spacing_mm[0], spacing_mm[1]))
    return max(1, int(round(mm / s)))


def smooth_binary(mask: np.ndarray, spacing_mm: tuple[float, float, float], sigma_mm: float) -> np.ndarray:
    if not mask.any():
        return mask
    dt_in = ndimage.distance_transform_edt(mask, sampling=spacing_mm)
    dt_out = ndimage.distance_transform_edt(~mask, sampling=spacing_mm)
    sdf = dt_in - dt_out
    sig = [max(0.2, sigma_mm / max(0.2, s)) for s in spacing_mm]
    sdf_s = ndimage.gaussian_filter(sdf, sigma=sig)
    return sdf_s > 0


def build_area_profile(mask: np.ndarray) -> np.ndarray:
    return mask.reshape((-1, mask.shape[2])).sum(axis=0).astype(np.float32)


def axis_slice_centroid(mask2d: np.ndarray) -> tuple[float, float] | None:
    pts = np.argwhere(mask2d)
    if pts.size == 0:
        return None
    cx, cy = pts.mean(axis=0)
    return float(cx), float(cy)


def pick_seed(aorta: np.ndarray, heart: np.ndarray, spacing: tuple[float, float, float]) -> tuple[int, tuple[float, float]]:
    contact = aorta & ndimage.binary_dilation(heart, iterations=mm_to_vox_xy(2.4, spacing))
    if contact.any():
        z = int(np.median(np.where(contact)[2]))
        c = axis_slice_centroid(contact[:, :, z])
        if c is None:
            c = axis_slice_centroid(aorta[:, :, z]) or (aorta.shape[0] / 2.0, aorta.shape[1] / 2.0)
        return z, c

    overlap = np.zeros(aorta.shape[2], dtype=np.int32)
    heart_d = ndimage.binary_dilation(heart, iterations=mm_to_vox_xy(3.0, spacing))
    for z in range(aorta.shape[2]):
        overlap[z] = int((aorta[:, :, z] & heart_d[:, :, z]).sum())
    z = int(np.argmax(overlap))
    c = axis_slice_centroid(aorta[:, :, z]) or (aorta.shape[0] / 2.0, aorta.shape[1] / 2.0)
    return z, c


def track_component_along_z(
    aorta: np.ndarray,
    seed_z: int,
    seed_xy: tuple[float, float],
    direction: int,
    spacing: tuple[float, float, float],
) -> np.ndarray:
    nz = aorta.shape[2]
    out = np.zeros_like(aorta, dtype=bool)
    z = int(seed_z)
    prev_xy = np.array(seed_xy, dtype=np.float32)
    prev_area = float(max(1, int(aorta[:, :, z].sum())))
    max_jump = float(mm_to_vox_xy(18.0, spacing))
    max_gap = 4
    gap = 0

    while 0 <= z < nz:
        sl = aorta[:, :, z]
        if not sl.any():
            gap += 1
            if gap > max_gap:
                break
            z += direction
            continue

        lab, num = ndimage.label(sl)
        if num == 0:
            gap += 1
            if gap > max_gap:
                break
            z += direction
            continue

        best_score = None
        best_id = None
        best_xy = None
        best_area = None
        for cid in range(1, num + 1):
            pts = np.argwhere(lab == cid)
            if pts.size == 0:
                continue
            area = float(pts.shape[0])
            cur_xy = pts.mean(axis=0).astype(np.float32)
            dist = float(np.linalg.norm(cur_xy - prev_xy))
            area_penalty = abs(np.log(max(1.0, area) / max(1.0, prev_area)))
            score = dist + 4.0 * area_penalty
            if best_score is None or score < best_score:
                best_score = score
                best_id = cid
                best_xy = cur_xy
                best_area = area

        if best_id is None:
            gap += 1
            if gap > max_gap:
                break
            z += direction
            continue

        if best_score is not None and best_score > max_jump and np.count_nonzero(out) > 0:
            gap += 1
            if gap > max_gap:
                break
            z += direction
            continue

        gap = 0
        out[:, :, z] = lab == best_id
        prev_xy = best_xy if best_xy is not None else prev_xy
        prev_area = float(best_area if best_area is not None else prev_area)
        z += direction

    return out


def first_branch_slice(
    tube: np.ndarray,
    branch: np.ndarray,
    seed_z: int,
    direction: int,
    spacing: tuple[float, float, float],
) -> int | None:
    if not branch.any():
        return None
    branch_d = ndimage.binary_dilation(branch, iterations=mm_to_vox_xy(2.0, spacing))
    z_idx = np.where((tube & branch_d).any(axis=(0, 1)))[0]
    if z_idx.size == 0:
        return None
    if direction > 0:
        z_idx = z_idx[z_idx >= seed_z]
        if z_idx.size == 0:
            return None
        return int(z_idx.min())
    z_idx = z_idx[z_idx <= seed_z]
    if z_idx.size == 0:
        return None
    return int(z_idx.max())


def directional_mm_from_seed(z: int, seed_z: int, direction: int, spacing: tuple[float, float, float]) -> float:
    return float((z - seed_z) * direction * spacing[2])


def z_select_by_direction(seed_z: int, direction: int, z_values: np.ndarray) -> np.ndarray:
    if direction > 0:
        return z_values[z_values >= seed_z]
    return z_values[z_values <= seed_z]


def radial_gate(mask: np.ndarray, z_indices: np.ndarray, r_min: float, r_max: float) -> np.ndarray:
    out = np.zeros_like(mask, dtype=bool)
    for z in z_indices:
        sl = mask[:, :, z]
        pts = np.argwhere(sl)
        if pts.shape[0] < 16:
            continue
        c = pts.mean(axis=0)
        area = float(pts.shape[0])
        r_eq = np.sqrt(area / np.pi)
        if r_eq < 2:
            continue
        xs = pts[:, 0].astype(np.float32)
        ys = pts[:, 1].astype(np.float32)
        r = np.sqrt((xs - c[0]) ** 2 + (ys - c[1]) ** 2)
        keep = (r >= r_min * r_eq) & (r <= r_max * r_eq)
        if keep.any():
            use = pts[keep]
            out[use[:, 0], use[:, 1], z] = True
    return out


def fallback_split_aorta_by_axis(
    aorta: np.ndarray,
    seed_z: int,
    direction: int,
    spacing: tuple[float, float, float],
) -> tuple[np.ndarray, np.ndarray]:
    tube = keep_top_components(aorta, top_k=1)
    root = np.zeros_like(aorta, dtype=bool)
    ascending = np.zeros_like(aorta, dtype=bool)
    z_values = np.where(tube.any(axis=(0, 1)))[0]
    if z_values.size == 0:
        return root, ascending

    z_min = int(z_values.min())
    z_max = int(z_values.max())
    anchor = int(np.clip(seed_z, z_min, z_max))
    root_span = mm_to_vox_z(45.0, spacing)
    asc_span = mm_to_vox_z(120.0, spacing)

    if direction >= 0:
        root_start = max(z_min, anchor - mm_to_vox_z(8.0, spacing))
        root_end = min(z_max, root_start + root_span)
        asc_start = min(z_max, root_end + 1)
        asc_end = min(z_max, asc_start + asc_span)
    else:
        root_end = min(z_max, anchor + mm_to_vox_z(8.0, spacing))
        root_start = max(z_min, root_end - root_span)
        asc_end = max(z_min, root_start - 1)
        asc_start = max(z_min, asc_end - asc_span)

    lo, hi = sorted((root_start, root_end))
    root[:, :, lo : hi + 1] = tube[:, :, lo : hi + 1]
    lo, hi = sorted((asc_start, asc_end))
    ascending[:, :, lo : hi + 1] = tube[:, :, lo : hi + 1]
    return root & aorta, ascending & aorta


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="Input CTA NIfTI (.nii/.nii.gz)")
    ap.add_argument("--output", required=True, help="Output multiclass mask (.nii.gz)")
    ap.add_argument("--meta", required=False, help="Optional output json metadata")
    ap.add_argument("--device", default="cpu", choices=["cpu", "gpu", "mps"])
    ap.add_argument("--quality", default="high", choices=["high", "fast"], help="high=better quality, fast=lower runtime")
    args = ap.parse_args()

    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    ct_nii = nib.load(str(input_path))
    ct = ct_nii.get_fdata().astype(np.float32)

    totalseg_bin = os.getenv("TOTALSEG_BIN") or str(Path(sys.executable).with_name("TotalSegmentator"))
    # On Windows, executables have .exe suffix
    if not Path(totalseg_bin).exists() and sys.platform == "win32":
        totalseg_bin_exe = totalseg_bin + ".exe"
        if Path(totalseg_bin_exe).exists():
            totalseg_bin = totalseg_bin_exe
    if not Path(totalseg_bin).exists():
        found = shutil.which("TotalSegmentator")
        if found:
            totalseg_bin = found
    if not Path(totalseg_bin).exists():
        raise FileNotFoundError(
            f"TotalSegmentator binary not found. Checked: {totalseg_bin}. "
            "Set TOTALSEG_BIN explicitly if needed."
        )

    with tempfile.TemporaryDirectory(prefix="aortic-real-mask-") as td:
        td_path = Path(td)
        seg_dir = td_path / "ts_total_open"
        seg_dir.mkdir(parents=True, exist_ok=True)

        # quality=fast uses 3mm resampling (quick, lower accuracy).
        # quality=high uses full-resolution model (better aortic root segmentation).
        # RTX 5060 has sufficient VRAM for the full model.
        if args.quality == "fast":
            common_flags: list[str] = ["--fast"]
        else:
            common_flags = ["--robust_crop", "--higher_order_resampling"]

        # Open-only task: no license required.
        totalseg_cmd_base = [
            totalseg_bin,
            "-i",
            str(input_path),
            "-o",
            str(seg_dir),
            "--task",
            "total",
            "--roi_subset",
            "aorta",
            "heart",
            "brachiocephalic_trunk",
            "common_carotid_artery_right",
            "common_carotid_artery_left",
            "subclavian_artery_right",
            "subclavian_artery_left",
            *common_flags,
        ]
        if args.device == "gpu":
            totalseg_cmd_gpu = [*totalseg_cmd_base, "--device", "gpu"]
            totalseg_cmd_cpu = [*totalseg_cmd_base, "--device", "cpu"]
            _run_totalsegmentator(totalseg_cmd_gpu, totalseg_cmd_cpu)
        else:
            totalseg_cmd = [*totalseg_cmd_base, "--device", args.device]
            _progress("totalsegmentator", f"cmd={' '.join(str(part) for part in totalseg_cmd)}")
            run_cmd(totalseg_cmd)

        aorta_nii = nib.load(str(seg_dir / "aorta.nii.gz"))
        aorta = aorta_nii.get_fdata() > 0.5
        spacing = tuple(float(x) for x in aorta_nii.header.get_zooms()[:3])
        shape = tuple(int(v) for v in aorta.shape)

        heart = load_mask_optional(seg_dir / "heart.nii.gz", shape)
        branch = (
            load_mask_optional(seg_dir / "brachiocephalic_trunk.nii.gz", shape)
            | load_mask_optional(seg_dir / "common_carotid_artery_right.nii.gz", shape)
            | load_mask_optional(seg_dir / "common_carotid_artery_left.nii.gz", shape)
            | load_mask_optional(seg_dir / "subclavian_artery_right.nii.gz", shape)
            | load_mask_optional(seg_dir / "subclavian_artery_left.nii.gz", shape)
        )

        aorta = keep_top_components(aorta, top_k=1)
        if not aorta.any():
            raise RuntimeError("aorta segmentation is empty")

        seed_z, seed_xy = pick_seed(aorta, heart, spacing)
        seed_z = int(np.clip(seed_z, 0, aorta.shape[2] - 1))

        tube_pos = track_component_along_z(aorta, seed_z, seed_xy, +1, spacing)
        tube_neg = track_component_along_z(aorta, seed_z, seed_xy, -1, spacing)
        branch_d = ndimage.binary_dilation(branch, iterations=mm_to_vox_xy(2.2, spacing))
        score_pos = int((tube_pos & branch_d).sum())
        score_neg = int((tube_neg & branch_d).sum())

        if score_pos > score_neg:
            asc_tube = tube_pos
            prox_tube = tube_neg
            direction = +1
        elif score_neg > score_pos:
            asc_tube = tube_neg
            prox_tube = tube_pos
            direction = -1
        else:
            if int(tube_pos.sum()) >= int(tube_neg.sum()):
                asc_tube = tube_pos
                prox_tube = tube_neg
                direction = +1
            else:
                asc_tube = tube_neg
                prox_tube = tube_pos
                direction = -1

        area = build_area_profile(asc_tube)
        smooth_area = ndimage.gaussian_filter1d(area, sigma=1.8)
        z_all = np.where(area > 0)[0]
        z_dir = z_select_by_direction(seed_z, direction, z_all)
        if z_dir.size == 0:
            z_dir = np.array([seed_z], dtype=np.int32)

        z_stj = None
        best_val = None
        for z in z_dir:
            dmm = directional_mm_from_seed(int(z), seed_z, direction, spacing)
            if 8.0 <= dmm <= 60.0:
                v = float(smooth_area[z])
                if best_val is None or v < best_val:
                    best_val = v
                    z_stj = int(z)

        if z_stj is None:
            target_mm = 18.0
            z_stj = int(np.clip(seed_z + direction * mm_to_vox_z(target_mm, spacing), 0, aorta.shape[2] - 1))

        z_branch = first_branch_slice(asc_tube, branch, seed_z, direction, spacing)
        if z_branch is not None:
            z_end = int(np.clip(z_branch - direction * mm_to_vox_z(3.0, spacing), 0, aorta.shape[2] - 1))
        else:
            z_end = int(np.clip(seed_z + direction * mm_to_vox_z(120.0, spacing), 0, aorta.shape[2] - 1))

        root = np.zeros_like(aorta, dtype=bool)
        ascending = np.zeros_like(aorta, dtype=bool)
        nz = aorta.shape[2]
        for z in range(nz):
            dmm = directional_mm_from_seed(z, seed_z, direction, spacing)
            if (asc_tube[:, :, z]).any():
                if dmm <= directional_mm_from_seed(z_stj, seed_z, direction, spacing):
                    root[:, :, z] |= asc_tube[:, :, z]
                if directional_mm_from_seed(z_stj, seed_z, direction, spacing) < dmm <= directional_mm_from_seed(z_end, seed_z, direction, spacing):
                    ascending[:, :, z] |= asc_tube[:, :, z]
            if dmm < 0 and abs(dmm) <= 4.0 and (prox_tube[:, :, z]).any():
                root[:, :, z] |= prox_tube[:, :, z]

        root &= aorta
        ascending &= aorta

        if not ascending.any():
            for z in range(nz):
                dmm = directional_mm_from_seed(z, seed_z, direction, spacing)
                if 18.0 <= dmm <= 120.0 and (asc_tube[:, :, z]).any():
                    ascending[:, :, z] = asc_tube[:, :, z]
            ascending &= aorta

        split_fallback_used = False
        if not root.any() or not ascending.any():
            root, ascending = fallback_split_aorta_by_axis(aorta, seed_z, direction, spacing)
            split_fallback_used = True

        # CTA-derived leaflet proxy in annulus/root band.
        leaflets = np.zeros_like(aorta, dtype=bool)
        if root.any():
            dist_in = ndimage.distance_transform_edt(aorta, sampling=spacing)
            root_area = build_area_profile(root)
            z_root = np.where(root_area > 0)[0]
            z_band = []
            stj_mm = directional_mm_from_seed(z_stj, seed_z, direction, spacing)
            hi_mm = min(18.0, max(10.0, stj_mm + 2.0))
            for z in z_root:
                dmm = directional_mm_from_seed(int(z), seed_z, direction, spacing)
                if -2.0 <= dmm <= hi_mm:
                    z_band.append(int(z))
            z_band = np.array(z_band, dtype=np.int32)

            if z_band.size > 0:
                band = np.zeros_like(aorta, dtype=bool)
                band[:, :, z_band] = True
                band &= root

                core = band & (dist_in >= 2.2)
                blood_pool = core & (ct > 120.0)
                if np.any(blood_pool):
                    blood_median = float(np.median(ct[blood_pool]))
                else:
                    blood_median = float(np.percentile(ct[band], 70)) if np.any(band) else 280.0

                soft_low = max(-150.0, blood_median - 260.0)
                soft_high = blood_median - 35.0

                gx = ndimage.sobel(ct, axis=0)
                gy = ndimage.sobel(ct, axis=1)
                gz = ndimage.sobel(ct, axis=2)
                grad = np.sqrt(gx * gx + gy * gy + gz * gz)
                g_thr = float(np.percentile(grad[band], 78)) if np.any(band) else float(np.percentile(grad, 95))

                shell = band & (dist_in >= 0.6) & (dist_in <= 4.2)
                radial = radial_gate(root, z_band, r_min=0.18, r_max=0.94)
                soft = (ct >= soft_low) & (ct <= soft_high)
                calc = ct >= 500.0
                edge = grad >= g_thr

                leaflets = shell & radial & (soft | calc | edge)
                leaflets = ndimage.binary_closing(leaflets, iterations=1)
                leaflets = ndimage.binary_opening(leaflets, iterations=1)

                min_vox = int(round(4.0 / max(0.1, spacing[0] * spacing[1] * spacing[2])))
                leaflets = drop_small_components(leaflets, min_vox=min_vox)
                if leaflets.any():
                    leaflets = keep_top_components(leaflets, top_k=6)

        if not leaflets.any():
            # Fallback: annulus-centered thin leaflet ring proxy.
            z_l_lo = int(np.clip(seed_z - direction * mm_to_vox_z(2.0, spacing), 0, nz - 1))
            z_l_hi = int(np.clip(seed_z + direction * mm_to_vox_z(12.0, spacing), 0, nz - 1))
            lo, hi = sorted((z_l_lo, z_l_hi))
            band = np.zeros_like(aorta, dtype=bool)
            band[:, :, lo : hi + 1] = True
            dist_in = ndimage.distance_transform_edt(aorta, sampling=spacing)
            leaflets = band & root & (dist_in >= 0.8) & (dist_in <= 3.6)
            leaflets = keep_top_components(leaflets, top_k=3)

        root = smooth_binary(root, spacing, sigma_mm=0.55) & aorta
        ascending = smooth_binary(ascending, spacing, sigma_mm=0.55) & aorta
        leaflets = smooth_binary(leaflets, spacing, sigma_mm=0.35) & root

        root = keep_top_components(root, top_k=1)
        ascending = keep_top_components(ascending, top_k=1)
        leaflets = keep_top_components(leaflets, top_k=6)

        out = np.zeros(aorta.shape, dtype=np.uint8)
        out[root] = 1
        out[ascending] = 3
        out[leaflets] = 2

        out[(out == 1) & (~aorta)] = 0
        out[(out == 3) & (~aorta)] = 0

        label_counts = {
            "root": int((out == 1).sum()),
            "leaflets": int((out == 2).sum()),
            "ascending": int((out == 3).sum()),
        }
        if label_counts["root"] <= 0 or label_counts["ascending"] <= 0:
            raise RuntimeError(
                "aortic_multiclass_required_labels_empty: "
                f"root={label_counts['root']} ascending={label_counts['ascending']} "
                f"leaflets={label_counts['leaflets']}"
            )

        out_nii = nib.Nifti1Image(out.astype(np.uint8), aorta_nii.affine, aorta_nii.header)
        out_nii.header.set_data_dtype(np.uint8)
        nib.save(out_nii, str(output_path))
        print(f"[ok] wrote {output_path}")

        if args.meta:
            meta = {
                "input": str(input_path),
                "output": str(output_path),
                "spacing_mm": spacing,
                "quality": args.quality,
                "seed_z": int(seed_z),
                "stj_z": int(z_stj),
                "asc_end_z": int(z_end),
                "direction": int(direction),
                "split_fallback_used": bool(split_fallback_used),
                "voxels": label_counts,
                "model_stack": [
                    "TotalSegmentator task=total (open) with ROI subset [aorta, heart, arch branches]",
                    "Centerline-tracked proximal aorta split for root/STJ/ascending separation",
                    "CTA intensity+gradient+radial-gated leaflet proxy refinement in annulus/root band",
                    "Signed-distance smoothing for sub-voxel contour refinement",
                ],
                "evidence_hint": [
                    "Centerline-orthogonal and annulus-based planning principle in SCCT/TAVI CT guidance",
                    "Open model provenance from TotalSegmentator (Radiology AI 2023)",
                ],
                "note": "Leaflet class is CTA-derived proxy without commercial cusp model; use for research/planning assistance, not standalone diagnosis.",
            }
            Path(args.meta).write_text(json.dumps(meta, indent=2), encoding="utf-8")
            print(f"[ok] wrote {args.meta}")


if __name__ == "__main__":
    main()
