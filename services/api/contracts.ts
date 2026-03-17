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

export interface DefaultCaseBundle {
  manifest: Record<string, unknown>;
  artifacts: Record<string, string>;
  meshes: Record<string, string>;
  reports: Record<string, string>;
  qa: Record<string, string>;
  imaging: Record<string, string>;
  digests: Record<string, string>;
}
