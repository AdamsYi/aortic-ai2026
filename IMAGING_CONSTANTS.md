# Imaging Constants — Per-Procedure CTA Thresholds

> **Authoritative sources**: `docs/imaging/{pears,tavi,vsrr}.md`  
> **Lockstep requirement**: `gpu_provider/geometry/data_quality.py` ↔ `services/api/contracts.ts` ↔ `schemas/case_manifest.json` must match these values exactly.  
> **Red line**: Never adjust threshold *values* to make a case pass. Refactor semantics instead (e.g., procedure-tiered gate) or accept rejection. See `feedback_threshold_redline` memory.

---

## Threshold Comparison Table

| Constant | PEARS | TAVI (Root) | TAVI (Peripheral) | VSRR | Source / Notes |
|----------|-------|-------------|-------------------|------|----------------|
| **Modality** | CT | CT | CT | CT | All procedures require CTA |
| **Coverage (proximal landmark)** | LVOT below lowest sinus -20mm | Aortic annulus | Upper thoracic aperture | Aortic annulus | Anatomical, not mm |
| **Coverage (distal landmark)** | Brachiocephalic origin +20mm | Left subclavian origin (full arch) | Lesser trochanter | Brachiocephalic origin | Anatomical, not mm |
| **Coverage (fallback Z, mm)** | 120.0 | 130.0 | 350.0 | 130.0 | Fallback when landmarks unavailable |
| **ECG-gating required** | Yes (retrospective) | Yes (root) / No (peripheral) | No | Yes (retrospective) | PEARS: Exstent §2; TAVI: SCCT Table 5 |
| **Required cardiac phase** | Diastole (60-80% R-R) | Systole (30-40% R-R) | N/A | Multi-phase (systole + diastole, 10% R-R intervals) | **PEARS and TAVI are opposite** |
| **Max slice thickness (mm)** | 0.75 | 1.0 | 1.5 | 1.0 | PEARS strictest (Exstent §3) |
| **Isotropic voxel required** | Yes | No | No | No | PEARS: Exstent §3 |
| **Min contrast HU (blood pool)** | 250.0 (proxy) | 250.0 | 250.0 | 250.0 (proxy) | SCCT 2019 line 160; PEARS/VSRR borrow |
| **Preferred contrast HU** | 350.0 | 350.0 | 350.0 | 350.0 | Soft target; 250-350 = marginal warn |
| **Max contrast HU** | 600.0 (internal) | 600.0 (internal) | 600.0 (internal) | 600.0 (internal) | Beam-hardening / mistimed bolus heuristic |
| **Reject if stitched reconstruction** | Yes | No | No | No | PEARS: Exstent §5 (manufacturing requirement) |
| **Coronary motion artifact check** | Manual review | Manual review | N/A | Manual review | Out of scope for v1 auto-gate |

---

## Source Documents

| Procedure | Authoritative Source | Document Link |
|-----------|---------------------|---------------|
| **PEARS** | Exstent Ltd. EXWI01-02 (2018) | [PDF](https://www.cardion.cz/file/1303/scanning-protocol-exovasc-pears-ascending-aorta-2018.pdf) |
| **TAVI** | SCCT 2019 Expert Consensus (Blanke et al.) | [PDF](https://cdn.ymaws.com/scct.org/resource/resmgr/docs/guidelines/scct_tavi_tavr_ecd_2019.pdf) |
| **VSRR** | Bissell 2016 RadioGraphics + Kim 2020 Korean J Radiol | [RadioGraphics](https://pmc.ncbi.nlm.nih.gov/articles/PMC4734055/), [KJR](https://pmc.ncbi.nlm.nih.gov/articles/PMC6992440/) |

**Note**: No society-level consensus exists for VSRR CT imaging. VSRR thresholds are compiled from institutional protocols and inferred from adjacent root-imaging conventions. Values marked "INFERRED" or "PROXY" in `docs/imaging/vsrr.md` require clinical-advisor confirmation.

---

## Naming Correction

**"SCCT 2021" does not exist.** The project memory and some code comments reference "SCCT 2021" — this is a misnomer for **SCCT 2019** (Blanke et al., JCCT 13:1-20). No SCCT 2021 TAVI consensus document exists in primary literature. All code references should be updated to "SCCT 2019".

---

## Open Questions (Blocking P0 #1 Rewrite)

Three questions pending user decision before rewriting `data_quality.py`:

1. **SCCT 2021 naming**: Confirm whether user has a 2021 DOI/PMC, or accept correction to "SCCT 2019" throughout codebase.

2. **VSRR multi-phase strictness**: 
   - **Strict**: Reject single-phase outright (as documented in `docs/imaging/vsrr.md`)
   - **Lenient**: Accept single-phase with warning flag (pragmatic, but deviates from Bissell 2016 / Kim 2020)

3. **Rewrite order**:
   - (a) Directly modify `data_quality.py` + `contracts.ts` + schema per this table
   - (b) First audit Zenodo 15094600 TAVI dataset to quantify gaps
   - (c) First update auto-memory, then code

---

## Implementation Checklist (P0 #1)

When rewriting, ensure lockstep updates across:

- [ ] `gpu_provider/geometry/data_quality.py` — Python constants + `DataQualityGate` class
- [ ] `services/api/contracts.ts` — `DATA_QUALITY_THRESHOLDS` constant (lines 185-194)
- [ ] `schemas/case_manifest.json` — `data_quality` object definition
- [ ] `schemas/data_quality.json` — if split schema exists
- [ ] `docs/imaging/*.md` — already authoritative; no changes needed
- [ ] Comments in `gpu_provider/download_and_process_tavi.py` — fix "SCCT 2021" → "SCCT 2019"

---

## Why This Matters

The legacy single-set thresholds (80/150/200/280 mm, 300 HU, 1.0 mm universal) **mixed procedures into one shared gate and lost procedure differentiation**. This caused:

1. **False accepts**: TAVI cases passing with 80 mm coverage (root only, no arch) — non-compliant with SCCT 2019
2. **False rejects**: PEARS cases rejected at 150 mm coverage — Exstent requires ~120 mm anatomical span, not 200 mm
3. **Wrong phase semantics**: No enforcement of diastole (PEARS) vs systole (TAVI) vs multi-phase (VSRR)
4. **Missing gates**: ECG-gating requirement, stitched-reconstruction reject (PEARS), isotropic voxel check (PEARS)

Per-procedure differentiation is not academic — it directly impacts which real-world CTA datasets are accepted or rejected, and whether the resulting surgical plans are clinically valid.
