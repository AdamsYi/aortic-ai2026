import {
  Enums as CoreEnums,
  RenderingEngine,
  cache,
  eventTarget,
  init as cornerstoneInit,
  metaData,
  registerImageLoader,
  setVolumesForViewports,
  volumeLoader,
} from '@cornerstonejs/core';
import cornerstoneDICOMImageLoader, { init as dicomImageLoaderInit } from '@cornerstonejs/dicom-image-loader';
import {
  cornerstoneNiftiImageLoader,
  createNiftiImageIdsAndCacheMetadata,
  init as niftiVolumeLoaderInit,
} from '@cornerstonejs/nifti-volume-loader';
import {
  AngleTool,
  Enums as ToolEnums,
  LengthTool,
  PanTool,
  ProbeTool,
  RectangleROITool,
  ToolGroupManager,
  WindowLevelTool,
  ZoomTool,
  addTool,
  annotation,
  init as cornerstoneToolsInit,
  synchronizers,
} from '@cornerstonejs/tools';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import zhCN from './i18n/zh-CN';
import enUS from './i18n/en';

declare global {
  interface Window {
    __AORTIC_BUILD_VERSION__?: string;
  }
}

type Point3 = [number, number, number];

type VolumeSource = {
  source_kind: 'nifti' | 'dicom_zip';
  loader_kind: 'cornerstone-nifti' | 'cornerstone-dicom-zip';
  signed_url: string;
  content_type?: string | null;
  filename?: string | null;
  frame_of_reference_hint?: string | null;
  spacing_hint?: number[] | null;
  direction_hint?: number[] | null;
};

type PlaneDefinition = {
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

type CenterlinePayload = {
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

type CprSources = {
  reference_json?: Record<string, unknown> | null;
  straightened_nifti?: string | null;
  source?: string | null;
  inferred?: boolean;
};

type CapabilityState = {
  available?: boolean;
  inferred?: boolean;
  legacy?: boolean;
  source?: string | null;
  reason?: string | null;
};

type WorkstationCapabilities = {
  cpr?: CapabilityState | null;
  coronary_ostia?: CapabilityState | null;
  leaflet_geometry?: CapabilityState | null;
  pears_geometry?: CapabilityState | null;
};

type AcceptanceDomain = {
  status?: 'pass' | 'needs_review' | 'blocked' | string;
  summary?: string | null;
  blockers?: string[] | null;
  review_flags?: string[] | null;
};

type AcceptanceReview = {
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

type ModelLandmarksSummary = {
  annulus?: Record<string, unknown> | null;
  stj?: Record<string, unknown> | null;
  commissures?: Record<string, unknown>[] | null;
  coronary_ostia?: Record<string, unknown> | null;
  leaflet_status?: Record<string, unknown>[] | null;
};

type WorkstationCasePayload = {
  case_id?: string;
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

type AnnotationRunState = {
  status: 'idle' | 'checking_provider' | 'provider_unavailable' | 'showcase_locked' | 'unavailable' | 'submitting' | 'queued' | 'running' | 'succeeded' | 'failed';
  studyId: string | null;
  jobId: string | null;
  message: string;
  detail: string;
};

type ProviderHealthState = {
  checked: boolean;
  checking: boolean;
  ok: boolean;
  status: number | null;
  code: string | null;
  message: string;
  detail: string;
};

type AnnotationUndoEntry =
  | {
      kind: 'remove_annotation';
      annotationUID: string;
    }
  | {
      kind: 'restore_snapshot';
      snapshot: unknown;
    };

type Locale = 'zh-CN' | 'en';
type ManualReviewFieldKey =
  | 'annulus_diameter_mm'
  | 'sinus_diameter_mm'
  | 'stj_diameter_mm'
  | 'coronary_height_left_mm'
  | 'coronary_height_right_mm';

type ManualAnnotationRecord = {
  case_id: string;
  annotator: string;
  annotation_date: string;
  measurements: Record<ManualReviewFieldKey, { value: number | null; method?: string }>;
  comparison: {
    auto_vs_manual_diff_mm: Record<ManualReviewFieldKey, number | null>;
    acceptable_threshold_mm: number;
  };
};

type AuxMode = 'annulus' | 'stj' | 'centerline' | 'cpr';
type CaseMode = 'showcase' | 'latest';
type LayoutMode = 'grid-2x2' | 'single';

type ViewportKey = 'axial' | 'sagittal' | 'coronal' | 'aux';
type DisplayViewportKey = 'axial' | 'sagittal' | 'coronal' | 'three';

type PrimaryToolMode =
  | 'crosshair'
  | 'windowLevel'
  | 'pan'
  | 'zoom'
  | 'length'
  | 'angle'
  | 'probe'
  | 'rectangleRoi';

type WindowPresetId = 'softTissue' | 'ctaVessel' | 'calcium' | 'wide';

type ViewerSession = {
  renderingEngine: RenderingEngine;
  viewportIds: Record<ViewportKey, string>;
  toolGroupId: string;
  volumeId: string;
  volumeImageIds: string[];
  cprVolumeId: string | null;
  cprImageIds: string[];
  syncs: SyncController[];
  dicomImageIds: string[];
};

type SyncController = {
  add: (target: { renderingEngineId: string; viewportId: string }) => void;
  destroy?: () => void;
};

type ThreeRuntime = {
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

type BootStage =
  | 'loading_shell'
  | 'loading_runtime'
  | 'loading_case_index'
  | 'loading_case_payload'
  | 'initializing_volume'
  | 'initializing_viewports'
  | 'ready'
  | 'failed';

const BUILD_VERSION = window.__AORTIC_BUILD_VERSION__ || 'dev';
const API_BASE = '/api';
const DEFAULT_CASE_API_PREFIX = `${API_BASE}/cases/default_clinical_case`;
const SHOWCASE_CASE_ID = 'default_clinical_case';
const DEFAULT_PRIMARY_TOOL: PrimaryToolMode = 'crosshair';
const DEFAULT_WINDOW_PRESET: WindowPresetId = 'ctaVessel';
const DEFAULT_CINE_FPS = 8;
const VIEWPORT_IDS: Record<ViewportKey, string> = {
  axial: 'mpr-axial',
  sagittal: 'mpr-sagittal',
  coronal: 'mpr-coronal',
  aux: 'mpr-aux',
};
const RENDERING_ENGINE_ID_PREFIX = 'aorticai-mpr-engine';
const TOOL_GROUP_ID_PREFIX = 'aorticai-mpr-tools';
const MPR_INIT_TIMEOUT_MS = 12000;
const THREE_INIT_TIMEOUT_MS = 30000;

function defaultCaseArtifactUrl(name: string): string {
  return `${DEFAULT_CASE_API_PREFIX}/artifacts/${name}`;
}

function defaultCaseMeshUrl(name: string): string {
  return `${DEFAULT_CASE_API_PREFIX}/meshes/${name}`;
}

function defaultCaseReportUrl(name = 'report.pdf'): string {
  return `${DEFAULT_CASE_API_PREFIX}/reports/${name}`;
}

const PRIMARY_TOOL_LABELS: Record<PrimaryToolMode, string> = {
  crosshair: 'Crosshair',
  windowLevel: 'Window/Level',
  pan: 'Pan',
  zoom: 'Zoom',
  length: 'Length',
  angle: 'Angle',
  probe: 'Probe',
  rectangleRoi: 'Rectangle ROI',
};

const WINDOW_PRESETS: Record<WindowPresetId, { label: string; lower: number; upper: number }> = {
  softTissue: { label: 'Soft tissue', lower: -160, upper: 240 },
  ctaVessel: { label: 'CTA vessel', lower: -150, upper: 850 },
  calcium: { label: 'Calcium', lower: 150, upper: 1300 },
  wide: { label: 'Wide', lower: -700, upper: 1400 },
};

const ROOT = document.getElementById('app');

if (!ROOT) {
  throw new Error('missing_app_root');
}
const APP_ROOT = ROOT as HTMLDivElement;

let cornerstoneReady = false;
let toolsRegistered = false;
let session: ViewerSession | null = null;
let activeCase: WorkstationCasePayload | null = null;
let caseLoadSerial = 0;
let currentCrosshairWorld: Point3 | null = null;
let currentAuxMode: AuxMode = 'annulus';
let currentCenterlineIndex = 0;
let dicomZipWorker: Worker | null = null;
let threeRuntime: ThreeRuntime | null = null;
let currentActiveViewport: ViewportKey = 'axial';
let currentDisplayViewport: DisplayViewportKey = 'axial';
let currentLayoutMode: LayoutMode = 'grid-2x2';
let currentBootStage: BootStage = 'loading_shell';
let lastBootError: string | null = null;
let mprWatchdogHandle: number | null = null;
let lastMprError: string | null = null;
let lastThreeError: string | null = null;
let viewerSessionSerial = 0;
let currentLocale: Locale = 'en';
let currentPrimaryTool: PrimaryToolMode = DEFAULT_PRIMARY_TOOL;
let currentWindowPreset: WindowPresetId = DEFAULT_WINDOW_PRESET;
let cineTimerHandle: number | null = null;
let fallbackCineActive = false;
let cineFps = DEFAULT_CINE_FPS;
let annotationRunState: AnnotationRunState = {
  status: 'idle',
  studyId: null,
  jobId: null,
  message: 'Auto annotation is ready for the active study.',
  detail: 'Root, annulus, sinus, STJ, coronary ostia, and leaflet geometry will be requested together.',
};
let providerHealthState: ProviderHealthState = {
  checked: false,
  checking: false,
  ok: false,
  status: null,
  code: null,
  message: 'Checking annotation provider…',
  detail: 'Verifying the external GPU annotation service before enabling this action.',
};
let providerHealthPromise: Promise<ProviderHealthState> | null = null;
let autoAnnotationRequestedForStudy: string | null = null;
let annotationUndoStack: AnnotationUndoEntry[] = [];
let ignoreAnnotationEvents = false;
let annotationBridgeReady = false;
let defaultMeasurementsArtifact: Record<string, unknown> | null = null;
let defaultPlanningArtifact: Record<string, unknown> | null = null;
let defaultCaseManifestArtifact: Record<string, unknown> | null = null;
let defaultAnnulusPlaneArtifact: Record<string, unknown> | null = null;
let coronaryReviewBannerAcknowledged = false;
let currentPlanningTab: 'TAVI' | 'VSRR' | 'PEARS' = 'TAVI';
let planningPanelCollapsed = false;
let measurementsPanelCollapsed = false;
let submitJobPollHandle: number | null = null;
let activeSubmissionJobId: string | null = null;
let manualAnnotationRecord: ManualAnnotationRecord | null = null;
let manualAnnotationCaseId: string | null = null;
let manualReviewCollapsed = false;
const activeLandmarkLayers: Record<string, boolean> = {
  annulus: true,
  commissures: true,
  sinus_peaks: true,
  stj: true,
  coronary_ostia: true,
  centerline: true,
};

const I18N: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN,
  en: enUS,
};

const DOM = {
  headerStatus: null as HTMLDivElement | null,
  bootStage: null as HTMLDivElement | null,
  demoCaseBadge: null as HTMLSpanElement | null,
  coronaryReviewBanner: null as HTMLDivElement | null,
  coronaryReviewAcknowledge: null as HTMLButtonElement | null,
  caseInfoLeft: null as HTMLDivElement | null,
  caseInfoCenter: null as HTMLDivElement | null,
  caseInfoRight: null as HTMLDivElement | null,
  gpuStatusDot: null as HTMLSpanElement | null,
  gpuStatusText: null as HTMLSpanElement | null,
  submitCaseButton: null as HTMLButtonElement | null,
  submitCaseModal: null as HTMLDivElement | null,
  submitCaseClose: null as HTMLButtonElement | null,
  submitCaseForm: null as HTMLFormElement | null,
  submitCaseFile: null as HTMLInputElement | null,
  submitCasePatientId: null as HTMLInputElement | null,
  submitCaseSubmit: null as HTMLButtonElement | null,
  jobProgressBanner: null as HTMLDivElement | null,
  jobProgressFill: null as HTMLDivElement | null,
  jobProgressLabel: null as HTMLSpanElement | null,
  bootOverlay: null as HTMLDivElement | null,
  bootOverlayTitle: null as HTMLHeadingElement | null,
  bootOverlayText: null as HTMLParagraphElement | null,
  bootOverlayDetail: null as HTMLPreElement | null,
  retryLatestButton: null as HTMLButtonElement | null,
  caseMeta: null as HTMLDivElement | null,
  mprStatus: null as HTMLDivElement | null,
  layoutGridButton: null as HTMLButtonElement | null,
  layoutSingleButton: null as HTMLButtonElement | null,
  toolButtons: [] as HTMLButtonElement[],
  windowPreset: null as HTMLSelectElement | null,
  cineToggle: null as HTMLButtonElement | null,
  cineSpeed: null as HTMLSelectElement | null,
  resetViewportButton: null as HTMLButtonElement | null,
  auxMode: null as HTMLSelectElement | null,
  centerlineSlider: null as HTMLInputElement | null,
  centerlineValue: null as HTMLSpanElement | null,
  loadShowcaseButton: null as HTMLAnchorElement | null,
  loadLatestButton: null as HTMLAnchorElement | null,
  reportOpenButton: null as HTMLButtonElement | null,
  focusAnnulusButton: null as HTMLButtonElement | null,
  focusStjButton: null as HTMLButtonElement | null,
  focusRootButton: null as HTMLButtonElement | null,
  focusCoronaryButton: null as HTMLButtonElement | null,
  undoMeasurementButton: null as HTMLButtonElement | null,
  deleteMeasurementButton: null as HTMLButtonElement | null,
  clearMeasurementsButton: null as HTMLButtonElement | null,
  backToCrosshairButton: null as HTMLButtonElement | null,
  localeButtons: [] as HTMLButtonElement[],
  measurementGrid: null as HTMLDivElement | null,
  planningGrid: null as HTMLDivElement | null,
  planningPanelSection: null as HTMLElement | null,
  measurementPanelSection: null as HTMLElement | null,
  planningPanelToggle: null as HTMLButtonElement | null,
  manualReviewToggle: null as HTMLButtonElement | null,
  measurementPanelToggle: null as HTMLButtonElement | null,
  exportMeasurementsCsv: null as HTMLButtonElement | null,
  manualReviewGrid: null as HTMLDivElement | null,
  manualReviewStatus: null as HTMLDivElement | null,
  manualReviewSection: null as HTMLElement | null,
  pearsPanel: null as HTMLDivElement | null,
  qaList: null as HTMLUListElement | null,
  evidenceList: null as HTMLUListElement | null,
  downloadList: null as HTMLDivElement | null,
  acceptanceSummary: null as HTMLDivElement | null,
  acceptanceList: null as HTMLUListElement | null,
  capabilityGrid: null as HTMLDivElement | null,
  caseOverviewSummary: null as HTMLDivElement | null,
  annotationStatus: null as HTMLDivElement | null,
  annotationDetail: null as HTMLDivElement | null,
  annotationButton: null as HTMLButtonElement | null,
  rawBlock: null as HTMLPreElement | null,
  threeStage: null as HTMLDivElement | null,
  threeFallback: null as HTMLDivElement | null,
  landmarkLayerButtons: [] as HTMLButtonElement[],
  planningTabButtons: [] as HTMLButtonElement[],
  threeMeshToggles: [] as HTMLInputElement[],
  threeMeshOpacity: [] as HTMLInputElement[],
  threeLayerToggles: [] as HTMLInputElement[],
  threeScreenshotButton: null as HTMLButtonElement | null,
  reportDrawer: null as HTMLDivElement | null,
  reportCloseButton: null as HTMLButtonElement | null,
  reportDownloadLink: null as HTMLAnchorElement | null,
  reportFrame: null as HTMLIFrameElement | null,
  viewportCardThree: null as HTMLDivElement | null,
  viewportElements: {} as Record<ViewportKey, HTMLDivElement>,
  viewportCards: {} as Record<ViewportKey, HTMLDivElement>,
  viewportBadges: {} as Record<ViewportKey, HTMLDivElement>,
  viewportFooters: {} as Record<ViewportKey, HTMLDivElement>,
  viewportPlaceholders: {} as Record<ViewportKey, HTMLDivElement>,
};

const MANUAL_REVIEW_THRESHOLD_MM = 1.5;
const MANUAL_REVIEW_FIELDS: Array<{
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

function renderShell(): void {
  document.getElementById('pre-load')?.remove();
  APP_ROOT.innerHTML = `
    <div class="workstation">
      <div class="case-info-bar">
        <div class="case-info-left" id="case-info-left">Case default_clinical_case · Scan n/a</div>
        <div class="case-info-center" id="case-info-center">AorticAI</div>
        <div class="case-info-right" id="case-info-right">Pipeline n/a · Build ${escapeHtml(BUILD_VERSION)} · <span class="quality-badge quality-needs_review">needs_review</span></div>
      </div>
      <header class="app-header">
        <div class="header-title">
          <h1 data-i18n="app.brand">AorticAI</h1>
          <p data-i18n="app.subtitle">Structural Heart Planning Platform</p>
        </div>
        <div class="header-actions">
          <div class="gpu-status-chip" id="gpu-status-chip">
            <span class="gpu-dot gpu-offline" id="gpu-status-dot"></span>
            <span id="gpu-status-text">GPU offline</span>
          </div>
          <a id="load-showcase" class="case-mode-button" href="/demo" data-i18n="action.open_showcase">Showcase</a>
          <a id="load-latest" class="case-mode-button" href="/demo?case=latest" data-i18n="action.load_case">Latest Case</a>
          <button id="submit-case" class="primary-action-button" data-i18n="action.submit_case">Submit Case</button>
          <button id="run-annotation" class="primary-action-button" data-i18n="action.run_annotation">Run Auto Annotation</button>
          <button id="open-report" data-i18n="action.open_report">Report</button>
          <button id="focus-annulus" data-i18n="action.focus_annulus">Annulus</button>
          <button id="focus-stj" data-i18n="action.focus_stj">STJ</button>
          <button id="focus-root" data-i18n="action.focus_root">Root</button>
          <button id="focus-coronary" data-i18n="action.focus_coronary">Coronary</button>
          <span id="demo-case-badge" class="demo-case-badge hidden" data-i18n="label.demo_case_badge">示范病例 / Demo Case</span>
          <div class="cluster locale-cluster">
            <button type="button" class="locale-button" data-locale-switch="en">EN</button>
            <button type="button" class="locale-button" data-locale-switch="zh-CN">中文</button>
          </div>
          <div class="status-chip" id="header-status">Initializing...</div>
          <div class="status-chip" id="boot-stage">loading_shell</div>
        </div>
      </header>
      <div class="coronary-review-banner hidden" id="coronary-review-banner">
        <div class="coronary-review-banner-text" data-i18n="banner.coronary_review_required">⚠️ Coronary ostia detection requires clinician review before use in planning / 冠脉开口检测需要临床医生复核后方可用于规划</div>
        <button type="button" id="coronary-review-ack" data-i18n="action.acknowledged">Acknowledged</button>
      </div>
      <div class="job-progress-banner hidden" id="job-progress-banner">
        <div class="job-progress-head">
          <span data-i18n="label.processing_case">Processing case</span>
          <span id="job-progress-label">Queued</span>
        </div>
        <div class="job-progress-track"><div id="job-progress-fill"></div></div>
      </div>
      <main class="workspace-grid">
        <section class="panel mpr-panel">
          <div class="mpr-toolbar">
            <div class="cluster">
              <span class="muted" id="case-meta">No case loaded</span>
            </div>
            <div class="cluster">
              <span class="tool-group-label" data-i18n="toolbar.layout">Layout</span>
              <button type="button" id="layout-grid" class="layout-button active" data-i18n="layout.grid_2x2">2x2</button>
              <button type="button" id="layout-single" class="layout-button" data-i18n="layout.single_view">Single</button>
            </div>
            <div class="cluster">
              <label for="aux-mode" data-i18n="label.aux_mode">Aux</label>
              <select id="aux-mode">
                <option value="annulus" data-i18n="aux.annulus">Annulus</option>
                <option value="stj" data-i18n="aux.stj">STJ</option>
                <option value="centerline" data-i18n="aux.centerline">Centerline</option>
                <option value="cpr">CPR</option>
              </select>
            </div>
            <div class="cluster">
              <label for="centerline-slider" data-i18n="label.centerline_short">CL</label>
              <input id="centerline-slider" type="range" min="0" max="0" value="0" step="1" />
              <span id="centerline-value" class="status-chip">0/0</span>
            </div>
            <div class="cluster">
              <span class="muted" id="mpr-status">Preparing engine...</span>
            </div>
          </div>
          <div class="mpr-toolrack">
            <div class="cluster tool-mode-cluster">
              <span class="tool-group-label" data-i18n="toolbar.tools">Tools</span>
              <button type="button" class="tool-button active" data-tool-mode="crosshair" data-i18n="tool.crosshair">Crosshair</button>
              <button type="button" class="tool-button" data-tool-mode="windowLevel" data-i18n="tool.window_level">Window/Level</button>
              <button type="button" class="tool-button" data-tool-mode="pan" data-i18n="tool.pan">Pan</button>
              <button type="button" class="tool-button" data-tool-mode="zoom" data-i18n="tool.zoom">Zoom</button>
              <button type="button" class="tool-button" data-tool-mode="length" data-i18n="tool.length">Length</button>
              <button type="button" class="tool-button" data-tool-mode="angle" data-i18n="tool.angle">Angle</button>
              <button type="button" class="tool-button" data-tool-mode="probe" data-i18n="tool.probe">Probe</button>
              <button type="button" class="tool-button" data-tool-mode="rectangleRoi" data-i18n="tool.rectangle_roi">Rectangle ROI</button>
            </div>
            <div class="cluster">
              <label for="window-preset" data-i18n="toolbar.window_preset">Preset</label>
              <select id="window-preset">
                <option value="softTissue" data-i18n="preset.soft_tissue">Soft tissue</option>
                <option value="ctaVessel" selected data-i18n="preset.cta_vessel">CTA vessel</option>
                <option value="calcium" data-i18n="preset.calcium">Calcium</option>
                <option value="wide" data-i18n="preset.wide">Wide</option>
              </select>
              <button type="button" id="reset-viewport" data-i18n="action.reset_viewport">Reset</button>
            </div>
            <div class="cluster">
              <label for="cine-speed" data-i18n="toolbar.cine">Cine</label>
              <button type="button" id="cine-toggle" data-i18n="action.play_cine">Play</button>
              <select id="cine-speed">
                <option value="4">4 fps</option>
                <option value="8" selected>8 fps</option>
                <option value="12">12 fps</option>
              </select>
            </div>
            <div class="cluster landmark-toolbar">
              <span class="tool-group-label" data-i18n="toolbar.landmarks">Landmarks</span>
              <button type="button" class="legend-toggle active" data-landmark-layer="annulus" data-i18n="landmark.annulus">Annulus</button>
              <button type="button" class="legend-toggle active" data-landmark-layer="commissures" data-i18n="landmark.commissures">Commissures</button>
              <button type="button" class="legend-toggle active" data-landmark-layer="sinus_peaks" data-i18n="landmark.sinus_peaks">Sinus peaks</button>
              <button type="button" class="legend-toggle active" data-landmark-layer="stj" data-i18n="landmark.stj">STJ</button>
              <button type="button" class="legend-toggle active" data-landmark-layer="coronary_ostia" data-i18n="landmark.coronary_ostia">Coronary ostia</button>
              <button type="button" class="legend-toggle active" data-landmark-layer="centerline" data-i18n="landmark.centerline">Centerline</button>
            </div>
            <div class="cluster annotation-edit-cluster">
              <span class="tool-group-label" data-i18n="toolbar.measurement_edit">Edit</span>
              <button type="button" id="undo-measurement" data-i18n="action.undo_measurement">Undo</button>
              <button type="button" id="delete-measurement" data-i18n="action.delete_measurement">Delete Selected</button>
              <button type="button" id="clear-measurements" data-i18n="action.clear_measurements">Clear All</button>
              <button type="button" id="back-to-crosshair" data-i18n="action.back_to_crosshair">Back to Crosshair</button>
            </div>
          </div>
          <div class="viewer-stage">
            <div class="mpr-grid layout-grid-2x2" id="mpr-grid">
              ${renderViewportCard('axial', 'Axial')}
              ${renderViewportCard('coronal', 'Coronal')}
              ${renderViewportCard('sagittal', 'Sagittal')}
              <div class="viewport-card viewport-card-three" id="viewport-card-three">
                <div class="viewport-label">3D</div>
                <div class="viewport-badge" id="viewport-badge-three">mesh</div>
                <div class="three-stage three-stage-grid">
                  <div class="three-root" id="three-root"></div>
                  <div class="three-fallback hidden" id="three-fallback"></div>
                </div>
                <div class="three-layer-controls">
                  <div class="three-layer-row">
                    <label><input type="checkbox" data-three-mesh-toggle="aortic_root" checked /> Root</label>
                    <input type="range" data-three-mesh-opacity="aortic_root" min="0" max="100" value="60" />
                  </div>
                  <div class="three-layer-row">
                    <label><input type="checkbox" data-three-mesh-toggle="leaflets" checked /> Leaflets</label>
                    <input type="range" data-three-mesh-opacity="leaflets" min="0" max="100" value="80" />
                  </div>
                  <div class="three-layer-row">
                    <label><input type="checkbox" data-three-mesh-toggle="ascending_aorta" checked /> Ascending</label>
                    <input type="range" data-three-mesh-opacity="ascending_aorta" min="0" max="100" value="40" />
                  </div>
                  <div class="three-layer-row">
                    <label><input type="checkbox" data-three-mesh-toggle="annulus_ring" checked /> Annulus ring</label>
                    <input type="range" data-three-mesh-opacity="annulus_ring" min="0" max="100" value="100" />
                  </div>
                  <div class="three-layer-row">
                    <label><input type="checkbox" data-three-layer-toggle="annulus_plane" checked /> Annulus Plane</label>
                    <span class="three-layer-note">plane + normal</span>
                  </div>
                  <button type="button" id="three-screenshot" data-i18n="action.export_png">Export PNG</button>
                </div>
              </div>
            </div>
            <div class="aux-hidden-runtime">${renderViewportCard('aux', 'Aux')}</div>
          </div>
        </section>
        <aside class="panel side-panel">
          <div class="panel-head">
            <div>
              <h2 data-i18n="panel.analysis_title">Clinical Review</h2>
              <div class="muted" data-i18n="panel.analysis_subtitle">Measurements, planning, review, downloads</div>
            </div>
          </div>
          <div class="side-scroll">
            <section class="info-card capability-card case-overview-card">
              <h4 data-i18n="panel.showcase_title">Case Overview</h4>
              <div class="case-overview-summary" id="case-overview-summary"></div>
              <div class="capability-grid" id="capability-grid">
                <div class="capability-item">
                  <div class="capability-title-row"><span class="capability-name">Cpr</span><span class="capability-pill capability-danger">Unavailable</span></div>
                  <div class="capability-source">unavailable</div>
                  <div class="capability-reason">cpr_artifact_missing</div>
                </div>
              </div>
              <div class="annotation-inline">
                <div class="section-subtitle" data-i18n="panel.annotation_title">Auto Annotation</div>
                <div class="annotation-status" id="annotation-status">Waiting for case context...</div>
                <div class="annotation-detail" id="annotation-detail">Root, annulus, sinus, STJ, coronary ostia, and leaflet geometry will be requested together.</div>
              </div>
            </section>
            <section class="info-card">
              <div class="section-head">
                <h4 data-i18n="panel.measurements_title">Measurements</h4>
                <div class="section-head-actions">
                  <button type="button" id="export-measurements-csv">Export CSV</button>
                  <button type="button" id="toggle-measurements-panel">Hide</button>
                </div>
              </div>
              <div class="metric-grid" id="measurement-grid">
                <div class="metric-row skeleton-shimmer">
                  <div class="metric-name">Annulus Equivalent Diameter</div>
                  <div class="metric-value">-- <span class="metric-unit">mm</span></div>
                </div>
              </div>
            </section>
            <section class="info-card" id="planning-panel-section">
              <div class="section-head">
                <h4 data-i18n="panel.planning_title">Surgical Planning</h4>
                <div class="section-head-actions">
                  <button type="button" id="toggle-planning-panel">Hide</button>
                </div>
              </div>
              <div class="manual-review-section" id="manual-review-section">
                <div class="section-head">
                  <h5 data-i18n="panel.manual_review_title">人工核查 / Manual Review</h5>
                  <div class="section-head-actions">
                    <button type="button" id="toggle-manual-review">Hide</button>
                  </div>
                </div>
                <div class="metric-grid manual-review-grid" id="manual-review-grid"></div>
                <div class="manual-review-status muted" id="manual-review-status"></div>
              </div>
              <div class="planning-tabs">
                <button type="button" class="planning-tab active" data-planning-tab="TAVI">TAVI</button>
                <button type="button" class="planning-tab" data-planning-tab="VSRR">VSRR</button>
                <button type="button" class="planning-tab" data-planning-tab="PEARS">PEARS</button>
              </div>
              <div class="metric-grid" id="planning-grid">
                <div class="metric-row skeleton-shimmer">
                  <div class="metric-name">TAVI · Access Route Assessment</div>
                  <div class="metric-value">--</div>
                </div>
                <div class="metric-row skeleton-shimmer">
                  <div class="metric-name">TAVI · Coronary Obstruction Risk</div>
                  <div class="metric-value">--</div>
                </div>
              </div>
            </section>
            <section class="info-card clinical-review-card">
              <h4 data-i18n="panel.acceptance_title">Acceptance Review</h4>
              <div class="acceptance-summary" id="acceptance-summary">Review Required · Awaiting acceptance context...</div>
              <ul class="qa-list acceptance-list" id="acceptance-list"></ul>
              <div class="section-subtitle" data-i18n="panel.qa_title">Landmark QA</div>
              <ul class="qa-list" id="qa-list">
                <li class="qa-item qa-warning">
                  <div class="qa-header"><span class="qa-category">Case</span><span class="qa-tone">reference</span></div>
                  <div class="qa-title">Showcase reference</div>
                </li>
                <li class="qa-item qa-warning">
                  <div class="qa-header"><span class="qa-category">Warning</span><span class="qa-tone">warning</span></div>
                  <div class="qa-title">Cpr Artifact Missing</div>
                </li>
              </ul>
            </section>
            <section class="info-card">
              <h4 data-i18n="panel.downloads_title">Downloads</h4>
              <div class="download-list" id="download-list"></div>
            </section>
          </div>
        </aside>
      </main>
      <div class="boot-overlay hidden" id="boot-overlay">
        <div class="boot-card skeleton-shimmer">
          <h2 id="boot-overlay-title">AorticAI</h2>
          <p id="boot-overlay-text">Initializing workstation...</p>
          <div class="boot-build-version">Build: ${escapeHtml(BUILD_VERSION)}</div>
          <pre class="code-block hidden" id="boot-overlay-detail"></pre>
          <div class="boot-actions">
            <button id="retry-latest" data-i18n="action.retry">Retry</button>
          </div>
        </div>
      </div>
      <aside class="report-drawer" id="report-drawer">
        <div class="report-drawer-head">
          <strong data-i18n="panel.report_title">Report</strong>
          <div class="report-drawer-actions">
            <a id="report-download" class="download-link" href="${defaultCaseReportUrl('report.pdf')}" download target="_blank" rel="noreferrer" data-i18n="action.download_report">Download</a>
            <button id="close-report" data-i18n="action.close_report">Close</button>
          </div>
        </div>
        <iframe id="report-frame" src="${defaultCaseReportUrl('report.pdf')}" title="AorticAI report"></iframe>
      </aside>
      <div class="shortcut-hint-bar">1 四格 | 2 全屏 | W/L 窗宽 | +/- 缩放 | R 重置 | P 规划 | M 测量 | ESC 关闭 | <span data-i18n="footer.research_only">仅供研究使用，不作为临床诊断依据 / For research use only</span></div>
      <div class="submit-case-modal hidden" id="submit-case-modal">
        <div class="submit-case-modal-card">
          <div class="submit-case-modal-head">
            <h3 data-i18n="modal.submit_case_title">Submit Case</h3>
            <button type="button" id="submit-case-close" data-i18n="action.close">Close</button>
          </div>
          <form id="submit-case-form" class="submit-case-form">
            <label data-i18n="label.case_file">Case File (.nii/.nii.gz)</label>
            <input type="file" id="submit-case-file" accept=".nii,.nii.gz,application/gzip,application/octet-stream" required />
            <label data-i18n="label.patient_id">Patient ID</label>
            <input type="text" id="submit-case-patient-id" placeholder="patient-001" />
            <button type="submit" id="submit-case-submit" class="primary-action-button" data-i18n="action.submit_case">Submit Case</button>
          </form>
        </div>
      </div>
    </div>
  `;

  DOM.headerStatus = document.getElementById('header-status') as HTMLDivElement;
  DOM.bootStage = document.getElementById('boot-stage') as HTMLDivElement;
  DOM.demoCaseBadge = document.getElementById('demo-case-badge') as HTMLSpanElement;
  DOM.coronaryReviewBanner = document.getElementById('coronary-review-banner') as HTMLDivElement;
  DOM.coronaryReviewAcknowledge = document.getElementById('coronary-review-ack') as HTMLButtonElement;
  DOM.caseInfoLeft = document.getElementById('case-info-left') as HTMLDivElement;
  DOM.caseInfoCenter = document.getElementById('case-info-center') as HTMLDivElement;
  DOM.caseInfoRight = document.getElementById('case-info-right') as HTMLDivElement;
  DOM.gpuStatusDot = document.getElementById('gpu-status-dot') as HTMLSpanElement;
  DOM.gpuStatusText = document.getElementById('gpu-status-text') as HTMLSpanElement;
  DOM.submitCaseButton = document.getElementById('submit-case') as HTMLButtonElement;
  DOM.submitCaseModal = document.getElementById('submit-case-modal') as HTMLDivElement;
  DOM.submitCaseClose = document.getElementById('submit-case-close') as HTMLButtonElement;
  DOM.submitCaseForm = document.getElementById('submit-case-form') as HTMLFormElement;
  DOM.submitCaseFile = document.getElementById('submit-case-file') as HTMLInputElement;
  DOM.submitCasePatientId = document.getElementById('submit-case-patient-id') as HTMLInputElement;
  DOM.submitCaseSubmit = document.getElementById('submit-case-submit') as HTMLButtonElement;
  DOM.jobProgressBanner = document.getElementById('job-progress-banner') as HTMLDivElement;
  DOM.jobProgressFill = document.getElementById('job-progress-fill') as HTMLDivElement;
  DOM.jobProgressLabel = document.getElementById('job-progress-label') as HTMLSpanElement;
  DOM.bootOverlay = document.getElementById('boot-overlay') as HTMLDivElement;
  DOM.bootOverlayTitle = document.getElementById('boot-overlay-title') as HTMLHeadingElement;
  DOM.bootOverlayText = document.getElementById('boot-overlay-text') as HTMLParagraphElement;
  DOM.bootOverlayDetail = document.getElementById('boot-overlay-detail') as HTMLPreElement;
  DOM.retryLatestButton = document.getElementById('retry-latest') as HTMLButtonElement;
  DOM.caseMeta = document.getElementById('case-meta') as HTMLDivElement;
  DOM.mprStatus = document.getElementById('mpr-status') as HTMLDivElement;
  DOM.layoutGridButton = document.getElementById('layout-grid') as HTMLButtonElement;
  DOM.layoutSingleButton = document.getElementById('layout-single') as HTMLButtonElement;
  DOM.toolButtons = Array.from(document.querySelectorAll('[data-tool-mode]')) as HTMLButtonElement[];
  DOM.windowPreset = document.getElementById('window-preset') as HTMLSelectElement;
  DOM.cineToggle = document.getElementById('cine-toggle') as HTMLButtonElement;
  DOM.cineSpeed = document.getElementById('cine-speed') as HTMLSelectElement;
  DOM.resetViewportButton = document.getElementById('reset-viewport') as HTMLButtonElement;
  DOM.auxMode = document.getElementById('aux-mode') as HTMLSelectElement;
  DOM.centerlineSlider = document.getElementById('centerline-slider') as HTMLInputElement;
  DOM.centerlineValue = document.getElementById('centerline-value') as HTMLSpanElement;
  DOM.loadShowcaseButton = document.getElementById('load-showcase') as HTMLAnchorElement;
  DOM.loadLatestButton = document.getElementById('load-latest') as HTMLAnchorElement;
  DOM.reportOpenButton = document.getElementById('open-report') as HTMLButtonElement;
  DOM.focusCoronaryButton = document.getElementById('focus-coronary') as HTMLButtonElement;
  DOM.focusAnnulusButton = document.getElementById('focus-annulus') as HTMLButtonElement;
  DOM.focusStjButton = document.getElementById('focus-stj') as HTMLButtonElement;
  DOM.focusRootButton = document.getElementById('focus-root') as HTMLButtonElement;
  DOM.undoMeasurementButton = document.getElementById('undo-measurement') as HTMLButtonElement;
  DOM.deleteMeasurementButton = document.getElementById('delete-measurement') as HTMLButtonElement;
  DOM.clearMeasurementsButton = document.getElementById('clear-measurements') as HTMLButtonElement;
  DOM.backToCrosshairButton = document.getElementById('back-to-crosshair') as HTMLButtonElement;
  DOM.localeButtons = Array.from(document.querySelectorAll('[data-locale-switch]')) as HTMLButtonElement[];
  DOM.measurementGrid = document.getElementById('measurement-grid') as HTMLDivElement;
  DOM.planningGrid = document.getElementById('planning-grid') as HTMLDivElement;
  DOM.planningPanelSection = document.getElementById('planning-panel-section');
  DOM.measurementPanelSection = DOM.measurementGrid?.closest('.info-card') as HTMLElement | null;
  DOM.planningPanelToggle = document.getElementById('toggle-planning-panel') as HTMLButtonElement;
  DOM.manualReviewToggle = document.getElementById('toggle-manual-review') as HTMLButtonElement;
  DOM.measurementPanelToggle = document.getElementById('toggle-measurements-panel') as HTMLButtonElement;
  DOM.exportMeasurementsCsv = document.getElementById('export-measurements-csv') as HTMLButtonElement;
  DOM.manualReviewGrid = document.getElementById('manual-review-grid') as HTMLDivElement;
  DOM.manualReviewStatus = document.getElementById('manual-review-status') as HTMLDivElement;
  DOM.manualReviewSection = document.getElementById('manual-review-section') as HTMLElement;
  DOM.pearsPanel = document.getElementById('pears-panel') as HTMLDivElement;
  DOM.qaList = document.getElementById('qa-list') as HTMLUListElement;
  DOM.evidenceList = document.getElementById('evidence-list') as HTMLUListElement;
  DOM.downloadList = document.getElementById('download-list') as HTMLDivElement;
  DOM.acceptanceSummary = document.getElementById('acceptance-summary') as HTMLDivElement;
  DOM.acceptanceList = document.getElementById('acceptance-list') as HTMLUListElement;
  DOM.capabilityGrid = document.getElementById('capability-grid') as HTMLDivElement;
  DOM.caseOverviewSummary = document.getElementById('case-overview-summary') as HTMLDivElement;
  DOM.annotationStatus = document.getElementById('annotation-status') as HTMLDivElement;
  DOM.annotationDetail = document.getElementById('annotation-detail') as HTMLDivElement;
  DOM.annotationButton = document.getElementById('run-annotation') as HTMLButtonElement;
  DOM.rawBlock = document.getElementById('viewer-state') as HTMLPreElement;
  DOM.threeStage = document.getElementById('three-root') as HTMLDivElement;
  DOM.threeFallback = document.getElementById('three-fallback') as HTMLDivElement;
  DOM.viewportCardThree = document.getElementById('viewport-card-three') as HTMLDivElement;
  DOM.landmarkLayerButtons = Array.from(document.querySelectorAll('[data-landmark-layer]')) as HTMLButtonElement[];
  DOM.planningTabButtons = Array.from(document.querySelectorAll('[data-planning-tab]')) as HTMLButtonElement[];
  DOM.threeMeshToggles = Array.from(document.querySelectorAll('[data-three-mesh-toggle]')) as HTMLInputElement[];
  DOM.threeMeshOpacity = Array.from(document.querySelectorAll('[data-three-mesh-opacity]')) as HTMLInputElement[];
  DOM.threeLayerToggles = Array.from(document.querySelectorAll('[data-three-layer-toggle]')) as HTMLInputElement[];
  DOM.threeScreenshotButton = document.getElementById('three-screenshot') as HTMLButtonElement;
  DOM.reportDrawer = document.getElementById('report-drawer') as HTMLDivElement;
  DOM.reportCloseButton = document.getElementById('close-report') as HTMLButtonElement;
  DOM.reportDownloadLink = document.getElementById('report-download') as HTMLAnchorElement;
  DOM.reportFrame = document.getElementById('report-frame') as HTMLIFrameElement;

  (['axial', 'sagittal', 'coronal', 'aux'] as ViewportKey[]).forEach((key) => {
    DOM.viewportElements[key] = document.getElementById(`viewport-${key}`) as HTMLDivElement;
    DOM.viewportCards[key] = document.getElementById(`viewport-card-${key}`) as HTMLDivElement;
    DOM.viewportBadges[key] = document.getElementById(`viewport-badge-${key}`) as HTMLDivElement;
    DOM.viewportFooters[key] = document.getElementById(`viewport-footer-${key}`) as HTMLDivElement;
    DOM.viewportPlaceholders[key] = document.getElementById(`viewport-placeholder-${key}`) as HTMLDivElement;
  });

  DOM.loadShowcaseButton?.addEventListener('click', (event) => {
    event.preventDefault();
    void loadShowcaseCase({ updateUrl: true });
  });
  DOM.loadLatestButton?.addEventListener('click', (event) => {
    event.preventDefault();
    if (DOM.caseMeta) DOM.caseMeta.textContent = 'Latest Case Auto Annotation · loading...';
    if (DOM.annotationStatus) DOM.annotationStatus.textContent = 'ready';
    void loadLatestCase({ updateUrl: true });
  });
  DOM.submitCaseButton?.addEventListener('click', () => setSubmitCaseModalOpen(true));
  DOM.submitCaseClose?.addEventListener('click', () => setSubmitCaseModalOpen(false));
  DOM.submitCaseModal?.addEventListener('click', (event) => {
    if (event.target === DOM.submitCaseModal) setSubmitCaseModalOpen(false);
  });
  DOM.submitCaseForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitCaseFromModal();
  });
  DOM.layoutGridButton?.addEventListener('click', () => setLayoutMode('grid-2x2'));
  DOM.layoutSingleButton?.addEventListener('click', () => setLayoutMode('single'));
  DOM.retryLatestButton?.addEventListener('click', () => void retryLatestCase());
  DOM.reportOpenButton?.addEventListener('click', () => setReportDrawerOpen(true));
  DOM.reportCloseButton?.addEventListener('click', () => setReportDrawerOpen(false));
  DOM.planningPanelToggle?.addEventListener('click', () => togglePlanningPanelVisibility());
  DOM.manualReviewToggle?.addEventListener('click', () => toggleManualReviewVisibility());
  DOM.measurementPanelToggle?.addEventListener('click', () => toggleMeasurementsPanelVisibility());
  DOM.exportMeasurementsCsv?.addEventListener('click', () => exportMeasurementsCsv());
  DOM.manualReviewGrid?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest('button[data-manual-save]') as HTMLButtonElement | null;
    if (!button) return;
    const fieldKey = String(button.dataset.manualSave || '') as ManualReviewFieldKey;
    if (!fieldKey) return;
    void saveManualReviewField(fieldKey);
  });
  DOM.annotationButton?.addEventListener('click', () => {
    void startAutoAnnotation();
  });
  DOM.focusAnnulusButton?.addEventListener('click', () => focusPlane('annulus'));
  DOM.focusStjButton?.addEventListener('click', () => focusPlane('stj'));
  DOM.focusRootButton?.addEventListener('click', () => focusRoot());
  DOM.focusCoronaryButton?.addEventListener('click', () => focusCoronaryOstium());
  DOM.undoMeasurementButton?.addEventListener('click', () => undoLastMeasurementAction());
  DOM.deleteMeasurementButton?.addEventListener('click', () => deleteSelectedMeasurements());
  DOM.clearMeasurementsButton?.addEventListener('click', () => clearAllMeasurements());
  DOM.coronaryReviewAcknowledge?.addEventListener('click', () => {
    coronaryReviewBannerAcknowledged = true;
    renderCoronaryReviewBanner(activeCase);
  });
  DOM.backToCrosshairButton?.addEventListener('click', () => {
    currentPrimaryTool = 'crosshair';
    applyPrimaryToolBindings();
    syncToolUi();
    refreshMeasurementActionAvailability();
  });
  DOM.toolButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.toolMode as PrimaryToolMode;
      if (!mode) return;
      if (currentBootStage !== 'ready') {
        currentPrimaryTool = mode;
        syncToolUi();
        return;
      }
      if (!viewerInteractive()) return;
      setPrimaryToolMode(mode);
    });
  });
  DOM.windowPreset?.addEventListener('change', () => {
    currentWindowPreset = (DOM.windowPreset?.value as WindowPresetId) || DEFAULT_WINDOW_PRESET;
    if (!viewerInteractive()) {
      syncToolUi();
      return;
    }
    void applyWindowPresetToSession();
  });
  DOM.cineToggle?.addEventListener('click', () => {
    toggleCine();
  });
  DOM.cineSpeed?.addEventListener('change', () => {
    if (!viewerInteractive()) return;
    cineFps = Number.parseInt(DOM.cineSpeed?.value || String(DEFAULT_CINE_FPS), 10) || DEFAULT_CINE_FPS;
    if (cineTimerHandle !== null) {
      stopCine();
      startCine();
    }
  });
  DOM.resetViewportButton?.addEventListener('click', () => {
    if (!viewerInteractive()) return;
    resetActiveViewport();
  });
  DOM.localeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      currentLocale = (button.dataset.localeSwitch as Locale) || 'en';
      applyLocale();
      syncToolUi();
      if (activeCase) updateHeaderMeta(activeCase);
      if (activeCase) renderSidePanels(activeCase);
    });
  });
  DOM.auxMode?.addEventListener('change', () => {
    if (!viewerInteractive()) return;
    currentAuxMode = (DOM.auxMode?.value as AuxMode) || 'annulus';
    if (currentAuxMode === 'cpr' && !isCapabilityAvailable(activeCase?.capabilities?.cpr)) {
      currentAuxMode = 'annulus';
      if (DOM.auxMode) DOM.auxMode.value = currentAuxMode;
      if (DOM.mprStatus) DOM.mprStatus.textContent = 'CPR is not available for this case. Falling back to annulus view.';
    }
    void applyAuxViewportMode();
  });
  DOM.centerlineSlider?.addEventListener('input', () => {
    if (!viewerInteractive()) return;
    currentCenterlineIndex = Number.parseInt(DOM.centerlineSlider?.value || '0', 10) || 0;
    updateCenterlineLabel();
    void applyAuxViewportMode();
  });
  DOM.landmarkLayerButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (!viewerInteractive()) return;
      const layer = String(button.dataset.landmarkLayer || '');
      if (!layer) return;
      activeLandmarkLayers[layer] = !activeLandmarkLayers[layer];
      button.classList.toggle('active', activeLandmarkLayers[layer]);
      updateThreeLayerVisibility();
    });
  });
  DOM.planningTabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const tab = String(button.dataset.planningTab || 'TAVI').toUpperCase();
      if (tab === 'TAVI' || tab === 'VSRR' || tab === 'PEARS') {
        currentPlanningTab = tab;
        DOM.planningTabButtons.forEach((entry) => {
          entry.classList.toggle('active', String(entry.dataset.planningTab || '').toUpperCase() === currentPlanningTab);
        });
        if (activeCase) renderPlanningPanel(activeCase);
      }
    });
  });
  DOM.threeMeshToggles.forEach((toggle) => {
    toggle.addEventListener('change', () => updateThreeMeshFromUi());
  });
  DOM.threeLayerToggles.forEach((toggle) => {
    toggle.addEventListener('change', () => updateThreeLayerVisibility());
  });
  DOM.threeMeshOpacity.forEach((slider) => {
    slider.addEventListener('input', () => updateThreeMeshFromUi());
    slider.addEventListener('change', () => updateThreeMeshFromUi());
  });
  DOM.threeScreenshotButton?.addEventListener('click', () => exportThreePng());
  DOM.viewportCardThree?.addEventListener('pointerdown', () => {
    currentDisplayViewport = 'three';
    refreshLayoutMode();
  });
  DOM.viewportCardThree?.addEventListener('dblclick', () => {
    currentDisplayViewport = 'three';
    setLayoutMode('single');
  });
  window.addEventListener('keydown', handleGlobalShortcuts);
  syncPanelVisibilityButtons();
  applyLocale();
  syncToolUi();
  syncCaseModeButtons();
  refreshMeasurementActionAvailability();
  setBootStage('loading_shell');
}

