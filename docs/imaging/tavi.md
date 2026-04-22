# TAVI — CTA Imaging Requirements

> **Status**: v1 (2026-04-22). Authoritative source: **SCCT 2019 Expert Consensus** (Blanke et al., *JCCT* 13:1–20). This is the document AorticAI's project memory refers to as "SCCT 2021" — no SCCT 2021 TAVI consensus exists in primary literature; the 2019 document remains current as of the writing date. All numeric thresholds below are cited to line numbers in the SCCT 2019 PDF.
>
> **Scope**: TAVI / TAVR only. PEARS and VSRR have separate documents.
>
> **Priority note**: per project owner directive (2026-04-22), TAVI is now priority #2 (behind PEARS, ahead of VSRR).

---

## 1. Procedure overview (imaging-relevant only)

TAVI / TAVR = transcatheter delivery of a bioprosthetic aortic valve into the native aortic annulus via a catheter, most commonly transfemoral. The CTA informs three distinct decisions:

1. **Prosthesis sizing**: annular plane geometry (area, perimeter, diameters) at systole.
2. **Coronary obstruction risk**: coronary ostial heights from annulus, sinus width, leaflet length.
3. **Access route feasibility**: iliofemoral caliber, tortuosity, calcification — for transfemoral; alternative routes (subclavian, transcarotid, transapical, transaxillary) have different coverage needs.

Each decision maps to a different CTA requirement. The imaging protocol must satisfy **all three** for a standard transfemoral TAVI; a root-only scan is insufficient.

---

## 2. Authoritative source

> **Blanke P, Weir-McCall JR, Achenbach S, Delgado V, Hausleiter J, Jilaihawi H, Marwan M, Nørgaard BL, Piazza N, Schoenhagen P, Leipsic JA.** "Computed Tomography Imaging in the Context of Transcatheter Aortic Valve Implantation (TAVI) / Transcatheter Aortic Valve Replacement (TAVR): An Expert Consensus Document of the Society of Cardiovascular Computed Tomography."
> *Journal of Cardiovascular Computed Tomography* 2019;13(1):1–20.
> DOI: 10.1016/j.jcct.2018.11.008
> PDF: https://cdn.ymaws.com/scct.org/resource/resmgr/docs/guidelines/scct_tavi_tavr_ecd_2019.pdf

**Naming note**: the project CLAUDE.md and memory entries reference "SCCT 2021". No SCCT 2021 TAVR consensus document was found in primary searches. Unless the project owner has a different reference, all references to "SCCT 2021" in this codebase should be read as pointing to this 2019 document. AorticAI code comments and constants should be updated accordingly.

---

## 3. Modality and gating

### 3.1 Gating

Per SCCT 2019 Table 5:
- **Cardiac block** (root + arch): **ECG-gated required** (retrospective or prospective wide-window).
- **Peripheral / aorto-ilio-femoral block**: **ECG-gating not required** — a standard CT angiogram suffices.

**AorticAI encoding**:
- `TAVI_ROOT_REQUIRES_ECG_GATING = True`
- `TAVI_PERIPHERAL_REQUIRES_ECG_GATING = False`

### 3.2 Cardiac phase for annular sizing

> "Systolic measurements are preferred for measurement and calculation of device sizing" — SCCT 2019 Table 6, line 563
> "...systolic scan coverage is recommended" — SCCT 2019 lines 99–100

Multi-phase is also acceptable and often preferred when scanner capability allows:

> "reconstruction of 10 or more phases from 30–80 % of the R-R interval" — SCCT 2019 line 107

**AorticAI encoding**:
- `TAVI_REQUIRED_PHASE = "systole"` (30–40 % R-R primary; multi-phase 30–80 % R-R acceptable)
- Phase is a **hard** requirement for the root block (wrong phase gives wrong annulus size), so the gate must reject diastole-only root reconstructions.

---

## 4. Z-coverage (two blocks)

SCCT 2019 prescribes **two** acquisition blocks:

### 4.1 Cardiac block (ECG-gated)

> "The imaging volume should include the aortic root, aortic arch and ilio-femoral access" — SCCT 2019 Table 5 recommendation, line 293

Empirical z-distance annulus → full arch: **~130–150 mm** patient-dependent. This is the **minimum** for annulus + coronary + sinus + arch sizing.

**AorticAI encoding**:
- Primary: verify annulus + full aortic arch (distal to left subclavian origin) are in FOV
- Fallback scalar: `TAVI_ROOT_COVERAGE_MIN_Z_MM = 130.0`
- Note: the current `data_quality.py` value of 80 mm is **non-compliant** with SCCT 2019 — it only covers the root, not the required root + arch.

### 4.2 Peripheral block (aorto-ilio-femoral)

> "should extend from the upper thoracic aperture to the lesser trochanter to include the thoracic and abdominal aorta, the iliac arteries and common femoral arteries" — SCCT 2019 lines 164–167

