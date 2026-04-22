# Session Handoff Log

> **Purpose**: Track session-to-session continuity for AorticAI development. Each new Claude session should append a handoff entry here before beginning work.
>
> **Location**: `docs/HANDOFF.md` — this file lives in the codebase, not in `.claude/memory/`. Auto-memory (`MEMORY.md`) stores point-in-time snapshots; this file is the chronological log.
>
> **Update discipline**: One entry per session. Lead with the most recent. Keep entries under 200 lines each.

---

## Session 2026-04-22 — Project Organization + P0 #1 + PEARS Data Strategy

**Session ID**: `ed47b766-b0db-4b83-8546-166fdd4abddd` (previous) → continued  
**Role**: Primary Claude (prompts + audits)  
**Trigger**: User requested "本地+git 的文件比较混乱，解决这一点，并且让以后项目推进更有序和让人看得懂"

### Starting State

- **Git**: `main` branch, HEAD `24a0296` — `docs(imaging): split per-procedure CTA requirements`
- **Working tree**: 7 modified files (MPR clinical workflow draft from P0 #4)
- **Auto-memory**: 9 entries loaded (project_handoff_2026_04_22, project_phase_b2b, feedback_threshold_redline, etc.)
- **Three open questions** (blocking P0 #1):
  1. "SCCT 2021" naming — confirm DOI or accept correction to "SCCT 2019"
  2. VSRR multi-phase strictness — strict reject vs warning
  3. Rewrite order — code first vs Zenodo audit first vs memory first

### User Decisions (2026-04-22)

| Question | Decision | Rationale |
|----------|----------|-----------|
| SCCT 2021 naming | **笔误，用 2019** | No 2021 document exists in primary literature |
| VSRR strictness | **严格拒收单相位** | "临床的事情不可以随便搞" — Bissell 2016 / Kim 2020 require multi-phase |
| Rewrite order | **(a) 直接改代码，逐个击破** | PEARS → TAVI → VSRR sequence, not all together |

### Work Completed

#### Step 1: Working Tree Disposition ✅

**Decision**: Option B — commit MPR draft as WIP (user confirmed)

**Commit**: `e753b24` — `wip: MPR clinical workflow draft (CrosshairsTool + ReferenceLines + Slab MIP + HU footer)`

Files preserved:
- `apps/web/src/{main.ts, shell/dom.ts, shell/template.ts, styles.css}`
- `src/generated/*` (build artifacts)
- `wrangler.toml` (BUILD_VERSION bump)

**Rationale**: P0 #4 MPR workflow early work preserved; not discarded, not polished. DOM wiring remains in `main.ts` pending PR #4 modularization.

#### Step 2: File Organization Refactor ✅

**Commit**: `edcd008` — `refactor: reorganize scripts/ into subfolders + add IMAGING_CONSTANTS.md`

Changes:
1. **Created `IMAGING_CONSTANTS.md`** — per-procedure threshold comparison table, authoritative source links, open questions listed
2. **Reorganized `scripts/`** into 4 subfolders:
   - `build/` — build scripts (3 files)
   - `deploy/` — deploy/publish scripts (3 files)
   - `diagnostic/` — tests/validation (5 files)
   - `data-import/` — ingest pipelines (2 files)
   - Added `scripts/README.md` as navigation index
3. **Fixed naming**: "SCCT 2021" → "SCCT 2019" in:
   - `services/api/contracts.ts` comment
   - `gpu_provider/download_and_process_tavi.py` manifest note
   - `gpu_provider/geometry/data_quality.py` docstring
4. **Updated `.gitignore`**: excluded `src/generated/` (regenerated on each build)
5. **Added deprecation notices** to `data_quality.py` and `contracts.ts` — legacy combined thresholds, P0 #1 rewrite target

**Git hygiene**: All renames tracked correctly (15 files moved, 0 deleted).

#### Step 3: Handoff Documentation ✅

**Created**: `docs/HANDOFF.md` (this file) — living session log for future continuity.

#### P0 #1: Per-Procedure Data Quality Rewrite ✅

**Commit**: `3ac96cc` — `feat(data-quality): per-procedure thresholds rewrite (P0 #1)`

Changes (lockstep across Python/TypeScript/Schema):
- `gpu_provider/geometry/data_quality.py` — PEARS/TAVI/VSRR constants + gate logic
- `services/api/contracts.ts` — `DATA_QUALITY_THRESHOLDS` restructured by procedure
- `schemas/case_manifest.json` — added `cardiac_phase`, `is_ecg_gated` fields

**PEARS thresholds (Exstent 2018)**:
- Slice thickness: ≤0.75mm
- Coverage: ≥120mm (LVOT-20 → brachio+20)
- Contrast HU: ≥250 (proxy from SCCT 2019)
- Cardiac phase: diastole (60-80% R-R)
- ECG gating: required
- Isotropic voxel: required
- Reject stitched reconstruction: true

**TAVI thresholds (SCCT 2019)**:
- Root: ≤1.0mm, ≥130mm coverage
- Peripheral: ≤1.5mm, ≥350mm coverage
- Contrast HU: ≥250
- Cardiac phase: systole (30-40% R-R)

**VSRR thresholds (Bissell 2016 / Kim 2020)**:
- Slice thickness: ≤1.0mm
- Coverage: ≥130mm
- Contrast HU: ≥250
- Cardiac phase: multi_phase (strict: systole + diastole)

#### Step 4: PEARS Data Strategy Analysis ✅

**User insight**: PEARS is patient-specific — only need **1合格 CTA** per patient, not a large dataset.

**Data source evaluation**:

| Source | Immediately available | Matches PEARS population | Verdict |
|--------|----------------------|-------------------------|---------|
| Zenodo 15094600 (TAVI) | ✅ | ❌ (elderly TAVI patients) | Not suitable |
| ImageCAS (800 CCTA) | ✅ | ⚠️ (coronary CTA, non-aneurysm) | Pipeline dev only |
| CTACardio (local) | ✅ | ❌ (slice thickness 1.25mm) | Not suitable |
| UK Biobank | ❌ (2-4 week application) | ✅ | Too slow |
| Leuven/RBH PEARS cohort | ❌ (collaboration required) | ✅ | Best for validation |
| **Local hospital (1 retrospective case)** | ⚠️ (1-2 weeks) | ✅ | **Recommended path** |

**Key realization**: Exstent model = one CTA → one custom device. No need for large dataset for initial development.

**Next session action**: User to decide on hospital collaboration approach.

### Current Git State (End of Session)

```
On branch main
Your branch is ahead of 'origin/main' by 6 commits.

nothing to commit, working tree clean
```

**Git log (most recent first):**
```
e2ccf8a docs: update HANDOFF.md with P0 #1 completion status
3ac96cc feat(data-quality): per-procedure thresholds rewrite (P0 #1)
9f8e407 docs: add HANDOFF.md for session-to-session continuity
edcd008 refactor: reorganize scripts/ into subfolders + add IMAGING_CONSTANTS.md
e753b24 wip: MPR clinical workflow draft (CrosshairsTool + ReferenceLines + Slab MIP + HU footer)
24a0296 docs(imaging): split per-procedure CTA requirements (PEARS / TAVI / VSRR)
```

### P0 Task Status

| P0 # | Task | Status | Next Action |
|------|------|--------|-------------|
| 1 | Per-procedure imaging rewrite | ✅ **COMPLETED** | None |
| 2 | Data acquisition (1 PEARS-qualified CTA) | **Pending** | User to decide hospital collaboration |
| 3 | STL resolution improvement | Not started | After P0 #2 |
| 4 | MPR clinical workflow | WIP (`e753b24`) | Not priority |
| 5 | Manual annotation + coronary ostia | Not started | After P0 #2-4 |

### Auto-Memory Status

No new memory entries created. Existing memories remain authoritative:
- `project_handoff_2026_04_22.md` — three open questions (now resolved)
- `project_phase_b2b.md` — ImageCAS ingest status
- `feedback_threshold_redline.md` — threshold red line
- `reference_imaging_requirements.md` — docs/imaging/*.md authority

### Notes for Next Session

1. **PEARS data strategy**: User recognized that only 1 qualified CTA is needed per patient (patient-specific device). Shift from "dataset validation" to "single case acquisition".

2. **Hospital collaboration options**:
   - User has local hospital contacts? → Direct request
   - No contacts? → Cold outreach email (can be drafted)
   - In parallel: Use ImageCAS for pipeline development

3. **Files uploaded for reference** (not in repo):
   - `/Users/adams/Documents/New project/paper/PEARS 产品完整复刻指南.docx` — user's AI-assisted summary
   - `/Users/adams/Documents/New project/paper/20 Years of PEARS.pdf` — Pepper et al, JTCVS 2024
   - `/Users/adams/Documents/New project/paper/1–9 year outcomes.pdf` — Van Hoof et al, Heart 2021
   - `/Users/adams/Documents/New project/paper/A narrative review.pdf` — Pepper et al, JTCVS 2024

4. **Key literature insights**:
   - PEARS evidence = Level 4-5 (case series, expert opinion)
   - No RCT, no independent multi-center validation
   - Exstent imaging requirements = proprietary (no published validation)
   - Van Hoof 2021 used 1.0mm slice thickness (not 0.5mm)

### Lessons / Observations

1. **File organization**: Scripts now discoverable via `scripts/README.md`. Future additions should follow the same subfolder pattern.
2. **IMAGING_CONSTANTS.md**: Serves as "single source of truth" summary. When P0 #1 rewrite completes, update this file with new values.
3. **WIP commits are valuable**: The MPR draft (`e753b24`) would have been lost or become a merge conflict if not committed. Future sessions should commit working drafts before context switches.
4. **Naming corrections matter**: "SCCT 2021" appeared in 3 files. Systematic search-and-replace + deprecation notices prevent future confusion.
5. **Clinical safety red lines are non-negotiable**: User's decision on VSRR multi-phase strictness ("临床的事情不可以随便搞") sets the tone for all future clinical gate decisions.
6. **PEARS business model insight**: One CTA → one device. Don't over-engineer data requirements for initial development.

### Unresolved / Next Session Starting Point

**Three open questions — RESOLVED (2026-04-22 user decisions):**

1. **SCCT 2021 naming** — ✅ User confirmed: 笔误，use "SCCT 2019"
2. **VSRR multi-phase strictness** — ✅ User confirmed: 严格拒收单相位 ("临床的事情不可以随便搞")
3. **Rewrite order** — ✅ User confirmed: (a) 直接改代码，逐个击破 (PEARS → TAVI → VSRR)

**P0 task status**:

| P0 # | Task | Status | Blockers |
|------|------|--------|----------|
| 1 | Per-procedure imaging rewrite | ✅ **COMPLETED** (commit `3ac96cc`) | None |
| 2 | Zenodo TAVI dataset ingest | Not started | Ready to start |
| 3 | STL resolution improvement | Not started | P0 #2 first |
| 4 | MPR clinical workflow | WIP committed (`e753b24`) | Not priority — data layer first |
| 5 | Manual annotation + coronary ostia | Not started | P0 #2-4 first |

### Working Tree State (End of Session)

```
On branch main
Your branch is ahead of 'origin/main' by 6 commits.

nothing to commit, working tree clean
```

**Git log (most recent first):**
```
165a083 docs: update HANDOFF.md with P0 #1 completion status
3ac96cc feat(data-quality): per-procedure thresholds rewrite (P0 #1)
9f8e407 docs: add HANDOFF.md for session-to-session continuity
edcd008 refactor: reorganize scripts/ into subfolders + add IMAGING_CONSTANTS.md
e753b24 wip: MPR clinical workflow draft (CrosshairsTool + ReferenceLines + Slab MIP + HU footer)
24a0296 docs(imaging): split per-procedure CTA requirements (PEARS / TAVI / VSRR)
```

### Auto-Memory Updates

No new memory entries created in this session. Existing memories remain authoritative:
- `project_handoff_2026_04_22.md` — records previous session's three open questions (now resolved)
- `project_phase_b2b.md` — ImageCAS ingest status snapshot
- `feedback_threshold_redline.md` — threshold adjustment red line
- `reference_imaging_requirements.md` — docs/imaging/*.md authority

### Lessons / Observations

1. **File organization**: Scripts now discoverable via `scripts/README.md`. Future additions should follow the same subfolder pattern.
2. **IMAGING_CONSTANTS.md**: Serves as "single source of truth" summary. When P0 #1 rewrite completes, update this file with new values.
3. **WIP commits are valuable**: The MPR draft (`e753b24`) would have been lost or become a merge conflict if not committed. Future sessions should commit working drafts before context switches.
4. **Naming corrections matter**: "SCCT 2021" appeared in 3 files. Systematic search-and-replace + deprecation notices prevent future confusion.
5. **Clinical safety red lines are non-negotiable**: User's decision on VSRR multi-phase strictness ("临床的事情不可以随便搞") sets the tone for all future clinical gate decisions. When literature says X, we implement X — not a convenient approximation.

---

## Template for Future Sessions

Copy this template and fill in at the start of each new session:

```markdown
## Session YYYY-MM-DD — [Session Title]

**Session ID**: [from previous session or "cold-start"]  
**Role**: [Primary Claude / Secondary CC / Execution End]  
**Trigger**: [What prompted this session]

### Starting State

- **Git**: [branch, HEAD commit hash + message]
- **Working tree**: [modified files or "clean"]
- **Auto-memory**: [key entries loaded]
- **Open questions**: [from previous session or "none"]

### Work Completed

[Summary of commits, files created/modified, decisions made]

### Unresolved / Next Session Starting Point

[What's still pending, what the next session should do first]

### Working Tree State (End of Session)

[Git status output]

### Auto-Memory Updates

[New memories created, or "none"]

### Lessons / Observations

[Any meta-observations for future sessions]
```

---

## Previous Session Index

| Date | Session ID | Key Outcome |
|------|------------|-------------|
| 2026-04-22 | `ed47b766-b0db-4b83-8546-166fdd4abddd` | Phase B2b strategic pause, three open questions, project organization cleanup (Steps 1-3) |
| 2026-04-21 | `9f3ddcf0-2c0d-4f88-a1c5-16d96557a540` | ImageCAS ingest, mesh_qa investigation paused, per-procedure imaging docs created |
| 2026-04-20 | — | Imaging workstation observation fixes (PR #4a), commit `ae2cbac` |
| 2026-04-19 | — | Frontend shell modularization (PR #3), commit `d2e599d` |
| 2026-04-18 | — | Manual annotation闭环 (PR #2), commit `9ada02a` |
| 2026-04-18 | — | Refactor kickoff (PR #1), commits `0f19db9` + `f918ad9` |

**See**: `docs/REFACTOR_LOG.md` for detailed PR-by-PR logs from April 2026 refactor.
