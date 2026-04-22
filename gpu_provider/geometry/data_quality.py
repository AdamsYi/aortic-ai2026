"""Clinical data-quality gate for source CTAs (Python mirror).

Must stay in lockstep with:
  services/api/contracts.ts   → shared gate thresholds
  schemas/case_manifest.json  → study_meta + data_quality
  IMAGING_CONSTANTS.md        → per-procedure threshold summary

Dual-sided gate constants mirrored in TypeScript:
  MAX_SLICE_THICKNESS_MM
  MIN_CONTRAST_BLOOD_POOL_HU
  MAX_CONTRAST_BLOOD_POOL_HU
  ACCEPTED_CONTRAST_PHASES
  TAVI_ROOT_COVERAGE_MIN_Z_MM
  VSRR_ROOT_COVERAGE_MIN_Z_MM
  PEARS_COVERAGE_MIN_Z_MM
  ILIOFEMORAL_COVERAGE_MIN_Z_MM

Source of thresholds: SCCT 2019 Expert Consensus on CT for TAVR
(Blanke et al., J Cardiovasc Comput Tomogr 2019;13:1-20).

@deprecated: These are legacy combined thresholds that mix procedures.
Authoritative per-procedure thresholds live in IMAGING_CONSTANTS.md
and docs/imaging/{pears,tavi,vsrr}.md. This module is the target of
P0 #1 rewrite (per-procedure constants + phase + ECG-gating fields).
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


# ── Thresholds: Per-procedure constants (P0 #1 rewrite, 2026-04-22) ─────────
# Source docs: docs/imaging/{pears,tavi,vsrr}.md
# Lockstep: services/api/contracts.ts DATA_QUALITY_THRESHOLDS

# === SHARED (all procedures) ===
MAX_CONTRAST_BLOOD_POOL_HU = 600.0  # Internal heuristic; not guideline-sourced

# === PEARS — Exstent EXWI01-02 (2018) ===
# Strictest of the three procedures; external 3D-printed sleeve manufacturing
PEARS_MAX_SLICE_THICKNESS_MM = 0.75  # Exstent §3 (stricter than TAVI/VSRR)
PEARS_COVERAGE_MIN_Z_MM = 120.0  # Exstent §4: LVOT-20mm → brachiocephalic+20mm (~100-140mm)
PEARS_MIN_CONTRAST_BLOOD_POOL_HU = 250.0  # Proxy: SCCT 2019 line 160 (Exstent publishes no number)
PEARS_REQUIRES_ECG_GATING = True  # Exstent §2
PEARS_REQUIRED_PHASE = "diastole"  # Exstent §2: 60-80% R-R (opposite of TAVI!)
PEARS_REJECT_IF_STITCHED = True  # Exstent §5: single-unit reconstruction required
PEARS_ISOTROPIC_VOXEL_REQUIRED = True  # Exstent §3

# === TAVI — SCCT 2019 (Blanke et al., JCCT 13:1-20) ===
# Two-block acquisition: cardiac (gated) + peripheral (non-gated)
TAVI_ROOT_MAX_SLICE_THICKNESS_MM = 1.0  # SCCT Table 5 line 298
TAVI_PERIPHERAL_MAX_SLICE_THICKNESS_MM = 1.5  # SCCT Table 5 line 272
TAVI_ROOT_COVERAGE_MIN_Z_MM = 130.0  # SCCT Table 5 line 293: root + arch (was 80mm, non-compliant)
TAVI_PERIPHERAL_COVERAGE_MIN_Z_MM = 350.0  # SCCT lines 164-167: to lesser trochanter (was 280mm)
TAVI_MIN_CONTRAST_BLOOD_POOL_HU = 250.0  # SCCT line 160 (was 300HU, too strict)
TAVI_PREFERRED_CONTRAST_BLOOD_POOL_HU = 350.0  # Soft target; 250-350 = marginal warn
TAVI_ROOT_REQUIRES_ECG_GATING = True  # SCCT Table 5
TAVI_PERIPHERAL_REQUIRES_ECG_GATING = False  # SCCT Table 5
TAVI_REQUIRED_PHASE = "systole"  # SCCT Table 6 line 563: 30-40% R-R for sizing

# === VSRR — Bissell 2016 RadioGraphics + Kim 2020 KJR ===
# No society consensus; institutional protocols only
VSRR_MAX_SLICE_THICKNESS_MM = 1.0  # Inferred from SCCT 2019 TAVI root (proxy)
VSRR_COVERAGE_MIN_Z_MM = 130.0  # Anatomical: annulus → brachiocephalic (was 150mm, no source)
VSRR_MIN_CONTRAST_BLOOD_POOL_HU = 250.0  # Proxy: SCCT 2019 (no VSRR-specific number)
VSRR_REQUIRES_ECG_GATING = True  # Bissell 2016; Kim 2020
VSRR_REQUIRED_PHASE = "multi_phase"  # Bissell 2016: systole + diastole required (strict!)
VSRR_RR_RECONSTRUCTION_INTERVAL_PCT = 10  # Kim 2020: 10% R-R intervals

# === ILIOFEMORAL (TAVI peripheral access) ===
ILIOFEMORAL_COVERAGE_MIN_Z_MM = 350.0  # SCCT lines 164-167: lesser trochanter


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
    cardiac_phase: Optional[str]  # "systole" | "diastole" | "multi_phase" | "unknown"
    is_ecg_gated: Optional[bool]  # True if retrospective ECG-gating detected
    fov_mm: Optional[Tuple[float, float, float]]
    blood_pool_hu_mean: Optional[float]
    blood_pool_hu_source: Optional[str]

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
            "cardiac_phase": self.cardiac_phase,
            "is_ecg_gated": self.is_ecg_gated,
            "fov_mm": list(self.fov_mm) if self.fov_mm else None,
            "blood_pool_hu_mean": self.blood_pool_hu_mean,
            "blood_pool_hu_source": self.blood_pool_hu_source,
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


def estimate_blood_pool_hu(
    ct_data,
    mask_data=None,
    label_semantics: Optional[str] = None,
) -> Tuple[Optional[float], str]:
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

    if label_semantics in {"coronary_tree", "none"}:
        return central_sample_hu(), "central-by-design"

    if mask_data is not None:
        m = np.asarray(mask_data) > 0
        if float(np.mean(m)) < 0.005:
            return central_sample_hu(), "central-fallback"
        hu = arr[m]
        hu = hu[(hu >= 0) & (hu <= 600)]
        if hu.size < 1000:
            return central_sample_hu(), "central-fallback"
        return float(np.mean(hu)), "mask"
    return central_sample_hu(), "central-by-design"


def extract_study_meta(
    ct_path: Path,
    mask_path: Optional[Path] = None,
    contrast_phase_hint: Optional[str] = None,
    label_semantics: Optional[str] = None,
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
    blood_hu, blood_hu_source = estimate_blood_pool_hu(
        ct_data,
        mask_data,
        label_semantics=label_semantics,
    )

    # Heuristic contrast phase classification
    phase: Optional[str] = contrast_phase_hint
    if phase is None:
        if blood_hu is None:
            phase = "unknown"
        elif blood_hu >= PEARS_MIN_CONTRAST_BLOOD_POOL_HU:  # 250 HU
            phase = "arterial"
        elif blood_hu >= 150:
            phase = "venous"
        else:
            phase = "non_contrast"

    # Heuristic cardiac phase classification (systole/diastole/multi_phase)
    # Note: This requires DICOM (0018,0020) or (0020,0120) trigger time data
    # For now, we cannot reliably infer cardiac phase from HU alone
    # TODO: Parse DICOM tags for cardiac phase before ingest
    cardiac_phase: Optional[str] = None  # Unknown until DICOM metadata parsed

    # Heuristic ECG-gating detection (requires DICOM (0018,0091) or acquisition protocol)
    # For now, assume unknown until DICOM metadata parsed
    is_ecg_gated: Optional[bool] = None  # TODO: Parse DICOM (0018,0091) ReconstructionType

    is_tavi_root_covered = bool(fov[2] >= TAVI_ROOT_COVERAGE_MIN_Z_MM)
    is_vsrr_root_covered = bool(fov[2] >= VSRR_COVERAGE_MIN_Z_MM)
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
        cardiac_phase=cardiac_phase,
        is_ecg_gated=is_ecg_gated,
        fov_mm=fov,
        blood_pool_hu_mean=blood_hu,
        blood_pool_hu_source=blood_hu_source,
    )


def _check_slice_thickness(meta: StudyMeta, procedure: str) -> tuple[bool, str]:
    """Check slice thickness against procedure-specific threshold."""
    if meta.slice_thickness_mm is None:
        return False, "slice_thickness_unknown"

    if procedure == "PEARS":
        if meta.slice_thickness_mm > PEARS_MAX_SLICE_THICKNESS_MM:
            return False, f"slice_thickness_exceeds_{PEARS_MAX_SLICE_THICKNESS_MM}mm_exstent2018"
    elif procedure == "TAVI":
        if meta.slice_thickness_mm > TAVI_ROOT_MAX_SLICE_THICKNESS_MM:
            return False, f"slice_thickness_exceeds_{TAVI_ROOT_MAX_SLICE_THICKNESS_MM}mm_scct2019"
    elif procedure == "VSRR":
        if meta.slice_thickness_mm > VSRR_MAX_SLICE_THICKNESS_MM:
            return False, f"slice_thickness_exceeds_{VSRR_MAX_SLICE_THICKNESS_MM}mm_bissell2016"
    return True, ""


def _check_contrast_hu(meta: StudyMeta, procedure: str) -> tuple[bool, str, str]:
    """Check contrast HU against procedure-specific threshold.

    Returns: (passes, failure_reason, advisory)
    """
    if meta.blood_pool_hu_mean is None:
        return True, "", "blood_pool_hu_unmeasured"  # Advisory, not hard fail

    min_hu: float
    if procedure == "PEARS":
        min_hu = PEARS_MIN_CONTRAST_BLOOD_POOL_HU
    elif procedure == "TAVI":
        min_hu = TAVI_MIN_CONTRAST_BLOOD_POOL_HU
    elif procedure == "VSRR":
        min_hu = VSRR_MIN_CONTRAST_BLOOD_POOL_HU
    else:
        min_hu = 250.0  # Default fallback

    if meta.blood_pool_hu_mean < min_hu:
        return False, f"blood_pool_hu_below_{min_hu:.0f}hu", ""
    elif meta.blood_pool_hu_mean > MAX_CONTRAST_BLOOD_POOL_HU:
        return True, "", f"blood_pool_hu_above_{MAX_CONTRAST_BLOOD_POOL_HU:.0f}hu_possible_hyperenhancement"
    return True, "", ""


def _check_cardiac_phase(meta: StudyMeta, procedure: str) -> tuple[bool, str]:
    """Check cardiac phase against procedure-specific requirement.

    PEARS: diastole (60-80% R-R) — Exstent §2
    TAVI: systole (30-40% R-R) — SCCT 2019 Table 6
    VSRR: multi_phase (systole + diastole) — Bissell 2016; Kim 2020
    """
    if meta.cardiac_phase is None:
        return False, "cardiac_phase_unknown"

    required_phase: str
    if procedure == "PEARS":
        required_phase = PEARS_REQUIRED_PHASE  # "diastole"
    elif procedure == "TAVI":
        required_phase = TAVI_REQUIRED_PHASE  # "systole"
    elif procedure == "VSRR":
        required_phase = VSRR_REQUIRED_PHASE  # "multi_phase"
    else:
        return True, ""  # Unknown procedure, skip check

    if required_phase == "multi_phase":
        # Strict: only "multi_phase" passes
        if meta.cardiac_phase != "multi_phase":
            return False, f"single_phase_ct_insufficient_{procedure}_requires_multi_phase_bissell2016"
    elif meta.cardiac_phase != required_phase:
        return False, f"cardiac_phase_{meta.cardiac_phase}_incorrect_for_{procedure}_requires_{required_phase}"

    return True, ""


def _check_ecg_gating(meta: StudyMeta, procedure: str) -> tuple[bool, str]:
    """Check ECG-gating requirement against procedure-specific need."""
    requires_gating: bool
    if procedure == "PEARS":
        requires_gating = PEARS_REQUIRES_ECG_GATING
    elif procedure == "TAVI":
        requires_gating = TAVI_ROOT_REQUIRES_ECG_GATING
    elif procedure == "VSRR":
        requires_gating = VSRR_REQUIRES_ECG_GATING
    else:
        return True, ""

    if requires_gating and meta.is_ecg_gated is False:
        return False, f"ecg_gating_required_for_{procedure}"
    return True, ""


def _check_isotropic_voxel(meta: StudyMeta, procedure: str) -> tuple[bool, str]:
    """Check isotropic voxel requirement (PEARS-specific)."""
    if procedure != "PEARS" or not PEARS_ISOTROPIC_VOXEL_REQUIRED:
        return True, ""

    if meta.voxel_spacing_mm is None:
        return False, "voxel_spacing_unknown_cannot_verify_isotropic"

    spacing = meta.voxel_spacing_mm
    ratio = max(spacing) / min(spacing)
    if ratio > 1.2:  # Allow 20% tolerance
        return False, f"anisotropic_voxel_pears_requires_isotropic_exstent2018_ratio_{ratio:.2f}"
    return True, ""


def evaluate_gate(meta: StudyMeta) -> DataQualityGate:
    """Evaluate data quality gate per procedure (P0 #1 rewrite, 2026-04-22).

    Each procedure (PEARS / TAVI / VSRR) is evaluated independently against
    its own authoritative thresholds from docs/imaging/*.md.

    Gate structure:
    1. Global checks (apply to all): slice thickness, contrast HU
    2. Procedure-specific checks: cardiac phase, ECG-gating, isotropic voxel (PEARS)
    3. Coverage checks: Z-coverage per procedure
    4. Iliofemoral advisory (TAVI peripheral access)

    Returns: DataQualityGate with passes_sizing_gate=True if ANY procedure passes.
    """
    reasons: List[str] = []
    advisories: List[str] = []
    allowed_procedures: List[str] = []

    # === Global checks (all procedures) ===
    if meta.slice_thickness_mm is None:
        reasons.append("slice_thickness_unknown")

    if meta.blood_pool_hu_mean is None:
        advisories.append("blood_pool_hu_unmeasured")
    elif meta.blood_pool_hu_mean > MAX_CONTRAST_BLOOD_POOL_HU:
        advisories.append(f"blood_pool_hu_above_{MAX_CONTRAST_BLOOD_POOL_HU:.0f}hu_possible_hyperenhancement")

    # === Per-procedure evaluation ===
    procedures = ["PEARS", "TAVI", "VSRR"]

    for procedure in procedures:
        proc_reasons: List[str] = []
        proc_advisories: List[str] = []

        # 1. Slice thickness check
        passes, reason = _check_slice_thickness(meta, procedure)
        if not passes:
            proc_reasons.append(reason)

        # 2. Contrast HU check
        passes_hu, reason_hu, advisory_hu = _check_contrast_hu(meta, procedure)
        if not passes_hu:
            proc_reasons.append(reason_hu)
        if advisory_hu:
            proc_advisories.append(advisory_hu)

        # 3. Cardiac phase check (clinical safety critical)
        passes_phase, reason_phase = _check_cardiac_phase(meta, procedure)
        if not passes_phase:
            proc_reasons.append(reason_phase)

        # 4. ECG-gating check
        passes_gating, reason_gating = _check_ecg_gating(meta, procedure)
        if not passes_gating:
            proc_reasons.append(reason_gating)

        # 5. Isotropic voxel check (PEARS-specific)
        passes_iso, reason_iso = _check_isotropic_voxel(meta, procedure)
        if not passes_iso:
            proc_reasons.append(reason_iso)

        # 6. Coverage check
        if procedure == "PEARS":
            if meta.is_pears_covered is False:
                proc_reasons.append(f"pears_coverage_below_{PEARS_COVERAGE_MIN_Z_MM}mm_exstent2018")
        elif procedure == "TAVI":
            if meta.is_tavi_root_covered is False:
                proc_reasons.append(f"tavi_root_coverage_below_{TAVI_ROOT_COVERAGE_MIN_Z_MM}mm_scct2019")
        elif procedure == "VSRR":
            if meta.is_vsrr_root_covered is False:
                proc_reasons.append(f"vsrr_coverage_below_{VSRR_COVERAGE_MIN_Z_MM}mm_bissell2016")

        # Procedure passes if no hard failures
        if len(proc_reasons) == 0:
            allowed_procedures.append(procedure)

        # Add procedure-specific advisories to global list
        advisories.extend(proc_advisories)

    # Iliofemoral advisory (TAVI peripheral access)
    if meta.is_iliofemoral_covered is False:
        advisories.append("iliofemoral_access_not_assessable_plan_separately")

    # Merge global reasons (slice_thickness_unknown applies to all)
    all_reasons = reasons + [r for r in proc_reasons if r not in allowed_procedures]

    return DataQualityGate(
        passes_sizing_gate=len(allowed_procedures) > 0,
        allowed_procedures=allowed_procedures,
        failure_reasons=list(dict.fromkeys(all_reasons)),  # Deduplicate
        advisories=advisories,
    )


__all__ = [
    # Shared constants
    "MAX_CONTRAST_BLOOD_POOL_HU",
    # PEARS constants (Exstent 2018)
    "PEARS_MAX_SLICE_THICKNESS_MM",
    "PEARS_COVERAGE_MIN_Z_MM",
    "PEARS_MIN_CONTRAST_BLOOD_POOL_HU",
    "PEARS_REQUIRES_ECG_GATING",
    "PEARS_REQUIRED_PHASE",
    "PEARS_REJECT_IF_STITCHED",
    "PEARS_ISOTROPIC_VOXEL_REQUIRED",
    # TAVI constants (SCCT 2019)
    "TAVI_ROOT_MAX_SLICE_THICKNESS_MM",
    "TAVI_PERIPHERAL_MAX_SLICE_THICKNESS_MM",
    "TAVI_ROOT_COVERAGE_MIN_Z_MM",
    "TAVI_PERIPHERAL_COVERAGE_MIN_Z_MM",
    "TAVI_MIN_CONTRAST_BLOOD_POOL_HU",
    "TAVI_PREFERRED_CONTRAST_BLOOD_POOL_HU",
    "TAVI_ROOT_REQUIRES_ECG_GATING",
    "TAVI_PERIPHERAL_REQUIRES_ECG_GATING",
    "TAVI_REQUIRED_PHASE",
    # VSRR constants (Bissell 2016 / Kim 2020)
    "VSRR_MAX_SLICE_THICKNESS_MM",
    "VSRR_COVERAGE_MIN_Z_MM",
    "VSRR_MIN_CONTRAST_BLOOD_POOL_HU",
    "VSRR_REQUIRES_ECG_GATING",
    "VSRR_REQUIRED_PHASE",
    "VSRR_RR_RECONSTRUCTION_INTERVAL_PCT",
    # Iliofemoral constants
    "ILIOFEMORAL_COVERAGE_MIN_Z_MM",
    # Classes
    "StudyMeta",
    "DataQualityGate",
    # Functions
    "estimate_blood_pool_hu",
    "extract_study_meta",
    "evaluate_gate",
]
