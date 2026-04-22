export type SourceType = "guideline" | "literature" | "algorithm" | "device_ifu" | "manual" | "other";

export type UncertaintyFlag =
  | "NONE"
  | "MISSING_INPUT"
  | "DETECTION_FAILED"
  | "LOW_CONFIDENCE"
  | "ANATOMY_CONSTRAINT_VIOLATION"
  | "OUT_OF_RANGE"
  | "IMAGE_QUALITY_LIMITATION"
  | "MODEL_INCONSISTENCY"
  | "PLACEHOLDER_ONLY"
  | "NOT_AVAILABLE";

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Evidence {
  method: string;
  source_type: SourceType;
  source_ref: string;
  confidence: number;
}

export interface Uncertainty {
  flag: UncertaintyFlag;
  message: string;
  clinician_review_required: boolean;
}

export interface ScalarMeasurement<T = unknown> {
  value: T | null;
  unit: string;
  evidence: Evidence;
  uncertainty: Uncertainty;
}

export interface CapabilityState {
  available: boolean;
  inferred: boolean;
  legacy: boolean;
  source: string | null;
  reason: string | null;
}

export type ClinicalGateStatus = "normal" | "borderline" | "review_required" | "not_assessable" | "failed";

export interface ClinicalGate {
  status: ClinicalGateStatus;
  summary: string;
  clinician_review_required: boolean;
  evidence: Evidence;
  observed_value?: unknown;
  expected_context?: string | null;
  impact: string[];
  reason_codes: string[];
}

export type CoronaryOstiumStatus =
  | "not_evaluated"
  | "not_found"
  | "detection_failed"
  | "uncertain"
  | "detected";

export interface CoronaryOstiumSummary {
  status: CoronaryOstiumStatus;
  height_mm: number | null;
  confidence: number;
  clinician_review_required: boolean;
  ostium_world?: number[] | null;
  ostium_voxel?: number[] | null;
}

export interface CoronaryOstiaSummary {
  left: CoronaryOstiumSummary;
  right: CoronaryOstiumSummary;
  detected?: unknown[];
  method?: string;
  expected_height_mm?: number;
  clinician_review_required?: boolean;
}

export interface PipelineRun {
  source_mode: "stored" | "inferred" | "legacy";
  inference_mode: string;
  inferred: boolean;
  provider_target: string | null;
  provider_runtime: string | null;
  pipeline_version: string | null;
  build_version: string | null;
  provider_job_id?: string | null;
  status?: string | null;
}

export type AcceptanceStatus = "pass" | "needs_review" | "blocked";

export interface AcceptanceDomain {
  status: AcceptanceStatus;
  summary: string;
  blockers: string[];
  review_flags: string[];
}

export interface AcceptanceReview {
  overall_status: AcceptanceStatus;
  summary: string;
  human_review_required: boolean;
  domains: {
    viewing: AcceptanceDomain;
    clinical: AcceptanceDomain;
    planning: AcceptanceDomain;
  };
  next_actions: string[];
}

export type ContrastPhase = "non_contrast" | "arterial" | "venous" | "unknown";
export type CardiacPhase = "systole" | "diastole" | "multi_phase" | "unknown";

export interface StudyMeta {
  slice_thickness_mm: number | null;
  voxel_spacing_mm: [number, number, number] | null;
  is_tavi_root_covered?: boolean | null;
  is_vsrr_root_covered?: boolean | null;
  is_pears_covered?: boolean | null;
  is_root_covered?: boolean | null;
  is_iliofemoral_covered: boolean | null;
  is_cropped?: boolean | null;
  contrast_phase: ContrastPhase | null;
  cardiac_phase?: CardiacPhase | null;  // P0 #1: systole/diastole/multi_phase
  is_ecg_gated?: boolean | null;  // P0 #1: retrospective ECG-gating detected
  fov_mm: [number, number, number] | null;
  blood_pool_hu_mean: number | null;
  blood_pool_hu_source?: "mask" | "central-fallback" | "central-by-design" | null;
}

export interface DataQualityGate {
  passes_sizing_gate: boolean;
  allowed_procedures?: Array<"TAVI" | "VSRR" | "PEARS">;
  failure_reasons: string[];
  advisories?: string[];
}

export interface SourceDataset {
  name: string;
  host?: string;
  kaggle_id?: string;
  license?: string;
  citation?: string;
  label_semantics?: string;
  available_meshes?: string[];
}