function renderViewportCard(key: ViewportKey, label: string): string {
  return `
    <div class="viewport-card" id="viewport-card-${key}">
      <div class="viewport-label">${label}</div>
      <div class="viewport-badge" id="viewport-badge-${key}"></div>
      <div class="viewport-element" id="viewport-${key}"></div>
      <div class="viewport-placeholder hidden" id="viewport-placeholder-${key}"></div>
      <div class="viewport-footer" id="viewport-footer-${key}"></div>
    </div>
  `;
}

function viewportFallbackTitle(key: ViewportKey): string {
  return {
    axial: 'Axial MPR',
    sagittal: 'Sagittal MPR',
    coronal: 'Coronal MPR',
    aux: 'Double-oblique',
  }[key];
}

function viewportFallbackTags(key: ViewportKey): string[] {
  if (!activeCase) {
    return key === 'aux' ? ['double-oblique', 'centerline', 'annulus'] : ['crosshair', 'fallback'];
  }
  const landmarkSummary = activeCase.model_landmarks_summary || {};
  const tags: string[] = [];
  if (key === 'axial') tags.push('annulus', 'commissures', 'crosshair');
  if (key === 'sagittal') tags.push('sinus peaks', 'stj', 'crosshair');
  if (key === 'coronal') tags.push('coronary ostia', 'crosshair');
  if (key === 'aux') tags.push(currentAuxMode, 'double-oblique', 'centerline');
  if (Array.isArray(landmarkSummary.commissures) && key === 'axial') tags.push(`${landmarkSummary.commissures.length} commissures`);
  return tags;
}

function renderViewportFallback(key: ViewportKey, reason: string): string {
  const tags = viewportFallbackTags(key);
  return `
    <div class="viewport-placeholder-backdrop viewport-placeholder-${key}">
      <div class="viewport-crosshair viewport-crosshair-v"></div>
      <div class="viewport-crosshair viewport-crosshair-h"></div>
      <div class="viewport-placeholder-card">
        <div class="viewport-placeholder-kicker">${escapeHtml(viewportFallbackTitle(key))}</div>
        <div class="viewport-placeholder-text">Viewer fallback remains visible while live volume rendering is unavailable.</div>
        <div class="viewport-placeholder-tags">
          ${tags.map((tag) => `<span class="viewport-placeholder-tag">${escapeHtml(tag)}</span>`).join('')}
        </div>
        <div class="viewport-placeholder-reason">${escapeHtml(reason)}</div>
      </div>
    </div>
  `;
}

function setViewportPlaceholderState(enabled: boolean, reason: string): void {
  (Object.keys(DOM.viewportPlaceholders) as ViewportKey[]).forEach((key) => {
    const placeholder = DOM.viewportPlaceholders[key];
    if (!placeholder) return;
    if (!enabled) {
      placeholder.classList.add('hidden');
      placeholder.innerHTML = '';
      return;
    }
    placeholder.innerHTML = renderViewportFallback(key, reason);
    placeholder.classList.remove('hidden');
  });
}

function t(key: string): string {
  return I18N[currentLocale][key] || I18N.en[key] || key;
}

function applyLocale(): void {
  document.documentElement.lang = currentLocale;
  document.title = t('app.title');
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
    const key = node.dataset.i18n;
    if (!key) return;
    node.textContent = t(key);
  });
  DOM.localeButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.localeSwitch === currentLocale);
  });
  void refreshGpuStatusIndicator();
}

function bootStageLabel(stage: BootStage): string {
  return {
    loading_shell: 'Loading shell',
    loading_runtime: 'Loading runtime',
    loading_case_index: 'Loading case index',
    loading_case_payload: 'Loading case payload',
    initializing_volume: 'Initializing volume',
    initializing_viewports: 'Initializing MPR',
    ready: 'Ready',
    failed: 'Failed',
  }[stage];
}

function setBootStage(stage: BootStage, detail?: string): void {
  currentBootStage = stage;
  const label = bootStageLabel(stage);
  if (DOM.bootStage) DOM.bootStage.textContent = stage;
  setStatus(detail ? `${label}: ${detail}` : label);
  updateViewerActionAvailability();
  DOM.bootOverlay?.classList.remove('interactive');
  if (stage === 'failed') {
    DOM.bootOverlay?.classList.add('interactive');
    DOM.bootOverlay?.classList.remove('hidden');
    return;
  }
  if (stage === 'ready') {
    DOM.bootOverlay?.classList.add('fade-out');
    window.setTimeout(() => {
      DOM.bootOverlay?.classList.add('hidden');
      DOM.bootOverlay?.classList.remove('fade-out');
    }, 260);
    if (DOM.bootOverlayTitle) DOM.bootOverlayTitle.textContent = 'AorticAI';
    if (DOM.bootOverlayText) DOM.bootOverlayText.textContent = 'Workstation ready';
    lastBootError = null;
    DOM.bootOverlayDetail?.classList.add('hidden');
    if (DOM.bootOverlayDetail) DOM.bootOverlayDetail.textContent = '';
    return;
  }
  DOM.bootOverlay?.classList.remove('hidden');
  if (DOM.bootOverlayTitle) DOM.bootOverlayTitle.textContent = 'AorticAI';
  if (DOM.bootOverlayText) DOM.bootOverlayText.textContent = detail || label;
  lastBootError = null;
  DOM.bootOverlayDetail?.classList.add('hidden');
  if (DOM.bootOverlayDetail) DOM.bootOverlayDetail.textContent = '';
}

function showFatalError(error: unknown, detail?: string): void {
  currentBootStage = 'failed';
  const text = error instanceof Error ? error.stack || error.message : String(error);
  lastBootError = text;
  if (DOM.bootStage) DOM.bootStage.textContent = 'failed';
  if (DOM.bootOverlayTitle) DOM.bootOverlayTitle.textContent = 'Workstation bootstrap failed';
  if (DOM.bootOverlayText) {
    DOM.bootOverlayText.textContent = detail || 'The workstation could not complete startup. The page is staying visible so you can retry without a blank screen.';
  }
  if (DOM.bootOverlayDetail) {
    DOM.bootOverlayDetail.textContent = text;
    DOM.bootOverlayDetail.classList.remove('hidden');
  }
  DOM.bootOverlay?.classList.remove('hidden');
  setStatus(`Failed: ${detail || 'bootstrap error'}`);
  DOM.bootOverlay?.classList.add('interactive');
  console.error(error);
}

function showMprFailure(error: unknown): void {
  clearMprWatchdog();
  stopCine();
  const text = error instanceof Error ? error.message : String(error);
  lastMprError = text;
  if (DOM.mprStatus) DOM.mprStatus.textContent = `Live MPR unavailable. The workstation remains visible with a fallback overlay.`;
  (Object.keys(DOM.viewportBadges) as ViewportKey[]).forEach((key) => {
    if (DOM.viewportBadges[key]) DOM.viewportBadges[key].textContent = key === 'aux' ? 'double-oblique preview' : 'fallback preview';
    if (DOM.viewportFooters[key]) {
      DOM.viewportFooters[key].innerHTML = `<span>Fallback preview</span><span>${escapeHtml(text)}</span>`;
    }
  });
  setViewportPlaceholderState(true, text);
  updateViewerState();
}

function showThreeFailure(error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);
  lastThreeError = text;
  if (DOM.threeFallback) {
    DOM.threeFallback.innerHTML = `
      <div class="three-fallback-card">
        <h3>3D model unavailable</h3>
        <p>⚠ Data unavailable</p>
        <pre class="code-block">${escapeHtml(text)}</pre>
      </div>
    `;
    DOM.threeFallback.classList.remove('hidden');
  }
  updateViewerState();
}

async function retryLatestCase(): Promise<void> {
  setBootStage('loading_case_index', 'Retrying current case');
  if (requestedCaseMode() === 'showcase') {
    await loadShowcaseCase({ updateUrl: false });
    return;
  }
  await loadLatestCase({ updateUrl: false });
}

async function bootstrap(): Promise<void> {
  renderShell();
  void refreshGpuStatusIndicator();
  window.setInterval(() => {
    void refreshGpuStatusIndicator();
  }, 15000);
  window.addEventListener('resize', handleViewportResize);
  window.addEventListener('popstate', () => {
    void loadInitialCase();
  });
  setBootStage('loading_runtime', 'Loading case manifest...');
  await enforceVersionFreshness();
  setBootStage('loading_runtime', 'Initializing workstation...');
  await initializeCornerstoneOnce();
  await preloadDefaultPanelArtifacts();
  await loadInitialCase();
}

async function preloadDefaultPanelArtifacts(): Promise<void> {
  try {
    setBootStage('loading_runtime', 'Loading case manifest...');
    defaultCaseManifestArtifact = await fetchJson<Record<string, unknown>>(defaultCaseArtifactUrl('case_manifest'));
  } catch {
    defaultCaseManifestArtifact = null;
  }
  try {
    setBootStage('loading_runtime', 'Loading measurements...');
    defaultMeasurementsArtifact = await fetchJson<Record<string, unknown>>(defaultCaseArtifactUrl('measurements'));
  } catch {
    defaultMeasurementsArtifact = null;
  }
  try {
    setBootStage('loading_runtime', 'Loading 3D models...');
    defaultPlanningArtifact = await fetchJson<Record<string, unknown>>(defaultCaseArtifactUrl('planning'));
  } catch {
    defaultPlanningArtifact = null;
  }
  try {
    defaultAnnulusPlaneArtifact = await fetchJson<Record<string, unknown>>(defaultCaseArtifactUrl('annulus_plane'));
  } catch {
    defaultAnnulusPlaneArtifact = null;
  }
  setBootStage('loading_runtime', 'Initializing workstation...');
}