Empirical z-distance annulus → lesser trochanter: **~350–450 mm** patient-dependent (taller / longer torso → higher number).

**AorticAI encoding**:
- Primary: verify lesser trochanter is within FOV caudally, upper thoracic aperture cranially
- Fallback scalar: `ILIOFEMORAL_COVERAGE_MIN_Z_MM = 350.0`
- Note: the current value of 280 mm is **below SCCT** for average-sized patients — often fails to reach the trochanter.

### 4.3 Alternative access routes

If transfemoral access is infeasible or contraindicated (small/calcified iliacs), TAVI can be delivered via subclavian, transcarotid, transapical, transcaval, or transaxillary routes. Each alters the peripheral coverage requirement:
- **Subclavian / transaxillary**: imaging must extend cranially to include the subclavian / axillary vessels bilaterally.
- **Transcarotid**: must include common and internal carotids.
- **Transapical**: chest wall and LV apex; no peripheral access imaging needed.

AorticAI v1 gate assumes transfemoral. Other routes are out of scope — flag manually.

---

## 5. Spatial resolution

SCCT 2019 Table 5:

> "Thin slice collimation and reconstructed slice thickness **≤1 mm for the root and ≤1.5 mm for the peripheral vasculature** should be obtained" — Table 5 recommendation (lines 272, 298)

**AorticAI encoding**:
- `TAVI_ROOT_MAX_SLICE_THICKNESS_MM = 1.0`
- `TAVI_PERIPHERAL_MAX_SLICE_THICKNESS_MM = 1.5`
- Current code applies 1.0 mm universally; this would incorrectly reject SCCT-compliant peripheral-only reconstructions.

---

## 6. Contrast and blood pool attenuation

### 6.1 Attenuation target

> "Optimal images require high intra-arterial opacification, and **attenuation values should exceed 250 Hounsfield units**." — SCCT 2019 line 160 (citing SCCT 2016 radiation protection document)

**AorticAI encoding**:
- `TAVI_MIN_CONTRAST_BLOOD_POOL_HU = 250.0`
- Note: current code uses 300 HU min — stricter than SCCT 2019. 300 HU is a common clinical "good" target but the published floor is 250. Using 300 as a hard reject excludes SCCT-compliant scans.
- Recommend: `PREFERRED_CONTRAST_BLOOD_POOL_HU = 350.0` as a soft target; 250–350 HU range is "marginal" (warn, not reject).

### 6.2 Upper bound

**No upper HU bound is published in SCCT 2019.** The current code's 600 HU max is an internal AorticAI heuristic (catches mistimed bolus / beam hardening). Keep it, but label as non-guideline.

### 6.3 Contrast protocol (informational, not a gate)

Per SCCT 2019:
- **Volume**: 50–100 cc (line 218)
- **Rate**: 4–6 mL/s (line 247)
- **Access**: 20G antecubital (line 280)
- **Timing**: bolus tracking or test bolus to ensure arterial phase opacification

Not enforced as a gate — these are acquisition protocol details. AorticAI reads the acquired image, not the injection pump.

---

## 7. Tube potential (informational)

Per SCCT 2019 lines 136–138:
- **100 kV**: BMI ≤30 and weight ≤90 kg
- **120 kV**: BMI >30 or weight >90 kg

Not enforced as a gate. Recorded in DICOM; AorticAI can log for audit but should not reject on this basis.

---

## 8. Measurements used pre-operatively

Per SCCT 2019 (ordered by sizing impact):

| Measurement | Decision it drives |
|---|---|
| Annular area and perimeter (systole) | Prosthesis size selection |
| Annular diameters (min / max / mean) | Prosthesis size cross-check; ovality assessment |
| Left + right coronary ostial heights from annulus | Coronary obstruction risk (low ostium + long leaflet + narrow sinus = high risk) |
| Left + right sinus of Valsalva diameters | Coronary obstruction risk |
| Leaflet lengths (all three cusps) | Coronary obstruction risk |
| STJ diameter | Prosthesis landing-zone confirmation |
| Ascending aorta diameter | Co-pathology check |
| Aortic annulus plane angulation | C-arm projection planning (intra-op fluoro) |
| Iliofemoral min luminal diameter, tortuosity, calcification | Transfemoral feasibility |
| Aortic root calcification burden + distribution | Paravalvular leak risk, balloon expansion plan |

---

## 9. Summary: proposed `data_quality.py` TAVI constants

