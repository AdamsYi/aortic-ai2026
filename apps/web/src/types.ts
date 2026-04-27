/**
 * AorticAI Workstation — Shared type definitions & constants
 * Extracted from main.ts for modularity.
 */

// ── Geometry ────────────────────────────────────────────────────────────────
export type Point3 = [number, number, number];

// ── Volume / Imaging ────────────────────────────────────────────────────────
export type NiftiVoxelArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

export type VolumeSource = {
  source_kind: 'nifti' | 'dicom_zip';
  loader_kind: 'cornerstone-nifti' | 'cornerstone-dicom-zip';
  signed_url: string;
  content_type?: string | null;
  filename?: string | null;
  frame_of_reference_hint?: string | null;
  spacing_hint?: number[] | null;
  direction_hint?: number[] | null;
};

// ── Planes / Landmarks ──────────────────────────────────────────────────────
export type PlaneDefinition = {
  id?: string;
  label?: string;
  status?: string | null;
  confidence?: number | null;
  origin_world?: Point3;
  normal_world?: Point3;
  basis_u_world?: Point3;
  basis_v_world?: Point3;
  ring_points_world?: Point3[];
  source_index?: number | null;
};

export type CenterlinePayload = {
  point_count?: number;
  points_world?: Point3[];
  points_voxel?: Point3[] | null;
  s_mm?: number[];
  radii_mm?: number[] | null;
  tangents_world?: Point3[];
  method?: string | null;
  status?: string | null;
  confidence?: number | null;
  fallback_reason?: string | null;
  branch_graph?: Record<string, unknown> | null;
};

export type CprSources = {
  reference_json?: Record<string, unknown> | null;
  straightened_nifti?: string | null;
  source?: string | null;
  inferred?: boolean;
};

// ── Capabilities ────────────────────────────────────────────────────────────
export type CapabilityState = {
  available?: boolean;
  inferred?: boolean;
  legacy?: boolean;
  source?: string | null;
  reason?: string | null;
};

export type WorkstationCapabilities = {
  cpr?: CapabilityState | null;
  coronary_ostia?: CapabilityState | null;
  leaflet_geometry?: CapabilityState | null;
  pears_geometry?: CapabilityState | null;
};

// ── Acceptance Review ───────────────────────────────────────────────────────
export type AcceptanceDomain = {
  status?: 'pass' | 'needs_review' | 'blocked' | string;
  summary?: string | null;
  blockers?: string[] | null;
  review_flags?: string[] | null;
};

export type AcceptanceReview = {
  overall_status?: 'pass' | 'needs_review' | 'blocked' | string;
  summary?: string | null;
  human_review_required?: boolean;
  domains?: {
    viewing?: AcceptanceDomain | null;
    clinical?: AcceptanceDomain | null;
    planning?: AcceptanceDomain | null;
  } | null;
  next_actions?: string[] | null;
};

// ── Model Landmarks ─────────────────────────────────────────────────────────
export type ModelLandmarksSummary = {
  annulus?: Record<string, unknown> | null;
  stj?: Record<string, unknown> | null;
  commissures?: Record<string, unknown>[] | null;
  coronary_ostia?: Record<string, unknown> | null;
  leaflet_status?: Record<string, unknown>[] | null;
};