async function enforceVersionFreshness(): Promise<void> {
  try {
    const resp = await fetch('/version', { cache: 'no-store' });
    if (!resp.ok) return;
    const payload = (await resp.json()) as { build_version?: string };
    if (payload.build_version && payload.build_version !== BUILD_VERSION) {
      const current = new URL(window.location.href);
      current.searchParams.set('v', payload.build_version);
      location.replace(current.toString());
    }
  } catch {
    // Keep workstation usable even if version endpoint is temporarily unavailable.
  }
}

async function initializeCornerstoneOnce(): Promise<void> {
  if (cornerstoneReady) return;
  cornerstoneInit({ rendering: { useCPURendering: false } } as never);
  registerImageLoader('nifti', cornerstoneNiftiImageLoader);
  cornerstoneToolsInit();
  dicomImageLoaderInit({ maxWebWorkers: Math.max(1, Math.min(2, navigator.hardwareConcurrency || 2)) });
  niftiVolumeLoaderInit();
  metaData.addProvider(cornerstoneDICOMImageLoader.wadouri.metaData.metaDataProvider, 11000);
  if (!toolsRegistered) {
    addTool(WindowLevelTool);
    addTool(PanTool);
    addTool(ZoomTool);
    addTool(LengthTool);
    addTool(AngleTool);
    addTool(ProbeTool);
    addTool(RectangleROITool);
    toolsRegistered = true;
  }
  initializeAnnotationBridge();
  cornerstoneReady = true;
  if (DOM.mprStatus) DOM.mprStatus.textContent = 'Cornerstone3D runtime ready. Opening showcase case...';
  setStatus('Cornerstone3D initialized. Opening showcase case...');
}

function primaryToolName(mode: PrimaryToolMode): string | null {
  return {
    crosshair: null,
    windowLevel: WindowLevelTool.toolName,
    pan: PanTool.toolName,
    zoom: ZoomTool.toolName,
    length: LengthTool.toolName,
    angle: AngleTool.toolName,
    probe: ProbeTool.toolName,
    rectangleRoi: RectangleROITool.toolName,
  }[mode];
}

function syncToolUi(): void {
  DOM.toolButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.toolMode === currentPrimaryTool);
  });
  if (DOM.windowPreset) DOM.windowPreset.value = currentWindowPreset;
  if (DOM.cineSpeed) DOM.cineSpeed.value = String(cineFps);
  if (DOM.cineToggle) DOM.cineToggle.textContent = cineTimerHandle === null && !fallbackCineActive ? t('action.play_cine') : t('action.pause_cine');
  updateViewerActionAvailability();
  refreshMeasurementActionAvailability();
}

function initializeAnnotationBridge(): void {
  if (annotationBridgeReady) return;
  annotationBridgeReady = true;
  eventTarget.addEventListener(ToolEnums.Events.ANNOTATION_COMPLETED, onAnnotationCompleted as EventListener);
  eventTarget.addEventListener(ToolEnums.Events.ANNOTATION_SELECTION_CHANGE, onAnnotationSelectionChange as EventListener);
  eventTarget.addEventListener(ToolEnums.Events.ANNOTATION_REMOVED, onAnnotationRemoved as EventListener);
}

function onAnnotationCompleted(event: Event): void {
  if (ignoreAnnotationEvents) return;
  const detail = (event as CustomEvent<{ annotation?: { annotationUID?: string; metadata?: { toolName?: string } } }>).detail;
  const annotationRecord = detail?.annotation;
  const annotationUID = typeof annotationRecord?.annotationUID === 'string' ? annotationRecord.annotationUID : null;
  const toolName = String(annotationRecord?.metadata?.toolName || '');
  if (!annotationUID || !isInteractiveMeasurementTool(toolName)) {
    refreshMeasurementActionAvailability();
    return;
  }
  annotationUndoStack.push({
    kind: 'remove_annotation',
    annotationUID,
  });
  refreshMeasurementActionAvailability();
}

function onAnnotationSelectionChange(): void {
  refreshMeasurementActionAvailability();
}

function onAnnotationRemoved(): void {
  refreshMeasurementActionAvailability();
}

function isInteractiveMeasurementTool(toolName: string): boolean {
  return [
    LengthTool.toolName,
    AngleTool.toolName,
    ProbeTool.toolName,
    RectangleROITool.toolName,
  ].includes(toolName);
}

function saveAnnotationSnapshot(): unknown {
  const manager = annotation.state.getAnnotationManager() as { saveAnnotations?: () => unknown } | undefined;
  if (!manager?.saveAnnotations) return null;
  try {
    return manager.saveAnnotations();
  } catch {
    return null;
  }
}

function restoreAnnotationSnapshot(snapshot: unknown): void {
  const manager = annotation.state.getAnnotationManager() as {
    restoreAnnotations?: (state: unknown) => void;
  } | undefined;
  if (!manager?.restoreAnnotations || snapshot == null) return;
  annotation.state.removeAllAnnotations();
  manager.restoreAnnotations(snapshot);
}

function clearAnnotationStateForSession(): void {
  ignoreAnnotationEvents = true;
  try {
    annotation.selection.deselectAnnotation();
    annotation.state.removeAllAnnotations();
  } catch {
    // Keep workstation cleanup resilient even if annotation state is partially unavailable.
  } finally {
    ignoreAnnotationEvents = false;
  }
  annotationUndoStack = [];
  refreshMeasurementActionAvailability();
}

function deleteSelectedMeasurements(): void {
  if (!viewerInteractive()) return;
  const selected = annotation.selection.getAnnotationsSelected().filter(Boolean);
  if (!selected.length) return;
  const snapshot = saveAnnotationSnapshot();
  ignoreAnnotationEvents = true;
  try {
    selected.forEach((annotationUID) => annotation.state.removeAnnotation(annotationUID));
    annotation.selection.deselectAnnotation();
    if (snapshot != null) {
      annotationUndoStack.push({ kind: 'restore_snapshot', snapshot });
    }
  } finally {
    ignoreAnnotationEvents = false;
  }
  renderAllViewports();
  refreshMeasurementActionAvailability();
}

function clearAllMeasurements(): void {
  if (!viewerInteractive()) return;
  const allAnnotations = annotation.state.getAllAnnotations();
  if (!Array.isArray(allAnnotations) || !allAnnotations.length) return;
  const snapshot = saveAnnotationSnapshot();
  ignoreAnnotationEvents = true;
  try {
    annotation.selection.deselectAnnotation();
    annotation.state.removeAllAnnotations();
    if (snapshot != null) {
      annotationUndoStack.push({ kind: 'restore_snapshot', snapshot });
    }
  } finally {
    ignoreAnnotationEvents = false;
  }
  renderAllViewports();
  refreshMeasurementActionAvailability();
}

function undoLastMeasurementAction(): void {
  if (!viewerInteractive()) return;
  const entry = annotationUndoStack.pop();
  if (!entry) {
    refreshMeasurementActionAvailability();
    return;
  }
  ignoreAnnotationEvents = true;
  try {
    annotation.selection.deselectAnnotation();
    if (entry.kind === 'remove_annotation') {
      annotation.state.removeAnnotation(entry.annotationUID);
    } else {
      restoreAnnotationSnapshot(entry.snapshot);
    }
  } finally {
    ignoreAnnotationEvents = false;
  }
  renderAllViewports();
  refreshMeasurementActionAvailability();
}

function refreshMeasurementActionAvailability(): void {
  const enabled = viewerInteractive();
  const selectedCount = annotation.selection.getAnnotationsSelected().length;
  if (DOM.undoMeasurementButton) {
    DOM.undoMeasurementButton.disabled = !enabled || annotationUndoStack.length === 0;
  }
  if (DOM.deleteMeasurementButton) {
    DOM.deleteMeasurementButton.disabled = !enabled || selectedCount === 0;
  }
  if (DOM.clearMeasurementsButton) {
    const count = enabled ? annotation.state.getAllAnnotations().length : 0;
    DOM.clearMeasurementsButton.disabled = !enabled || count === 0;
  }
  if (DOM.backToCrosshairButton) {
    DOM.backToCrosshairButton.disabled = !enabled || currentPrimaryTool === 'crosshair';
  }
}

function viewerInteractive(): boolean {
  return Boolean(activeCase) && currentBootStage === 'ready';
}

function updateViewerActionAvailability(): void {
  const enabled = Boolean(activeCase) && currentBootStage !== 'failed';
  const annulusNavigationEnabled = enabled && canNavigateLandmarkPlane(activeCase, 'annulus');
  const stjNavigationEnabled = enabled && canNavigateLandmarkPlane(activeCase, 'stj');
  const rootNavigationEnabled = enabled && Boolean(getBootstrapWorldPoint(activeCase));
  const coronaryNavigationEnabled = enabled && hasCoronaryJumpTarget(activeCase);
  DOM.toolButtons.forEach((button) => {
    button.disabled = !enabled;
  });
  DOM.landmarkLayerButtons.forEach((button) => {
    button.disabled = !enabled;
  });
  const controls = [
    DOM.windowPreset,
    DOM.cineToggle,
    DOM.cineSpeed,
    DOM.resetViewportButton,
    DOM.auxMode,
    DOM.centerlineSlider,
  ];
  controls.forEach((control) => {
    if (!control) return;
    control.disabled = !enabled;
  });
  if (DOM.focusAnnulusButton) {
    DOM.focusAnnulusButton.disabled = !annulusNavigationEnabled;
    DOM.focusAnnulusButton.title = annulusNavigationEnabled
      ? 'Jump to annulus plane'
      : 'Annulus plane unavailable.';
  }
  if (DOM.focusStjButton) {
    DOM.focusStjButton.disabled = !stjNavigationEnabled;
    DOM.focusStjButton.title = stjNavigationEnabled
      ? 'Jump to STJ plane'
      : 'STJ plane unavailable.';
  }
  if (DOM.focusRootButton) {
    DOM.focusRootButton.disabled = !rootNavigationEnabled;
    DOM.focusRootButton.title = rootNavigationEnabled
      ? 'Jump to root focus'
      : 'Root focus unavailable.';
  }
  if (DOM.focusCoronaryButton) {
    DOM.focusCoronaryButton.disabled = !coronaryNavigationEnabled;
    DOM.focusCoronaryButton.title = coronaryNavigationEnabled
      ? 'Jump to coronary ostium'
      : 'Coronary ostium jump unavailable.';
  }
  (Object.keys(DOM.viewportCards) as ViewportKey[]).forEach((key) => {
    const card = DOM.viewportCards[key];
    if (!card) return;
    card.classList.toggle('viewer-disabled', !enabled);
  });
  DOM.viewportCardThree?.classList.toggle('viewer-disabled', !enabled);
}

function hasCoronaryJumpTarget(casePayload: WorkstationCasePayload | null | undefined): boolean {
  const coronary = pickObject(pickObject(casePayload?.aortic_root_model)?.coronary_ostia);
  return Boolean(pickObject(coronary?.left)?.point_world || pickObject(coronary?.right)?.point_world);
}

function applyPrimaryToolBindings(toolGroup = session ? ToolGroupManager.getToolGroup(session.toolGroupId) : undefined): void {
  if (!toolGroup) return;
  const primaryTools = [
    WindowLevelTool.toolName,
    PanTool.toolName,
    ZoomTool.toolName,
    LengthTool.toolName,
    AngleTool.toolName,
    ProbeTool.toolName,
    RectangleROITool.toolName,
  ];
  primaryTools.forEach((toolName) => {
    toolGroup.setToolPassive(toolName, { removeAllBindings: true });
  });
  toolGroup.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: ToolEnums.MouseBindings.Auxiliary }],
  });
  toolGroup.setToolActive(ZoomTool.toolName, {
    bindings: [{ mouseButton: ToolEnums.MouseBindings.Secondary }],
  });
  if (currentPrimaryTool === 'pan') {
    toolGroup.setToolActive(PanTool.toolName, {
      bindings: [
        { mouseButton: ToolEnums.MouseBindings.Primary },
        { mouseButton: ToolEnums.MouseBindings.Auxiliary },
      ],
    });
  } else if (currentPrimaryTool === 'zoom') {
    toolGroup.setToolActive(ZoomTool.toolName, {
      bindings: [
        { mouseButton: ToolEnums.MouseBindings.Primary },
        { mouseButton: ToolEnums.MouseBindings.Secondary },
      ],
    });
  } else if (currentPrimaryTool !== 'crosshair') {
    toolGroup.setToolActive(primaryToolName(currentPrimaryTool), {
      bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
    });
  }
  syncToolUi();
}

function setPrimaryToolMode(mode: PrimaryToolMode): void {
  currentPrimaryTool = mode;
  applyPrimaryToolBindings();
  refreshViewportPresentation();
}

async function applyWindowPresetToSession(): Promise<void> {
  if (!session) return;
  await applyWindowPresetToRenderingEngine(session.renderingEngine, session.volumeId, currentWindowPreset, session.cprVolumeId);
  await settleViewerPresentation(1);
  refreshViewportPresentation();
}

async function applyWindowPresetToRenderingEngine(
  renderingEngine: RenderingEngine,
  volumeId: string,
  presetId: WindowPresetId,
  cprVolumeId: string | null = null
): Promise<void> {
  const preset = WINDOW_PRESETS[presetId];
  if (!preset) return;
  const volumeRange = readRenderingScalarRange(renderingEngine, VIEWPORT_IDS.axial);
  const resolvedRange = resolvePresetRange(presetId, volumeRange);
  for (const key of Object.keys(VIEWPORT_IDS) as ViewportKey[]) {
    const viewport = renderingEngine.getViewport(VIEWPORT_IDS[key]) as any;
    if (!viewport?.setProperties) continue;
    const targetVolumeId = key === 'aux' && currentAuxMode === 'cpr' && cprVolumeId ? cprVolumeId : volumeId;
    viewport.setProperties({ voiRange: { lower: resolvedRange.lower, upper: resolvedRange.upper } }, targetVolumeId, true);
    viewport.render?.();
  }
  renderAllViewports(renderingEngine);
}

function readRenderingScalarRange(renderingEngine: RenderingEngine, viewportId: string): [number, number] | null {
  const viewport = renderingEngine.getViewport(viewportId) as any;
  return readViewportScalarRange(viewport);
}

function readViewportScalarRange(viewport: any): [number, number] | null {
  try {
    const imageDataResult = viewport?.getImageData?.();
    const imageData = imageDataResult?.imageData || imageDataResult;
    const scalars = imageData?.getPointData?.()?.getScalars?.();
    const range = scalars?.getRange?.();
    if (!Array.isArray(range) || range.length < 2) return null;
    const min = Number(range[0]);
    const max = Number(range[1]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
    return [min, max];
  } catch {
    return null;
  }
}

function looksLikeNormalizedScalarRange(range: [number, number] | null): boolean {
  if (!range) return false;
  const [min, max] = range;
  const span = max - min;
  if (span <= 0) return false;
  return span < 1800 || max < 1200 || min > -400;
}

function resolvePresetRange(
  presetId: WindowPresetId,
  scalarRange: [number, number] | null
): { lower: number; upper: number } {
  const preset = WINDOW_PRESETS[presetId];
  if (!preset) return { lower: -150, upper: 850 };
  if (!scalarRange) return { lower: preset.lower, upper: preset.upper };
  const [min, max] = scalarRange;
  const span = max - min;
  if (!looksLikeNormalizedScalarRange(scalarRange)) {
    return {
      lower: clampNumber(preset.lower, min, max),
      upper: clampNumber(preset.upper, min, max),
    };
  }
  const normalizedWindows: Record<WindowPresetId, [number, number]> = {
    softTissue: [0.08, 0.42],
    ctaVessel: [0.04, 0.78],
    calcium: [0.32, 1],
    wide: [0, 1],
  };
  const [start, end] = normalizedWindows[presetId];
  const lower = min + span * start;
  const upper = min + span * end;
  return {
    lower: Number(lower.toFixed(2)),
    upper: Number(Math.max(lower + 1, upper).toFixed(2)),
  };
}

function viewportSliceCount(key: ViewportKey): number {
  if (key === 'aux' && currentAuxMode === 'cpr') {
    return Array.isArray(session?.cprImageIds) ? session!.cprImageIds.length : 0;
  }
  return Array.isArray(session?.volumeImageIds) ? session!.volumeImageIds.length : 0;
}

function viewportSliceIndex(key: ViewportKey): number | null {
  if (!session) return null;
  const total = viewportSliceCount(key);
  if (!total) return null;
  const viewport = session.renderingEngine.getViewport(VIEWPORT_IDS[key]) as any;
  if (!viewport?.getCurrentImageIdIndex) return null;
  let rawIndex: number | null = null;
  try {
    if (key === 'aux' && currentAuxMode === 'cpr' && session.cprVolumeId) {
      rawIndex = Number(viewport.getCurrentImageIdIndex(session.cprVolumeId));
    } else {
      rawIndex = Number(viewport.getCurrentImageIdIndex(session.volumeId));
    }
  } catch {
    try {
      rawIndex = Number(viewport.getCurrentImageIdIndex());
    } catch {
      return null;
    }
  }
  if (!Number.isFinite(rawIndex)) return null;
  const index = Math.trunc(rawIndex);
  if (index < 0 || index >= total) return null;
  return index;
}

function refreshViewportPresentation(): void {
  refreshViewportBadges();
  updateViewerState();
}

function refreshViewportBadges(): void {
  const cineActive = cineTimerHandle !== null || fallbackCineActive;
  const world = currentCrosshairWorld;
  const activeToolLabel = PRIMARY_TOOL_LABELS[currentPrimaryTool];
  (Object.keys(DOM.viewportFooters) as ViewportKey[]).forEach((key) => {
    const footer = DOM.viewportFooters[key];
    const badge = DOM.viewportBadges[key];
    if (!footer || !badge) return;
    const title = humanize(key);
    const sliceIndex = viewportSliceIndex(key);
    const total = viewportSliceCount(key);
    const sliceLabel = sliceIndex !== null && total ? `slice ${sliceIndex + 1}/${total}` : 'slice n/a';
    const worldLabel = world
      ? key === 'axial'
        ? `z ${world[2].toFixed(1)} mm`
        : key === 'sagittal'
          ? `x ${world[0].toFixed(1)} mm`
          : key === 'coronal'
            ? `y ${world[1].toFixed(1)} mm`
            : currentAuxMode === 'cpr'
              ? `cl ${currentCenterlineIndex + 1}`
              : `${humanize(currentAuxMode)}`
      : 'position n/a';
    const activeLabel = key === currentActiveViewport ? 'active' : 'idle';
    badge.textContent = key === 'aux'
      ? `${currentAuxMode} · ${activeLabel}`
      : `${title} · ${activeLabel}`;
    footer.innerHTML = `<span>${sliceLabel}</span><span>${worldLabel}</span><span>${activeToolLabel}</span><span>${currentPrimaryTool === 'crosshair' ? 'crosshair on' : 'crosshair off'}</span>`;
  });
  if (DOM.mprStatus) {
    DOM.mprStatus.textContent = `Preset ${WINDOW_PRESETS[currentWindowPreset].label} · Tool ${PRIMARY_TOOL_LABELS[currentPrimaryTool]} · ${cineActive ? `cine ${cineFps} fps` : 'cine off'}`;
  }
}

function stopCine(): void {
  fallbackCineActive = false;
  if (cineTimerHandle !== null) {
    window.clearInterval(cineTimerHandle);
    cineTimerHandle = null;
  }
  syncToolUi();
  refreshViewportPresentation();
}

function startCine(): void {
  if (!session) {
    fallbackCineActive = true;
    syncToolUi();
    refreshViewportPresentation();
    return;
  }
  if (cineTimerHandle !== null) return;
  if (viewportSliceCount(currentActiveViewport) <= 1 || viewportSliceIndex(currentActiveViewport) === null) {
    refreshViewportPresentation();
    return;
  }
  const intervalMs = Math.max(60, Math.round(1000 / Math.max(1, cineFps)));
  cineTimerHandle = window.setInterval(() => {
    if (!session) {
      stopCine();
      return;
    }
    if (!safeScrollViewport(currentActiveViewport, 1)) {
      stopCine();
      return;
    }
    refreshViewportPresentation();
  }, intervalMs);
  syncToolUi();
  refreshViewportPresentation();
}

function toggleCine(): void {
  if (cineTimerHandle !== null || fallbackCineActive) {
    stopCine();
    return;
  }
  startCine();
}

function resetActiveViewport(): void {
  if (!session) return;
  const viewport = session.renderingEngine.getViewport(VIEWPORT_IDS[currentActiveViewport]) as any;
  if (!viewport) return;
  try {
    viewport.resetProperties?.(currentActiveViewport === 'aux' && currentAuxMode === 'cpr' && session.cprVolumeId ? session.cprVolumeId : session.volumeId);
  } catch {}
  try {
    viewport.resetCamera?.({
      resetPan: true,
      resetZoom: true,
      resetToCenter: true,
      resetCameraRotation: true,
    });
  } catch {}
  viewport.render?.();
  void applyWindowPresetToSession();
  if (currentActiveViewport === 'aux') {
    void applyAuxViewportMode();
  } else {
    applyClinicalViewportFraming(activeCase, currentCrosshairWorld || getBootstrapWorldPoint(activeCase));
  }
  handleViewportResize();
  if (currentCrosshairWorld) void syncCrosshair(currentCrosshairWorld);
}

function syncPanelVisibilityButtons(): void {
  if (DOM.planningPanelSection) DOM.planningPanelSection.classList.toggle('hidden', planningPanelCollapsed);
  if (DOM.measurementPanelSection) DOM.measurementPanelSection.classList.toggle('hidden', measurementsPanelCollapsed);
  if (DOM.manualReviewSection) DOM.manualReviewSection.classList.toggle('hidden', manualReviewCollapsed);
  if (DOM.planningPanelToggle) DOM.planningPanelToggle.textContent = planningPanelCollapsed ? 'Show' : 'Hide';
  if (DOM.measurementPanelToggle) DOM.measurementPanelToggle.textContent = measurementsPanelCollapsed ? 'Show' : 'Hide';
  if (DOM.manualReviewToggle) DOM.manualReviewToggle.textContent = manualReviewCollapsed ? 'Show' : 'Hide';
}

function togglePlanningPanelVisibility(): void {
  planningPanelCollapsed = !planningPanelCollapsed;
  syncPanelVisibilityButtons();
}

function toggleMeasurementsPanelVisibility(): void {
  measurementsPanelCollapsed = !measurementsPanelCollapsed;
  syncPanelVisibilityButtons();
}

function toggleManualReviewVisibility(): void {
  manualReviewCollapsed = !manualReviewCollapsed;
  syncPanelVisibilityButtons();
}

function activeViewportInstance(): any | null {
  if (!session) return null;
  return session.renderingEngine.getViewport(VIEWPORT_IDS[currentActiveViewport]) as any;
}

function activeViewportTargetVolumeId(): string | null {
  if (!session) return null;
  if (currentActiveViewport === 'aux' && currentAuxMode === 'cpr' && session.cprVolumeId) return session.cprVolumeId;
  return session.volumeId;
}

function adjustWindowWidth(deltaWidth: number): void {
  if (!viewerInteractive()) return;
  const viewport = activeViewportInstance();
  if (!viewport?.setProperties) return;
  const targetVolumeId = activeViewportTargetVolumeId();
  const properties = viewport.getProperties?.() || {};
  const voiRange = pickObject(properties.voiRange);
  let lower = Number(voiRange?.lower);
  let upper = Number(voiRange?.upper);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) {
    const fallback = resolvePresetRange(currentWindowPreset, readViewportScalarRange(viewport));
    lower = fallback.lower;
    upper = fallback.upper;
  }
  const center = (lower + upper) / 2;
  const nextWidth = Math.max(20, (upper - lower) + deltaWidth);
  const nextLower = center - nextWidth / 2;
  const nextUpper = center + nextWidth / 2;
  try {
    viewport.setProperties({ voiRange: { lower: nextLower, upper: nextUpper } }, targetVolumeId || undefined, true);
    viewport.render?.();
    renderAllViewports(session?.renderingEngine);
    refreshViewportPresentation();
  } catch {
    // ignore single-keyboard adjustment failures
  }
}

function adjustViewportZoom(zoomIn: boolean): void {
  if (!viewerInteractive()) return;
  const viewport = activeViewportInstance();
  if (!viewport?.getCamera || !viewport?.setCamera) return;
  try {
    const camera = viewport.getCamera();
    const currentScale = Number(camera?.parallelScale);
    if (!Number.isFinite(currentScale) || currentScale <= 0) return;
    const factor = zoomIn ? 0.9 : 1.1;
    viewport.setCamera({
      ...camera,
      parallelScale: clampNumber(currentScale * factor, 1, 500),
    });
    viewport.render?.();
    renderAllViewports(session?.renderingEngine);
    refreshViewportPresentation();
  } catch {
    // ignore single-keyboard zoom failures
  }
}