export interface MeshQaEntry {
  tri_count: number;
  non_manifold_edges?: number | null;
  watertight?: boolean | null;
  aspect_ratio_p95?: number | null;
  mesh_kind?: "solid" | "tube_segment" | null;
  boundary_loop_count?: number | null;
  boundary_loops_all_closed?: boolean | null;
  passes_gate?: boolean | null;
  failure_reasons?: string[];
  skipped_reason?: string | null;
}

export type MeshQaReport = Record<string, MeshQaEntry>;

/**
 * Clinical data-quality gate thresholds (per-procedure, P0 #1 rewrite 2026-04-22).
 *
 * Source documents:
 *   - PEARS: Exstent EXWI01-02 (2018) manufacturer protocol
 *   - TAVI: SCCT 2019 Expert Consensus (Blanke et al., JCCT 13:1-20)
 *   - VSRR: Bissell 2016 RadioGraphics + Kim 2020 Korean J Radiol (no society consensus)
 *
 * Keep in lockstep with:
 *   - gpu_provider/geometry/data_quality.py (Python constants)
 *   - schemas/case_manifest.json (study_meta + data_quality schema)
 *   - IMAGING_CONSTANTS.md (summary table)
 *   - docs/imaging/{pears,tavi,vsrr}.md (authoritative sources)
 */
export const DATA_QUALITY_THRESHOLDS = {
  // === SHARED (all procedures) ===
  maxContrastBloodPoolHu: 600,  // Internal heuristic; not guideline-sourced

  // === PEARS — Exstent EXWI01-02 (2018) ===
  pears: {
    maxSliceThicknessMm: 0.75,  // Exstent §3 (stricter than TAVI/VSRR)
    coverageMinZMm: 120,  // Exstent §4: LVOT-20mm → brachiocephalic+20mm (~100-140mm)
    minContrastBloodPoolHu: 250,  // Proxy: SCCT 2019 line 160 (Exstent publishes no number)
    requiresEcgGating: true,  // Exstent §2
    requiredPhase: "diastole" as const,  // Exstent §2: 60-80% R-R (opposite of TAVI!)
    rejectIfStitched: true,  // Exstent §5: single-unit reconstruction required
    isotropicVoxelRequired: true,  // Exstent §3
  },

  // === TAVI — SCCT 2019 (Blanke et al.) ===
  tavi: {
    rootMaxSliceThicknessMm: 1.0,  // SCCT Table 5 line 298
    peripheralMaxSliceThicknessMm: 1.5,  // SCCT Table 5 line 272
    rootCoverageMinZMm: 130,  // SCCT Table 5 line 293: root + arch (was 80mm, non-compliant)
    peripheralCoverageMinZMm: 350,  // SCCT lines 164-167: to lesser trochanter (was 280mm)
    minContrastBloodPoolHu: 250,  // SCCT line 160 (was 300HU, too strict)
    preferredContrastBloodPoolHu: 350,  // Soft target; 250-350 = marginal warn
    rootRequiresEcgGating: true,  // SCCT Table 5
    peripheralRequiresEcgGating: false,  // SCCT Table 5
    requiredPhase: "systole" as const,  // SCCT Table 6 line 563: 30-40% R-R
  },

  // === VSRR — Bissell 2016 + Kim 2020 ===
  vsrr: {
    maxSliceThicknessMm: 1.0,  // Inferred from SCCT 2019 TAVI root (proxy)
    coverageMinZMm: 130,  // Anatomical: annulus → brachiocephalic (was 150mm, no source)
    minContrastBloodPoolHu: 250,  // Proxy: SCCT 2019 (no VSRR-specific number)
    requiresEcgGating: true,  // Bissell 2016; Kim 2020
    requiredPhase: "multi_phase" as const,  // Bissell 2016: systole + diastole required (strict!)
    rrReconstructionIntervalPct: 10,  // Kim 2020: 10% R-R intervals
  },

  // === ILIOFEMORAL (TAVI peripheral access) ===
  iliofemoralCoverageMinZMm: 350,  // SCCT lines 164-167: lesser trochanter
} as const;

export const MESH_QA_THRESHOLDS: Record<string, { minTris: number }> = {
  aortic_root: { minTris: 80000 },
  ascending_aorta: { minTris: 40000 },
  annulus_ring: { minTris: 2000 },
  leaflet_L: { minTris: 20000 },
  leaflet_N: { minTris: 20000 },
  leaflet_R: { minTris: 20000 },
  leaflets: { minTris: 60000 },
};

export interface DefaultCaseBundle {
  manifest: Record<string, unknown>;
  artifacts: Record<string, string>;
  meshes: Record<string, string>;
  reports: Record<string, string>;
  qa: Record<string, string>;
  imaging: Record<string, string>;
  digests: Record<string, string>;
}
