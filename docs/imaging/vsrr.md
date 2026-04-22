# VSRR — CTA Imaging Requirements

> **Status**: v1 (2026-04-22). **No society-level consensus exists for CT imaging in valve-sparing root replacement (VSRR)**; institutional protocols only. Highest-quality public references are the RadioGraphics 2016 review (Bissell et al.) and the Korean J Radiol 2020 paper on recurrent AR after reimplantation (Kim et al.). Numeric thresholds below are either directly cited or, where marked, inferred from anatomy + adjacent TAVI / imaging conventions and **require clinical-advisor confirmation before merge**.
>
> **Scope**: VSRR only (David reimplantation, Yacoub remodelling, and their variants). PEARS and TAVI have separate documents.

---

## 1. Procedure overview (imaging-relevant only)

VSRR replaces the aortic root while preserving the native valve. Two canonical techniques:

- **David procedure (reimplantation)**: dilated root + sinuses replaced with a Dacron graft; native valve reimplanted inside it; coronaries reimplanted on the graft.
- **Yacoub procedure (remodelling)**: sinuses excised and replaced with a scalloped Dacron graft, leaving the annulus native.

Imaging consequences (both techniques):

- **Valve leaflet geometry must be assessed pre-op** to judge whether the native valve is salvageable. This requires **multi-phase (4D-CT)** data — at minimum systole + diastole — because leaflet coaptation and motion are evaluated in cine.
- **Coronary ostia are reimplanted in David**: accurate ostial location, takeoff angle, and button size are needed.
- **Annulus, SoV, STJ, and tubular ascending** are measured to size the Dacron graft.
- **No iliofemoral imaging required** unless re-operation or vascular access concerns.

---

## 2. Authoritative sources

There is **no society consensus document** (STS / EACTS / AATS / SCCT) specifically for VSRR pre-op CT. The best public references are:

- **Bissell MM, et al.** "Pre- and Postoperative Imaging of the Aortic Root." *RadioGraphics* 2016;36(1):19–37. PMC4734055. https://pmc.ncbi.nlm.nih.gov/articles/PMC4734055/
- **Kim EK, et al.** "Preoperative Cardiac Computed Tomography Characteristics Associated with Recurrent Aortic Regurgitation after Aortic Valve Re-Implantation." *Korean J Radiol* 2020;21(2):181–191. PMC6992440. https://pmc.ncbi.nlm.nih.gov/articles/PMC6992440/

Everything below is either cited to one of these, cited to the SCCT 2019 TAVI consensus as a proxy for root-imaging technique (reasonable because the underlying anatomy is identical), or flagged as an inference.

---

## 3. Modality

CT (cardiac CTA) is the pre-op imaging modality of choice for VSRR sizing. MRI is used post-op and for serial surveillance but not for operative sizing, because Dacron graft sizing requires the geometric precision and coronary detail that CT provides. (Same logic as PEARS, but without the PEARS-specific manufacturer mandate.)

**AorticAI encoding**: `VSRR_REQUIRED_MODALITY = "CT"`.

---

## 4. ECG-gating and cardiac phase (most important differentiator)

VSRR **requires multi-phase reconstruction** across the cardiac cycle:

> "Both systolic and diastolic phases of the cardiac cycle are required to assess valve function and geometry." — Bissell 2016 RadioGraphics

> "Preoperative cardiac CT is performed using dual-source CT scanners with a retrospective electrocardiogram-gated protocol. CT data sets are reconstructed using a **10 % R-R interval**." — Kim 2020

This is **stricter than both PEARS (one diastolic phase) and TAVI (systolic for sizing)**. Rationale: leaflet coaptation, cusp symmetry, commissural heights, and motion cannot be judged from a single phase.

**AorticAI encoding**:
- `VSRR_REQUIRES_ECG_GATING = True` (retrospective)
- `VSRR_REQUIRED_PHASE = "multi_phase"` (at minimum systole + diastole; 10 % R-R reconstruction preferred)
- Gate must reject non-gated or single-phase acquisitions for the VSRR pipeline.