function shouldIgnoreShortcutEvent(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function handleGlobalShortcuts(event: KeyboardEvent): void {
  if (shouldIgnoreShortcutEvent(event)) return;
  const key = event.key;
  if (key === 'Escape') {
    setReportDrawerOpen(false);
    return;
  }
  if (!viewerInteractive()) return;

  if (key === '1') {
    event.preventDefault();
    setLayoutMode('grid-2x2');
    return;
  }
  if (key === '2') {
    event.preventDefault();
    setLayoutMode('single');
    return;
  }
  if (key === 'w' || key === 'W') {
    event.preventDefault();
    adjustWindowWidth(100);
    return;
  }
  if (key === 'l' || key === 'L') {
    event.preventDefault();
    adjustWindowWidth(-100);
    return;
  }
  if (key === '+' || key === '=') {
    event.preventDefault();
    adjustViewportZoom(true);
    return;
  }
  if (key === '-') {
    event.preventDefault();
    adjustViewportZoom(false);
    return;
  }
  if (key === 'r' || key === 'R') {
    event.preventDefault();
    resetActiveViewport();
    return;
  }
  if (key === 'p' || key === 'P') {
    event.preventDefault();
    togglePlanningPanelVisibility();
    return;
  }
  if (key === 'm' || key === 'M') {
    event.preventDefault();
    toggleMeasurementsPanelVisibility();
  }
}

function requestedCaseMode(): CaseMode {
  const current = new URL(window.location.href);
  if (current.searchParams.get('case') === 'latest') return 'latest';
  return 'showcase';
}

function updateCaseModeUrl(mode: CaseMode, replace = false): void {
  const current = new URL(window.location.href);
  if (mode === 'latest') current.searchParams.set('case', 'latest');
  else current.searchParams.delete('case');
  const next = `${current.pathname}${current.search}${current.hash}`;
  if (replace) window.history.replaceState({ caseMode: mode }, '', next);
  else window.history.pushState({ caseMode: mode }, '', next);
}

function setReportDrawerOpen(open: boolean): void {
  if (!DOM.reportDrawer) return;
  DOM.reportDrawer.classList.toggle('open', open);
}

function updateReportLinks(casePayload: WorkstationCasePayload | null): void {
  const reportHref = casePayload?.links?.report_pdf || defaultCaseReportUrl('report.pdf');
  if (DOM.reportFrame && DOM.reportFrame.src !== resolveAbsoluteUrl(reportHref)) {
    DOM.reportFrame.src = resolveAbsoluteUrl(reportHref);
  }
  if (DOM.reportDownloadLink) {
    DOM.reportDownloadLink.href = reportHref;
  }
}

function syncCaseModeButtons(): void {
  const mode = requestedCaseMode();
  DOM.loadShowcaseButton?.classList.toggle('active', mode === 'showcase');
  DOM.loadLatestButton?.classList.toggle('active', mode === 'latest');
}

async function loadInitialCase(): Promise<void> {
  syncCaseModeButtons();
  if (requestedCaseMode() === 'latest') {
    await loadLatestCase({ updateUrl: false });
    return;
  }
  await loadShowcaseCase({ updateUrl: false });
}

async function loadShowcaseCase(options: { updateUrl?: boolean; replaceUrl?: boolean } = {}): Promise<void> {
  if (options.updateUrl) updateCaseModeUrl('showcase', Boolean(options.replaceUrl));
  syncCaseModeButtons();
  setBootStage('loading_case_index', 'Loading showcase reference case');
  setStatus('Loading showcase reference case...');
  if (DOM.mprStatus) DOM.mprStatus.textContent = 'Opening showcase reference case...';
  await loadCase(SHOWCASE_CASE_ID);
}

async function loadLatestCase(options: { updateUrl?: boolean; replaceUrl?: boolean; allowFallback?: boolean } = {}): Promise<void> {
  if (options.updateUrl) updateCaseModeUrl('latest', Boolean(options.replaceUrl));
  syncCaseModeButtons();
  setBootStage('loading_case_index', 'Resolving latest processed CTA case');
  setStatus('Resolving latest processed CTA case...');
  if (DOM.caseMeta) DOM.caseMeta.textContent = 'Latest Case Auto Annotation · loading...';
  if (DOM.mprStatus) DOM.mprStatus.textContent = 'Looking up the latest processed CTA case...';
  try {
    const latest = await fetchJson<Record<string, unknown>>('/demo/latest-case');
    const resolvedJobId = String(latest.id || latest.job_id || '').trim();
    const jobId = resolvedJobId && resolvedJobId !== SHOWCASE_CASE_ID ? resolvedJobId : 'latest_case_fixture';
    await loadCase(jobId);
    if (!activeCase?.links?.raw_ct) {
      throw new Error('latest_case_missing_raw_ct');
    }
  } catch (error) {
    if (options.allowFallback === false) throw error;
    console.warn('latest case load failed, falling back to showcase case', error);
    try {
      await loadCase('latest_case_fixture');
      return;
    } catch {
      // continue to showcase fallback
    }
    await loadShowcaseCase({ updateUrl: true, replaceUrl: true });
  }
}

async function loadCase(jobId: string): Promise<void> {
  const loadSerial = ++caseLoadSerial;
  setBootStage('loading_case_payload', `Loading case ${jobId}`);
  setStatus(`Loading workstation case ${jobId}...`);
  if (DOM.mprStatus) DOM.mprStatus.textContent = `Loading case ${jobId}...`;
  stopCine();
  const loadedCase = await fetchJson<WorkstationCasePayload>(`/workstation/cases/${encodeURIComponent(jobId)}`);
  if (loadSerial !== caseLoadSerial) return;
  activeCase = loadedCase;
  updateReportLinks(activeCase);
  await destroySession();
  if (loadSerial !== caseLoadSerial) return;
  resetViewerRuntimeForCase(activeCase);
  updateHeaderMeta(activeCase);
  applyCapabilityControls(activeCase);
  renderSidePanels(activeCase);
  await hydrateManualReview(activeCase);
  setBootStage('ready', `Case ${jobId} shell ready`);
  maybeAutoRunAnnotation(activeCase);
  const volumeFailure = await initializeViewerSession(activeCase);
  if (loadSerial !== caseLoadSerial) return;
  if (session) {
    await nextAnimationFrame();
    if (loadSerial !== caseLoadSerial) return;
    handleViewportResize();
    attachViewportInteractions();
    await syncCrosshair(getBootstrapWorldPoint(activeCase));
    if (loadSerial !== caseLoadSerial) return;
    await applyAuxViewportMode();
    if (loadSerial !== caseLoadSerial) return;
    applyClinicalViewportFraming(activeCase, currentCrosshairWorld || getBootstrapWorldPoint(activeCase));
    await settleViewerPresentation(2);
    if (loadSerial !== caseLoadSerial) return;
    await stabilizePrimaryViewports(activeCase);
    if (loadSerial !== caseLoadSerial) return;
    handleViewportResize();
  } else if (volumeFailure) {
    setBootStage('ready', 'Planning outputs loaded while MPR is unavailable');
    if (DOM.headerStatus) {
      DOM.headerStatus.textContent = `Case ${jobId} loaded with MPR unavailable`;
    }
  }
  const threeFailure = await initializeThreePanel(activeCase);
  if (loadSerial !== caseLoadSerial) return;
  if (!session && volumeFailure && threeFailure) {
    setBootStage('ready', 'Planning outputs loaded while both MPR and 3D viewers are unavailable');
  } else if (!session && volumeFailure) {
    setBootStage('ready', 'Planning and 3D remain available while CT volume failed to initialize');
  } else if (threeFailure) {
    setBootStage('ready', 'CT workstation is available while 3D viewer failed to initialize');
  } else {
    setBootStage('ready', `Case ${jobId} ready`);
  }
  if (DOM.headerStatus) {
    DOM.headerStatus.textContent = !session && volumeFailure
      ? `Case ${jobId} loaded with MPR unavailable`
      : threeFailure
        ? `Case ${jobId} loaded with 3D viewer unavailable`
        : `Case ready: ${jobId}`;
  }
  maybeAutoRunAnnotation(activeCase);
}

async function initializeViewerSession(casePayload: WorkstationCasePayload): Promise<unknown | null> {
  try {
    setBootStage('initializing_volume', `Preparing ${casePayload.volume_source.loader_kind}`);
    armMprWatchdog();
    session = await withTimeout(
      createViewerSession(casePayload),
      MPR_INIT_TIMEOUT_MS,
      `mpr_initialization_timeout_after_${MPR_INIT_TIMEOUT_MS}ms`
    );
    setBootStage('initializing_viewports', 'Synchronizing axial, sagittal, coronal, and auxiliary MPR');
    clearMprFailure();
    return null;
  } catch (error) {
    session = null;
    showMprFailure(error);
    return error;
  }
}

async function initializeThreePanel(casePayload: WorkstationCasePayload): Promise<unknown | null> {
  try {
    await withTimeout(
      ensureThreeViewer(casePayload),
      THREE_INIT_TIMEOUT_MS,
      `three_initialization_timeout_after_${THREE_INIT_TIMEOUT_MS}ms`
    );
    clearThreeFailure();
    return null;
  } catch (error) {
    showThreeFailure(error);
    return error;
  }
}

async function createViewerSession(casePayload: WorkstationCasePayload): Promise<ViewerSession> {
  const sessionSuffix = `${Date.now()}-${++viewerSessionSerial}`;
  const renderingEngineId = `${RENDERING_ENGINE_ID_PREFIX}-${sessionSuffix}`;
  const toolGroupId = `${TOOL_GROUP_ID_PREFIX}-${sessionSuffix}`;
  const renderingEngine = new RenderingEngine(renderingEngineId);
  const syncs: SyncController[] = [];
  let volumeId = '';
  let imageIds: string[] = [];
  let cprVolumeId: string | null = null;
  let cprImageIds: string[] = [];
  let dicomImageIds: string[] = [];
  let toolGroupCreated = false;
  try {
    renderingEngine.setViewports([
      createViewportInput('axial', CoreEnums.OrientationAxis.AXIAL),
      createViewportInput('sagittal', CoreEnums.OrientationAxis.SAGITTAL),
      createViewportInput('coronal', CoreEnums.OrientationAxis.CORONAL),
      createViewportInput('aux', CoreEnums.OrientationAxis.AXIAL),
    ]);
    await nextAnimationFrame();
    safeResizeRenderingEngine(renderingEngine);

    const source = await loadVolumeFromSource(casePayload.volume_source, String(casePayload.job.id || 'case'));
    volumeId = source.volumeId;
    imageIds = source.imageIds;
    dicomImageIds = source.dicomImageIds;
    const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds });
    if (typeof (volume as { load?: () => Promise<unknown> | void }).load === 'function') {
      const maybePromise = (volume as { load: () => Promise<unknown> | void }).load();
      if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
        await maybePromise;
      }
    }

    await setVolumesForViewports(
      renderingEngine,
      [{ volumeId }],
      Object.values(VIEWPORT_IDS)
    );
    await nextAnimationFrame();
    safeResizeRenderingEngine(renderingEngine);

    const cprUrl = typeof casePayload.cpr_sources?.straightened_nifti === 'string'
      ? casePayload.cpr_sources.straightened_nifti
      : null;
    if (cprUrl) {
      const cprSource = await loadVolumeFromSource(
        {
          source_kind: 'nifti',
          loader_kind: 'cornerstone-nifti',
          signed_url: cprUrl,
        },
        `${String(casePayload.job.id || 'case')}-cpr`
      );
      cprVolumeId = cprSource.volumeId;
      cprImageIds = cprSource.imageIds;
      const cprVolume = await volumeLoader.createAndCacheVolume(cprVolumeId, { imageIds: cprImageIds });
      if (typeof (cprVolume as { load?: () => Promise<unknown> | void }).load === 'function') {
        const maybePromise = (cprVolume as { load: () => Promise<unknown> | void }).load();
        if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
          await maybePromise;
        }
      }
    }

    const toolGroup = ToolGroupManager.createToolGroup(toolGroupId);
    if (!toolGroup) throw new Error('tool_group_creation_failed');
    toolGroupCreated = true;
    toolGroup.addTool(WindowLevelTool.toolName);
    toolGroup.addTool(PanTool.toolName);
    toolGroup.addTool(ZoomTool.toolName);
    toolGroup.addTool(LengthTool.toolName);
    toolGroup.addTool(AngleTool.toolName);
    toolGroup.addTool(ProbeTool.toolName);
    toolGroup.addTool(RectangleROITool.toolName);

    syncs.push(
      synchronizers.createVOISynchronizer(`mpr-voi-${Date.now()}`, {
        syncInvertState: true,
        syncColormap: false,
      })
    );

    for (const viewportId of Object.values(VIEWPORT_IDS)) {
      toolGroup.addViewport(viewportId, renderingEngineId);
      syncs.forEach((sync) => sync.add({ renderingEngineId, viewportId }));
    }

    Object.entries(VIEWPORT_IDS).forEach(([key, viewportId]) => {
      const viewport = renderingEngine.getViewport(viewportId) as any;
      if (key !== 'aux') viewport.setOrientation(defaultOrientationForKey(key as ViewportKey), true);
      try {
        viewport.resetCamera?.({
          resetPan: true,
          resetZoom: true,
          resetToCenter: true,
          resetCameraRotation: true,
        });
      } catch {
        // Keep runtime startup moving if one viewport rejects the reset hint.
      }
      viewport.render();
    });

    applyPrimaryToolBindings(toolGroup);
    await applyWindowPresetToRenderingEngine(renderingEngine, volumeId, currentWindowPreset, cprVolumeId);
    safeResizeRenderingEngine(renderingEngine);

    return {
      renderingEngine,
      viewportIds: VIEWPORT_IDS,
      toolGroupId,
      volumeId,
      volumeImageIds: imageIds,
      cprVolumeId,
      cprImageIds,
      syncs,
      dicomImageIds,
    };
  } catch (error) {
    syncs.forEach((sync) => sync.destroy?.());
    if (toolGroupCreated) {
      try { ToolGroupManager.destroyToolGroup(toolGroupId); } catch {}
    }
    try { renderingEngine.destroy(); } catch {}
    if (volumeId) {
      try { cache.removeVolumeLoadObject(volumeId); } catch {}
    }
    if (cprVolumeId) {
      try { cache.removeVolumeLoadObject(cprVolumeId); } catch {}
    }
    if (dicomImageIds.length) {
      try { cornerstoneDICOMImageLoader.wadouri.fileManager.purge(); } catch {}
    }
    try { cache.purgeCache(); } catch {}
    throw error;
  }
}

function createViewportInput(key: ViewportKey, orientation: any) {
  return {
    viewportId: VIEWPORT_IDS[key],
    type: CoreEnums.ViewportType.ORTHOGRAPHIC,
    element: DOM.viewportElements[key],
    defaultOptions: {
      orientation,
      background: [0.01, 0.03, 0.06] as [number, number, number],
    },
  };
}

function defaultOrientationForKey(key: ViewportKey): any {
  switch (key) {
    case 'axial':
      return CoreEnums.OrientationAxis.AXIAL;
    case 'sagittal':
      return CoreEnums.OrientationAxis.SAGITTAL;
    case 'coronal':
      return CoreEnums.OrientationAxis.CORONAL;
    default:
      return CoreEnums.OrientationAxis.AXIAL;
  }
}

async function loadVolumeFromSource(source: VolumeSource, caseId: string): Promise<{ volumeId: string; imageIds: string[]; dicomImageIds: string[] }> {
  const resolvedSourceUrl = resolveAbsoluteUrl(source.signed_url);
  if (source.loader_kind === 'cornerstone-nifti') {
    const imageIds = await createNiftiImageIdsAndCacheMetadata({ url: resolvedSourceUrl });
    const volumeId = `cornerstoneStreamingImageVolume:${caseId}:nifti`;
    return { volumeId, imageIds, dicomImageIds: [] };
  }

  const zipBuffer = await fetchArrayBuffer(resolvedSourceUrl);
  const entries = await unzipDicomZip(zipBuffer);
  if (!entries.entries.length) {
    throw new Error('dicom_zip_empty_after_unpack');
  }
  const imageIds: string[] = [];
  for (const entry of entries.entries) {
    const file = new File([entry.buffer], entry.name, { type: 'application/dicom' });
    const imageId = cornerstoneDICOMImageLoader.wadouri.fileManager.add(file);
    imageIds.push(imageId);
  }
  const volumeId = `cornerstoneStreamingImageVolume:${caseId}:dicom`;
  return { volumeId, imageIds, dicomImageIds: imageIds.slice() };
}

async function unzipDicomZip(buffer: ArrayBuffer): Promise<{ entries: Array<{ name: string; buffer: ArrayBuffer }>; warning?: string | null }> {
  if (!dicomZipWorker) {
    dicomZipWorker = new Worker(`/assets/dicom-zip-worker.${BUILD_VERSION}.js?v=${BUILD_VERSION}`, { type: 'module' });
  }
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<any>) => {
      const data = event.data;
      if (!data || (data.type !== 'ok' && data.type !== 'error')) return;
      dicomZipWorker?.removeEventListener('message', onMessage);
      dicomZipWorker?.removeEventListener('error', onError);
      if (data.type === 'error') reject(new Error(String(data.error || 'dicom_zip_worker_failed')));
      else resolve({ entries: Array.isArray(data.entries) ? data.entries : [], warning: data.warning || null });
    };
    const onError = (event: ErrorEvent) => {
      dicomZipWorker?.removeEventListener('message', onMessage);
      dicomZipWorker?.removeEventListener('error', onError);
      reject(event.error || new Error(event.message || 'dicom_zip_worker_error'));
    };
    dicomZipWorker?.addEventListener('message', onMessage);
    dicomZipWorker?.addEventListener('error', onError);
    dicomZipWorker?.postMessage({ type: 'unzip-dicom-zip', buffer }, [buffer]);
  });
}

function attachViewportInteractions(): void {
  if (!session) return;
  (Object.keys(VIEWPORT_IDS) as ViewportKey[]).forEach((key) => {
    const element = DOM.viewportElements[key];
    element.onpointerdown = async (evt) => {
      if (!viewerInteractive()) return;
      currentActiveViewport = key;
      if (key !== 'aux') currentDisplayViewport = key;
      setActiveViewport(key);
      if (evt.button !== 0 || currentPrimaryTool !== 'crosshair') return;
      const viewport = session?.renderingEngine.getViewport(VIEWPORT_IDS[key]) as any;
      if (!viewport?.canvasToWorld) return;
      const rect = element.getBoundingClientRect();
      const canvasPoint: [number, number] = [evt.clientX - rect.left, evt.clientY - rect.top];
      const world = viewport.canvasToWorld(canvasPoint) as Point3;
      await syncCrosshair(clampWorldToSessionBounds(toPoint3(world)));
    };
    element.onwheel = (evt) => {
      if (!viewerInteractive()) return;
      evt.preventDefault();
      currentActiveViewport = key;
      if (key !== 'aux') currentDisplayViewport = key;
      setActiveViewport(key);
      if (!safeScrollViewport(key, evt.deltaY > 0 ? 1 : -1)) return;
      refreshViewportPresentation();
    };
    element.ondblclick = () => {
      if (!viewerInteractive()) return;
      currentActiveViewport = key;
      if (key !== 'aux') currentDisplayViewport = key;
      setActiveViewport(key);
      resetActiveViewport();
    };
  });
  (['axial', 'coronal', 'sagittal'] as const).forEach((key) => {
    DOM.viewportCards[key]?.addEventListener('dblclick', () => {
      currentDisplayViewport = key;
      setLayoutMode('single');
    });
  });
  setActiveViewport(currentActiveViewport);
  refreshLayoutMode();
}

function setActiveViewport(key: ViewportKey): void {
  (Object.keys(DOM.viewportCards) as ViewportKey[]).forEach((entry) => {
    DOM.viewportCards[entry]?.classList.toggle('active', entry === key);
  });
  DOM.viewportCardThree?.classList.toggle('active', currentDisplayViewport === 'three');
  if (key !== 'aux') {
    currentDisplayViewport = key;
  }
  refreshLayoutMode();
  refreshViewportPresentation();
}

function setLayoutMode(mode: LayoutMode): void {
  currentLayoutMode = mode;
  refreshLayoutMode();
}

function refreshLayoutMode(): void {
  const grid = document.getElementById('mpr-grid');
  if (!grid) return;
  grid.classList.toggle('layout-grid-2x2', currentLayoutMode === 'grid-2x2');
  grid.classList.toggle('layout-single', currentLayoutMode === 'single');
  if (DOM.layoutGridButton) DOM.layoutGridButton.classList.toggle('active', currentLayoutMode === 'grid-2x2');
  if (DOM.layoutSingleButton) DOM.layoutSingleButton.classList.toggle('active', currentLayoutMode === 'single');
  const displayMap: Record<DisplayViewportKey, HTMLElement | null> = {
    axial: DOM.viewportCards.axial,
    coronal: DOM.viewportCards.coronal,
    sagittal: DOM.viewportCards.sagittal,
    three: DOM.viewportCardThree,
  };
  Object.entries(displayMap).forEach(([key, element]) => {
    if (!element) return;
    element.classList.toggle('hidden-by-layout', currentLayoutMode === 'single' && key !== currentDisplayViewport);
    element.classList.toggle('single-active', currentLayoutMode === 'single' && key === currentDisplayViewport);
  });
}

async function syncCrosshair(world: Point3): Promise<void> {
  const safeWorld = clampWorldToSessionBounds(world);
  currentCrosshairWorld = safeWorld;
  updateCrosshairFooters(safeWorld);
  if (!session) return;
  for (const key of Object.keys(VIEWPORT_IDS) as ViewportKey[]) {
    if (key === 'aux' && currentAuxMode === 'cpr') continue;
    const viewport = session.renderingEngine.getViewport(VIEWPORT_IDS[key]) as any;
    const target = clampWorldToViewport(viewport, safeWorld);
    if (viewport?.jumpToWorld) {
      try {
        viewport.jumpToWorld(target);
      } catch {
        // Keep the rest of the workstation alive even if one viewport rejects the target.
      }
    } else if (viewport?.setCamera) {
      try {
        const camera = viewport.getCamera();
        viewport.setCamera({ ...camera, focalPoint: target });
      } catch {
        // Ignore per-viewport camera failures.
      }
    }
    viewport?.render?.();
  }
  if (currentAuxMode === 'centerline' || currentAuxMode === 'cpr') {
    const idx = findNearestCenterlineIndex(activeCase?.centerline, safeWorld);
    currentCenterlineIndex = idx;
    if (DOM.centerlineSlider) DOM.centerlineSlider.value = String(idx);
    updateCenterlineLabel();
    await applyAuxViewportMode();
  }
  renderAllViewports(session.renderingEngine);
  updateViewerState();
}

function updateCrosshairFooters(world: Point3): void {
  void world;
  refreshViewportPresentation();
}

async function applyAuxViewportMode(): Promise<void> {
  if (!session || !activeCase) return;
  if (currentAuxMode !== 'cpr') stopCine();
  const auxViewport = session.renderingEngine.getViewport(VIEWPORT_IDS.aux) as any;
  if (currentAuxMode === 'cpr') {
    await applyCprViewportMode(auxViewport);
    return;
  }
  await setVolumesForViewports(session.renderingEngine, [{ volumeId: session.volumeId }], [VIEWPORT_IDS.aux]);
  const plane = planeForMode(activeCase, currentAuxMode, currentCenterlineIndex);
  if (!plane || !auxViewport) return;
  const orientation = planeToOrientation(plane);
  auxViewport.setOrientation(orientation, true);
  try {
    auxViewport.resetCamera?.({
      resetPan: true,
      resetZoom: true,
      resetToCenter: true,
      resetCameraRotation: true,
    });
  } catch {
    // Aux reset is best effort only.
  }
  const target = plane.origin_world ? clampWorldToSessionBounds(toPoint3(plane.origin_world)) : currentCrosshairWorld;
  if (target && auxViewport.jumpToWorld) {
    try {
      auxViewport.jumpToWorld(clampWorldToViewport(auxViewport, target));
    } catch {
      stopCine();
    }
  }
  auxViewport.render();
  renderAllViewports(session.renderingEngine);
  refreshViewportPresentation();
  if (threeRuntime) updateThreePlaneHighlights();
}

async function applyCprViewportMode(auxViewport: any): Promise<void> {
  if (!session || !activeCase || !auxViewport) return;
  if (!isCapabilityAvailable(activeCase.capabilities?.cpr) || !session.cprVolumeId) {
    stopCine();
    refreshViewportPresentation();
    return;
  }
  await setVolumesForViewports(session.renderingEngine, [{ volumeId: session.cprVolumeId }], [VIEWPORT_IDS.aux]);
  auxViewport.setOrientation(CoreEnums.OrientationAxis.AXIAL, true);
  try {
    auxViewport.resetCamera?.({
      resetPan: true,
      resetZoom: true,
      resetToCenter: true,
      resetCameraRotation: true,
    });
  } catch {
    // CPR reset is best effort only.
  }
  const sliceSpacing = Number(activeCase.cpr_sources?.reference_json?.slice_spacing_mm || 1);
  const maxSliceIndex = Math.max(0, viewportSliceCount('aux') - 1);
  const safeIndex = Math.max(0, Math.min(maxSliceIndex, currentCenterlineIndex));
  currentCenterlineIndex = safeIndex;
  const sliceWorld: Point3 = [0, 0, safeIndex * Math.max(0.5, sliceSpacing)];
  if (auxViewport.jumpToWorld) {
    try {
      auxViewport.jumpToWorld(clampWorldToViewport(auxViewport, sliceWorld));
    } catch {
      stopCine();
      refreshViewportPresentation();
      return;
    }
  }
  auxViewport.render?.();
  renderAllViewports(session.renderingEngine);
  refreshViewportPresentation();
  if (threeRuntime) updateThreePlaneHighlights();
}

function planeForMode(casePayload: WorkstationCasePayload | null, mode: AuxMode, centerlineIndex: number): PlaneDefinition | null {
  if (!casePayload) return null;
  if (mode === 'annulus') return casePayload.display_planes?.annulus || null;
  if (mode === 'stj') return casePayload.display_planes?.stj || null;
  if (mode === 'cpr') return buildCenterlinePlane(casePayload.centerline, centerlineIndex);
  return buildCenterlinePlane(casePayload.centerline, centerlineIndex);
}

function buildCenterlinePlane(centerline: CenterlinePayload | null | undefined, index: number): PlaneDefinition | null {
  const points = Array.isArray(centerline?.points_world) ? centerline?.points_world : [];
  if (!points.length) return null;
  const clamped = Math.max(0, Math.min(points.length - 1, index));
  const origin = toPoint3(points[clamped]);
  const tangent = computeCenterlineTangent(points, clamped);
  const referenceUp: Point3 = [0, 1, 0];
  let basisU = normalize3(cross3(tangent, referenceUp));
  if (length3(basisU) < 1e-5) basisU = normalize3(cross3(tangent, [1, 0, 0]));
  const basisV = normalize3(cross3(basisU, tangent));
  return {
    id: 'centerline-orthogonal',
    label: 'centerline_orthogonal',
    origin_world: origin,
    normal_world: tangent,
    basis_u_world: basisU,
    basis_v_world: basisV,
    confidence: 1,
    source_index: clamped,
    status: 'derived',
  };
}

function planeToOrientation(plane: PlaneDefinition): { viewPlaneNormal: Point3; viewUp: Point3 } {
  const normal = normalize3(toPoint3(plane.normal_world || [0, 0, -1]));
  const viewUp = plane.basis_v_world ? normalize3(toPoint3(plane.basis_v_world)) : pickViewUp(normal);
  return { viewPlaneNormal: normal, viewUp };
}

function pickViewUp(normal: Point3): Point3 {
  const candidate = cross3([1, 0, 0], normal);
  if (length3(candidate) > 1e-5) return normalize3(candidate);
  return normalize3(cross3([0, 1, 0], normal));
}

function focusPlane(mode: AuxMode): void {
  if (!activeCase || !viewerInteractive()) return;
  if (!canNavigateLandmarkPlane(activeCase, mode)) {
    if (DOM.headerStatus) {
      DOM.headerStatus.textContent = isHistoricalInferredCase(activeCase)
        ? `${humanize(mode)} plane is unavailable for the current case`
        : `${humanize(mode)} plane unavailable`;
    }
    return;
  }
  if (DOM.auxMode) DOM.auxMode.value = mode;
  currentAuxMode = mode;
  if (mode === 'cpr') {
    void applyAuxViewportMode();
    return;
  }
  const plane = planeForMode(activeCase, mode, currentCenterlineIndex);
  if (plane?.origin_world) {
    void syncCrosshair(toPoint3(plane.origin_world));
  }
}

function focusRoot(): void {
  if (!activeCase || !viewerInteractive()) return;
  const focus = getBootstrapWorldPoint(activeCase);
  if (focus) void syncCrosshair(focus);
}

function focusCoronaryOstium(): void {
  if (!activeCase || !viewerInteractive()) return;
  const coronary = pickObject(pickObject(activeCase.aortic_root_model)?.coronary_ostia);
  const left = pickObject(coronary?.left);
  const right = pickObject(coronary?.right);
  const target = left?.point_world || right?.point_world;
  if (!target) return;
  void syncCrosshair(clampWorldToSessionBounds(toPoint3(target)));
}

function isHistoricalInferredCase(casePayload: WorkstationCasePayload | null | undefined): boolean {
  if (!casePayload) return false;
  if (Boolean(casePayload.pipeline_run && pickObject(casePayload.pipeline_run)?.inferred)) return true;
  const warnings = Array.isArray(casePayload.viewer_bootstrap?.bootstrap_warnings) ? casePayload.viewer_bootstrap?.bootstrap_warnings : [];
  return warnings.includes('historical_pipeline_run_inferred');
}

function getSessionWorldCenter(): Point3 | null {
  if (!session) return null;
  const viewport = session.renderingEngine.getViewport(VIEWPORT_IDS.axial) as any;
  const bounds = getViewportWorldBounds(viewport);
  if (!bounds) return null;
  return [
    (bounds[0] + bounds[1]) / 2,
    (bounds[2] + bounds[3]) / 2,
    (bounds[4] + bounds[5]) / 2,
  ];
}

function canNavigateLandmarkPlane(casePayload: WorkstationCasePayload | null | undefined, mode: AuxMode): boolean {
  if (!casePayload) return false;
  if (mode === 'cpr') return isCapabilityAvailable(casePayload.capabilities?.cpr);
  if (mode === 'annulus' || mode === 'stj') {
    const plane = planeForMode(casePayload, mode, currentCenterlineIndex);
    return Boolean(plane?.origin_world);
  }
  return true;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return value;
  return Math.min(max, Math.max(min, value));
}

function getViewportWorldBounds(viewport: any): [number, number, number, number, number, number] | null {
  try {
    const imageDataResult = viewport?.getImageData?.();
    const imageData = imageDataResult?.imageData || imageDataResult;
    const bounds = imageData?.getBounds?.();
    if (!Array.isArray(bounds) || bounds.length < 6) return null;
    const values = bounds.slice(0, 6).map((entry) => Number(entry));
    if (values.some((entry) => !Number.isFinite(entry))) return null;
    return [
      Math.min(values[0], values[1]),
      Math.max(values[0], values[1]),
      Math.min(values[2], values[3]),
      Math.max(values[2], values[3]),
      Math.min(values[4], values[5]),
      Math.max(values[4], values[5]),
    ];
  } catch {
    return null;
  }
}

function clampWorldToBounds(world: Point3, bounds: [number, number, number, number, number, number]): Point3 {
  return [
    clampNumber(world[0], bounds[0], bounds[1]),
    clampNumber(world[1], bounds[2], bounds[3]),
    clampNumber(world[2], bounds[4], bounds[5]),
  ];
}

function clampWorldToViewport(viewport: any, world: Point3): Point3 {
  const bounds = getViewportWorldBounds(viewport);
  return bounds ? clampWorldToBounds(world, bounds) : world;
}

function clampWorldToSessionBounds(world: Point3): Point3 {
  if (!session) return world;
  const viewport = session.renderingEngine.getViewport(VIEWPORT_IDS.axial) as any;
  return clampWorldToViewport(viewport, world);
}

function safeScrollViewport(key: ViewportKey, delta: number): boolean {
  if (!session) return false;
  if (key === 'aux' && currentAuxMode === 'cpr' && !isCapabilityAvailable(activeCase?.capabilities?.cpr)) {
    return false;
  }
  const viewport = session.renderingEngine.getViewport(VIEWPORT_IDS[key]) as any;
  if (!viewport?.scroll) return false;
  try {
    viewport.scroll(delta, false, true);
    viewport.render?.();
  } catch {
    return false;
  }
  return viewportSliceIndex(key) !== null || viewportSliceCount(key) === 0;
}

function primaryViewportsStable(): boolean {
  return (["axial", "sagittal", "coronal"] as ViewportKey[]).every((key) => viewportSliceIndex(key) !== null);
}

async function stabilizePrimaryViewports(casePayload: WorkstationCasePayload | null): Promise<void> {
  if (!session || primaryViewportsStable()) return;
  const focus = clampWorldToSessionBounds(getBootstrapWorldPoint(casePayload));
  (["axial", "sagittal", "coronal"] as ViewportKey[]).forEach((key) => {
    const viewport = session?.renderingEngine.getViewport(VIEWPORT_IDS[key]) as any;
    if (!viewport) return;
    try {
      viewport.resetCamera?.({
        resetPan: true,
        resetZoom: true,
        resetToCenter: true,
        resetCameraRotation: true,
      });
    } catch {
      // Best effort only.
    }
  });
  applyClinicalViewportFraming(casePayload, focus);
  await syncCrosshair(focus);
  await settleViewerPresentation(2);
}

