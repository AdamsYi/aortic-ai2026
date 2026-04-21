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
 * Clinical data-quality gate thresholds (TAVI-grade sizing).
 *
 * Source: SCCT 2021 Expert Consensus on CT for TAVR (Blanke et al.,
 * J Cardiovasc Comput Tomogr 2019;13:1-20). Section 4 recommends:
 *   - slice thickness ≤ 1.0 mm reconstructed (isotropic preferred)
 *   - annular contrast opacification ≥ 300 HU on the targeted phase
 *   - retrospective ECG-gated acquisition (arterial / cardiac phase)
 *
 * These are the mainstream inclusion thresholds used by public TAVI
 * research datasets (Zenodo, MM-WHS, ASOCA). Values tighter than this
 * (e.g. 0.625 mm) describe reconstruction hardware, not acquisition
 * quality, and would reject most legitimate research CTAs.
 * Keep in lockstep with gpu_provider/geometry/mesh_qa.py and
 * schemas/case_manifest.json.
 */
export const DATA_QUALITY_THRESHOLDS = {
  maxSliceThicknessMm: 1.0,
  minContrastBloodPoolHu: 300,
  maxContrastBloodPoolHu: 600,
  acceptedContrastPhases: ["arterial", "cardiac"] as const,
  taviRootCoverageMinZMm: 80,
  vsrrRootCoverageMinZMm: 150,
  pearsCoverageMinZMm: 200,
  iliofemoralCoverageMinZMm: 280,
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
