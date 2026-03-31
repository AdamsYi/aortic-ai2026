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

export interface DefaultCaseBundle {
  manifest: Record<string, unknown>;
  artifacts: Record<string, string>;
  meshes: Record<string, string>;
  reports: Record<string, string>;
  qa: Record<string, string>;
  imaging: Record<string, string>;
  digests: Record<string, string>;
}