function getMeasurementsRoot(casePayload: WorkstationCasePayload | null): Record<string, unknown> | null {
  const measurements = pickObject(casePayload?.measurements);
  return pickObject(measurements?.measurements) || measurements;
}

function estimateClinicalParallelScale(casePayload: WorkstationCasePayload | null): number {
  const measurementsRoot = getMeasurementsRoot(casePayload);
  const annulus = pickObject(measurementsRoot?.annulus);
  const sinus = pickObject(measurementsRoot?.sinus_of_valsalva);
  const stj = pickObject(measurementsRoot?.stj);
  const ascending = pickObject(measurementsRoot?.ascending_aorta);
  const values = [
    readMetricValue(annulus?.equivalent_diameter_mm),
    readMetricValue(annulus?.diameter_long_mm),
    readMetricValue(sinus?.max_diameter_mm),
    readMetricValue(sinus?.equivalent_diameter_mm),
    readMetricValue(stj?.diameter_mm),
    readMetricValue(stj?.diameter_long_mm),
    readMetricValue(ascending?.diameter_mm),
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const dominantDiameter = values.length ? Math.max(...values) : 32;
  return Math.max(20, Math.min(42, dominantDiameter * 1.2));
}

function applyClinicalViewportFraming(casePayload: WorkstationCasePayload | null, focalPoint?: Point3): void {
  if (!session) return;
  void focalPoint;
  const baseScale = estimateClinicalParallelScale(casePayload);
  (Object.keys(VIEWPORT_IDS) as ViewportKey[]).forEach((key) => {
    if (key === 'aux' && currentAuxMode === 'cpr') return;
    const viewport = session?.renderingEngine.getViewport(VIEWPORT_IDS[key]) as any;
    if (!viewport?.setCamera || !viewport?.getCamera) return;
    try {
      const camera = viewport.getCamera();
      viewport.setCamera({
        ...camera,
        parallelScale: key === 'aux' ? Math.max(16, baseScale * 0.82) : baseScale,
      });
      viewport.render?.();
    } catch {
      // Keep interactive viewing available even if a specific viewport camera rejects the framing hint.
    }
  });
}

function getBootstrapWorldPoint(casePayload: WorkstationCasePayload | null): Point3 {
  if (casePayload?.viewer_bootstrap?.focus_world) return toPoint3(casePayload.viewer_bootstrap.focus_world);
  const annulus = casePayload?.display_planes?.annulus?.origin_world;
  if (annulus) return toPoint3(annulus);
  const centerlineFirst = casePayload?.centerline?.points_world?.[0];
  if (centerlineFirst) return toPoint3(centerlineFirst);
  if (isHistoricalInferredCase(casePayload)) {
    const sessionCenter = getSessionWorldCenter();
    if (sessionCenter) return sessionCenter;
  }
  return [0, 0, 0];
}

function preferredDisplayName(casePayload: WorkstationCasePayload): string {
  if (typeof casePayload.display_name === 'string' && casePayload.display_name.trim()) {
    return casePayload.display_name.trim();
  }
  const localized = casePayload.display_name?.[currentLocale] || casePayload.display_name?.en || casePayload.display_name?.['zh-CN'];
  if (typeof localized === 'string' && localized.trim()) return localized.trim();
  if (isHistoricalInferredCase(casePayload)) {
    return currentLocale === 'zh-CN' ? '最新真实病例' : 'Latest Real Case';
  }
  return String(casePayload.case_id || casePayload.job.id || 'Case');
}

function updateHeaderMeta(casePayload: WorkstationCasePayload): void {
  const overallStatusRaw = String(casePayload.acceptance_review?.overall_status || casePayload.clinical_review?.overall_status || 'needs_review').toLowerCase();
  const statusClass = overallStatusRaw === 'pass'
    ? 'quality-pass'
    : overallStatusRaw === 'blocked'
      ? 'quality-blocked'
      : 'quality-needs_review';
  const scanDate = String(
    casePayload.study_meta?.scan_date
    || casePayload.study_meta?.acquired_at
    || defaultCaseManifestArtifact?.scan_date
    || 'n/a'
  );
  const caseId = String(casePayload.case_id || casePayload.job.id || 'default_clinical_case');
  const pipelineVersion = String(casePayload.pipeline_run?.pipeline_version || defaultCaseManifestArtifact?.pipeline_version || 'n/a');
  if (DOM.caseInfoLeft) {
    DOM.caseInfoLeft.textContent = `Case ${caseId} · Scan ${scanDate}`;
  }
  if (DOM.caseInfoCenter) {
    DOM.caseInfoCenter.textContent = 'AorticAI';
  }
  if (DOM.caseInfoRight) {
    DOM.caseInfoRight.innerHTML = `Pipeline ${escapeHtml(pipelineVersion)} · Build ${escapeHtml(BUILD_VERSION)} · <span class="quality-badge ${statusClass}">${escapeHtml(overallStatusRaw)}</span>`;
  }
  if (DOM.caseMeta) {
    const displayName = preferredDisplayName(casePayload);
    const acceptanceStatus = acceptanceStatusLabel(casePayload.acceptance_review?.overall_status);
    DOM.caseMeta.textContent = [
      String(displayName || casePayload.job.id || '-'),
      `Dataset ${String(casePayload.study_meta?.source_dataset || 'unknown')}`,
      `Phase ${String(casePayload.study_meta?.phase || casePayload.pipeline_run?.selected_phase || 'unknown')}`,
      `Input ${casePayload.volume_source.source_kind}`,
      acceptanceStatus ? `Acceptance ${acceptanceStatus}` : null,
      Array.isArray(casePayload.case_role) && casePayload.case_role.includes('showcase') ? 'Gold showcase reference' : null,
      casePayload.pipeline_run?.inferred ? 'Historical inferred provenance' : null,
    ].filter(Boolean).join(' · ');
  }
  if (DOM.demoCaseBadge) {
    const isDemoCase = Array.isArray(casePayload.case_role) && casePayload.case_role.includes('showcase');
    DOM.demoCaseBadge.classList.toggle('hidden', !isDemoCase);
  }
}

function isCapabilityAvailable(state: CapabilityState | null | undefined): boolean {
  return Boolean(state?.available);
}

function applyCapabilityControls(casePayload: WorkstationCasePayload): void {
  const cprOption = DOM.auxMode?.querySelector('option[value="cpr"]') as HTMLOptionElement | null;
  const cprEnabled = isCapabilityAvailable(casePayload.capabilities?.cpr);
  if (cprOption) {
    cprOption.disabled = !cprEnabled;
    cprOption.textContent = cprEnabled ? t('aux.cpr') : t('aux.cpr_unavailable');
  }
}

function resolveCaseAuxMode(casePayload: WorkstationCasePayload | null | undefined): AuxMode {
  const candidate = casePayload?.viewer_bootstrap?.aux_mode || 'annulus';
  if (candidate === 'cpr' && !isCapabilityAvailable(casePayload?.capabilities?.cpr)) return 'annulus';
  return candidate;
}

function resetViewerRuntimeForCase(casePayload: WorkstationCasePayload | null | undefined): void {
  stopCine();
  annotation.selection.deselectAnnotation();
  annotationUndoStack = [];
  currentCrosshairWorld = null;
  currentActiveViewport = 'axial';
  currentPrimaryTool = DEFAULT_PRIMARY_TOOL;
  currentWindowPreset = DEFAULT_WINDOW_PRESET;
  currentAuxMode = resolveCaseAuxMode(casePayload);
  currentCenterlineIndex = 0;
  if (casePayload) {
    activeCase = casePayload;
    currentCenterlineIndex = clampCenterlineIndex(casePayload.viewer_bootstrap?.centerline_index ?? 0);
  }
  if (DOM.auxMode) DOM.auxMode.value = currentAuxMode;
  updateCenterlineControl(casePayload?.centerline);
  syncToolUi();
  setActiveViewport(currentActiveViewport);
  refreshViewportPresentation();
}

function maybeAutoRunAnnotation(casePayload: WorkstationCasePayload | null): void {
  if (!casePayload || (casePayload.case_role || []).includes('showcase')) return;
  const studyId = currentStudyId(casePayload);
  if (!studyId) return;
  if (DOM.caseMeta && !DOM.caseMeta.textContent?.includes('Latest Case Auto Annotation')) {
    DOM.caseMeta.textContent = `${DOM.caseMeta.textContent || 'Latest Real Case'} · Latest Case Auto Annotation`;
  }
  if (autoAnnotationRequestedForStudy === studyId) return;
  const pipeline = pickObject(casePayload.pipeline_run);
  const alreadyAnnotated = (casePayload.case_role || []).includes('annotated')
    || (pipeline?.inferred === false && String(pipeline?.inference_mode || '').toLowerCase().includes('segmentation'));
  if (alreadyAnnotated) {
    autoAnnotationRequestedForStudy = studyId;
    return;
  }
  autoAnnotationRequestedForStudy = studyId;
  queueMicrotask(() => {
    void startAutoAnnotation();
  });
}

function updateCenterlineControl(centerline: CenterlinePayload | null | undefined): void {
  const count = Array.isArray(centerline?.points_world) ? centerline?.points_world.length : 0;
  if (!DOM.centerlineSlider) return;
  DOM.centerlineSlider.max = String(Math.max(0, count - 1));
  DOM.centerlineSlider.value = String(Math.max(0, Math.min(count - 1, currentCenterlineIndex)));
  DOM.centerlineSlider.disabled = count <= 1;
  updateCenterlineLabel();
}

function updateCenterlineLabel(): void {
  if (!DOM.centerlineValue) return;
  const total = Array.isArray(activeCase?.centerline?.points_world) ? activeCase!.centerline!.points_world!.length : 0;
  DOM.centerlineValue.textContent = total ? `${currentCenterlineIndex + 1} / ${total}` : '—';
}

function clampCenterlineIndex(index: number): number {
  const total = Array.isArray(activeCase?.centerline?.points_world) ? activeCase!.centerline!.points_world!.length : 0;
  if (!total) return 0;
  return Math.max(0, Math.min(total - 1, index));
}

function findNearestCenterlineIndex(centerline: CenterlinePayload | null | undefined, point: Point3): number {
  const points = Array.isArray(centerline?.points_world) ? centerline.points_world : [];
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  points.forEach((candidate, index) => {
    const distance = squaredDistance3(toPoint3(candidate), point);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function renderPearsPanel(casePayload: WorkstationCasePayload): void {
  if (!DOM.pearsPanel) return;
  const contentEl = DOM.pearsPanel.querySelector('.pears-content') as HTMLDivElement | null;
  if (!contentEl) return;

  // ── New data structure: pears_geometry from pears_planner_v3 ──────────────
  // Shape: { geometry, eligibility, surgical_planning, data_quality, module_version, ... }
  const pg = casePayload.pears_geometry as Record<string, unknown> | null | undefined;
  const pearsCapability = casePayload.capabilities?.pears_geometry || null;

  if (!pg || pg['error']) {
    const errMsg = pg ? String(pg['error'] || 'Unknown error') : 'PEARS geometry not yet computed.';
    contentEl.innerHTML = `<div class="pears-unavailable muted">${escapeHtml(errMsg)}</div>`;
    return;
  }

  // ── Extract top-level sections ────────────────────────────────────────────
  const geo       = pickObject(pg['geometry']);
  const elig      = pickObject(pg['eligibility']);
  const surgical  = pickObject(pg['surgical_planning']);
  const dq        = pickObject(pg['data_quality']);

  // ── Geometry sub-objects ──────────────────────────────────────────────────
  const ann       = pickObject(geo?.['annulus']);
  const stj       = pickObject(geo?.['stj']);
  const sov       = pickObject(geo?.['sinus']);
  const sinH      = pickObject(geo?.['sinus_height']);
  const cor       = pickObject(geo?.['coronary_heights']);
  const lcaObj    = pickObject(cor?.['left']);
  const rcaObj    = pickObject(cor?.['right']);

  // ── Surgical planning sub-objects ─────────────────────────────────────────
  const meshSz    = pickObject(surgical?.['mesh_sizing']);
  const suppSeg   = pickObject(surgical?.['support_segment']);
  const corWin    = pickObject(surgical?.['coronary_windows']);

  // ── Eligibility ───────────────────────────────────────────────────────────
  const status: string    = String(elig?.['status'] || 'unknown');
  const verdict: string   = String(elig?.['verdict'] || status.replace(/_/g, ' ').toUpperCase());
  const eligible: boolean = elig?.['eligible'] === true;
  const riskLevel: string = String(elig?.['risk_level'] || 'unknown');
  const summary: string   = String(elig?.['summary'] || '');
  const criteriaArr       = Array.isArray(elig?.['criteria']) ? (elig!['criteria'] as Record<string, unknown>[]) : [];
  const riskFlags         = Array.isArray(elig?.['risk_flags']) ? (elig!['risk_flags'] as string[]) : [];

  // ── Verdict CSS class ─────────────────────────────────────────────────────
  const verdictClass = eligible
    ? (riskLevel === 'high' ? 'pears-eligible-high-risk'
      : riskLevel === 'moderate' ? 'pears-eligible-caution'
      : 'pears-eligible')
    : status.startsWith('not_indicated') ? 'pears-not-indicated'
    : 'pears-consider';

  // ── Helpers ───────────────────────────────────────────────────────────────
  const fmm = (v: unknown, dec = 1): string =>
    (typeof v === 'number' && isFinite(v)) ? `${v.toFixed(dec)} mm` : '—';

  const fcrit = (id: string): string => {
    const c = criteriaArr.find((x) => x['id'] === id);
    if (!c) return '<span class="badge-muted">—</span>';
    const sev = String(c['severity'] || '');
    const met = c['met'];
    const icon = String(c['icon'] || (met === true ? '✓' : met === false ? '✗' : '?'));
    if (met === true && sev === 'ok')      return `<span class="badge-ok">${icon} pass</span>`;
    if (met === true && sev === 'caution') return `<span class="badge-caution">${icon} caution</span>`;
    if (met === false && sev === 'high_risk') return `<span class="badge-danger">${icon} high risk</span>`;
    if (met === false)                     return `<span class="badge-warn">${icon} fail</span>`;
    if (sev === 'info')                    return `<span class="badge-info">${icon}</span>`;
    if (sev === 'data_missing')            return `<span class="badge-warn">? missing</span>`;
    return `<span class="badge-muted">—</span>`;
  };

  const confBadge = (conf: unknown): string => {
    const c = typeof conf === 'number' ? conf : 0;
    if (c >= 0.8) return `<span class="pears-conf pears-conf-high">${(c * 100).toFixed(0)}%</span>`;
    if (c >= 0.5) return `<span class="pears-conf pears-conf-mid">${(c * 100).toFixed(0)}%</span>`;
    return `<span class="pears-conf pears-conf-low">${(c * 100).toFixed(0)}%</span>`;
  };

  // ── Coronary status badges ────────────────────────────────────────────────
  const coronaryStatusBadge = (obj: Record<string, unknown> | null | undefined): string => {
    if (!obj) return '<span class="badge-muted">—</span>';
    const st = String(obj['status'] || '');
    if (st === 'measured')              return '<span class="badge-ok">detected</span>';
    if (st === 'estimated_statistical') return '<span class="badge-warn">estimated</span>';
    return '<span class="badge-muted">—</span>';
  };

  // ── Geometry table rows ───────────────────────────────────────────────────
  const geoRows: string[] = [
    `<tr>
      <td>Sinus max diameter</td>
      <td class="val">${fmm(sov?.['max_diameter_mm'])}</td>
      <td>${fcrit('sinus_diameter')}</td>
      <td>${confBadge(sov?.['confidence'])}</td>
    </tr>`,
    `<tr>
      <td>STJ diameter</td>
      <td class="val">${fmm(stj?.['max_diameter_mm'] ?? stj?.['diameter_mm'])}</td>
      <td>${fcrit('stj_reference')}</td>
      <td>${confBadge(stj?.['confidence'])}</td>
    </tr>`,
    `<tr>
      <td>Sinus height</td>
      <td class="val">${fmm(sinH?.['height_mm'])}</td>
      <td><span class="badge-info">ℹ ref</span></td>
      <td>—</td>
    </tr>`,
    `<tr>
      <td>Annulus max (hinge PCA)</td>
      <td class="val">${fmm(ann?.['max_diameter_mm'])}</td>
      <td>${fcrit('annulus_reference')}</td>
      <td>${confBadge(ann?.['confidence'])}</td>
    </tr>`,
    `<tr>
      <td>Annulus equiv. diameter</td>
      <td class="val">${fmm(ann?.['equivalent_diameter_mm'])}</td>
      <td><span class="badge-info">ℹ ref</span></td>
      <td>—</td>
    </tr>`,
    `<tr>
      <td>LCA height</td>
      <td class="val">${fmm(lcaObj?.['height_mm'])}</td>
      <td>${fcrit('coronary_lca')}</td>
      <td>${coronaryStatusBadge(lcaObj)}</td>
    </tr>`,
    `<tr>
      <td>RCA height</td>
      <td class="val">${fmm(rcaObj?.['height_mm'])}</td>
      <td>${fcrit('coronary_rca')}</td>
      <td>${coronaryStatusBadge(rcaObj)}</td>
    </tr>`,
    `<tr>
      <td>Ascending aorta</td>
      <td class="val">${fmm(geo?.['ascending_max_diameter_mm'])}</td>
      <td>${fcrit('ascending_diameter')}</td>
      <td>—</td>
    </tr>`,
  ];

  // ── Mesh sizing rows ──────────────────────────────────────────────────────
  const meshRows: string[] = meshSz ? [
    `<tr><td>Sinus mesh diameter</td><td class="val">${fmm(meshSz['sinus_mesh_diameter_mm'])}</td><td class="pears-note-cell">95% of ${fmm(meshSz['sinus_reference_mm'])}</td></tr>`,
    `<tr><td>STJ mesh diameter</td><td class="val">${fmm(meshSz['stj_mesh_diameter_mm'])}</td><td class="pears-note-cell">95% of ${fmm(meshSz['stj_reference_mm'])}</td></tr>`,
    meshSz['ascending_mesh_diameter_mm'] ? `<tr><td>Ascending mesh diameter</td><td class="val">${fmm(meshSz['ascending_mesh_diameter_mm'])}</td><td class="pears-note-cell">95% of ${fmm(meshSz['ascending_reference_mm'])}</td></tr>` : '',
  ].filter(Boolean) : [];

  // ── Support segment rows ──────────────────────────────────────────────────
  const suppRows: string[] = suppSeg ? [
    `<tr><td>Root segment</td><td class="val">${fmm(suppSeg['root_segment_mm'])}</td><td class="pears-note-cell">Annulus → STJ</td></tr>`,
    `<tr><td>Ascending segment</td><td class="val">${fmm(suppSeg['ascending_segment_mm'])}</td><td class="pears-note-cell">STJ → innominate</td></tr>`,
    `<tr><td><strong>Total support length</strong></td><td class="val"><strong>${fmm(suppSeg['total_mm'])}</strong></td><td class="pears-note-cell">Verify intraop (paper ruler)</td></tr>`,
  ] : [];

  // ── Coronary window planning ──────────────────────────────────────────────
  const lcaWin = pickObject(corWin?.['lca']);
  const rcaWin = pickObject(corWin?.['rca']);
  const coronaryWindowsHtml = (lcaWin || rcaWin) ? `
    <div class="pears-subsection">
      <div class="pears-subsection-title">Coronary Window Planning</div>
      <div class="pears-coronary-grid">
        <div class="pears-coronary-item ${lcaObj?.['height_mm'] !== undefined && Number(lcaObj['height_mm']) < 10 ? 'pears-coronary-risk' : ''}">
          <span class="pears-coronary-label">LCA</span>
          <span class="pears-coronary-val">${fmm(lcaObj?.['height_mm'])}</span>
          <span class="pears-coronary-status">${coronaryStatusBadge(lcaObj)}</span>
        </div>
        <div class="pears-coronary-item ${rcaObj?.['height_mm'] !== undefined && Number(rcaObj['height_mm']) < 10 ? 'pears-coronary-risk' : ''}">
          <span class="pears-coronary-label">RCA</span>
          <span class="pears-coronary-val">${fmm(rcaObj?.['height_mm'])}</span>
          <span class="pears-coronary-status">${coronaryStatusBadge(rcaObj)}</span>
        </div>
      </div>
      <div class="pears-coronary-note muted">Windows cut from ostial holes to longitudinal end (Conci 2025)</div>
    </div>
  ` : '';

  // ── Criteria detail list ──────────────────────────────────────────────────
  const criteriaHtml = criteriaArr.length ? `
    <div class="pears-subsection">
      <div class="pears-subsection-title">Criteria Detail</div>
      <ul class="pears-criteria-list">
        ${criteriaArr.map((c) => {
          const sev = String(c['severity'] || 'info');
          const sevClass = sev === 'ok' ? 'pears-crit-ok'
            : sev === 'high_risk' ? 'pears-crit-danger'
            : sev === 'caution' ? 'pears-crit-caution'
            : sev === 'not_indicated' || sev === 'consider_alternative' ? 'pears-crit-warn'
            : 'pears-crit-info';
          const icon = String(c['icon'] || 'ℹ');
          const label = String(c['label'] || c['id'] || '');
          const msg = String(c['message'] || '');
          const val = typeof c['value_mm'] === 'number' ? ` (${(c['value_mm'] as number).toFixed(1)} mm)` : '';
          return `<li class="pears-crit-item ${sevClass}">
            <span class="pears-crit-icon">${icon}</span>
            <span class="pears-crit-body">
              <span class="pears-crit-label">${escapeHtml(label)}${escapeHtml(val)}</span>
              <span class="pears-crit-msg">${escapeHtml(msg)}</span>
            </span>
          </li>`;
        }).join('')}
      </ul>
    </div>
  ` : '';

  // ── Risk flags ────────────────────────────────────────────────────────────
  const flagsHtml = riskFlags.length ? `
    <div class="pears-flags">
      ${riskFlags.map((f) => `<span class="pears-flag">${escapeHtml(f.replace(/_/g, ' '))}</span>`).join('')}
    </div>
  ` : '';

  // ── Data quality bar ─────────────────────────────────────────────────────
  const dqHtml = dq ? `
    <div class="pears-dq">
      <span class="pears-dq-label">Data quality</span>
      <span class="pears-dq-item">Annulus ${confBadge(dq['annulus_confidence'])}</span>
      <span class="pears-dq-item">STJ ${confBadge(dq['stj_confidence'])}</span>
      <span class="pears-dq-item">Sinus ${confBadge(dq['sinus_confidence'])}</span>
      <span class="pears-dq-item">LCA ${confBadge(dq['lca_confidence'])}</span>
      <span class="pears-dq-item">RCA ${confBadge(dq['rca_confidence'])}</span>
    </div>
  ` : '';

  // ── Module version & references ───────────────────────────────────────────
  const modVer = String(pg['module_version'] || 'pears_planner_v3');
  const refs = Array.isArray(pg['references']) ? (pg['references'] as string[]) : [];
  const refsHtml = refs.length ? `
    <div class="pears-refs">
      ${refs.map((r) => `<div class="pears-ref">${escapeHtml(r)}</div>`).join('')}
    </div>
  ` : '';
  const sourceBanner = pearsCapability?.inferred
    ? `<div class="pears-unavailable muted">Historical inferred preview. This PEARS panel is derived from stored model landmarks, not a dedicated provider artifact.</div>`
    : pearsCapability?.available === false
      ? `<div class="pears-unavailable muted">Dedicated PEARS artifact is not available for this case.</div>`
      : '';

  // ── Assemble final HTML ───────────────────────────────────────────────────
  contentEl.innerHTML = `
    ${sourceBanner}
    <div class="pears-verdict ${verdictClass}">${escapeHtml(verdict)}</div>
    ${flagsHtml}
    ${summary ? `<p class="pears-summary">${escapeHtml(summary)}</p>` : ''}

    <div class="pears-subsection">
      <div class="pears-subsection-title">Anatomical Measurements</div>
      <table class="pears-table">
        <thead><tr><th>Parameter</th><th>Value</th><th>Criterion</th><th>Conf.</th></tr></thead>
        <tbody>${geoRows.join('')}</tbody>
      </table>
    </div>

    ${meshRows.length ? `
    <div class="pears-subsection">
      <div class="pears-subsection-title">Mesh Sizing <span class="pears-subsection-note">(Conci 2025: 95% inner diam.)</span></div>
      <table class="pears-table">
        <thead><tr><th>Parameter</th><th>Value</th><th>Basis</th></tr></thead>
        <tbody>${meshRows.join('')}</tbody>
      </table>
    </div>` : ''}

    ${suppRows.length ? `
    <div class="pears-subsection">
      <div class="pears-subsection-title">Support Segment <span class="pears-subsection-note">(annulus → innominate)</span></div>
      <table class="pears-table">
        <thead><tr><th>Segment</th><th>Length</th><th>Note</th></tr></thead>
        <tbody>${suppRows.join('')}</tbody>
      </table>
    </div>` : ''}

    ${coronaryWindowsHtml}
    ${criteriaHtml}
    ${dqHtml}

    <div class="pears-footer">
      <div class="pears-method muted">${escapeHtml(modVer)} · root_model_based · Treasure/Pepper + Conci 2025</div>
      ${refsHtml}
      <div class="pears-disclaimer muted">Research use only. Not validated for clinical decision-making.</div>
    </div>
  `;
}

function renderSidePanels(casePayload: WorkstationCasePayload): void {
  if (!casePayload) return;
  renderCoronaryReviewBanner(casePayload);
  renderCaseOverviewSummary(casePayload);
  renderCapabilitySummary(casePayload);
  renderAnnotationPanel(casePayload);
  renderMeasurementsPanel(casePayload);
  renderManualReviewPanel(casePayload);
  renderPlanningPanel(casePayload);

  renderAcceptancePanel(casePayload);
  const qaItems = collectQaItems(casePayload);
  DOM.qaList!.innerHTML = qaItems.map(renderQaItem).join('') || `<li class="muted">${escapeHtml(t('message.no_qa'))}</li>`;
  renderDownloadPanel(casePayload);

  updateViewerState();
}

function resolveCoronaryReviewRequired(casePayload: WorkstationCasePayload): boolean {
  const artifactCoronary = pickObject(defaultMeasurementsArtifact)?.coronary_detection;
  const payloadCoronary = pickObject(casePayload.measurements)?.coronary_detection
    || pickObject(pickObject(casePayload.measurements)?.measurements)?.coronary_detection;
  if (Boolean(pickObject(artifactCoronary)?.clinician_review_required) || Boolean(pickObject(payloadCoronary)?.clinician_review_required)) {
    return true;
  }

  const fromMeasurementPayload = pickObject(casePayload.measurements);
  const riskFlags = Array.isArray(fromMeasurementPayload?.risk_flags)
    ? (fromMeasurementPayload?.risk_flags as Array<Record<string, unknown>>)
    : [];
  return riskFlags.some((entry) => String(entry?.id || '').toLowerCase() === 'coronary_detection_requires_review');
}

function renderCoronaryReviewBanner(casePayload: WorkstationCasePayload | null): void {
  if (!DOM.coronaryReviewBanner) return;
  if (!casePayload || coronaryReviewBannerAcknowledged) {
    DOM.coronaryReviewBanner.classList.add('hidden');
    return;
  }
  const show = resolveCoronaryReviewRequired(casePayload);
  DOM.coronaryReviewBanner.classList.toggle('hidden', !show);
}

function renderMeasurementsPanel(casePayload: WorkstationCasePayload): void {
  if (!DOM.measurementGrid) return;
  DOM.measurementGrid.classList.remove('skeleton-shimmer');
  const isShowcaseCase = Array.isArray(casePayload.case_role) && casePayload.case_role.includes('showcase');
  if ((isShowcaseCase && !defaultMeasurementsArtifact) || (!defaultMeasurementsArtifact && !casePayload.measurements)) {
    DOM.measurementGrid.innerHTML = '<div class="muted">⚠ Data unavailable</div>';
    return;
  }
  const artifactRoot = pickObject(defaultMeasurementsArtifact)?.measurements
    ? pickObject(defaultMeasurementsArtifact)
    : null;
  const measurementRoot = pickObject(artifactRoot?.measurements)
    || pickObject(pickObject(casePayload.measurements)?.measurements)
    || pickObject(casePayload.measurements)
    || {};
  const sections: Array<{ key: string; titleKey: string; entries: string[] }> = [
    {
      key: 'annulus',
      titleKey: 'section.annulus',
      entries: ['annulus_equivalent_diameter_mm', 'annulus_short_diameter_mm', 'annulus_long_diameter_mm', 'annulus_area_mm2', 'annulus_perimeter_mm'],
    },
    {
      key: 'stj',
      titleKey: 'section.stj',
      entries: ['stj_diameter_mm'],
    },
    {
      key: 'sinus',
      titleKey: 'section.sinus',
      entries: ['sinus_diameter_mm', 'ascending_aorta_diameter_mm'],
    },
    {
      key: 'coronary',
      titleKey: 'section.coronary',
      entries: ['coronary_height_left_mm', 'coronary_height_right_mm'],
    },
    {
      key: 'leaflet',
      titleKey: 'section.leaflet',
      entries: ['leaflet_effective_height_mm', 'calcium_burden_ml'],
    },
  ];
  const html = sections.map((section) => {
    const rows = section.entries
      .map((fieldKey) => measurementPanelRow(fieldKey, measurementRoot[fieldKey]))
      .filter(Boolean) as string[];
    if (!rows.length) return '';
    return `
      <div class="metric-section measurement-section">
        <div class="metric-section-title">${escapeHtml(t(section.titleKey))}</div>
        ${rows.join('')}
      </div>
    `;
  }).join('');
  DOM.measurementGrid.innerHTML = html || `<div class="muted">${escapeHtml(t('message.no_measurements'))}</div>`;
}

function createEmptyManualAnnotation(caseId: string): ManualAnnotationRecord {
  const emptyMeasurements = Object.fromEntries(
    MANUAL_REVIEW_FIELDS.map((entry) => [entry.key, { value: null, method: entry.method }])
  ) as Record<ManualReviewFieldKey, { value: number | null; method?: string }>;
  const emptyDiffs = Object.fromEntries(
    MANUAL_REVIEW_FIELDS.map((entry) => [entry.key, null])
  ) as Record<ManualReviewFieldKey, number | null>;
  return {
    case_id: caseId,
    annotator: 'manual_reviewer',
    annotation_date: new Date().toISOString(),
    measurements: emptyMeasurements,
    comparison: {
      auto_vs_manual_diff_mm: emptyDiffs,
      acceptable_threshold_mm: MANUAL_REVIEW_THRESHOLD_MM,
    },
  };
}

async function hydrateManualReview(casePayload: WorkstationCasePayload): Promise<void> {
  if (!DOM.manualReviewGrid || !DOM.manualReviewStatus) return;
  const caseId = String(casePayload.case_id || casePayload.job?.id || SHOWCASE_CASE_ID).trim() || SHOWCASE_CASE_ID;
  if (manualAnnotationCaseId === caseId && manualAnnotationRecord) {
    renderManualReviewPanel(casePayload);
    return;
  }
  manualAnnotationCaseId = caseId;
  manualAnnotationRecord = createEmptyManualAnnotation(caseId);
  DOM.manualReviewStatus.textContent = t('manual.status_loading');
  renderManualReviewPanel(casePayload);
  try {
    const payload = await fetchJson<{ annotations?: Array<{ annotation?: Record<string, unknown> }> }>(
      `/api/cases/${encodeURIComponent(caseId)}/annotations`
    );
    const latest = Array.isArray(payload.annotations) ? pickObject(payload.annotations[0]?.annotation) : null;
    if (latest) {
      manualAnnotationRecord = normalizeManualAnnotation(caseId, latest);
    }
    DOM.manualReviewStatus.textContent = t('manual.status_ready');
  } catch {
    DOM.manualReviewStatus.textContent = t('manual.status_unavailable');
  }
  renderManualReviewPanel(casePayload);
}

function normalizeManualAnnotation(caseId: string, raw: Record<string, unknown>): ManualAnnotationRecord {
  const fallback = createEmptyManualAnnotation(caseId);
  const measurements = pickObject(raw.measurements) || {};
  const comparison = pickObject(raw.comparison) || {};
  const diffMap = pickObject(comparison.auto_vs_manual_diff_mm) || {};

  MANUAL_REVIEW_FIELDS.forEach((entry) => {
    const measurement = pickObject(measurements[entry.key]) || {};
    const value = Number(measurement.value);
    fallback.measurements[entry.key] = {
      value: Number.isFinite(value) ? value : null,
      method: String(measurement.method || entry.method),
    };
    const diff = Number(diffMap[entry.key]);
    fallback.comparison.auto_vs_manual_diff_mm[entry.key] = Number.isFinite(diff) ? diff : null;
  });
  const threshold = Number(comparison.acceptable_threshold_mm);
  if (Number.isFinite(threshold) && threshold > 0) {
    fallback.comparison.acceptable_threshold_mm = threshold;
  }
  fallback.annotator = String(raw.annotator || fallback.annotator);
  fallback.annotation_date = String(raw.annotation_date || fallback.annotation_date);
  return fallback;
}

function manualDiffTone(diff: number | null): MetricTone {
  if (diff == null || Number.isNaN(diff)) return 'info';
  if (diff < MANUAL_REVIEW_THRESHOLD_MM) return 'ok';
  if (diff < 3) return 'warn';
  return 'danger';
}

function manualDiffLabel(diff: number | null): string {
  if (diff == null || Number.isNaN(diff)) return t('manual.diff_na');
  if (diff < MANUAL_REVIEW_THRESHOLD_MM) return t('manual.diff_ok');
  if (diff < 3) return t('manual.diff_review');
  return t('manual.diff_remeasure');
}

function renderManualReviewPanel(casePayload: WorkstationCasePayload): void {
  if (!DOM.manualReviewGrid || !DOM.manualReviewStatus || !manualAnnotationRecord) return;
  const measurements = currentMeasurementsEnvelopeMap(casePayload);
  const rows = MANUAL_REVIEW_FIELDS.map((entry) => {
    const autoValue = envelopeNumber(measurements[entry.autoKey]);
    const manualValue = manualAnnotationRecord?.measurements?.[entry.key]?.value;
    const existingDiff = manualAnnotationRecord?.comparison?.auto_vs_manual_diff_mm?.[entry.key];
    const diff = autoValue == null || manualValue == null ? (existingDiff ?? null) : Math.abs(autoValue - manualValue);
    const tone = manualDiffTone(diff);
    const diffText = diff == null ? t('manual.diff_na') : `${diff.toFixed(2)} mm · ${manualDiffLabel(diff)}`;
    return `
      <div class="metric-row tone-${tone} manual-review-row">
        <div class="metric-label">
          <span class="metric-label-text">${escapeHtml(t(entry.labelKey))}</span>
          <span class="metric-meta">${escapeHtml(`Auto: ${autoValue == null ? 'N/A' : `${autoValue.toFixed(2)} mm`} · ${diffText}`)}</span>
        </div>
        <div class="manual-entry-actions">
          <input type="number" step="0.1" class="manual-input" data-manual-input="${escapeHtml(entry.key)}" value="${manualValue == null ? '' : escapeHtml(String(manualValue))}" placeholder="mm" />
          <button type="button" data-manual-save="${escapeHtml(entry.key)}" class="manual-save-btn">${escapeHtml(t('manual.save'))}</button>
        </div>
      </div>
    `;
  });
  DOM.manualReviewGrid.innerHTML = rows.join('');
}

async function saveManualReviewField(fieldKey: ManualReviewFieldKey): Promise<void> {
  if (!activeCase || !manualAnnotationRecord || !DOM.manualReviewGrid || !DOM.manualReviewStatus) return;
  const input = DOM.manualReviewGrid.querySelector(`input[data-manual-input="${fieldKey}"]`) as HTMLInputElement | null;
  if (!input) return;
  const parsed = Number(input.value);
  const manualValue = Number.isFinite(parsed) ? parsed : null;
  manualAnnotationRecord.measurements[fieldKey] = {
    value: manualValue,
    method: manualAnnotationRecord.measurements[fieldKey]?.method || 'double_oblique',
  };

  const entry = MANUAL_REVIEW_FIELDS.find((item) => item.key === fieldKey);
  const autoEnvelope = entry ? currentMeasurementsEnvelopeMap(activeCase)[entry.autoKey] : null;
  const autoValue = envelopeNumber(autoEnvelope);
  manualAnnotationRecord.comparison.auto_vs_manual_diff_mm[fieldKey] =
    autoValue == null || manualValue == null ? null : Math.abs(autoValue - manualValue);
  manualAnnotationRecord.annotation_date = new Date().toISOString();
  DOM.manualReviewStatus.textContent = t('manual.status_saving');
  renderManualReviewPanel(activeCase);

  try {
    const caseId = String(activeCase.case_id || activeCase.job?.id || SHOWCASE_CASE_ID).trim() || SHOWCASE_CASE_ID;
    await fetchJson(`/api/cases/${encodeURIComponent(caseId)}/annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(manualAnnotationRecord),
    });
    DOM.manualReviewStatus.textContent = t('manual.status_saved');
  } catch {
    DOM.manualReviewStatus.textContent = t('manual.status_save_failed');
  }
}

function currentMeasurementsEnvelopeMap(casePayload: WorkstationCasePayload | null): Record<string, Record<string, unknown>> {
  if (!casePayload) return {};
  const artifactRoot = pickObject(defaultMeasurementsArtifact)?.measurements ? pickObject(defaultMeasurementsArtifact) : null;
  const measurementRoot = pickObject(artifactRoot?.measurements)
    || pickObject(pickObject(casePayload.measurements)?.measurements)
    || pickObject(casePayload.measurements)
    || {};
  const sections: Array<string> = [
    'annulus_equivalent_diameter_mm',
    'annulus_short_diameter_mm',
    'annulus_long_diameter_mm',
    'annulus_area_mm2',
    'annulus_perimeter_mm',
    'stj_diameter_mm',
    'sinus_diameter_mm',
    'ascending_aorta_diameter_mm',
    'coronary_height_left_mm',
    'coronary_height_right_mm',
    'leaflet_effective_height_mm',
    'calcium_burden_ml',
  ];
  const out: Record<string, Record<string, unknown>> = {};
  sections.forEach((key) => {
    const envelope = pickObject(measurementRoot[key]);
    if (envelope) out[key] = envelope;
  });
  return out;
}

function csvEscape(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n')) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function exportMeasurementsCsv(): void {
  const casePayload = activeCase;
  if (!casePayload) return;
  const envelopeMap = currentMeasurementsEnvelopeMap(casePayload);
  const rows: string[] = ['field,value,unit,uncertainty,clinician_review_required'];
  Object.entries(envelopeMap).forEach(([field, envelope]) => {
    const value = envelope.value == null
      ? ''
      : typeof envelope.value === 'object'
        ? JSON.stringify(envelope.value)
        : String(envelope.value);
    const unit = String(envelope.unit || '');
    const uncertainty = String(pickObject(envelope.uncertainty)?.flag || 'NOT_AVAILABLE');
    const reviewRequired = Boolean(pickObject(envelope.uncertainty)?.clinician_review_required);
    rows.push([
      csvEscape(field),
      csvEscape(value),
      csvEscape(unit),
      csvEscape(uncertainty),
      reviewRequired ? 'true' : 'false',
    ].join(','));
  });
  const date = new Date().toISOString().slice(0, 10);
  const caseId = String(casePayload.case_id || casePayload.job?.id || 'case').replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `aorticai_measurements_${caseId}_${date}.csv`;
  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function measurementPanelRow(fieldKey: string, value: unknown): string | null {
  const envelope = pickObject(value);
  if (!envelope) return null;
  const uncertainty = pickObject(envelope.uncertainty);
  const flag = String(uncertainty?.flag || 'NOT_AVAILABLE').toUpperCase();
  const tone = measurementToneFromFlag(flag);
  const reviewRequired = Boolean(uncertainty?.clinician_review_required);
  const displayValue = formatMetricDisplayValue(fieldKey, envelope, inferUnitFromValue(fieldKey, envelope));
  const unit = String(envelope.unit || inferUnitFromValue(fieldKey, envelope) || '');
  const confidence = pickObject(envelope.evidence)?.confidence;
  const confidenceText = confidence == null || Number.isNaN(Number(confidence))
    ? 'n/a'
    : `${Math.round(Number(confidence) * 100)}%`;
  return `
    <div class="metric-row tone-${tone} measurement-row ${reviewRequired ? 'review-required' : ''}">
      <div class="metric-label">
        <span class="metric-label-text"><span class="confidence-dot tone-${tone}"></span>${escapeHtml(humanize(fieldKey))}</span>
        <span class="metric-meta">${escapeHtml(flag)} · conf ${escapeHtml(confidenceText)}</span>
      </div>
      <div class="metric-value">${escapeHtml(displayValue)}${unit ? `<span class="metric-unit">${escapeHtml(unit)}</span>` : ''}</div>
    </div>
  `;
}

function renderPlanningPanel(casePayload: WorkstationCasePayload): void {
  if (!DOM.planningGrid) return;
  DOM.planningGrid.classList.remove('skeleton-shimmer');
  DOM.planningGrid.classList.add('planning-grid');
  const isShowcaseCase = Array.isArray(casePayload.case_role) && casePayload.case_role.includes('showcase');
  if ((isShowcaseCase && !defaultPlanningArtifact) || (!defaultPlanningArtifact && !casePayload.planning)) {
    DOM.planningGrid.innerHTML = '<div class="muted">⚠ Data unavailable</div>';
    return;
  }
  const planningRoot = pickObject(defaultPlanningArtifact) || pickObject(casePayload.planning) || {};
  const tabKey = currentPlanningTab.toLowerCase();
  const section = pickObject(planningRoot[tabKey]);
  const measurementMap = currentMeasurementsEnvelopeMap(casePayload);
  let rows: string[] = [];
  if (currentPlanningTab === 'TAVI') {
    rows = buildTaviPlanningRows(section, measurementMap);
  } else if (currentPlanningTab === 'VSRR') {
    rows = buildVsrrPlanningRows(section, measurementMap);
  } else {
    rows = buildPearsPlanningRows(section, measurementMap);
  }
  DOM.planningGrid.innerHTML = rows.join('') || `<div class="muted">${escapeHtml(t('message.no_planning'))}</div>`;
}

function planningPanelRow(
  tab: 'TAVI' | 'VSRR' | 'PEARS',
  key: string,
  entry: unknown,
  overrideDisplay?: string,
  overrideTone?: MetricTone,
  overrideReason?: string
): string | null {
  const envelope = pickObject(entry) || {
    value: null,
    evidence: { method: 'not_available', source_ref: 'N/A', confidence: 0 },
    uncertainty: { flag: 'NOT_AVAILABLE', message: 'Planning value is not available in this artifact.', clinician_review_required: true },
  };
  const evidence = pickObject(envelope.evidence);
  const uncertainty = pickObject(envelope.uncertainty);
  const value = envelope.value;
  const flag = String(uncertainty?.flag || 'NOT_AVAILABLE').toUpperCase();
  const tone = overrideTone || measurementToneFromFlag(flag);
  const displayValue = overrideDisplay || (value == null
    ? 'Unavailable'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value));
  const tooltip = [
    evidence?.method ? `method: ${String(evidence.method)}` : null,
    evidence?.source_ref ? `source: ${String(evidence.source_ref)}` : null,
    evidence?.confidence != null ? `confidence: ${Number(evidence.confidence).toFixed(2)}` : null,
    uncertainty?.message ? `uncertainty: ${String(uncertainty.message)}` : null,
  ].filter(Boolean).join(' | ');
  return `
    <div class="metric-row tone-${tone}" title="${escapeHtml(tooltip || 'No evidence metadata')}">
      <div class="metric-label">
        <span class="metric-group tone-${tone}">${escapeHtml(tab)}</span>
        <span class="metric-label-text"><span class="confidence-dot tone-${tone}"></span>${escapeHtml(humanize(key))}</span>
        <span class="metric-meta">${escapeHtml(`method: ${String(evidence?.method || 'not_available')} · flag: ${flag}`)}</span>
        <span class="metric-meta">${escapeHtml(`${t('planning.recommendation_reason')}: ${String(overrideReason || evidence?.method || 'not_available')}`)}</span>
      </div>
      <div class="metric-value">${escapeHtml(displayValue)}</div>
    </div>
  `;
}

function envelopeNumber(entry: unknown): number | null {
  const envelope = pickObject(entry);
  if (!envelope) return null;
  const value = envelope.value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function buildTaviPlanningRows(
  section: Record<string, unknown> | null | undefined,
  measurements: Record<string, Record<string, unknown>>
): string[] {
  const rows: Array<string | null> = [];
  const annulusArea = envelopeNumber(measurements.annulus_area_mm2);
  const annulusPerimeter = envelopeNumber(measurements.annulus_perimeter_mm);
  const annulusAreaDisplay = annulusArea == null || annulusPerimeter == null
    ? 'Unavailable'
    : `${annulusArea.toFixed(1)} mm² / ${annulusPerimeter.toFixed(1)} mm`;
  rows.push(planningPanelRow('TAVI', 'annulus_area_perimeter', measurements.annulus_area_mm2, annulusAreaDisplay, annulusArea == null ? 'danger' : 'ok', 'annulus area + perimeter derived sizing'));

  const areaDerived = pickObject(section?.area_derived_valve_size);
  const derivedValue = pickObject(areaDerived?.value);
  const recommendedNominal = typeof derivedValue?.nearest_nominal_size_mm === 'number' ? derivedValue.nearest_nominal_size_mm : null;
  const recommendedDisplay = recommendedNominal == null ? 'Unavailable' : `${recommendedNominal} mm`;
  rows.push(planningPanelRow('TAVI', 'recommended_valve_size', section?.area_derived_valve_size, recommendedDisplay, recommendedNominal == null ? 'danger' : 'ok', 'area/perimeter nominal size mapping'));

  const lca = envelopeNumber(measurements.coronary_height_left_mm);
  const rca = envelopeNumber(measurements.coronary_height_right_mm);
  const minCor = [lca, rca].filter((v): v is number => typeof v === 'number').reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
  const corTone: MetricTone = !Number.isFinite(minCor) ? 'danger' : minCor < 12 ? 'warn' : 'ok';
  const corReason = Number.isFinite(minCor) && minCor < 12 ? 'coronary obstruction risk warning (<12 mm)' : 'coronary heights above warning threshold';
  const corDisplay = lca == null || rca == null ? 'Unavailable' : `L ${lca.toFixed(1)} mm / R ${rca.toFixed(1)} mm`;
  rows.push(planningPanelRow('TAVI', 'coronary_height', measurements.coronary_height_left_mm, corDisplay, corTone, corReason));

  const stj = envelopeNumber(measurements.stj_diameter_mm);
  const stjDisplay = stj == null || recommendedNominal == null ? 'Unavailable' : `${stj.toFixed(1)} mm vs valve ${recommendedNominal} mm`;
  rows.push(planningPanelRow('TAVI', 'stj_vs_valve', measurements.stj_diameter_mm, stjDisplay, stj == null ? 'danger' : 'info', 'stj diameter compared with recommended prosthesis size'));

  return rows.filter(Boolean) as string[];
}

function buildVsrrPlanningRows(
  section: Record<string, unknown> | null | undefined,
  measurements: Record<string, Record<string, unknown>>
): string[] {
  const rows: Array<string | null> = [];
  const graftEntry = section?.recommended_graft_diameter_mm || section?.graft_sizing;
  const graftNum = envelopeNumber(graftEntry);
  const graftDisplay = graftNum == null ? (pickObject(graftEntry)?.value != null ? JSON.stringify(pickObject(graftEntry)?.value) : 'Unavailable') : `${graftNum} mm`;
  rows.push(planningPanelRow('VSRR', 'recommended_graft_diameter', graftEntry, graftDisplay, graftNum == null ? 'warn' : 'ok', 'David procedure graft sizing guidance'));

  const leafletEff = envelopeNumber(measurements.leaflet_effective_height_mm);
  const leafletTone: MetricTone = leafletEff == null ? 'danger' : leafletEff > 9 ? 'ok' : 'danger';
  const leafletDisplay = leafletEff == null ? 'Unavailable' : `${leafletEff.toFixed(1)} mm (target > 9 mm)`;
  rows.push(planningPanelRow('VSRR', 'leaflet_effective_height_target', measurements.leaflet_effective_height_mm, leafletDisplay, leafletTone, 'leaflet effective height target check'));

  const ann = envelopeNumber(measurements.annulus_equivalent_diameter_mm);
  const stj = envelopeNumber(measurements.stj_diameter_mm);
  const mismatch = ann != null && stj != null ? Math.abs(ann - stj) : null;
  const mismatchTone: MetricTone = mismatch == null ? 'danger' : mismatch > 4 ? 'warn' : 'ok';
  const mismatchDisplay = mismatch == null ? 'Unavailable' : `Δ ${mismatch.toFixed(1)} mm (annulus ${ann!.toFixed(1)} / STJ ${stj!.toFixed(1)})`;
  rows.push(planningPanelRow('VSRR', 'annulus_stj_mismatch', measurements.stj_diameter_mm, mismatchDisplay, mismatchTone, 'annulus to STJ mismatch review'));

  return rows.filter(Boolean) as string[];
}

function buildPearsPlanningRows(
  section: Record<string, unknown> | null | undefined,
  measurements: Record<string, Record<string, unknown>>
): string[] {
  const rows: Array<string | null> = [];
  const rootDiameterEntry = section?.max_sinus_diameter_mm || measurements.sinus_diameter_mm;
  const rootDiameter = envelopeNumber(rootDiameterEntry);
  const rootDiameterDisplay = rootDiameter == null ? 'Unavailable' : `${rootDiameter.toFixed(1)} mm`;
  rows.push(planningPanelRow('PEARS', 'root_external_reference_diameter', rootDiameterEntry, rootDiameterDisplay, rootDiameter == null ? 'danger' : 'ok', 'external root reference diameter'));

  const supportEntry = pickObject(section?.support_region_status);
  const supportValue = pickObject(supportEntry?.value);
  const supportLength = typeof supportValue?.support_segment_length_mm === 'number' ? supportValue.support_segment_length_mm : null;
  const supportDisplay = supportLength == null ? 'Unavailable' : `${supportLength.toFixed(1)} mm`;
  rows.push(planningPanelRow('PEARS', 'support_segment_length', section?.support_region_status, supportDisplay, supportLength == null ? 'warn' : 'ok', 'support region segment length'));

  return rows.filter(Boolean) as string[];
}

function measurementToneFromFlag(flag: string): MetricTone {
  const normalized = flag.toUpperCase();
  if (normalized === 'NONE') return 'ok';
  if (normalized === 'LOW_CONFIDENCE' || normalized === 'BORDERLINE') return 'warn';
  if (normalized === 'NOT_AVAILABLE' || normalized === 'DETECTION_FAILED') return 'danger';
  return 'danger';
}

function renderCaseOverviewSummary(casePayload: WorkstationCasePayload): void {
  if (!DOM.caseOverviewSummary) return;
  const review = casePayload.clinical_review || casePayload.acceptance_review;
  const overall = acceptanceStatusLabel(review?.overall_status);
  const sourceLabel = Array.isArray(casePayload.case_role) && casePayload.case_role.includes('showcase')
    ? 'Showcase'
    : isHistoricalInferredCase(casePayload)
      ? 'Latest / Legacy'
      : 'Latest';
  const limitations = [
    isCapabilityAvailable(casePayload.capabilities?.cpr) ? null : 'CPR unavailable',
    isHistoricalInferredCase(casePayload) ? 'Historical / inferred provenance' : null,
    review?.human_review_required ? 'Human review required' : null,
  ].filter(Boolean);
  DOM.caseOverviewSummary.innerHTML = `
    <div class="case-pill-row">
      <span class="case-pill">${escapeHtml(sourceLabel)}</span>
      <span class="case-pill">${escapeHtml(overall || 'Review')}</span>
      <span class="case-pill">${escapeHtml(casePayload.volume_source.source_kind.toUpperCase())}</span>
    </div>
    <div class="case-overview-caption">${escapeHtml(preferredDisplayName(casePayload))}</div>
    ${limitations.length
      ? `<div class="case-overview-limitations">${limitations.map((item) => `<span class="case-limit-pill">${escapeHtml(item)}</span>`).join('')}</div>`
      : ''
    }
  `;
}

function renderAcceptancePanel(casePayload: WorkstationCasePayload): void {
  if (!DOM.acceptanceSummary || !DOM.acceptanceList) return;
  const review = pickObject(casePayload.clinical_review || casePayload.acceptance_review) as AcceptanceReview | null;
  if (!review) {
    DOM.acceptanceSummary.textContent = t('message.no_acceptance');
    DOM.acceptanceList.innerHTML = `<li class="muted">${escapeHtml(t('message.no_acceptance'))}</li>`;
    return;
  }
  const overallStatus = acceptanceStatusLabel(review.overall_status);
  const summary = typeof review.summary === 'string' && review.summary.trim() ? review.summary.trim() : t('message.no_acceptance');
  DOM.acceptanceSummary.textContent = `${overallStatus} · ${summary}`;
  const items = collectAcceptanceItems(review);
  DOM.acceptanceList.innerHTML = items.map(renderQaItem).join('') || `<li class="muted">${escapeHtml(t('message.no_acceptance'))}</li>`;
}

function renderCapabilitySummary(casePayload: WorkstationCasePayload): void {
  if (!DOM.capabilityGrid) return;
  const capabilities = casePayload.capabilities || {};
  const cards = Object.entries(capabilities).map(([key, raw]) => {
    const state = pickObject(raw);
    if (!state) return '';
    const tone = capabilityTone(state);
    const status = state.available ? 'Available' : state.inferred ? 'Inferred' : state.legacy ? 'Legacy' : 'Unavailable';
    return `
      <div class="capability-card-item tone-${tone}">
        <div class="capability-card-head">
          <span class="capability-name">${escapeHtml(humanize(key))}</span>
          <span class="capability-pill tone-${tone}">${escapeHtml(status)}</span>
        </div>
        <div class="capability-meta">${escapeHtml(String(state.source || 'artifact-driven'))}</div>
        <div class="capability-reason">${escapeHtml(String(state.reason || 'artifact-driven'))}</div>
      </div>
    `;
  }).filter(Boolean);
  DOM.capabilityGrid.innerHTML = cards.join('');
}

function collectMeasurementRows(payload: Record<string, unknown> | null | undefined, casePayload?: WorkstationCasePayload | null): MetricRow[] {
  const measurementsRoot = pickObject(payload?.measurements_regularized)
    || pickObject(payload?.measurements)
    || pickObject(payload?.regularized_measurements)
    || {};
  const contract = pickObject(payload?.measurement_contract) || {};

  const candidates = [
    ['annulus_equivalent_diameter_mm', 'Annulus eq. diameter'],
    ['annulus_short_diameter_mm', 'Annulus short'],
    ['annulus_long_diameter_mm', 'Annulus long'],
    ['annulus_area_mm2', 'Annulus area'],
    ['annulus_perimeter_mm', 'Annulus perimeter'],
    ['sinus_diameter_mm', 'Sinus of Valsalva'],
    ['stj_diameter_mm', 'STJ diameter'],
    ['ascending_aorta_diameter_mm', 'Ascending aorta'],
    ['lvot_diameter_mm', 'LVOT diameter'],
    ['coronary_height_left_mm', 'Left coronary height'],
    ['coronary_height_right_mm', 'Right coronary height'],
    ['calcium_burden_ml', 'Valve calcium burden'],
  ] as const;

  const rows = candidates
    .map(([key, label]) => metricRowFromValue(label, key, measurementsRoot[key], pickObject(contract[key])))
    .filter(Boolean) as MetricRow[];
  const leafletCapability = casePayload?.capabilities?.leaflet_geometry || null;
  const leafletSummary = pickObject(casePayload?.leaflet_geometry_summary);
  const leaflets = isCapabilityAvailable(leafletCapability) && Array.isArray(leafletSummary?.leaflets) ? leafletSummary?.leaflets : [];
  for (const leaflet of leaflets as Array<unknown>) {
    const record = pickObject(leaflet);
    if (!record) continue;
    const label = String(record.cusp_label || record.label || record.name || 'Leaflet');
    rows.push(...[
      metricRowFromValue(`${label} geometric height`, `${label}_geometric_height_mm`, record.geometric_height_mm, null),
      metricRowFromValue(`${label} effective height`, `${label}_effective_height_mm`, record.effective_height_mm, null),
      metricRowFromValue(`${label} coaptation height`, `${label}_coaptation_height_mm`, record.coaptation_height_mm, null),
    ].filter(Boolean) as MetricRow[]);
  }
  return rows;
}

function renderDownloadPanel(casePayload: WorkstationCasePayload): void {
  if (!DOM.downloadList) return;
  const downloads = casePayload.downloads || {};
  const rawLink = normalizeDownloadEntry(downloads.raw, 'Raw CT');
  const jsonLinks = Array.isArray(downloads.json)
    ? downloads.json.map((entry, index) => normalizeDownloadEntry(entry, `JSON ${index + 1}`)).filter(Boolean)
    : [];
  const stlLinks = Array.isArray(downloads.stl)
    ? downloads.stl.map((entry, index) => normalizeDownloadEntry(entry, `STL ${index + 1}`)).filter(Boolean)
    : [];
  const pdfLink = normalizeDownloadEntry(downloads.pdf, 'PDF report');
  const items: string[] = [];
  if (rawLink) items.push(renderDownloadLink(rawLink.label, rawLink.href));
  jsonLinks.forEach((entry) => {
    items.push(renderDownloadLink(entry.label, entry.href));
  });
  stlLinks.forEach((entry) => {
    items.push(renderDownloadLink(entry.label, entry.href));
  });
  if (pdfLink) items.push(renderDownloadLink(pdfLink.label, pdfLink.href));
  DOM.downloadList.innerHTML = items.join('') || `<div class="muted">${escapeHtml(t('message.no_downloads'))}</div>`;
}

function currentStudyId(casePayload: WorkstationCasePayload | null | undefined): string | null {
  if (!casePayload) return null;
  const studyMeta = pickObject(casePayload.study_meta);
  const id = typeof studyMeta?.id === 'string' ? studyMeta.id.trim() : '';
  return id || null;
}

function canRunAutoAnnotation(casePayload: WorkstationCasePayload | null | undefined): boolean {
  const studyId = currentStudyId(casePayload);
  if (!studyId) return false;
  if ((casePayload?.case_role || []).includes('showcase')) return false;
  if (providerHealthState.checking) return false;
  return true;
}

async function ensureAnnotationProviderHealth(force = false): Promise<ProviderHealthState> {
  if (providerHealthPromise && !force) return providerHealthPromise;
  if (providerHealthState.checked && !force) return providerHealthState;
  providerHealthState = {
    checked: false,
    checking: true,
    ok: false,
    status: null,
    code: null,
    message: 'Checking annotation provider…',
    detail: 'Verifying the external GPU annotation service before enabling this action.',
  };
  renderAnnotationPanel(activeCase);
  providerHealthPromise = (async () => {
    try {
      const payload = await fetchJson<Record<string, unknown>>('/providers/inference-health');
      const ok = Boolean(payload.ok);
      providerHealthState = {
        checked: true,
        checking: false,
        ok,
        status: typeof payload.status === 'number' ? payload.status : null,
        code: typeof payload.code === 'string' ? payload.code : null,
        message: ok ? 'Auto annotation is ready for the active study.' : 'Auto annotation provider unavailable.',
        detail: ok
          ? 'Root, annulus, sinus, STJ, coronary ostia, and leaflet geometry will be requested together.'
          : String(payload.message || payload.code || 'The external GPU provider is not reachable right now.'),
      };
    } catch (error) {
      providerHealthState = {
        checked: true,
        checking: false,
        ok: false,
        status: null,
        code: 'provider_check_failed',
        message: 'Auto annotation provider unavailable.',
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      providerHealthPromise = null;
      renderAnnotationPanel(activeCase);
    }
    return providerHealthState;
  })();
  return providerHealthPromise;
}

function syncAnnotationState(casePayload: WorkstationCasePayload | null): void {
  const studyId = currentStudyId(casePayload);
  if (!casePayload) {
    annotationRunState = {
      status: 'unavailable',
      studyId: null,
      jobId: null,
      message: 'No case is active.',
      detail: 'Load a case before requesting automated annotations.',
    };
    return;
  }
  if ((casePayload.case_role || []).includes('showcase')) {
    annotationRunState = {
      status: 'showcase_locked',
      studyId,
      jobId: null,
      message: 'Showcase annotations are precomputed.',
      detail: 'Use Latest Case to run a fresh automated annotation job on a real study.',
    };
    return;
  }
  if (!studyId) {
    annotationRunState = {
      status: 'unavailable',
      studyId: null,
      jobId: null,
      message: 'Auto annotation is unavailable for this case.',
      detail: 'The active case does not expose a study identifier that can be submitted to the segmentation pipeline.',
    };
    return;
  }
  if (providerHealthState.checking) {
    annotationRunState = {
      status: 'idle',
      studyId,
      jobId: null,
      message: 'Ready to run root + coronary + leaflet auto annotation.',
      detail: 'Provider health is being checked in the background. You can still trigger annotation from this workstation.',
    };
    return;
  }
  if (providerHealthState.checked && !providerHealthState.ok) {
    annotationRunState = {
      status: 'provider_unavailable',
      studyId,
      jobId: null,
      message: providerHealthState.message,
      detail: providerHealthState.detail,
    };
    return;
  }
  if (
    annotationRunState.studyId !== studyId
    || annotationRunState.status === 'showcase_locked'
    || annotationRunState.status === 'unavailable'
    || annotationRunState.status === 'provider_unavailable'
    || annotationRunState.status === 'checking_provider'
  ) {
    annotationRunState = {
      status: 'idle',
      studyId,
      jobId: null,
      message: 'Ready to run root + coronary + leaflet auto annotation.',
      detail: 'This sends the study to the existing segmentation pipeline and reloads the finished case back into the same workstation.',
    };
  }
}

function renderAnnotationPanel(casePayload: WorkstationCasePayload | null): void {
  syncAnnotationState(casePayload);
  if (casePayload && !((casePayload.case_role || []).includes('showcase')) && currentStudyId(casePayload) && !providerHealthState.checked && !providerHealthState.checking) {
    void ensureAnnotationProviderHealth();
  }
  if (DOM.annotationStatus) DOM.annotationStatus.textContent = annotationRunState.message;
  if (DOM.annotationDetail) DOM.annotationDetail.textContent = annotationRunState.detail;
  if (!DOM.annotationButton) return;
  const roles = casePayload?.case_role || [];
  const button = DOM.annotationButton;
  button.disabled = !canRunAutoAnnotation(casePayload) || annotationRunState.status === 'submitting' || annotationRunState.status === 'queued' || annotationRunState.status === 'running';
  button.textContent =
    annotationRunState.status === 'checking_provider' ? t('action.annotation_checking_provider')
    : annotationRunState.status === 'provider_unavailable' ? t('action.annotation_provider_unavailable')
    : annotationRunState.status === 'submitting' ? t('action.annotation_submitting')
    : annotationRunState.status === 'queued' || annotationRunState.status === 'running' ? t('action.annotation_running')
    : annotationRunState.status === 'succeeded' ? t('action.annotation_rerun')
    : annotationRunState.status === 'failed' ? t('action.annotation_retry')
    : roles.includes('showcase') ? t('action.annotation_showcase_locked')
    : t('action.run_annotation');
}

async function startAutoAnnotation(): Promise<void> {
  if (!activeCase || !canRunAutoAnnotation(activeCase)) {
    renderAnnotationPanel(activeCase as WorkstationCasePayload);
    return;
  }
  const studyId = currentStudyId(activeCase);
  if (!studyId) return;
  const providerState = await ensureAnnotationProviderHealth(annotationRunState.status === 'provider_unavailable');
  if (!providerState.ok) {
    annotationRunState = {
      status: 'provider_unavailable',
      studyId,
      jobId: null,
      message: providerState.message,
      detail: providerState.detail,
    };
    renderAnnotationPanel(activeCase);
    return;
  }
  annotationRunState = {
    status: 'submitting',
    studyId,
    jobId: null,
    message: 'Submitting auto annotation job...',
    detail: 'Requesting root, annulus, sinus, STJ, coronary ostia, and leaflet geometry from the segmentation pipeline.',
  };
  renderAnnotationPanel(activeCase);
  try {
    const payload = await fetchJson<Record<string, unknown>>('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        study_id: studyId,
        job_type: 'segmentation_v1',
        model_tag: 'aorticai-root-coronary-leaflet-v1',
      }),
    });
    const jobId = typeof payload.job_id === 'string' ? payload.job_id : '';
    if (!jobId) throw new Error('annotation_submission_missing_job_id');
    annotationRunState = {
      status: 'queued',
      studyId,
      jobId,
      message: 'Auto annotation job queued.',
      detail: `Job ${jobId} is waiting for the external pipeline. The workstation will reload the completed case automatically.`,
    };
    renderAnnotationPanel(activeCase);
    await waitForAnnotationJob(jobId, studyId);
  } catch (error) {
    annotationRunState = {
      status: 'failed',
      studyId,
      jobId: null,
      message: 'Auto annotation could not be started.',
      detail: error instanceof Error ? error.message : String(error),
    };
    renderAnnotationPanel(activeCase);
  }
}

async function waitForAnnotationJob(jobId: string, studyId: string): Promise<void> {
  const timeoutMs = 180000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await delay(1000);
    const payload = await fetchJson<Record<string, unknown>>(`/api/jobs/${encodeURIComponent(jobId)}`);
    const status = String(payload.status || '').toLowerCase();
    annotationRunState = {
      status: status === 'succeeded' ? 'succeeded' : status === 'failed' ? 'failed' : 'running',
      studyId,
      jobId,
      message:
        status === 'succeeded' ? 'Auto annotation completed.'
        : status === 'failed' ? 'Auto annotation failed.'
        : 'Auto annotation is running.',
      detail:
        status === 'succeeded' ? 'Reloading the finished case into the current workstation view.'
        : status === 'failed' ? String(payload.error_message || 'The provider reported failure.')
        : `Job ${jobId} is still processing.`,
    };
    renderAnnotationPanel(activeCase as WorkstationCasePayload);
    if (status === 'succeeded') {
      await loadCase(jobId);
      return;
    }
    if (status === 'failed') return;
  }
  annotationRunState = {
    status: 'failed',
    studyId,
    jobId,
    message: 'Auto annotation timed out.',
    detail: 'The job did not reach a terminal state before the workstation timeout. You can retry without leaving the page.',
  };
  renderAnnotationPanel(activeCase as WorkstationCasePayload);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function renderDownloadLink(label: string, href: string): string {
  return `<a class="download-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function normalizeDownloadEntry(
  entry: string | { label?: string; href: string } | null | undefined,
  fallbackLabel: string
): { label: string; href: string } | null {
  if (!entry) return null;
  if (typeof entry === 'string') return { label: fallbackLabel, href: entry };
  const href = typeof entry.href === 'string' ? entry.href : null;
  if (!href) return null;
  return {
    label: typeof entry.label === 'string' && entry.label.trim() ? entry.label : fallbackLabel,
    href,
  };
}

type ClinicalGateView = {
  key: string;
  label: string;
  status: string;
  tone: QaTone;
  detail?: string;
};

function collectClinicalGateItems(casePayload: WorkstationCasePayload): ClinicalGateView[] {
  const gates = pickObject(casePayload.quality_gates);
  if (!gates) return [];
  const items: ClinicalGateView[] = [];
  Object.entries(gates).forEach(([key, raw]) => {
    const gate = pickObject(raw);
    if (!gate || typeof gate.status !== 'string') return;
    const status = String(gate.status || 'unknown');
    const tone = gateStatusTone(status);
    const pieces = [
      typeof gate.summary === 'string' ? gate.summary : null,
      gate.clinician_review_required ? 'clinician review required' : null,
      Array.isArray(gate.impact) ? `impact=${gate.impact.join(', ')}` : null,
    ].filter(Boolean);
    items.push({
      key,
      label: humanize(key.replace(/_relation$/, '').replace(/_assessment$/, '').replace(/_check$/, '')),
      status,
      tone,
      detail: pieces.join(' · ') || undefined,
    });
  });
  return items;
}

type QaTone = 'ok' | 'warn' | 'danger' | 'info';

type QaItem = {
  section: string;
  label: string;
  status: string;
  tone: QaTone;
  detail?: string;
};

function collectAcceptanceItems(review: AcceptanceReview): QaItem[] {
  const items: QaItem[] = [];
  const domains = review.domains || {};
  (['viewing', 'clinical', 'planning'] as const).forEach((key) => {
    const domain = pickObject(domains[key]) as AcceptanceDomain | null;
    if (!domain) return;
    const blockers = Array.isArray(domain.blockers) ? domain.blockers.filter((entry) => typeof entry === 'string' && entry.trim()) : [];
    const flags = Array.isArray(domain.review_flags) ? domain.review_flags.filter((entry) => typeof entry === 'string' && entry.trim()) : [];
    const detail = [
      typeof domain.summary === 'string' ? domain.summary : null,
      blockers.length ? `blockers: ${blockers.join(', ')}` : null,
      flags.length ? `review: ${flags.join(', ')}` : null,
    ].filter(Boolean).join(' · ');
    items.push({
      section: 'Acceptance',
      label: humanize(key),
      status: acceptanceStatusLabel(domain.status),
      tone: acceptanceTone(domain.status),
      detail,
    });
  });
  const nextActions = Array.isArray(review.next_actions)
    ? review.next_actions.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  if (nextActions.length) {
    items.push({
      section: 'Acceptance',
      label: 'Next actions',
      status: review.human_review_required ? 'Review Required' : 'Pass',
      tone: review.human_review_required ? 'warn' : 'ok',
      detail: nextActions.join(' · '),
    });
  }
  return items;
}

function collectQaItems(casePayload: WorkstationCasePayload): QaItem[] {
  const items: QaItem[] = [];
  if (Array.isArray(casePayload.case_role) && casePayload.case_role.includes('showcase')) {
    items.push({
      section: 'Case',
      label: t('qa.placeholder_case'),
      status: casePayload.not_real_cta ? 'placeholder' : 'reference',
      tone: casePayload.not_real_cta ? 'warn' : 'info',
      detail: casePayload.not_real_cta
        ? 'Committed showcase bundle with placeholder imaging.'
        : 'Committed gold showcase bundle with real CTA source data and manifest-first planning.',
    });
  }
  if (casePayload.pipeline_run) {
    const run = pickObject(casePayload.pipeline_run);
    if (run) {
      const sourceMode = String(run.source_mode || 'unknown');
      const inferred = Boolean(run.inferred);
      items.push({
        section: 'Provenance',
        label: 'Pipeline provenance',
        status: sourceMode,
        tone: inferred ? 'warn' : 'ok',
        detail: inferred ? 'Historical / inferred provenance is active.' : 'Current case comes from the manifest-first showcase bundle.',
      });
    }
  }
  const warnings = casePayload.viewer_bootstrap?.bootstrap_warnings || [];
  const summary = casePayload.model_landmarks_summary || {};
  const annulus = pickObject(summary.annulus);
  if (annulus && String(annulus.status || '').toLowerCase() !== 'available') {
    items.push(buildQaLine('Landmark', 'Annulus', annulus.status, annulus.confidence));
  }
  const stj = pickObject(summary.stj);
  if (stj && String(stj.status || '').toLowerCase() !== 'available') {
    items.push(buildQaLine('Landmark', 'STJ', stj.status, stj.confidence));
  }
  const coronary = isCapabilityAvailable(casePayload.capabilities?.coronary_ostia)
    ? pickObject(casePayload.coronary_ostia_summary)
    : null;
  if (coronary) {
    const left = pickObject(coronary.left);
    const right = pickObject(coronary.right);
    if (left) items.push(buildQaLine('Landmark', 'Left coronary ostium', left.status, left.confidence, left.reason));
    if (right) items.push(buildQaLine('Landmark', 'Right coronary ostium', right.status, right.confidence, right.reason));
  }
  const leafletSummary = pickObject(casePayload.leaflet_geometry_summary);
  const leaflets = isCapabilityAvailable(casePayload.capabilities?.leaflet_geometry) && Array.isArray(leafletSummary?.leaflets)
    ? leafletSummary?.leaflets
    : (Array.isArray(summary.leaflet_status) ? summary.leaflet_status : []);
  leaflets.forEach((leaflet, index) => {
    const record = pickObject(leaflet);
    if (!record) return;
    const normalizedStatus = String(record.status || '').toLowerCase();
    if (normalizedStatus === 'available' || normalizedStatus === 'accepted') return;
    const label = String(record.cusp_label || record.label || `Leaflet ${index + 1}`);
    items.push(buildQaLine('Leaflet', label, record.status, record.confidence, record.reason));
  });
  if (!items.length && casePayload.centerline?.point_count) {
    items.push({
      section: 'Centerline',
      label: 'Centerline points',
      status: String(casePayload.centerline.point_count),
      tone: 'info',
    });
  }
  warnings.forEach((warning) => {
    items.push({
      section: 'Warning',
      label: humanize(warning),
      status: 'warning',
      tone: 'warn',
    });
  });
  collectClinicalGateItems(casePayload).forEach((gate) => {
    items.push({
      section: 'Clinical Gate',
      label: gate.label,
      status: gate.status,
      tone: gate.tone,
      detail: gate.detail,
    });
  });
  return items;
}

function renderQaItem(item: QaItem): string {
  return `
    <li class="qa-item tone-${item.tone}">
      <div class="qa-item-head">
        <span class="qa-item-section">${escapeHtml(item.section)}</span>
        <span class="qa-item-badge tone-${item.tone}">${escapeHtml(item.status)}</span>
      </div>
      <div class="qa-item-label">${escapeHtml(item.label)}</div>
      ${item.detail ? `<div class="qa-item-detail">${escapeHtml(item.detail)}</div>` : ''}
    </li>
  `;
}

function buildQaLine(section: string, label: string, status: unknown, confidence: unknown, reason?: unknown): QaItem {
  const statusText = String(status || 'unknown');
  const details = [
    typeof confidence === 'number' ? `conf ${confidence.toFixed(2)}` : null,
    reason ? String(reason) : null,
  ].filter(Boolean).join(' · ');
  return {
    section,
    label,
    status: statusText,
    tone: statusBadge(statusText),
    detail: details || undefined,
  };
}

function acceptanceStatusLabel(status: unknown): string {
  const value = String(status || '').toLowerCase();
  if (value === 'pass') return 'Pass';
  if (value === 'needs_review') return 'Review Required';
  if (value === 'blocked') return 'Blocked';
  return value ? humanize(value) : 'Unknown';
}

function acceptanceTone(status: unknown): QaTone {
  const value = String(status || '').toLowerCase();
  if (value === 'pass') return 'ok';
  if (value === 'blocked') return 'danger';
  return 'warn';
}

function collectEvidenceItems(casePayload: WorkstationCasePayload): string[] {
  const items: string[] = [];
  if (casePayload.pipeline_run) {
    items.push(`<strong>Pipeline</strong><span class="muted">${escapeHtml(JSON.stringify(casePayload.pipeline_run))}</span>`);
  }
  if (casePayload.capabilities) {
    Object.entries(casePayload.capabilities).forEach(([key, value]) => {
      const state = pickObject(value);
      if (!state) return;
      const fragments = [
        state.source ? `source=${String(state.source)}` : null,
        state.inferred ? 'inferred=true' : null,
        state.legacy ? 'legacy=true' : null,
        state.reason ? `reason=${String(state.reason)}` : null,
      ].filter(Boolean).join(' · ');
      items.push(`<strong>${escapeHtml(humanize(key))}</strong><span class="muted">${escapeHtml(fragments || 'capability metadata unavailable')}</span>`);
    });
  }
  const contract = pickObject(casePayload.measurement_contract);
  if (contract) {
    const first = Object.entries(contract).slice(0, 4);
    for (const [key, value] of first) {
      const record = pickObject(value);
      if (!record) continue;
      const method = record.method ? `method=${escapeHtml(String(record.method))}` : 'method=unknown';
      const rule = record.evidence_rule ? `evidence=${escapeHtml(String(record.evidence_rule))}` : 'evidence=n/a';
      items.push(`<strong>${escapeHtml(humanize(key))}</strong><span class="muted">${method} · ${rule}</span>`);
    }
  }
  return items;
}

function updateViewerState(): void {
  if (!DOM.rawBlock) return;
  DOM.rawBlock.textContent = JSON.stringify(
    {
      build_version: BUILD_VERSION,
      active_viewport: currentActiveViewport,
      primary_tool: currentPrimaryTool,
      window_preset: currentWindowPreset,
      cine_fps: cineFps,
      cine_active: cineTimerHandle !== null,
      aux_mode: currentAuxMode,
      centerline_index: currentCenterlineIndex,
      crosshair_world: currentCrosshairWorld,
      volume_source: activeCase?.volume_source || null,
      runtime_requirements: activeCase?.viewer_bootstrap?.runtime_requirements || null,
      cpr_sources: activeCase?.cpr_sources || null,
      annotation_state: annotationRunState,
      acceptance_review: activeCase?.acceptance_review || null,
      qa_flags: activeCase?.viewer_bootstrap?.qa_flags || null,
      bootstrap_warnings: activeCase?.viewer_bootstrap?.bootstrap_warnings || null,
      case_job_id: activeCase?.job?.id || null,
      boot_stage: currentBootStage,
      session_available: Boolean(session),
      three_runtime_available: Boolean(threeRuntime),
      last_mpr_error: lastMprError,
      last_three_error: lastThreeError,
    },
    null,
    2
  );
}

async function ensureThreeViewer(casePayload: WorkstationCasePayload): Promise<void> {
  if (!DOM.threeStage) return;
  if (!threeRuntime) {
    threeRuntime = await createThreeRuntime(DOM.threeStage);
  }
  await loadThreeCase(threeRuntime, casePayload);
}

async function createThreeRuntime(container: HTMLDivElement): Promise<ThreeRuntime> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060b12);
  const camera = new THREE.PerspectiveCamera(34, Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight), 0.1, 5000);
  camera.position.set(0, -118, 118);
  const canvas = document.createElement('canvas');
  const webglContext = canvas.getContext('webgl2', {
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  })
    || canvas.getContext('webgl', {
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    })
    || canvas.getContext('experimental-webgl');
  if (!webglContext) {
    throw new Error('webgl_context_unavailable');
  }
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, canvas, context: webglContext as WebGLRenderingContext });
  renderer.preserveDrawingBuffer = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
  container.replaceChildren(canvas);
  DOM.threeFallback?.classList.add('hidden');
  if (DOM.threeFallback) DOM.threeFallback.innerHTML = '';

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 24;
  controls.maxDistance = 260;
  controls.target.set(0, 0, 0);

  const ambient = new THREE.AmbientLight(0xffffff, 1.15);
  scene.add(ambient);
  const dirA = new THREE.DirectionalLight(0xf6fbff, 1.05);
  dirA.position.set(120, 120, 180);
  scene.add(dirA);
  const dirB = new THREE.DirectionalLight(0x8eb9ff, 0.52);
  dirB.position.set(-90, -40, 90);
  scene.add(dirB);

  const rootGroup = new THREE.Group();
  scene.add(rootGroup);
  const layerGroups = {
    annulus: new THREE.Group(),
    annulus_plane: new THREE.Group(),
    commissures: new THREE.Group(),
    sinus_peaks: new THREE.Group(),
    stj: new THREE.Group(),
    coronary_ostia: new THREE.Group(),
    centerline: new THREE.Group(),
  };
  Object.values(layerGroups).forEach((group) => rootGroup.add(group));
  const meshGroups = {
    aortic_root: new THREE.Group(),
    leaflets: new THREE.Group(),
    ascending_aorta: new THREE.Group(),
    annulus_ring: new THREE.Group(),
  };
  Object.values(meshGroups).forEach((group) => rootGroup.add(group));
  const meshState = {
    aortic_root: { visible: true, opacity: 0.6, label: 'Root' },
    leaflets: { visible: true, opacity: 0.8, label: 'Leaflets' },
    ascending_aorta: { visible: true, opacity: 0.4, label: 'Ascending' },
    annulus_ring: { visible: true, opacity: 1, label: 'Annulus ring' },
  };

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const animate = () => {
    controls.update();
    renderer.render(scene, camera);
    runtime.animationHandle = requestAnimationFrame(animate);
  };
  const resizeHandler = () => resizeThreeRuntime(runtime, container);
  const runtime: ThreeRuntime = { scene, camera, renderer, controls, rootGroup, layerGroups, meshGroups, meshState, animationHandle: null, raycaster, pointer, resizeHandler };
  animate();
  window.addEventListener('resize', resizeHandler);
  return runtime;
}

function resizeThreeRuntime(runtime: ThreeRuntime, container: HTMLDivElement): void {
  runtime.camera.aspect = Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight);
  runtime.camera.updateProjectionMatrix();
  runtime.renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
}

