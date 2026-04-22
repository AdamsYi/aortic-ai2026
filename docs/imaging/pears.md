# PEARS — CTA Imaging Requirements

> **Status**: v1 (2026-04-22). Authoritative source: Exstent Ltd. manufacturer protocol (EXWI01-02, 2018). PEARS is AorticAI's highest-priority procedure and the most clinically constrained of the three (PEARS / VSRR / TAVI) because a 3D-printed external sleeve is manufactured from the CTA — imaging error propagates directly into device unusability.
>
> **Scope**: this document covers only PEARS. VSRR and TAVI have separate documents.

---

## 1. Procedure overview (imaging-relevant only)

PEARS (Personalized External Aortic Root Support) = the ExoVasc device, a custom 3D-printed macro-porous mesh sleeve fitted externally around the dilated aortic root + ascending aorta. Indication: Marfan syndrome, bicuspid valve aortopathy, other aortic root aneurysm where the aortic wall is preserved but diameter must be constrained.

Imaging consequences:
- The sleeve is designed from a **segmentation of the outer aortic wall** (annulus → proximal arch).
- It is sized to **95 %** of the measured **diastolic inner diameter** (Treasure 2014).
- It has **integrated fenestrations** at coronary ostial positions — ostial localization error is clinically load-bearing.
- Manufacturing is rejected if the CTA is a stitched / multi-block reconstruction.

---

## 2. Authoritative source

> **Exstent Ltd., document EXWI01-02 Section 5**, "Scanning Protocol for the ExoVasc Personalised External Aortic Root Support to manage a dilated aorta", 2018.
> PDF: https://www.cardion.cz/file/1303/scanning-protocol-exovasc-pears-ascending-aorta-2018.pdf

This is a manufacturer-authored scanning protocol, not a society consensus. It is the only authoritative document for PEARS imaging. AorticAI should treat its numeric thresholds as hard gates.

---

## 3. Modality

Exstent prefers **CT over MRI**, explicitly because MRI does not visualize coronary origins well enough for the sleeve's fenestrations.

> "While MR scanning can be used to image the ascending aorta, it is less able to visualise the coronary origins." — Exstent 2018

**AorticAI decision**: PEARS gate accepts CTA only. MRI sources are out of scope until coronary-ostia localization from MRI is validated (not available in public literature).

---

## 4. Z-coverage (anatomical, not metric)

Exstent specifies **anatomical landmarks**, not a millimeter value:

> "The image must extend from **20 mm below the lowest sinus in the Left Ventricular Outflow Tract**, (thereby including the proximal origins of ALL the 3 sinuses), to about **20 mm up the brachiocephalic artery at the top of the aortic arch**, (thereby including the origins of the brachiocephalic and common carotid arteries)." — Exstent 2018 §4

Empirical z-distance corresponding to this anatomical span: **~100–140 mm** (patient-dependent).

**AorticAI encoding**:
- Primary: verify that both (a) LVOT below lowest sinus and (b) brachiocephalic origin are within FOV
- Fallback (until landmark detection is available): `PEARS_COVERAGE_MIN_Z_MM = 120.0`
- Note: the current `data_quality.py` value of `200.0` mm is **over-constrained** and would reject compliant scans.

---

## 5. ECG-gating and cardiac phase

Retrospective ECG-gating is **required**. The acquisition phase for PEARS modelling is **diastole**, specifically 60–80 % of R-R:

> "Acquiring images between **60 % to 80 % of the R-R interval during ventricular diastole** gives good image quality and the best dimensional data for the PEARS modelling process." — Exstent 2018 §2

**Critical**: this is opposite to TAVI (which uses systole). Using a systolic reconstruction for PEARS modelling over-sizes the sleeve, because the aorta is larger in systole. The sleeve is made to 95 % of the diastolic diameter; a systolic measurement breaks the 95 % rule.

**AorticAI encoding**:
- `PEARS_REQUIRED_PHASE = "diastole"`
- `PEARS_REQUIRES_ECG_GATING = True`
- Gate must reject non-gated acquisitions and gated-but-systolic reconstructions for PEARS.

---

## 6. Spatial resolution

