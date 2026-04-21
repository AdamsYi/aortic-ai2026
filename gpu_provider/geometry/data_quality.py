"""Clinical data-quality gate for source CTAs (Python mirror).

Must stay in lockstep with:
  services/api/contracts.ts   → shared gate thresholds
  schemas/case_manifest.json  → study_meta + data_quality

Dual-sided gate constants mirrored in TypeScript:
  MAX_SLICE_THICKNESS_MM
  MIN_CONTRAST_BLOOD_POOL_HU
  MAX_CONTRAST_BLOOD_POOL_HU
  ACCEPTED_CONTRAST_PHASES
  TAVI_ROOT_COVERAGE_MIN_Z_MM
  VSRR_ROOT_COVERAGE_MIN_Z_MM
  PEARS_COVERAGE_MIN_Z_MM
  ILIOFEMORAL_COVERAGE_MIN_Z_MM

Source of thresholds: SCCT 2021 Expert Consensus on CT for TAVR
(Blanke et al., J Cardiovasc Comput Tomogr 2019;13:1-20).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Tuple

try:
    import nibabel as nib
    import numpy as np
except ImportError:  # pragma: no cover
    nib = None  # type: ignore
    np = None  # type: ignore


# ── Thresholds (shared gate constants + coverage derivation) ────────────────
MAX_SLICE_THICKNESS_MM = 1.0
MIN_CONTRAST_BLOOD_POOL_HU = 300.0
MAX_CONTRAST_BLOOD_POOL_HU = 600.0
ACCEPTED_CONTRAST_PHASES = ("arterial", "cardiac")
TAVI_ROOT_COVERAGE_MIN_Z_MM = 80.0
VSRR_ROOT_COVERAGE_MIN_Z_MM = 150.0
PEARS_COVERAGE_MIN_Z_MM = 200.0
ILIOFEMORAL_COVERAGE_MIN_Z_MM = 280.0


@dataclass
class StudyMeta:
    slice_thickness_mm: Optional[float]
    voxel_spacing_mm: Optional[Tuple[float, float, float]]
    is_tavi_root_covered: Optional[bool]
    is_vsrr_root_covered: Optional[bool]
    is_pears_covered: Optional[bool]
    is_iliofemoral_covered: Optional[bool]
    is_cropped: Optional[bool]
    contrast_phase: Optional[str]
    fov_mm: Optional[Tuple[float, float, float]]
    blood_pool_hu_mean: Optional[float]

    def to_manifest_dict(self) -> dict:
        return {
            "slice_thickness_mm": self.slice_thickness_mm,
            "voxel_spacing_mm": list(self.voxel_spacing_mm) if self.voxel_spacing_mm else None,
            "is_tavi_root_covered": self.is_tavi_root_covered,
            "is_vsrr_root_covered": self.is_vsrr_root_covered,
            "is_pears_covered": self.is_pears_covered,
            "is_root_covered": self.is_vsrr_root_covered,
            "is_iliofemoral_covered": self.is_iliofemoral_covered,
            "is_cropped": self.is_cropped,
            "contrast_phase": self.contrast_phase,
            "fov_mm": list(self.fov_mm) if self.fov_mm else None,
            "blood_pool_hu_mean": self.blood_pool_hu_mean,
        }


@dataclass
class DataQualityGate:
    passes_sizing_gate: bool
    allowed_procedures: List[str] = field(default_factory=list)
    failure_reasons: List[str] = field(default_factory=list)
    advisories: List[str] = field(default_factory=list)

    def to_manifest_dict(self) -> dict:
        return {
            "passes_sizing_gate": self.passes_sizing_gate,
            "allowed_procedures": list(self.allowed_procedures),
            "failure_reasons": list(self.failure_reasons),
            "advisories": list(self.advisories),
        }


def estimate_blood_pool_hu(ct_data, mask_data=None) -> Optional[float]:
    """Estimate mean HU of the blood pool.

    If a label mask is provided, use voxels where label > 0 AND HU in [0, 600]
    (filters mineralized calcium / metal). Otherwise fall back to a central
    ellipsoidal sample in the HU range [50, 500] which typically catches the
    blood pool without including soft tissue or bone.
    """
    if np is None:
        return None
    arr = np.asarray(ct_data)

    def central_sample_hu() -> Optional[float]:
        shape = arr.shape
        cz, cy, cx = [s // 2 for s in shape]
        rz, ry, rx = [max(4, s // 6) for s in shape]
        sample = arr[cz - rz : cz + rz, cy - ry : cy + ry, cx - rx : cx + rx]
        sample = sample[(sample > 50) & (sample < 500)]
        if sample.size < 1000:
            return None
        return float(np.mean(sample))

    if mask_data is not None:
        m = np.asarray(mask_data) > 0
        if float(np.mean(m)) < 0.005:
            return central_sample_hu()
        hu = arr[m]
        hu = hu[(hu >= 0) & (hu <= 600)]
        if hu.size < 1000:
            return central_sample_hu()
        return float(np.mean(hu))
    return central_sample_hu()


def extract_study_meta(
    ct_path: Path,
    mask_path: Optional[Path] = None,
    contrast_phase_hint: Optional[str] = None,
) -> StudyMeta:
    """Read a NIfTI CT and derive study_meta fields."""
    if nib is None:
        raise RuntimeError("nibabel not installed")

    img = nib.load(str(ct_path))
    zooms = img.header.get_zooms()
    # Accept 3D or 4D; we only care about spatial zooms[:3]
    spacing = tuple(float(z) for z in zooms[:3])
    shape = tuple(int(s) for s in img.shape[:3])
    fov = (spacing[0] * shape[0], spacing[1] * shape[1], spacing[2] * shape[2])
    slice_thickness = float(zooms[2])

    ct_data = img.get_fdata()
    mask_data = None
    if mask_path is not None and mask_path.exists():
        mask_data = nib.load(str(mask_path)).get_fdata()
    blood_hu = estimate_blood_pool_hu(ct_data, mask_data)

    # Heuristic contrast phase classification
    phase: Optional[str] = contrast_phase_hint
    if phase is None:
        if blood_hu is None:
            phase = "unknown"
        elif blood_hu >= MIN_CONTRAST_BLOOD_POOL_HU:
            phase = "arterial"
        elif blood_hu >= 150:
            phase = "venous"
        else:
            phase = "non_contrast"

    is_tavi_root_covered = bool(fov[2] >= TAVI_ROOT_COVERAGE_MIN_Z_MM)
    is_vsrr_root_covered = bool(fov[2] >= VSRR_ROOT_COVERAGE_MIN_Z_MM)
    is_pears_covered = bool(fov[2] >= PEARS_COVERAGE_MIN_Z_MM)
    is_iliofemoral_covered = bool(fov[2] >= ILIOFEMORAL_COVERAGE_MIN_Z_MM)

    return StudyMeta(
        slice_thickness_mm=slice_thickness,
        voxel_spacing_mm=spacing,
        is_tavi_root_covered=is_tavi_root_covered,
        is_vsrr_root_covered=is_vsrr_root_covered,
        is_pears_covered=is_pears_covered,
        is_iliofemoral_covered=is_iliofemoral_covered,
        is_cropped=(not is_iliofemoral_covered),
        contrast_phase=phase,
        fov_mm=fov,
        blood_pool_hu_mean=blood_hu,
    )


def evaluate_gate(meta: StudyMeta) -> DataQualityGate:
    """Run SCCT 2021 data-quality gate on a StudyMeta."""
    reasons: List[str] = []
    advisories: List[str] = []
    allowed_procedures: List[str] = []

    if meta.slice_thickness_mm is None:
        reasons.append("slice_thickness_unknown")
    elif meta.slice_thickness_mm > MAX_SLICE_THICKNESS_MM:
        reasons.append(
            f"slice_thickness_exceeds_{MAX_SLICE_THICKNESS_MM}mm_scct2021"
        )

    if meta.contrast_phase not in ACCEPTED_CONTRAST_PHASES:
        reasons.append(
            f"contrast_phase_not_in_{'|'.join(ACCEPTED_CONTRAST_PHASES)}"
        )

    if meta.blood_pool_hu_mean is None:
        advisories.append("blood_pool_hu_unmeasured")
    elif meta.blood_pool_hu_mean < MIN_CONTRAST_BLOOD_POOL_HU:
        reasons.append(
            f"blood_pool_hu_below_{MIN_CONTRAST_BLOOD_POOL_HU:.0f}_scct2021"
        )
    elif meta.blood_pool_hu_mean > MAX_CONTRAST_BLOOD_POOL_HU:
        advisories.append(
            f"blood_pool_hu_above_{MAX_CONTRAST_BLOOD_POOL_HU:.0f}_possible_hyperenhancement"
        )

    has_global_hard_failure = len(reasons) > 0

    procedure_coverage = (
        ("TAVI", meta.is_tavi_root_covered, "tavi_root_coverage_below_80mm"),
        ("VSRR", meta.is_vsrr_root_covered, "vsrr_root_coverage_below_150mm"),
        ("PEARS", meta.is_pears_covered, "pears_coverage_below_200mm"),
    )
    for procedure, covered, failure_reason in procedure_coverage:
        if covered is False:
            reasons.append(failure_reason)
            continue
        if covered is True and not has_global_hard_failure:
            allowed_procedures.append(procedure)

    if meta.is_iliofemoral_covered is False:
        advisories.append("iliofemoral_access_not_assessable_plan_separately")

    return DataQualityGate(
        passes_sizing_gate=len(allowed_procedures) > 0,
        allowed_procedures=allowed_procedures,
        failure_reasons=reasons,
        advisories=advisories,
    )


__all__ = [
    "MAX_SLICE_THICKNESS_MM",
    "MIN_CONTRAST_BLOOD_POOL_HU",
    "MAX_CONTRAST_BLOOD_POOL_HU",
    "ACCEPTED_CONTRAST_PHASES",
    "TAVI_ROOT_COVERAGE_MIN_Z_MM",
    "VSRR_ROOT_COVERAGE_MIN_Z_MM",
    "PEARS_COVERAGE_MIN_Z_MM",
    "ILIOFEMORAL_COVERAGE_MIN_Z_MM",
    "StudyMeta",
    "DataQualityGate",
    "estimate_blood_pool_hu",
    "extract_study_meta",
    "evaluate_gate",
]