function safeResizeRenderingEngine(renderingEngine: RenderingEngine | null | undefined): void {
  if (!renderingEngine) return;
  try {
    (renderingEngine as unknown as { resize?: (immediate?: boolean, keepCamera?: boolean) => void }).resize?.(true, false);
    return;
  } catch {
    // Fall through to the no-arg variant for older runtime builds.
  }
  try {
    (renderingEngine as unknown as { resize?: () => void }).resize?.();
  } catch {
    // Keep the viewer alive even if this runtime omits resize.
  }
}

function handleViewportResize(): void {
  safeResizeRenderingEngine(session?.renderingEngine);
  if (threeRuntime && DOM.threeStage) {
    resizeThreeRuntime(threeRuntime, DOM.threeStage);
  }
  refreshViewportPresentation();
}

function renderAllViewports(renderingEngine: RenderingEngine | null | undefined = session?.renderingEngine): void {
  if (!renderingEngine) return;
  for (const viewportId of Object.values(VIEWPORT_IDS)) {
    try {
      renderingEngine.getViewport(viewportId)?.render?.();
    } catch {
      // Keep the workstation alive if one viewport refuses to render.
    }
  }
}

async function settleViewerPresentation(frameCount = 1): Promise<void> {
  if (!session) return;
  for (let index = 0; index < Math.max(1, frameCount); index += 1) {
    handleViewportResize();
    renderAllViewports(session.renderingEngine);
    await nextAnimationFrame();
  }
}