```python
# TAVI — all thresholds per SCCT 2019 (Blanke et al., JCCT 13:1–20)
# unless explicitly flagged as AorticAI-internal heuristic.

TAVI_REQUIRED_MODALITY                  = "CT"

# Cardiac block (root + arch, ECG-gated)
TAVI_ROOT_COVERAGE_LANDMARK_PROXIMAL    = "aortic_annulus"
TAVI_ROOT_COVERAGE_LANDMARK_DISTAL      = "left_subclavian_origin"   # full arch
TAVI_ROOT_COVERAGE_MIN_Z_MM             = 130.0     # fallback; SCCT Table 5 line 293
TAVI_ROOT_REQUIRES_ECG_GATING           = True      # SCCT Table 5
TAVI_REQUIRED_PHASE                     = "systole" # 30–40% R-R primary; multi-phase OK
TAVI_ROOT_MAX_SLICE_THICKNESS_MM        = 1.0       # SCCT Table 5 line 298

# Peripheral block (aorto-ilio-femoral, non-gated)
TAVI_PERIPHERAL_COVERAGE_LANDMARK_CRANIAL = "upper_thoracic_aperture"
TAVI_PERIPHERAL_COVERAGE_LANDMARK_CAUDAL  = "lesser_trochanter"
ILIOFEMORAL_COVERAGE_MIN_Z_MM           = 350.0     # fallback; SCCT lines 164–167
TAVI_PERIPHERAL_REQUIRES_ECG_GATING     = False     # SCCT Table 5
TAVI_PERIPHERAL_MAX_SLICE_THICKNESS_MM  = 1.5       # SCCT Table 5 line 272

# Contrast attenuation
TAVI_MIN_CONTRAST_BLOOD_POOL_HU         = 250.0     # SCCT line 160
TAVI_PREFERRED_CONTRAST_BLOOD_POOL_HU   = 350.0     # soft target; warn if 250–350
TAVI_MAX_CONTRAST_BLOOD_POOL_HU         = 600.0     # INTERNAL heuristic; not SCCT

# Access route (v1 assumption)
TAVI_DEFAULT_ACCESS_ROUTE               = "transfemoral"   # alternate routes out of scope for auto-gate
```

### Changes vs current `data_quality.py`

| Constant | Current | Proposed | Source of change |
|---|---:|---:|---|
| `TAVI_ROOT_COVERAGE_MIN_Z_MM` | 80.0 | **130.0** | SCCT Table 5 line 293 (root + arch required) |
| `ILIOFEMORAL_COVERAGE_MIN_Z_MM` | 280.0 | **350.0** | SCCT lines 164–167 (lesser trochanter) |
| Slice thickness | 1.0 (universal) | **1.0 root / 1.5 peripheral** | SCCT Table 5 lines 272, 298 |
| HU floor | 300.0 | **250.0** | SCCT line 160 |
| HU ceiling | 600.0 | **600.0** (flagged non-guideline) | No SCCT source; retain as internal heuristic |
| Required phase | unchecked | **"systole"** | SCCT Table 6 line 563 |
| ECG-gating | unchecked | **root=required, peripheral=not required** | SCCT Table 5 |

---

## 10. Uncertainty & open questions (TAVI-specific)

1. **"SCCT 2021" in project memory**: no SCCT 2021 TAVR CT consensus exists in public literature as of the writing date. This doc assumes the project's reference is actually SCCT 2019 and should be renamed in code / memory. Flag to project owner to confirm or provide a 2021 reference.
2. **HU ceiling 600**: no published source. Defensible as a beam-hardening / mistimed-bolus sanity check, but should be documented as "internal heuristic, not guideline-sourced".
3. **Alternative access routes**: v1 gate assumes transfemoral. If non-transfemoral cases enter the AorticAI pipeline, the peripheral coverage landmarks change — the gate will false-reject. Needs a per-case access route flag.
4. **Landmark detection**: all mm fallback values are less reliable than actual anatomical landmark checks. TAVI root currently has no FOV-arch detection; implementing it (detect left subclavian origin in FOV) would eliminate false rejects of short-patient scans where 130 mm isn't anatomically reachable.

---

## 11. Sources

### Primary
- **Blanke P, Weir-McCall JR, Achenbach S, Delgado V, Hausleiter J, Jilaihawi H, Marwan M, Nørgaard BL, Piazza N, Schoenhagen P, Leipsic JA.** "Computed Tomography Imaging in the Context of Transcatheter Aortic Valve Implantation (TAVI) / Transcatheter Aortic Valve Replacement (TAVR): An Expert Consensus Document of the Society of Cardiovascular Computed Tomography." *J Cardiovasc Comput Tomogr* 2019;13(1):1–20. DOI: 10.1016/j.jcct.2018.11.008. PDF: https://cdn.ymaws.com/scct.org/resource/resmgr/docs/guidelines/scct_tavi_tavr_ecd_2019.pdf

### Secondary (cited indirectly via SCCT 2019)
- SCCT 2016 radiation protection document — cited by SCCT 2019 line 160 for the 250 HU attenuation target. Not independently retrieved.

### Navigational
- SCCT guidelines portal: https://scct.org/page/Guidelines
- Valve Academic Research Consortium-3 (VARC-3) definitions: https://doi.org/10.1093/eurheartj/ehab375 — used for TAVI outcome reporting, not CT protocol.