> "Resolution of **voxel size 0.5 mm × 0.5 mm × 0.5 mm, 0.6 mm × 0.6 mm × 0.6 mm or 0.75 mm × 0.75 mm × 0.75 mm is ideal**. It is essential that **contiguous, thin slices are acquired** and that the reconstructions should be the **thinnest possible without overlap**." — Exstent 2018 §3

Reconstruction kernel example: Siemens "smooth kernel [B26F] with the cardiac/angio window setting".

**AorticAI encoding**:
- `PEARS_MAX_SLICE_THICKNESS_MM = 0.75` (stricter than the SCCT TAVI root value of 1.0 mm)
- Ideally verify isotropic voxels (in-plane = slice); store `voxel_spacing_mm` and check `max/min ≤ 1.2`.
- Flag non-isotropic acquisitions as non-ideal (warn, not reject) pending clinical-advisor ruling on how strict to be.

---

## 7. Contrast and blood pool attenuation

Exstent's text is qualitative:

> "appropriately opacified using a contrast agent and bolus tracking/time density curve to ensure a high signal to noise ratio image" — Exstent 2018

**No numeric HU target is published by Exstent.** AorticAI should use the SCCT 2019 floor of **≥ 250 HU** as a conservative proxy until Exstent publishes a number. The current `data_quality.py` value of 300 HU is stricter than any published guideline for PEARS and would reject some SCCT-compliant studies.

**AorticAI encoding**:
- `PEARS_MIN_CONTRAST_BLOOD_POOL_HU = 250.0` (borrowed from SCCT 2019; flag as non-Exstent)
- Keep `MAX = 600` as an internal heuristic (beam-hardening / mistimed bolus detection); flag as not guideline-sourced.

---

## 8. Manufacturing-critical hard rejects

Beyond the thresholds above, Exstent explicitly disqualifies:

### 8.1 Stitched / multi-block reconstructions

> "The image block is a **single unit and not two or more image blocks with registration artefact lines** across the anatomical structures being imaged." — Exstent 2018 §5

**AorticAI encoding**: `PEARS_REJECT_IF_STITCHED = True`. Needs a detector — registration-artifact line detection is a new requirement; not implemented.

### 8.2 Motion artifact at coronary arteries

> "coronary arteries [must be] free of motion artifact" — Exstent 2018 §5

**AorticAI encoding**: out of scope for v1 automated gate (needs image-quality estimator). Flag as manual-review item until v2.

---

## 9. Measurements the sleeve design depends on

From Exstent 2018 + Treasure & Pepper 2016:

- **Outer aortic wall segmentation** from VA junction → brachiocephalic origin (primary input to CAD sleeve model)
- **Diastolic inner diameter** at multiple levels → sleeve internal diameter = 95 % of measured
- **Coronary ostial position** (left and right) → fenestration location on the sleeve

If any of these cannot be measured from the CTA, the case cannot produce a manufacturable sleeve. AorticAI's PEARS output must include per-measurement confidence and flag any ostium that could not be localized with ≤ X mm uncertainty (X TBD, see §11).

---

## 10. Summary: proposed `data_quality.py` PEARS constants

```python
# PEARS — all thresholds per Exstent EXWI01-02 (2018) unless noted
PEARS_REQUIRED_MODALITY            = "CT"           # Exstent §1
PEARS_COVERAGE_MIN_Z_MM            = 120.0          # ~LVOT-20 → brachio+20; anatomical landmarks preferred
PEARS_COVERAGE_LANDMARK_PROXIMAL   = "lvot_below_lowest_sinus_20mm"
PEARS_COVERAGE_LANDMARK_DISTAL     = "brachiocephalic_origin_plus_20mm"
PEARS_MAX_SLICE_THICKNESS_MM       = 0.75           # Exstent §3
PEARS_ISOTROPIC_VOXEL_REQUIRED     = True           # Exstent §3
PEARS_REQUIRES_ECG_GATING          = True           # Exstent §2
PEARS_REQUIRED_PHASE               = "diastole"     # 60–80% R-R, Exstent §2
PEARS_MIN_CONTRAST_BLOOD_POOL_HU   = 250.0          # SCCT 2019 floor (no Exstent number); NON-EXSTENT, flag as proxy
PEARS_REJECT_IF_STITCHED           = True           # Exstent §5
# out of scope for v1 automated gate (flag for manual review):
# - coronary motion artifact
# - explicit ostial localization uncertainty threshold
```