async function loadThreeCase(runtime: ThreeRuntime, casePayload: WorkstationCasePayload): Promise<void> {
  const loader = new STLLoader();
  while (runtime.rootGroup.children.length) {
    const child = runtime.rootGroup.children[0];
    runtime.rootGroup.remove(child);
    disposeThreeObject(child);
  }
  runtime.layerGroups = {
    annulus: new THREE.Group(),
    annulus_plane: new THREE.Group(),
    commissures: new THREE.Group(),
    sinus_peaks: new THREE.Group(),
    stj: new THREE.Group(),
    coronary_ostia: new THREE.Group(),
    centerline: new THREE.Group(),
  };
  runtime.meshGroups = {
    aortic_root: new THREE.Group(),
    leaflets: new THREE.Group(),
    ascending_aorta: new THREE.Group(),
    annulus_ring: new THREE.Group(),
  };
  Object.values(runtime.layerGroups).forEach((group) => runtime.rootGroup.add(group));
  Object.values(runtime.meshGroups).forEach((group) => runtime.rootGroup.add(group));
  runtime.meshState = {
    aortic_root: { visible: true, opacity: readMeshOpacityFromUi('aortic_root', 0.6), label: 'Root' },
    leaflets: { visible: true, opacity: readMeshOpacityFromUi('leaflets', 0.8), label: 'Leaflets' },
    ascending_aorta: { visible: true, opacity: readMeshOpacityFromUi('ascending_aorta', 0.4), label: 'Ascending' },
    annulus_ring: { visible: true, opacity: readMeshOpacityFromUi('annulus_ring', 1), label: 'Annulus ring' },
  };

  const loadedRoot = await maybeLoadStlMesh(
    casePayload.links.aortic_root_stl || defaultCaseMeshUrl('aortic_root.stl'),
    loader,
    new THREE.MeshStandardMaterial({
      color: 0xdc5050,
      transparent: true,
      opacity: runtime.meshState.aortic_root.opacity,
      roughness: 0.55,
      metalness: 0.02,
      side: THREE.DoubleSide,
    }),
    runtime.meshGroups.aortic_root
  );
  const loadedLeaflets = await maybeLoadStlMesh(
    casePayload.links.leaflets_stl || defaultCaseMeshUrl('leaflets.stl'),
    loader,
    new THREE.MeshStandardMaterial({
      color: 0xf0e6c8,
      transparent: true,
      opacity: runtime.meshState.leaflets.opacity,
      roughness: 0.5,
      metalness: 0.01,
      side: THREE.DoubleSide,
    }),
    runtime.meshGroups.leaflets
  );
  const loadedAscending = await maybeLoadStlMesh(
    casePayload.links.ascending_aorta_stl || defaultCaseMeshUrl('ascending_aorta.stl'),
    loader,
    new THREE.MeshStandardMaterial({
      color: 0xdc9696,
      transparent: true,
      opacity: runtime.meshState.ascending_aorta.opacity,
      roughness: 0.56,
      metalness: 0.01,
      side: THREE.DoubleSide,
    }),
    runtime.meshGroups.ascending_aorta
  );
  const loadedAnnulusRing = await maybeLoadStlMesh(
    defaultCaseMeshUrl('annulus_ring.stl'),
    loader,
    new THREE.MeshStandardMaterial({
      color: 0x5ee6b0,
      wireframe: true,
      transparent: true,
      opacity: runtime.meshState.annulus_ring.opacity,
      side: THREE.DoubleSide,
    }),
    runtime.meshGroups.annulus_ring
  );

  if (Array.isArray(casePayload.centerline?.points_world) && casePayload.centerline!.points_world!.length > 1) {
    const points = casePayload.centerline!.points_world!.map((point) => toPoint3(point));
    runtime.layerGroups.centerline.add(
      buildRingLine(points, 0xcfe7ff, 'centerline', false, 0.95)
    );
  }

  const annulusRing = pickObject(pickObject(casePayload.aortic_root_model)?.annulus_ring);
  const annulusRingPoints = Array.isArray(annulusRing?.ring_points_world)
    ? annulusRing.ring_points_world.map((point) => toPoint3(point))
    : [];
  if (annulusRingPoints.length > 2) {
    runtime.layerGroups.annulus.add(buildRingLine(annulusRingPoints, 0xf06c7f, 'annulus-ring'));
  } else if (annulusRing?.origin_world && casePayload.display_planes?.annulus) {
    const annulusDiameter =
      readMetricValue(pickObject(casePayload.measurements)?.annulus_equivalent_diameter_mm)
      ?? readMetricValue(pickObject(pickObject(casePayload.measurements)?.raw_measurements)?.annulus?.equivalent_diameter_mm)
      ?? 22;
    runtime.layerGroups.annulus.add(
      buildDerivedRing(casePayload.display_planes.annulus, annulusDiameter / 2, 0xf06c7f, 'annulus-ring')
    );
  }
  const annulusPlaneRecord = pickObject(defaultAnnulusPlaneArtifact) || pickObject(casePayload.aortic_root_model)?.annulus_ring;
  const annulusPlane = buildAnnulusPlaneOverlay(annulusPlaneRecord);
  if (annulusPlane) {
    runtime.layerGroups.annulus_plane.add(annulusPlane.plane);
    runtime.layerGroups.annulus_plane.add(annulusPlane.normalArrow);
  }

  const stjPlane = casePayload.display_planes?.stj;
  if (stjPlane?.origin_world) {
    const stjDiameter =
      readMetricValue(pickObject(casePayload.measurements)?.stj_diameter_mm)
      ?? readMetricValue(pickObject(pickObject(casePayload.measurements)?.raw_measurements)?.stj?.diameter_mm)
      ?? 26;
    runtime.layerGroups.stj.add(buildDerivedRing(stjPlane, stjDiameter / 2, 0x9f8cff, 'stj-ring'));
  }

  if (annulusRing?.origin_world) {
    runtime.layerGroups.annulus.add(buildMarker(toPoint3(annulusRing.origin_world), 0xf06c7f, 1.2, 'annulus-origin'));
  }
  const commissures = Array.isArray(pickObject(casePayload.aortic_root_model)?.commissures)
    ? pickObject(casePayload.aortic_root_model)?.commissures as Array<unknown>
    : [];
  commissures.forEach((entry, index) => {
    const record = pickObject(entry);
    if (!record?.point_world) return;
    runtime.layerGroups.commissures.add(buildMarker(toPoint3(record.point_world), 0xf5c857, 1.2, `commissure-${index}`));
  });
  const sinusPeaks = Array.isArray(pickObject(casePayload.aortic_root_model)?.sinus_peaks)
    ? pickObject(casePayload.aortic_root_model)?.sinus_peaks as Array<unknown>
    : [];
  sinusPeaks.forEach((entry, index) => {
    const record = pickObject(entry);
    if (!record?.point_world) return;
    runtime.layerGroups.sinus_peaks.add(buildMarker(toPoint3(record.point_world), 0x5ee6b0, 1.1, `sinus-${index}`));
  });
  const stj = pickObject(pickObject(casePayload.aortic_root_model)?.sinotubular_junction);
  if (stj?.origin_world) {
    runtime.layerGroups.stj.add(buildMarker(toPoint3(stj.origin_world), 0x9f8cff, 1.2, 'stj-origin'));
  }
  const coronary = pickObject(pickObject(casePayload.aortic_root_model)?.coronary_ostia);
  ['left', 'right'].forEach((key, index) => {
    const record = pickObject(coronary?.[key]);
    if (!record?.point_world) return;
    runtime.layerGroups.coronary_ostia.add(buildMarker(toPoint3(record.point_world), index === 0 ? 0x4da6ff : 0xff8f7b, 1.2, `coronary-${key}`));
  });

  positionThreeCameraForCase(runtime, casePayload);
  updateThreeMeshFromUi();
  updateThreeLayerVisibility();
  updateThreePlaneHighlights();
  if (!loadedRoot && !loadedLeaflets && !loadedAscending && !loadedAnnulusRing && DOM.threeFallback) {
    DOM.threeFallback.innerHTML = '<div class="three-fallback-card"><h3>3D model unavailable</h3><p>⚠ Data unavailable</p></div>';
    DOM.threeFallback.classList.remove('hidden');
  }
}