⚠ **Open clinical-advisor question**: is single-phase CT + intra-op TEE acceptable for David planning in practice? If yes, we soften this to "multi-phase preferred, single-phase with warning". Not answered by Bissell / Kim.

---

## 5. Z-coverage

Anatomical requirement (all cited references agree, phrased differently):
- **Proximal**: aortic annulus with LVOT included.
- **Distal**: at least the brachiocephalic (innominate) origin; ideally the full arch.
- **No iliofemoral** required (distinguishing it from TAVI).

Empirical z-distance annulus → brachiocephalic: ~100–150 mm patient-dependent.

**No VSRR-specific mm value is published.** The 150 mm previously used by AorticAI was a project-internal guess; 130 mm matches the typical annulus-to-brachiocephalic length and is consistent with TAVI cardiac-block coverage. The correct primary check is anatomical landmark presence, not mm.

**AorticAI encoding**:
- Primary: verify annulus + brachiocephalic origin are in FOV
- Fallback: `VSRR_COVERAGE_MIN_Z_MM = 130.0` (inferred — no direct source; flag to clinical advisor)

---

## 6. Spatial resolution

**Not explicitly stated in VSRR-specific literature.** Kim 2020 does mention 5–10 mm slice thickness — but only for *en-face display of the aortic regurgitant orifice*, not for acquisition. Bissell 2016 does not give a number.

Reasonable default: match SCCT 2019 TAVI root spec (≤ 1 mm), because the anatomy of interest (aortic root) is identical. Thinner (0.5–0.75 mm) is preferable for cusp geometry quantification but there is no published evidence it is required for VSRR pre-op sizing.

**AorticAI encoding**:
- `VSRR_MAX_SLICE_THICKNESS_MM = 1.0` (inferred from SCCT 2019 TAVI root; flag as non-VSRR-sourced)
- Do **not** enforce isotropic voxel (no published basis).

---

## 7. Contrast and blood pool attenuation

**No VSRR-specific HU number is published.** Use SCCT 2019 floor as proxy.

> "Optimal images require high intra-arterial opacification, and attenuation values should exceed 250 Hounsfield units." — SCCT 2019 line 160

**AorticAI encoding**:
- `VSRR_MIN_CONTRAST_BLOOD_POOL_HU = 250.0` (proxy; flag as SCCT-sourced, not VSRR-sourced)
- Upper bound 600 HU retained as an internal heuristic (not guideline).

---

## 8. Measurements used pre-operatively

Per Kim 2020 + Bissell 2016 + Cleveland Clinic / Toronto institutional descriptions, pre-op VSRR measurements include:

| Measurement | Why it matters |
|---|---|
| Aortic annulus (diameter / perimeter / area, systolic + diastolic) | Graft size at the annular end; reimplantation suture line |
| Sinus of Valsalva diameters (per-cusp, all three) | Graft size choice; asymmetry flag |
| Sinotubular junction (STJ) diameter | Graft mid / distal size |
| Tubular ascending aorta diameter | Graft distal anastomosis |
| Cusp heights, free-edge lengths, commissure heights | Cusp geometry / suitability for sparing |
| Cusp coaptation zone and symmetry (multi-phase) | Predicts post-op AR risk (Kim 2020 specifically associates these with recurrent AR) |
| Coronary ostial positions (both) | Button excision + reimplantation on the graft |

This is a **superset of TAVI annulus sizing**. A CTA that is adequate for VSRR is also adequate for TAVI. The reverse is not true (TAVI does not need cusp-motion phases).

---

## 9. Summary: proposed `data_quality.py` VSRR constants

