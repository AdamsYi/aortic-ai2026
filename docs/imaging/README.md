# CTA Imaging Requirements — Index

> v1 (2026-04-22). Per-procedure CTA imaging requirements, split from the legacy combined draft so each procedure can be cited and audited independently.

**Priority order (per project owner 2026-04-22):** PEARS > TAVI > VSRR.

| # | File | Procedure | Authoritative source | Status |
|---|------|-----------|----------------------|--------|
| 1 | [pears.md](pears.md) | PEARS (Exstent external support) | Exstent EXWI01-02 (2018) manufacturer protocol | v1 — strictest, device-manufacturing driven |
| 2 | [tavi.md](tavi.md) | TAVI / TAVR | SCCT 2019 Expert Consensus (Blanke et al., *JCCT* 13:1–20) | v1 — two-block (cardiac + peripheral) structure |
| 3 | [vsrr.md](vsrr.md) | VSRR (David / Yacoub) | Bissell 2016 *RadioGraphics* + Kim 2020 *Korean J Radiol* | v1 — no society consensus; multi-phase requirement |

## Open strategic questions (pre-rewrite of `gpu_provider/geometry/data_quality.py`)

1. **"SCCT 2021"** — this project's memory refers to "SCCT 2021" but the authoritative TAVI CT consensus is 2019 (Blanke et al.). If a 2021 successor document exists, provide DOI/PMC; otherwise we correct the memory to "SCCT 2019".
2. **VSRR multi-phase** — strict enforcement (reject single-phase) disqualifies most public datasets. Fallback "multi-phase preferred, single-phase with warning" needs clinical-advisor sign-off.
3. **Rewrite order** — the three docs propose threshold changes that diverge from current `data_quality.py` / `contracts.ts`. Rewrite should land as one lockstep PR (Python + TypeScript + schema), not piecemeal.

## Legacy

The combined draft `docs/CTA_IMAGING_REQUIREMENTS.md` has been removed in favour of these three per-procedure files. Do not reintroduce it — mixing procedure requirements in one document has historically led to cross-contamination (TAVI values being applied to PEARS, etc.).