// ── Case Payload ────────────────────────────────────────────────────────────
export type WorkstationCasePayload = {
  case_id?: string;
  display_ready?: boolean;
  completion_state?: string | null;
  missing_requirements?: string[] | null;
  display_name?: Record<string, string> | string | null;
  case_role?: string[] | null;
  placeholder?: boolean;
  not_real_cta?: boolean;
  build_version?: string;
  job: Record<string, unknown>;
  study_meta?: Record<string, unknown> | null;
  pipeline_run?: Record<string, unknown> | null;
  links: Record<string, string>;
  volume_source: VolumeSource;
  display_planes: {
    annulus?: PlaneDefinition | null;
    stj?: PlaneDefinition | null;
    centerline?: PlaneDefinition | null;
  };
  cpr_sources?: CprSources | null;
  viewer_bootstrap?: {
    focus_world?: Point3 | null;
    aux_mode?: AuxMode;
    centerline_index?: number | null;
    runtime_requirements?: {
      source_kind?: string;
      loader_kind?: string;
      supports_mpr?: boolean;
      supports_aux_plane?: boolean;
      supports_cpr?: boolean;
    } | null;
    qa_flags?: Record<string, boolean> | null;
    bootstrap_warnings?: string[] | null;
  } | null;
  centerline?: CenterlinePayload | null;
  model_landmarks_summary?: ModelLandmarksSummary | null;
  coronary_ostia_summary?: Record<string, unknown> | null;
  leaflet_geometry_summary?: Record<string, unknown> | null;
  measurement_contract?: Record<string, unknown> | null;
  planning_evidence?: Record<string, unknown> | null;
  measurements?: Record<string, unknown> | null;
  planning?: Record<string, unknown> | null;
  aortic_root_model?: Record<string, unknown> | null;
  pears_geometry?: Record<string, unknown> | null;
  capabilities?: WorkstationCapabilities | null;
  quality_gates?: Record<string, unknown> | null;
  quality_gates_summary?: Record<string, unknown> | null;
  failure_flags?: Record<string, unknown> | null;
  downloads?: {
    raw?: string | { label?: string; href: string } | null;
    json?: Array<string | { label?: string; href: string }> | null;
    stl?: Array<string | { label?: string; href: string }> | null;
    pdf?: string | { label?: string; href: string } | null;
  } | null;
  uncertainty_summary?: Record<string, unknown> | null;
  planning_summary?: Record<string, unknown> | null;
  acceptance_review?: AcceptanceReview | null;
  clinical_review?: AcceptanceReview | null;
};

// ── Annotation ──────────────────────────────────────────────────────────────
export type AnnotationRunState = {
  status: 'idle' | 'checking_provider' | 'provider_unavailable' | 'showcase_locked' | 'unavailable' | 'submitting' | 'queued' | 'running' | 'succeeded' | 'failed';
  studyId: string | null;
  jobId: string | null;
  message: string;
  detail: string;
};

export type ProviderHealthState = {
  checked: boolean;
  checking: boolean;
  ok: boolean;
  status: number | null;
  code: string | null;
  message: string;
  detail: string;
};

export type AnnotationUndoEntry =
  | {
      kind: 'remove_annotation';
      annotationUID: string;
    }
  | {
      kind: 'restore_snapshot';
      snapshot: unknown;
    };

// ── UI Modes ────────────────────────────────────────────────────────────────
export type Locale = 'zh-CN' | 'en';
export type AuxMode = 'annulus' | 'stj' | 'centerline' | 'cpr';
export type CaseMode = 'showcase' | 'latest';
export type LayoutMode = 'grid-2x2' | 'single';
export type ViewportKey = 'axial' | 'sagittal' | 'coronal' | 'aux';
export type DisplayViewportKey = 'axial' | 'sagittal' | 'coronal' | 'three';
export type ViewportSliceKey = 'axial' | 'sagittal' | 'coronal' | 'aux';

export type PrimaryToolMode =
  | 'crosshair'
  | 'windowLevel'
  | 'pan'
  | 'zoom'
  | 'length'
  | 'angle'
  | 'probe'
  | 'rectangleRoi';

export type WindowPresetId = 'softTissue' | 'ctaVessel' | 'calcium' | 'wide';

export type BootStage =
  | 'loading_shell'
  | 'loading_runtime'
  | 'loading_case_index'
  | 'loading_case_payload'
  | 'initializing_volume'
  | 'initializing_viewports'
  | 'ready'
  | 'failed';

// ── Manual Review ───────────────────────────────────────────────────────────
export type ManualReviewFieldKey =
  | 'annulus_diameter_mm'
  | 'sinus_diameter_mm'
  | 'stj_diameter_mm'
  | 'coronary_height_left_mm'
  | 'coronary_height_right_mm';

export type ManualAnnotationRecord = {
  case_id: string;
  annotator: string;
  annotation_date: string;
  measurements: Record<ManualReviewFieldKey, { value: number | null; method?: string }>;
  comparison: {
    auto_vs_manual_diff_mm: Record<ManualReviewFieldKey, number | null>;
    acceptable_threshold_mm: number;
  };
};

// ── Viewer Session ──────────────────────────────────────────────────────────
export type SyncController = {
  add: (target: { renderingEngineId: string; viewportId: string }) => void;
  destroy?: () => void;
};

export type ViewerSession = {
  renderingEngine: import('@cornerstonejs/core').RenderingEngine;
  viewportIds: Record<ViewportKey, string>;
  toolGroupId: string;
  volumeId: string;
  volumeImageIds: string[];
  cprVolumeId: string | null;
  cprImageIds: string[];
  syncs: SyncController[];
  dicomImageIds: string[];
};