### Changes vs current `data_quality.py`

| Constant | Current | Proposed | Source of change |
|---|---:|---:|---|
| `PEARS_COVERAGE_MIN_Z_MM` | 200.0 | **120.0** | Exstent §4 (LVOT-20 to brachio+20 ≈ 100–140 mm) |
| Slice thickness (shared with TAVI) | 1.0 | **0.75** (PEARS-specific) | Exstent §3 |
| ECG-gating required | unchecked | **True** | Exstent §2 |
| Required phase | unchecked | **"diastole"** | Exstent §2 — **opposite to TAVI** |
| Stitched reject | unchecked | **True** | Exstent §5 |
| HU floor (shared) | 300.0 | **250.0** (proxy, not Exstent) | SCCT 2019 line 160 |

---

## 11. Uncertainty & open questions (PEARS-specific)

1. **PEARS blood-pool HU target**: Exstent publishes no number. 250 HU is a borrowed SCCT 2019 TAVI floor. Needs clinical-advisor or Exstent confirmation.
2. **Coronary ostial localization tolerance**: proprietary to Exstent manufacturing. Unknown mm error above which the sleeve is unusable. Flag to clinical advisor.
3. **Stitched-reconstruction detection**: not a standard DICOM metadata field. Either (a) derive from reconstruction table position discontinuities, or (b) require manual flag at ingest. Implementation TBD.
4. **Isotropic voxel strictness**: Exstent says 0.5/0.6/0.75 mm cubic is "ideal"; does not specify reject threshold for mildly anisotropic (e.g. 0.6 × 0.6 × 0.9). Warn vs reject is a clinical-advisor call.
5. **MRI-sourced PEARS**: Treasure 2014 reports 23/30 cases were MRI, but Exstent's current protocol prefers CT. AorticAI's current position is "CT only"; revisit when MRI coronary-ostia localization has validated tooling.

---

## 12. Sources

### Primary
- **Exstent Ltd.** "Scanning Protocol for the ExoVasc Personalised External Aortic Root Support to manage a dilated aorta", EXWI01-02, 2018. Mirror: https://www.cardion.cz/file/1303/scanning-protocol-exovasc-pears-ascending-aorta-2018.pdf

### Secondary (clinical / design)
- Treasure T, Takkenberg JJM, Golesworthy T, et al. "Personalised external aortic root support (PEARS) in Marfan syndrome: analysis of 1–9 year outcomes by intention-to-treat in a cohort of the first 30 consecutive patients...". *Heart* 2014;100:969–975. PMC4033204. https://pmc.ncbi.nlm.nih.gov/articles/PMC4033204/
- Treasure T, Pepper J. "Personalized external aortic root support: a review of the current status." *Eur J Cardiothorac Surg* 2016;50(3):400–404. https://academic.oup.com/ejcts/article/50/3/400/2197426
- Operative Techniques in Thoracic and Cardiovascular Surgery, "Personalized External Aortic Root Support (PEARS) for Aortic Root Aneurysm", 2021. https://www.optechtcs.com/article/S1522-2942(21)00035-0/fulltext
- CTSNet Technical Guide, "How to Perform PEARS: A Comprehensive Guide to Personalized External Aortic Root Support". https://www.ctsnet.org/article/how-perform-pears-comprehensive-guide-personalized-external-aortic-root-support
- Marfan Foundation, "Personalized External Root (PEARS) Procedure: What You Need to Know", 2025. https://marfan.org/wp-content/uploads/2025/03/PEARS-Procedure-What-You-Need-to-Know.pdf

### Proxy source for HU floor
- Blanke P et al. "Computed Tomography Imaging in the Context of TAVI/TAVR: An Expert Consensus Document of the Society of Cardiovascular Computed Tomography." *J Cardiovasc Comput Tomogr* 2019;13(1):1–20. Used **only** as a proxy for the HU floor that Exstent does not publish. Not a PEARS authority.

### Navigational
- Exstent corporate site: https://exstent.com/medical-devices/exovasc/aortic-pears/the-aortic-pears-procedure/
- Royal Brompton PEARS service: https://www.rbht.nhs.uk/our-services/personalised-external-aortic-root-support-pears