function positionThreeCameraForCase(runtime: ThreeRuntime, casePayload: WorkstationCasePayload): void {
  const box = new THREE.Box3().setFromObject(runtime.rootGroup);
  const center = box.isEmpty() ? new THREE.Vector3(0, 0, 0) : box.getCenter(new THREE.Vector3());
  const size = box.isEmpty() ? 80 : Math.max(60, box.getSize(new THREE.Vector3()).length());
  const annulusOrigin = casePayload.display_planes?.annulus?.origin_world
    ? toPoint3(casePayload.display_planes.annulus.origin_world)
    : null;
  const stjOrigin = casePayload.display_planes?.stj?.origin_world
    ? toPoint3(casePayload.display_planes.stj.origin_world)
    : null;
  const rootAxis = annulusOrigin && stjOrigin
    ? normalize3([
        stjOrigin[0] - annulusOrigin[0],
        stjOrigin[1] - annulusOrigin[1],
        stjOrigin[2] - annulusOrigin[2],
      ])
    : ([0, 0, 1] as Point3);
  const commissures = Array.isArray(pickObject(casePayload.aortic_root_model)?.commissures)
    ? (pickObject(casePayload.aortic_root_model)?.commissures as Array<unknown>)
    : [];
  const firstCommissure = pickObject(commissures[0]);
  const secondCommissure = pickObject(commissures[1]);
  let lateral: Point3 = [1, 0, 0];
  if (firstCommissure?.point_world && secondCommissure?.point_world) {
    const a = toPoint3(firstCommissure.point_world);
    const b = toPoint3(secondCommissure.point_world);
    lateral = normalize3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  }
  if (Math.abs(dot3(lateral, rootAxis)) > 0.9) {
    lateral = normalize3(cross3(rootAxis, [0, 1, 0]));
  }
  const up = normalize3(cross3(rootAxis, lateral));
  runtime.controls.target.copy(center);
  runtime.camera.position.set(
    center.x + lateral[0] * size * 0.75 - up[0] * size * 0.42 + rootAxis[0] * size * 0.52,
    center.y + lateral[1] * size * 0.75 - up[1] * size * 0.42 + rootAxis[1] * size * 0.52,
    center.z + lateral[2] * size * 0.75 - up[2] * size * 0.42 + rootAxis[2] * size * 0.52
  );
  runtime.camera.lookAt(center);
  runtime.controls.update();
}

async function maybeLoadStlMesh(url: string | undefined, loader: STLLoader, material: THREE.Material, group: THREE.Group): Promise<boolean> {
  if (!url) return false;
  try {
    const geometry = await loader.loadAsync(resolveAbsoluteUrl(url));
    geometry.computeVertexNormals?.();
    const object = new THREE.Mesh(geometry, material.clone());
    object.renderOrder = 1;
    object.name = url;
    group.add(object);
    return true;
  } catch {
    return false;
  }
}

function buildRingLine(points: Point3[], color: number, name: string, closed = true, opacity = 1): THREE.Line {
  const normalized = points
    .map((point) => toPoint3(point))
    .filter((point): point is Point3 => Array.isArray(point) && point.length === 3);
  const path = closed && normalized.length > 2 ? [...normalized, normalized[0]] : normalized;
  const geometry = new THREE.BufferGeometry().setFromPoints(
    path.map((point) => new THREE.Vector3(point[0], point[1], point[2]))
  );
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
  });
  const line = new THREE.Line(geometry, material);
  line.name = name;
  line.renderOrder = 6;
  return line;
}

function buildDerivedRing(plane: PlaneDefinition, radius: number, color: number, name: string): THREE.Line {
  const origin = toPoint3(plane.origin_world || [0, 0, 0]);
  const basisU = normalize3(toPoint3(plane.basis_u_world || [1, 0, 0]));
  const basisV = normalize3(toPoint3(plane.basis_v_world || [0, 1, 0]));
  const points: Point3[] = [];
  const safeRadius = Math.max(6, Math.min(32, radius || 12));
  for (let index = 0; index < 64; index += 1) {
    const theta = (Math.PI * 2 * index) / 64;
    points.push([
      origin[0] + Math.cos(theta) * safeRadius * basisU[0] + Math.sin(theta) * safeRadius * basisV[0],
      origin[1] + Math.cos(theta) * safeRadius * basisU[1] + Math.sin(theta) * safeRadius * basisV[1],
      origin[2] + Math.cos(theta) * safeRadius * basisU[2] + Math.sin(theta) * safeRadius * basisV[2],
    ]);
  }
  return buildRingLine(points, color, name, true, 0.96);
}

function buildPlaneMesh(plane: PlaneDefinition, radius: number, color: number, name: string): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(radius, radius, 1, 1);
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  const origin = toPoint3(plane.origin_world || [0, 0, 0]);
  const normal = normalize3(toPoint3(plane.normal_world || [0, 0, 1]));
  const up = normalize3(toPoint3(plane.basis_v_world || pickViewUp(normal)));
  const basisU = normalize3(toPoint3(plane.basis_u_world || cross3(up, normal)));
  const matrix = new THREE.Matrix4();
  matrix.makeBasis(
    new THREE.Vector3(basisU[0], basisU[1], basisU[2]),
    new THREE.Vector3(up[0], up[1], up[2]),
    new THREE.Vector3(normal[0], normal[1], normal[2])
  );
  matrix.setPosition(new THREE.Vector3(origin[0], origin[1], origin[2]));
  mesh.applyMatrix4(matrix);
  return mesh;
}

function buildAnnulusPlaneOverlay(record: Record<string, unknown> | null | undefined):
  { plane: THREE.Mesh; normalArrow: THREE.ArrowHelper } | null {
  const origin = toPoint3(record?.origin_world);
  const normal = normalize3(toPoint3(record?.normal_world || [0, 0, 1]));
  if (!origin) return null;
  const ringPoints = Array.isArray(record?.ring_points_world)
    ? record?.ring_points_world.map((point) => toPoint3(point))
    : [];
  const radius = computeRingRadius(origin, ringPoints);
  const planeDef: PlaneDefinition = {
    origin_world: origin,
    normal_world: normal,
    basis_u_world: toPoint3(record?.basis_u_world || [1, 0, 0]),
    basis_v_world: toPoint3(record?.basis_v_world || [0, 1, 0]),
  };
  const planeMesh = buildPlaneMesh(planeDef, radius * 2, 0x5ee6b0, 'annulus-plane');
  const material = planeMesh.material as THREE.MeshBasicMaterial;
  material.opacity = 0.35;
  material.transparent = true;
  const arrow = new THREE.ArrowHelper(
    new THREE.Vector3(normal[0], normal[1], normal[2]),
    new THREE.Vector3(origin[0], origin[1], origin[2]),
    10,
    0x5ee6b0,
    2.2,
    1.2
  );
  arrow.name = 'annulus-plane-normal';
  return { plane: planeMesh, normalArrow: arrow };
}

function computeRingRadius(origin: Point3, ringPoints: Array<Point3 | null | undefined>): number {
  const distances = ringPoints
    .map((point) => {
      if (!point) return null;
      const dx = point[0] - origin[0];
      const dy = point[1] - origin[1];
      const dz = point[2] - origin[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    })
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!distances.length) return 12;
  const mean = distances.reduce((sum, value) => sum + value, 0) / distances.length;
  return Math.max(8, Math.min(24, mean));
}

function buildMarker(point: Point3, color: number, radius: number, name: string): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(radius, 18, 18);
  const material = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.2 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.position.set(point[0], point[1], point[2]);
  return mesh;
}

function updateThreePlaneHighlights(): void {
  if (!threeRuntime || !activeCase) return;
  const aux = planeForMode(activeCase, currentAuxMode, currentCenterlineIndex);
  const existing = threeRuntime.rootGroup.getObjectByName('aux-plane');
  if (existing) {
    threeRuntime.rootGroup.remove(existing);
    disposeThreeObject(existing);
  }
  if (!aux) return;
  const mesh = buildPlaneMesh(aux, 20, 0xffffff, 'aux-plane');
  (mesh.material as THREE.MeshBasicMaterial).opacity = 0.12;
  threeRuntime.rootGroup.add(mesh);
}

function updateThreeLayerVisibility(): void {
  if (!threeRuntime) return;
  Object.entries(threeRuntime.layerGroups).forEach(([key, group]) => {
    if (key === 'annulus_plane') {
      const toggle = DOM.threeLayerToggles.find((entry) => entry.dataset.threeLayerToggle === 'annulus_plane');
      group.visible = toggle ? toggle.checked : true;
      return;
    }
    group.visible = activeLandmarkLayers[key] !== false;
  });
}

function readMeshOpacityFromUi(key: string, fallback: number): number {
  const slider = DOM.threeMeshOpacity.find((entry) => entry.dataset.threeMeshOpacity === key);
  if (!slider) return fallback;
  const value = Number.parseInt(slider.value, 10);
  if (Number.isNaN(value)) return fallback;
  return Math.max(0, Math.min(1, value / 100));
}

function updateThreeMeshFromUi(): void {
  if (!threeRuntime) return;
  Object.entries(threeRuntime.meshGroups).forEach(([key, group]) => {
    const toggle = DOM.threeMeshToggles.find((entry) => entry.dataset.threeMeshToggle === key);
    const slider = DOM.threeMeshOpacity.find((entry) => entry.dataset.threeMeshOpacity === key);
    const visible = toggle ? toggle.checked : true;
    const opacity = slider ? Math.max(0, Math.min(1, (Number.parseInt(slider.value, 10) || 0) / 100)) : 1;
    threeRuntime.meshState[key] = {
      ...(threeRuntime.meshState[key] || { label: key }),
      visible,
      opacity,
    };
    group.visible = visible;
    group.traverse((node: THREE.Object3D) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.material) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => {
        const typed = material as THREE.Material & { transparent?: boolean; opacity?: number };
        typed.transparent = opacity < 1;
        typed.opacity = opacity;
        typed.needsUpdate = true;
      });
    });
  });
}

function exportThreePng(): void {
  if (!threeRuntime) return;
  try {
    const url = threeRuntime.renderer.domElement.toDataURL('image/png');
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `aorticai-three-${Date.now()}.png`;
    anchor.click();
  } catch {
    if (DOM.mprStatus) DOM.mprStatus.textContent = '3D screenshot export failed.';
  }
}

async function destroySession(): Promise<void> {
  stopCine();
  clearAnnotationStateForSession();
  if (session) {
    session.syncs.forEach((sync) => sync.destroy?.());
    try { ToolGroupManager.destroyToolGroup(session.toolGroupId); } catch {}
    try { session.renderingEngine.destroy(); } catch {}
    try { cache.removeVolumeLoadObject(session.volumeId); } catch {}
    if (session.cprVolumeId) {
      try { cache.removeVolumeLoadObject(session.cprVolumeId); } catch {}
    }
    try { cache.purgeCache(); } catch {}
    if (session.dicomImageIds.length) {
      try { cornerstoneDICOMImageLoader.wadouri.fileManager.purge(); } catch {}
    }
  }
  session = null;
  updateViewerActionAvailability();
}

function clearMprFailure(): void {
  clearMprWatchdog();
  lastMprError = null;
  setViewportPlaceholderState(false, '');
  refreshViewportPresentation();
}

function clearThreeFailure(): void {
  lastThreeError = null;
  DOM.threeFallback?.classList.add('hidden');
  if (DOM.threeFallback) DOM.threeFallback.innerHTML = '';
  updateViewerState();
}

function disposeThreeObject(object: THREE.Object3D): void {
  object.traverse((node: THREE.Object3D) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose?.();
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((entry) => entry.dispose?.());
    } else {
      material?.dispose?.();
    }
  });
}

type MetricTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

function classifyEnvelopeTone(value: unknown): MetricTone {
  const envelope = pickObject(value);
  const uncertainty = pickObject(envelope?.uncertainty);
  const flag = String(uncertainty?.flag || '').toUpperCase();
  const envelopeValue = envelope && 'value' in envelope ? envelope.value : value;
  if (envelopeValue == null) return 'danger';
  if (flag === 'LOW_CONFIDENCE' || flag === 'LEGACY_ONLY') return 'warn';
  if (flag === 'NOT_AVAILABLE' || flag === 'MISSING_INPUT' || flag === 'DETECTION_FAILED' || flag === 'MODEL_INCONSISTENCY') return 'danger';
  if (flag === 'PLACEHOLDER_ONLY') return 'info';
  return 'ok';
}

function describeEnvelopeState(value: unknown): string {
  const envelope = pickObject(value);
  const uncertainty = pickObject(envelope?.uncertainty);
  const flag = String(uncertainty?.flag || '').toUpperCase();
  const envelopeValue = envelope && 'value' in envelope ? envelope.value : value;
  if (envelopeValue == null) return 'unavailable';
  if (flag === 'LOW_CONFIDENCE') return 'review';
  if (flag === 'PLACEHOLDER_ONLY') return 'showcase';
  return 'available';
}

function capabilityTone(state: Record<string, unknown>): MetricTone {
  if (state.available === true) return 'ok';
  if (state.inferred === true || state.legacy === true) return 'warn';
  return 'danger';
}

function gateStatusTone(status: string): QaTone {
  const normalized = status.toLowerCase();
  if (normalized === 'normal' || normalized === 'pass') return 'ok';
  if (normalized === 'borderline') return 'info';
  if (normalized === 'review_required' || normalized === 'review' || normalized === 'not_assessable') return 'warn';
  return 'danger';
}

function metricRowFromValue(label: string, key: string, value: unknown, contract: Record<string, unknown> | null): MetricRow | null {
  if (numericValueAbsent(value)) return null;
  const unit = inferUnitFromValue(key, value);
  const displayValue = formatMetricDisplayValue(key, value, unit);
  const envelope = pickObject(value);
  const evidence = pickObject(envelope?.evidence);
  const uncertainty = pickObject(envelope?.uncertainty);
  const envelopeMeta = [
    evidence?.method ? `method=${String(evidence.method)}` : null,
    evidence?.confidence != null ? `conf=${Number(evidence.confidence).toFixed(2)}` : null,
    uncertainty?.flag ? `flag=${String(uncertainty.flag)}` : null,
    uncertainty?.clinician_review_required ? 'review=true' : null,
  ].filter(Boolean).join(' · ');
  return {
    label,
    value: displayValue,
    meta: contract ? formatContractMeta(contract) : envelopeMeta,
    tone: classifyEnvelopeTone(value),
    stateLabel: describeEnvelopeState(value),
  };
}

type MetricRow = {
  label: string;
  value: string;
  meta?: string;
  tone?: MetricTone;
  group?: string;
  stateLabel?: string;
};

function renderMetricRow(row: MetricRow): string {
  return `
    <div class="metric-row tone-${row.tone || 'info'}">
      <div class="metric-label">
        <div class="metric-label-top">
          ${row.group ? `<span class="metric-group tone-${row.tone || 'info'}">${escapeHtml(row.group)}</span>` : ''}
          ${row.stateLabel ? `<span class="metric-state tone-${row.tone || 'info'}">${escapeHtml(row.stateLabel)}</span>` : ''}
        </div>
        <span class="metric-label-text">${escapeHtml(row.label)}</span>
        ${row.meta ? `<span class="metric-meta">${escapeHtml(row.meta)}</span>` : ''}
      </div>
      <div class="metric-value">${escapeHtml(row.value)}</div>
    </div>
  `;
}

function renderGroupedMetricRows(rows: MetricRow[]): string {
  if (!rows.length) return '';
  const grouped = new Map<string, MetricRow[]>();
  rows.forEach((row) => {
    const key = row.group || 'General';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  });
  return Array.from(grouped.entries()).map(([group, items]) => `
    <div class="metric-section">
      <div class="metric-section-title">${escapeHtml(group)}</div>
      ${items.map((item) => renderMetricRow({ ...item, group: undefined })).join('')}
    </div>
  `).join('');
}

function statusBadge(status: unknown): MetricTone {
  const normalized = String(status || '').toLowerCase();
  if (['detected', 'accepted', 'available', 'ready', 'stored', 'pass', 'normal'].includes(normalized)) return 'ok';
  if (['uncertain', 'fallback', 'legacy', 'inferred', 'warning', 'missing', 'partial', 'placeholder', 'borderline', 'review_required', 'review', 'not_assessable'].includes(normalized)) return 'warn';
  return 'danger';
}

function inferUnitFromKey(key: string): string {
  if (key.endsWith('_mm2')) return 'mm²';
  if (key.endsWith('_ml')) return 'mL';
  if (key.endsWith('_mm')) return 'mm';
  return '';
}

function inferUnitFromValue(key: string, value: unknown): string {
  const envelope = pickObject(value);
  const explicitUnit = typeof envelope?.unit === 'string' ? envelope.unit : null;
  return explicitUnit || inferUnitFromKey(key);
}

function formatContractMeta(contract: Record<string, unknown>): string {
  const parts: string[] = [];
  if (contract.method) parts.push(`method=${String(contract.method)}`);
  if (contract.evidence_rule) parts.push(`rule=${String(contract.evidence_rule)}`);
  if (Array.isArray(contract.source_fields)) parts.push(`src=${contract.source_fields.join(',')}`);
  return parts.join(' · ');
}

function readMetricValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).value === 'number') {
    return (value as Record<string, number>).value;
  }
  return null;
}

function numericValueAbsent(value: unknown): boolean {
  return value == null;
}

function formatMetricDisplayValue(key: string, value: unknown, unit: string): string {
  const numeric = readMetricValue(value);
  if (numeric !== null) return `${numeric.toFixed(unit === 'mm²' ? 2 : 2)} ${unit}`.trim();
  const envelope = pickObject(value);
  if (envelope && 'value' in envelope) {
    if (envelope.value == null) return unit && unit !== 'status' && unit !== 'category' ? `Unavailable · ${unit}` : 'Unavailable';
    if (typeof envelope.value === 'string') return `${envelope.value}${unit && unit !== 'status' && unit !== 'category' ? ` ${unit}` : ''}`.trim();
    if (typeof envelope.value === 'number') return `${envelope.value} ${unit}`.trim();
    if (typeof envelope.value === 'object') return summarizeStructuredValue(envelope.value);
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return summarizeStructuredValue(value);
  return String(value);
}

function summarizeStructuredValue(value: unknown): string {
  const record = pickObject(value);
  if (!record) return String(value);
  return Object.entries(record)
    .map(([key, entry]) => `${humanize(key)}=${typeof entry === 'number' ? entry : String(entry)}`)
    .join(' · ');
}

function setStatus(text: string): void {
  if (DOM.headerStatus) DOM.headerStatus.textContent = text;
}

function setSubmitCaseModalOpen(open: boolean): void {
  DOM.submitCaseModal?.classList.toggle('hidden', !open);
}

function stageLabel(stage: string | null | undefined): string {
  const raw = String(stage || '').toLowerCase();
  if (!raw) return t('status.queued');
  if (raw === 'segmentation') return t('status.segmentation');
  if (raw === 'centerline') return t('status.centerline');
  if (raw === 'measurements') return t('status.measurements');
  if (raw === 'completed' || raw === 'succeeded') return t('status.completed');
  if (raw === 'failed') return t('status.failed');
  if (raw === 'queued') return t('status.queued');
  if (raw === 'running') return t('status.running');
  return humanize(raw);
}

function updateJobProgressBanner(progress: number, stage: string | null | undefined): void {
  if (!DOM.jobProgressBanner || !DOM.jobProgressFill || !DOM.jobProgressLabel) return;
  DOM.jobProgressBanner.classList.remove('hidden');
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  DOM.jobProgressFill.style.width = `${clamped}%`;
  DOM.jobProgressLabel.textContent = `${stageLabel(stage)} · ${clamped}%`;
}

function clearJobProgressBanner(): void {
  DOM.jobProgressBanner?.classList.add('hidden');
  if (DOM.jobProgressFill) DOM.jobProgressFill.style.width = '0%';
  if (DOM.jobProgressLabel) DOM.jobProgressLabel.textContent = t('status.queued');
}

async function pollSubmittedJob(jobId: string): Promise<void> {
  if (submitJobPollHandle !== null) {
    window.clearInterval(submitJobPollHandle);
    submitJobPollHandle = null;
  }
  activeSubmissionJobId = jobId;
  updateJobProgressBanner(0, 'queued');

  const tick = async () => {
    if (!activeSubmissionJobId) return;
    try {
      const payload = await fetchJson<Record<string, unknown>>(`/api/jobs/${encodeURIComponent(activeSubmissionJobId)}/status`);
      const status = String(payload.status || 'queued').toLowerCase();
      const progressRaw = Number(payload.progress);
      const progress = Number.isFinite(progressRaw) ? progressRaw : (status === 'completed' || status === 'succeeded' ? 100 : status === 'running' ? 45 : 0);
      const resultCaseId = String(payload.result_case_id || '').trim();
      updateJobProgressBanner(progress, String(payload.stage || status));
      if (status === 'completed' || status === 'succeeded') {
        if (submitJobPollHandle !== null) {
          window.clearInterval(submitJobPollHandle);
          submitJobPollHandle = null;
        }
        activeSubmissionJobId = null;
        updateJobProgressBanner(100, 'completed');
        if (DOM.jobProgressLabel) DOM.jobProgressLabel.textContent = '✅ 处理完成，正在加载结果...';
        try {
          if (resultCaseId) {
            await loadCase(resultCaseId);
          } else {
            await loadLatestCase({ updateUrl: true });
          }
        } catch {
          await loadLatestCase({ updateUrl: true });
        } finally {
          window.setTimeout(() => clearJobProgressBanner(), 2000);
        }
      } else if (status === 'failed') {
        if (submitJobPollHandle !== null) {
          window.clearInterval(submitJobPollHandle);
          submitJobPollHandle = null;
        }
        activeSubmissionJobId = null;
        updateJobProgressBanner(100, 'failed');
      }
    } catch {
      // transient network failures ignored while polling
    }
  };
  await tick();
  submitJobPollHandle = window.setInterval(() => {
    void tick();
  }, 5000);
}

async function submitCaseFromModal(): Promise<void> {
  const file = DOM.submitCaseFile?.files?.[0];
  if (!file) return;
  const patientId = (DOM.submitCasePatientId?.value || '').trim();
  if (DOM.submitCaseSubmit) DOM.submitCaseSubmit.disabled = true;
  try {
    const form = new FormData();
    form.set('file', file);
    if (patientId) form.set('patient_id', patientId);
    const payload = await fetchJson<Record<string, unknown>>('/api/upload', {
      method: 'POST',
      body: form,
    });
    const jobId = String(payload.job_id || '').trim();
    if (!jobId) throw new Error('missing_job_id');
    setSubmitCaseModalOpen(false);
    if (DOM.submitCaseForm) DOM.submitCaseForm.reset();
    await pollSubmittedJob(jobId);
  } finally {
    if (DOM.submitCaseSubmit) DOM.submitCaseSubmit.disabled = false;
  }
}

async function refreshGpuStatusIndicator(): Promise<void> {
  if (!DOM.gpuStatusDot || !DOM.gpuStatusText) return;
  try {
    const resp = await fetch('https://api.heartvalvepro.edu.kg/health', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`gpu_health_failed:${resp.status}`);
    const payload = (await resp.json()) as Record<string, unknown>;
    const online = Boolean(payload.ok);
    DOM.gpuStatusDot.classList.toggle('gpu-online', online);
    DOM.gpuStatusDot.classList.toggle('gpu-offline', !online);
    DOM.gpuStatusText.textContent = online ? t('status.gpu_online') : t('status.gpu_offline');
  } catch {
    DOM.gpuStatusDot.classList.add('gpu-offline');
    DOM.gpuStatusDot.classList.remove('gpu-online');
    DOM.gpuStatusText.textContent = t('status.gpu_offline');
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, { cache: 'no-store', ...(init || {}) });
  if (!resp.ok) {
    throw new Error(`request_failed:${url}:${resp.status}`);
  }
  return (await resp.json()) as T;
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`binary_request_failed:${url}:${resp.status}`);
  return resp.arrayBuffer();
}

function pickObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function humanize(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase());
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function resolveAbsoluteUrl(url: string): string {
  return new URL(url, window.location.origin).toString();
}

function armMprWatchdog(): void {
  clearMprWatchdog();
  mprWatchdogHandle = window.setTimeout(() => {
    if (currentBootStage !== 'initializing_volume' && currentBootStage !== 'initializing_viewports') {
      return;
    }
    showMprFailure(new Error(`mpr_initialization_timeout_after_${MPR_INIT_TIMEOUT_MS}ms`));
    setBootStage('ready', 'MPR unavailable. Planning outputs remain visible while CT volume initialization is skipped.');
    if (DOM.headerStatus) {
      DOM.headerStatus.textContent = 'Case loaded with MPR unavailable';
    }
    if (activeCase) {
      void initializeThreePanel(activeCase);
    }
  }, MPR_INIT_TIMEOUT_MS);
}

function clearMprWatchdog(): void {
  if (mprWatchdogHandle !== null) {
    window.clearTimeout(mprWatchdogHandle);
    mprWatchdogHandle = null;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorCode: string): Promise<T> {
  let timeoutHandle: number | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = window.setTimeout(() => reject(new Error(errorCode)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
  }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function toPoint3(value: unknown): Point3 {
  if (Array.isArray(value) && value.length >= 3) {
    return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const x = Number(record.x);
    const y = Number(record.y);
    const z = Number(record.z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return [x, y, z];
    }
  }
  return [0, 0, 0];
}

function length3(v: Point3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize3(v: Point3): Point3 {
  const len = length3(v);
  if (len < 1e-8) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross3(a: Point3, b: Point3): Point3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot3(a: Point3, b: Point3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function subtract3(a: Point3, b: Point3): Point3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function computeCenterlineTangent(points: Point3[], index: number): Point3 {
  const prev = points[Math.max(0, index - 1)] || points[index];
  const next = points[Math.min(points.length - 1, index + 1)] || points[index];
  return normalize3(subtract3(toPoint3(next), toPoint3(prev)));
}

function squaredDistance3(a: Point3, b: Point3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function formatConfidence(value: unknown): string {
  return typeof value === 'number' ? `conf ${value.toFixed(2)}` : 'conf —';
}

bootstrap().catch((error) => {
  if (!DOM.bootOverlay) {
    renderShell();
  }
  showFatalError(error, 'The workstation shell loaded, but startup did not complete. You can retry the latest case without a blank page.');
});