export type ThreeRuntime = {
  scene: any;
  camera: any;
  renderer: any;
  controls: any;
  rootGroup: any;
  layerGroups: Record<string, any>;
  meshGroups: Record<string, any>;
  meshState: Record<string, { visible: boolean; opacity: number; label: string }>;
  animationHandle: number | null;
  raycaster: any;
  pointer: any;
  resizeHandler: (() => void) | null;
};

// ── Fallback ────────────────────────────────────────────────────────────────
export type FallbackPreviewVolume = {
  dims: [number, number, number];
  data: NiftiVoxelArray;
  min: number;
  max: number;
};

export type FallbackMprState = {
  volume: FallbackPreviewVolume;
  slices: Record<ViewportSliceKey, number>;
};

// ── Constants ───────────────────────────────────────────────────────────────
export const BUILD_VERSION = (window as any).__AORTIC_BUILD_VERSION__ || 'dev';
export const API_BASE = '/api';
export const DEFAULT_CASE_API_PREFIX = `${API_BASE}/cases/default_clinical_case`;
export const SHOWCASE_CASE_ID = 'default_clinical_case';
export const PRIMARY_REAL_CASE_ID = 'mao_mianqiang_preop';
export const DEFAULT_PRIMARY_TOOL: PrimaryToolMode = 'crosshair';
export const DEFAULT_WINDOW_PRESET: WindowPresetId = 'softTissue';
export const DEFAULT_CINE_FPS = 8;
export const MPR_INIT_TIMEOUT_MS = 12000;
export const THREE_INIT_TIMEOUT_MS = 30000;
export const MANUAL_REVIEW_THRESHOLD_MM = 1.5;

export const VIEWPORT_IDS: Record<ViewportKey, string> = {
  axial: 'mpr-axial',
  sagittal: 'mpr-sagittal',
  coronal: 'mpr-coronal',
  aux: 'mpr-aux',
};

export const RENDERING_ENGINE_ID_PREFIX = 'aorticai-mpr-engine';
export const TOOL_GROUP_ID_PREFIX = 'aorticai-mpr-tools';

export const PRIMARY_TOOL_LABELS: Record<PrimaryToolMode, string> = {
  crosshair: 'Crosshair',
  windowLevel: 'Window/Level',
  pan: 'Pan',
  zoom: 'Zoom',
  length: 'Length',
  angle: 'Angle',
  probe: 'Probe',
  rectangleRoi: 'Rectangle ROI',
};

export const WINDOW_PRESETS: Record<WindowPresetId, { label: string; lower: number; upper: number }> = {
  softTissue: { label: 'Soft tissue', lower: -160, upper: 240 },
  ctaVessel: { label: 'CTA vessel', lower: -150, upper: 850 },
  calcium: { label: 'Calcium', lower: 150, upper: 1300 },
  wide: { label: 'Wide', lower: -700, upper: 1400 },
};

export const MANUAL_REVIEW_FIELDS: Array<{
  key: ManualReviewFieldKey;
  autoKey: string;
  method: string;
  labelKey: string;
}> = [
  { key: 'annulus_diameter_mm', autoKey: 'annulus_equivalent_diameter_mm', method: 'double_oblique', labelKey: 'manual.annulus_diameter' },
  { key: 'sinus_diameter_mm', autoKey: 'sinus_diameter_mm', method: 'double_oblique', labelKey: 'manual.sinus_diameter' },
  { key: 'stj_diameter_mm', autoKey: 'stj_diameter_mm', method: 'double_oblique', labelKey: 'manual.stj_diameter' },
  { key: 'coronary_height_left_mm', autoKey: 'coronary_height_left_mm', method: 'landmark_distance', labelKey: 'manual.coronary_height_left' },
  { key: 'coronary_height_right_mm', autoKey: 'coronary_height_right_mm', method: 'landmark_distance', labelKey: 'manual.coronary_height_right' },
];

// ── URL helpers ─────────────────────────────────────────────────────────────
export function defaultCaseArtifactUrl(name: string): string {
  return `${DEFAULT_CASE_API_PREFIX}/artifacts/${name}`;
}

export function defaultCaseMeshUrl(name: string): string {
  return `${DEFAULT_CASE_API_PREFIX}/meshes/${name}`;
}

export function defaultCaseReportUrl(name = 'report.pdf'): string {
  return `${DEFAULT_CASE_API_PREFIX}/reports/${name}`;
}