```python
# VSRR — thresholds compiled from Bissell 2016 RadioGraphics + Kim 2020 KJR
# NOTE: no society-level VSRR CT consensus exists. Values marked "INFERRED"
# need clinical-advisor review before going to production gate.

VSRR_REQUIRED_MODALITY              = "CT"
VSRR_COVERAGE_LANDMARK_PROXIMAL     = "aortic_annulus"
VSRR_COVERAGE_LANDMARK_DISTAL       = "brachiocephalic_origin"
VSRR_COVERAGE_MIN_Z_MM              = 130.0          # INFERRED (anatomical) — no direct source
VSRR_MAX_SLICE_THICKNESS_MM         = 1.0            # INFERRED from SCCT 2019 TAVI root
VSRR_REQUIRES_ECG_GATING            = True           # Bissell 2016; Kim 2020
VSRR_REQUIRED_PHASE                 = "multi_phase"  # systole + diastole required
VSRR_RR_RECONSTRUCTION_INTERVAL_PCT = 10             # Kim 2020 (10% R-R reconstructions)
VSRR_MIN_CONTRAST_BLOOD_POOL_HU     = 250.0          # PROXY — SCCT 2019, not VSRR-specific
# out of scope for v1 automated gate (flag for manual review):
# - cusp motion artifact detection
# - coronary ostial localization uncertainty
```

### Changes vs current `data_quality.py`

| Constant | Current | Proposed | Source of change |
|---|---:|---:|---|
| `VSRR_COVERAGE_MIN_Z_MM` | 150.0 | **130.0** | Anatomical inference; no published 150 mm |
| Slice thickness (shared) | 1.0 | **1.0** (VSRR-specific constant) | Same value, but cited separately (proxy) |
| ECG-gating required | unchecked | **True** | Bissell 2016; Kim 2020 |
| Required phase | unchecked | **"multi_phase"** | Bissell 2016 — differs from PEARS and TAVI |
| HU floor (shared) | 300.0 | **250.0** (proxy) | SCCT 2019 line 160 |

---

## 10. Uncertainty & open questions (VSRR-specific)

1. **Single-phase vs multi-phase**: the multi-phase requirement is the single biggest dataset filter (excludes most public aortic datasets). Is single-phase CT + intra-op TEE acceptable in real practice? Clinical-advisor answer needed before we lock the gate to reject single-phase outright.
2. **Slice thickness evidence**: there is no VSRR-specific slice thickness published. 1.0 mm is borrowed from SCCT TAVI. Some centres may use 0.5–0.75 mm; we do not know the clinical minimum for cusp geometry.
3. **Z-coverage 130 mm number**: inferred from anatomy, no literature support. Landmark-based check (annulus + brachiocephalic present) is more defensible than the mm value.
4. **HU floor 250**: proxy from SCCT 2019 TAVI; no VSRR number exists. Probably fine, but flag it.
5. **Cusp geometry quantification from CT vs TEE**: different institutions weight these differently pre-op. AorticAI's VSRR measurements list assumes CT-primary; if TEE is primary at a given centre, several CT measurements become optional. Institutional-preference dependent.

---

## 11. Sources

### Primary
- **Bissell MM, Loudon M, Hess AT, Stoll V, Orchard E, Neubauer S, Myerson SG.** "Pre- and Postoperative Imaging of the Aortic Root." *RadioGraphics* 2016;36(1):19–37. PMC4734055. https://pmc.ncbi.nlm.nih.gov/articles/PMC4734055/
- **Kim EK, Choi SH, Song YB, et al.** "Preoperative Cardiac Computed Tomography Characteristics Associated with Recurrent Aortic Regurgitation after Aortic Valve Re-Implantation." *Korean J Radiol* 2020;21(2):181–191. PMC6992440. https://pmc.ncbi.nlm.nih.gov/articles/PMC6992440/

### Secondary (procedural context)
- Cleveland Clinic patient-facing overview of reimplantation surgery: https://my.clevelandclinic.org/health/treatments/17421-valve-sparing-or-valve-preserving-surgery-reimplantation-surgery
- David TE, et al. Original David procedure descriptions and follow-up series (multiple; not all open-access; navigational only).

### Proxy source (used where no VSRR-specific number exists)
- Blanke P et al. "Computed Tomography Imaging in the Context of TAVI/TAVR: An Expert Consensus Document of the Society of Cardiovascular Computed Tomography." *J Cardiovasc Comput Tomogr* 2019;13(1):1–20. https://cdn.ymaws.com/scct.org/resource/resmgr/docs/guidelines/scct_tavi_tavr_ecd_2019.pdf
  — Used only for the 250 HU floor and for the 1.0 mm root slice thickness, both of which have no VSRR-specific published equivalent. Not a VSRR authority.
