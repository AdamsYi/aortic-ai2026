import {
  Enums as CoreEnums,
  RenderingEngine,
  cache,
  init as cornerstoneInit,
  metaData,
  setVolumesForViewports,
  volumeLoader,
} from '@cornerstonejs/core';
import cornerstoneDICOMImageLoader, { init as dicomImageLoaderInit } from '@cornerstonejs/dicom-image-loader';
import { createNiftiImageIdsAndCacheMetadata, init as niftiVolumeLoaderInit } from '@cornerstonejs/nifti-volume-loader';
import {
  CrosshairsTool,
  Enums as ToolEnums,
  PanTool,
  ToolGroupManager,
  ZoomTool,
  addTool,
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
  failure_flags?: Record<string, unknown> | null;
  downloads?: {
    json?: string[] | null;
    stl?: string[] | null;
    pdf?: string | null;
  } | null;
  uncertainty_summary?: Record<string, unknown> | null;
  planning_summary?: Record<string, unknown> | null;
};

type Locale = 'zh-CN' | 'en';

type AuxMode = 'annulus' | 'stj' | 'centerline' | 'cpr';

type ViewportKey = 'axial' | 'sagittal' | 'coronal' | 'aux';

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
const VIEWPORT_IDS: Record<ViewportKey, string> = {
  axial: 'mpr-axial',
  sagittal: 'mpr-sagittal',
  coronal: 'mpr-coronal',
  aux: 'mpr-aux',
};
const RENDERING_ENGINE_ID = 'aorticai-mpr-engine';
const TOOL_GROUP_ID = 'aorticai-mpr-tools';
const MPR_INIT_TIMEOUT_MS = 30000;
const THREE_INIT_TIMEOUT_MS = 15000;
const ROOT = document.getElementById('app');

if (!ROOT) {
  throw new Error('missing_app_root');
}
const APP_ROOT = ROOT as HTMLDivElement;

let cornerstoneReady = false;
let toolsRegistered = false;
let session: ViewerSession | null = null;
let activeCase: WorkstationCasePayload | null = null;
let currentCrosshairWorld: Point3 | null = null;
let currentAuxMode: AuxMode = 'annulus';
let currentCenterlineIndex = 0;
let dicomZipWorker: Worker | null = null;
let threeRuntime: ThreeRuntime | null = null;
let currentActiveViewport: ViewportKey = 'axial';
let currentBootStage: BootStage = 'loading_shell';
let lastBootError: string | null = null;
let mprWatchdogHandle: number | null = null;
let lastMprError: string | null = null;
let lastThreeError: string | null = null;
let currentLocale: Locale = 'en';

const I18N: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN,
  en: enUS,
};

const DOM = {
  headerStatus: null as HTMLDivElement | null,
  bootStage: null as HTMLDivElement | null,
  bootOverlay: null as HTMLDivElement | null,
  bootOverlayTitle: null as HTMLHeadingElement | null,
  bootOverlayText: null as HTMLParagraphElement | null,
  bootOverlayDetail: null as HTMLPreElement | null,
  retryLatestButton: null as HTMLButtonElement | null,
  caseMeta: null as HTMLDivElement | null,
  mprStatus: null as HTMLDivElement | null,
  auxMode: null as HTMLSelectElement | null,
  centerlineSlider: null as HTMLInputElement | null,
  centerlineValue: null as HTMLSpanElement | null,
  loadLatestButton: null as HTMLButtonElement | null,
  focusAnnulusButton: null as HTMLButtonElement | null,
  focusStjButton: null as HTMLButtonElement | null,
  focusRootButton: null as HTMLButtonElement | null,
  localeButtons: [] as HTMLButtonElement[],
  measurementGrid: null as HTMLDivElement | null,
  planningGrid: null as HTMLDivElement | null,
  pearsPanel: null as HTMLDivElement | null,
  qaList: null as HTMLUListElement | null,
  evidenceList: null as HTMLUListElement | null,
  downloadList: null as HTMLDivElement | null,
  rawBlock: null as HTMLPreElement | null,
  threeStage: null as HTMLDivElement | null,
  threeFallback: null as HTMLDivElement | null,
  viewportElements: {} as Record<ViewportKey, HTMLDivElement>,
  viewportCards: {} as Record<ViewportKey, HTMLDivElement>,
  viewportBadges: {} as Record<ViewportKey, HTMLDivElement>,
  viewportFooters: {} as Record<ViewportKey, HTMLDivElement>,
};

function renderShell(): void {
  APP_ROOT.innerHTML = `
    <div class="workstation">
      <header class="app-header">
        <div class="header-title">
          <h1 data-i18n="app.title">AorticAI Structural Heart Workstation</h1>
          <p data-i18n="app.subtitle">Cornerstone3D MPR + Three.js anatomy viewer</p>
        </div>
        <div class="header-actions">
          <button id="load-latest" data-i18n="action.load_case">Load Case</button>
          <button id="focus-annulus" data-i18n="action.focus_annulus">Annulus</button>
          <button id="focus-stj" data-i18n="action.focus_stj">STJ</button>
          <button id="focus-root" data-i18n="action.focus_root">Root</button>
          <div class="cluster locale-cluster">
            <button type="button" class="locale-button" data-locale-switch="en">EN</button>
            <button type="button" class="locale-button" data-locale-switch="zh-CN">中文</button>
          </div>
          <div class="status-chip" id="header-status">Initializing...</div>
          <div class="status-chip" id="boot-stage">loading_shell</div>
        </div>
      </header>
      <main class="workspace-grid">
        <section class="panel mpr-panel">
          <div class="mpr-toolbar">
            <div class="cluster">
              <span class="muted" id="case-meta">No case loaded</span>
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
          <div class="mpr-grid">
            ${renderViewportCard('axial', 'Axial')}
            ${renderViewportCard('sagittal', 'Sagittal')}
            ${renderViewportCard('coronal', 'Coronal')}
            ${renderViewportCard('aux', 'Aux')}
          </div>
        </section>
        <section class="panel three-panel">
          <div class="panel-head">
            <div>
              <h2 data-i18n="panel.anatomy_title">3D Anatomy</h2>
              <div class="muted" data-i18n="panel.anatomy_subtitle">STL mesh + centerline</div>
            </div>
          </div>
          <div class="three-stage">
            <div class="three-root" id="three-root"></div>
            <div class="three-fallback hidden" id="three-fallback"></div>
          </div>
          <div class="legend">
            <div class="legend-item"><span class="legend-swatch" style="background:#4da6ff"></span>Root</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#5ee6b0"></span>Ascending</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#f5c842"></span>Leaflets</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#f06070"></span>Annulus</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#9080e0"></span>STJ</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#fff"></span>CL</div>
          </div>
        </section>
        <aside class="panel side-panel">
          <div class="panel-head">
            <div>
              <h2 data-i18n="panel.analysis_title">Analysis</h2>
              <div class="muted" data-i18n="panel.analysis_subtitle">Computational model outputs</div>
            </div>
          </div>
          <div class="side-scroll">
            <section class="info-card pears-card" id="pears-panel">
              <h4 data-i18n="panel.pears_title">PEARS Assessment</h4>
              <div class="pears-content">Awaiting data...</div>
            </section>
            <section class="info-card">
              <h4 data-i18n="panel.measurements_title">Measurements</h4>
              <div class="metric-grid" id="measurement-grid"></div>
            </section>
            <section class="info-card">
              <h4 data-i18n="panel.planning_title">Surgical Planning</h4>
              <div class="metric-grid" id="planning-grid"></div>
            </section>
            <section class="info-card">
              <h4 data-i18n="panel.qa_title">Landmark QA</h4>
              <ul class="qa-list" id="qa-list"></ul>
            </section>
            <section class="info-card">
              <h4 data-i18n="panel.evidence_title">Evidence</h4>
              <ul class="evidence-list" id="evidence-list"></ul>
            </section>
            <section class="info-card">
              <h4 data-i18n="panel.downloads_title">Downloads</h4>
              <div class="download-list" id="download-list"></div>
            </section>
            <section class="info-card">
              <h4 data-i18n="panel.debug_title">Debug</h4>
              <pre class="code-block" id="viewer-state">Waiting for volume...</pre>
            </section>
          </div>
        </aside>
      </main>
      <div class="boot-overlay hidden" id="boot-overlay">
        <div class="boot-card">
          <h2 id="boot-overlay-title">Loading workstation</h2>
          <p id="boot-overlay-text">Preparing runtime...</p>
          <pre class="code-block hidden" id="boot-overlay-detail"></pre>
          <div class="boot-actions">
            <button id="retry-latest" data-i18n="action.retry">Retry</button>
          </div>
        </div>
      </div>
    </div>
  `;

  DOM.headerStatus = document.getElementById('header-status') as HTMLDivElement;
  DOM.bootStage = document.getElementById('boot-stage') as HTMLDivElement;
  DOM.bootOverlay = document.getElementById('boot-overlay') as HTMLDivElement;
  DOM.bootOverlayTitle = document.getElementById('boot-overlay-title') as HTMLHeadingElement;
  DOM.bootOverlayText = document.getElementById('boot-overlay-text') as HTMLParagraphElement;
  DOM.bootOverlayDetail = document.getElementById('boot-overlay-detail') as HTMLPreElement;
  DOM.retryLatestButton = document.getElementById('retry-latest') as HTMLButtonElement;
  DOM.caseMeta = document.getElementById('case-meta') as HTMLDivElement;
  DOM.mprStatus = document.getElementById('mpr-status') as HTMLDivElement;
  DOM.auxMode = document.getElementById('aux-mode') as HTMLSelectElement;
  DOM.centerlineSlider = document.getElementById('centerline-slider') as HTMLInputElement;
  DOM.centerlineValue = document.getElementById('centerline-value') as HTMLSpanElement;
  DOM.loadLatestButton = document.getElementById('load-latest') as HTMLButtonElement;
  DOM.focusAnnulusButton = document.getElementById('focus-annulus') as HTMLButtonElement;
  DOM.focusStjButton = document.getElementById('focus-stj') as HTMLButtonElement;
  DOM.focusRootButton = document.getElementById('focus-root') as HTMLButtonElement;
  DOM.localeButtons = Array.from(document.querySelectorAll('[data-locale-switch]')) as HTMLButtonElement[];
  DOM.measurementGrid = document.getElementById('measurement-grid') as HTMLDivElement;
  DOM.planningGrid = document.getElementById('planning-grid') as HTMLDivElement;
  DOM.pearsPanel = document.getElementById('pears-panel') as HTMLDivElement;
  DOM.qaList = document.getElementById('qa-list') as HTMLUListElement;
  DOM.evidenceList = document.getElementById('evidence-list') as HTMLUListElement;
  DOM.downloadList = document.getElementById('download-list') as HTMLDivElement;
  DOM.rawBlock = document.getElementById('viewer-state') as HTMLPreElement;
  DOM.threeStage = document.getElementById('three-root') as HTMLDivElement;
  DOM.threeFallback = document.getElementById('three-fallback') as HTMLDivElement;

  (['axial', 'sagittal', 'coronal', 'aux'] as ViewportKey[]).forEach((key) => {
    DOM.viewportElements[key] = document.getElementById(`viewport-${key}`) as HTMLDivElement;
    DOM.viewportCards[key] = document.getElementById(`viewport-card-${key}`) as HTMLDivElement;
    DOM.viewportBadges[key] = document.getElementById(`viewport-badge-${key}`) as HTMLDivElement;
    DOM.viewportFooters[key] = document.getElementById(`viewport-footer-${key}`) as HTMLDivElement;
  });

  DOM.loadLatestButton?.addEventListener('click', () => void loadLatestCase());
  DOM.retryLatestButton?.addEventListener('click', () => void retryLatestCase());
  DOM.focusAnnulusButton?.addEventListener('click', () => focusPlane('annulus'));
  DOM.focusStjButton?.addEventListener('click', () => focusPlane('stj'));
  DOM.focusRootButton?.addEventListener('click', () => focusRoot());
  DOM.localeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      currentLocale = (button.dataset.localeSwitch as Locale) || 'en';
      applyLocale();
      if (activeCase) updateHeaderMeta(activeCase);
      if (activeCase) renderSidePanels(activeCase);
    });
  });
  DOM.auxMode?.addEventListener('change', () => {
    currentAuxMode = (DOM.auxMode?.value as AuxMode) || 'annulus';
    if (currentAuxMode === 'cpr' && !isCapabilityAvailable(activeCase?.capabilities?.cpr)) {
      currentAuxMode = 'annulus';
      if (DOM.auxMode) DOM.auxMode.value = currentAuxMode;
      if (DOM.mprStatus) DOM.mprStatus.textContent = 'CPR is not available for this case. Falling back to annulus view.';
    }
    void applyAuxViewportMode();
  });
  DOM.centerlineSlider?.addEventListener('input', () => {
    currentCenterlineIndex = Number.parseInt(DOM.centerlineSlider?.value || '0', 10) || 0;
    updateCenterlineLabel();
    void applyAuxViewportMode();
  });
  applyLocale();
  setBootStage('loading_shell');
}

function renderViewportCard(key: ViewportKey, label: string): string {
  return `
    <div class="viewport-card" id="viewport-card-${key}">
      <div class="viewport-label">${label}</div>
      <div class="viewport-badge" id="viewport-badge-${key}"></div>
      <div class="viewport-element" id="viewport-${key}"></div>
      <div class="viewport-footer" id="viewport-footer-${key}"></div>
    </div>
  `;
}

function t(key: string): string {
  return I18N[currentLocale][key] || I18N.en[key] || key;
}

function applyLocale(): void {
  document.documentElement.lang = currentLocale;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
    const key = node.dataset.i18n;
    if (!key) return;
    node.textContent = t(key);
  });
  DOM.localeButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.localeSwitch === currentLocale);
  });
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
  if (stage !== 'failed') {
    lastBootError = null;
    DOM.bootOverlay?.classList.add('hidden');
    DOM.bootOverlayDetail?.classList.add('hidden');
    if (DOM.bootOverlayDetail) DOM.bootOverlayDetail.textContent = '';
  }
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
  console.error(error);
}

function showMprFailure(error: unknown): void {
  clearMprWatchdog();
  const text = error instanceof Error ? error.message : String(error);
  lastMprError = text;
  if (DOM.mprStatus) DOM.mprStatus.textContent = `MPR unavailable: ${text}`;
  (Object.keys(DOM.viewportBadges) as ViewportKey[]).forEach((key) => {
    if (DOM.viewportBadges[key]) DOM.viewportBadges[key].textContent = key === 'aux' ? 'aux unavailable' : 'mpr unavailable';
  });
  updateViewerState();
}

function showThreeFailure(error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);
  lastThreeError = text;
  if (DOM.threeFallback) {
    DOM.threeFallback.innerHTML = `
      <div class="three-fallback-card">
        <h3>3D viewer unavailable</h3>
        <p>The CT workstation and planning outputs remain available, but the mesh viewer failed to initialize.</p>
        <pre class="code-block">${escapeHtml(text)}</pre>
      </div>
    `;
    DOM.threeFallback.classList.remove('hidden');
  }
  updateViewerState();
}

async function retryLatestCase(): Promise<void> {
  setBootStage('loading_case_index', 'Retrying latest case');
  await loadLatestCase();
}

async function bootstrap(): Promise<void> {
  renderShell();
  setBootStage('loading_runtime', 'Checking build freshness');
  await enforceVersionFreshness();
  setBootStage('loading_runtime', 'Initializing Cornerstone3D runtime');
  await initializeCornerstoneOnce();
  await loadLatestCase();
}

async function enforceVersionFreshness(): Promise<void> {
  try {
    const resp = await fetch('/version', { cache: 'no-store' });
    if (!resp.ok) return;
    const payload = (await resp.json()) as { build_version?: string };
    if (payload.build_version && payload.build_version !== BUILD_VERSION) {
      location.replace(`/demo?v=${payload.build_version}`);
    }
  } catch {
    // Keep workstation usable even if version endpoint is temporarily unavailable.
  }
}

async function initializeCornerstoneOnce(): Promise<void> {
  if (cornerstoneReady) return;
  cornerstoneInit({ rendering: { useCPURendering: false } } as never);
  cornerstoneToolsInit();
  dicomImageLoaderInit({ maxWebWorkers: Math.max(1, Math.min(2, navigator.hardwareConcurrency || 2)) });
  niftiVolumeLoaderInit();
  metaData.addProvider(cornerstoneDICOMImageLoader.wadouri.metaData.metaDataProvider, 11000);
  if (!toolsRegistered) {
    addTool(CrosshairsTool);
    addTool(PanTool);
    addTool(ZoomTool);
    toolsRegistered = true;
  }
  cornerstoneReady = true;
  if (DOM.mprStatus) DOM.mprStatus.textContent = 'Cornerstone3D runtime ready. Resolving default case...';
  setStatus('Cornerstone3D initialized. Loading default case...');
}

async function loadLatestCase(): Promise<void> {
  setBootStage('loading_case_index', 'Resolving latest processed CTA case');
  setStatus('Resolving latest processed CTA case...');
  if (DOM.mprStatus) DOM.mprStatus.textContent = 'Looking up the latest processed CTA case...';
  const latest = await fetchJson<Record<string, unknown>>('/demo/latest-case');
  const jobId = String(latest.id || latest.job_id || '').trim();
  if (!jobId) throw new Error('latest_case_missing_job_id');
  await loadCase(jobId);
}

async function loadCase(jobId: string): Promise<void> {
  setBootStage('loading_case_payload', `Loading case ${jobId}`);
  setStatus(`Loading workstation case ${jobId}...`);
  if (DOM.mprStatus) DOM.mprStatus.textContent = `Loading case ${jobId}...`;
  activeCase = await fetchJson<WorkstationCasePayload>(`/workstation/cases/${encodeURIComponent(jobId)}`);
  updateHeaderMeta(activeCase);
  applyCapabilityControls(activeCase);
  renderSidePanels(activeCase);
  await destroySession();
  const volumeFailure = await initializeViewerSession(activeCase);
  currentAuxMode = activeCase.viewer_bootstrap?.aux_mode || 'annulus';
  if (currentAuxMode === 'cpr' && !isCapabilityAvailable(activeCase.capabilities?.cpr)) {
    currentAuxMode = 'annulus';
  }
  if (DOM.auxMode) DOM.auxMode.value = currentAuxMode;
  currentCenterlineIndex = clampCenterlineIndex(activeCase.viewer_bootstrap?.centerline_index ?? 0);
  updateCenterlineControl(activeCase.centerline);
  if (session) {
    attachViewportInteractions();
    await syncCrosshair(getBootstrapWorldPoint(activeCase));
    await applyAuxViewportMode();
  } else if (volumeFailure) {
    setBootStage('ready', 'Planning outputs loaded while MPR is unavailable');
    if (DOM.headerStatus) {
      DOM.headerStatus.textContent = `Case ${jobId} loaded with MPR unavailable`;
    }
  }
  const threeFailure = await initializeThreePanel(activeCase);
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
  const renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID);
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

    const toolGroup = ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
    if (!toolGroup) throw new Error('tool_group_creation_failed');
    toolGroupCreated = true;
    toolGroup.addTool(CrosshairsTool.toolName);
    toolGroup.addTool(PanTool.toolName);
    toolGroup.addTool(ZoomTool.toolName);
    toolGroup.setToolActive(CrosshairsTool.toolName, {
      bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
    });
    toolGroup.setToolActive(PanTool.toolName, {
      bindings: [{ mouseButton: ToolEnums.MouseBindings.Auxiliary }],
    });
    toolGroup.setToolActive(ZoomTool.toolName, {
      bindings: [{ mouseButton: ToolEnums.MouseBindings.Secondary }],
    });

    syncs.push(
      synchronizers.createCameraPositionSynchronizer(`mpr-camera-${Date.now()}`),
      synchronizers.createVOISynchronizer(`mpr-voi-${Date.now()}`, {
        syncInvertState: true,
        syncColormap: false,
      }),
      synchronizers.createZoomPanSynchronizer(`mpr-zoom-${Date.now()}`)
    );

    for (const viewportId of Object.values(VIEWPORT_IDS)) {
      toolGroup.addViewport(viewportId, RENDERING_ENGINE_ID);
      syncs.forEach((sync) => sync.add({ renderingEngineId: RENDERING_ENGINE_ID, viewportId }));
    }

    Object.entries(VIEWPORT_IDS).forEach(([key, viewportId]) => {
      const viewport = renderingEngine.getViewport(viewportId) as any;
      if (key !== 'aux') viewport.setOrientation(defaultOrientationForKey(key as ViewportKey), true);
      viewport.render();
    });

    return {
      renderingEngine,
      viewportIds: VIEWPORT_IDS,
      toolGroupId: TOOL_GROUP_ID,
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
      try { ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID); } catch {}
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
      currentActiveViewport = key;
      setActiveViewport(key);
      const viewport = session?.renderingEngine.getViewport(VIEWPORT_IDS[key]) as any;
      if (!viewport?.canvasToWorld) return;
      const rect = element.getBoundingClientRect();
      const canvasPoint: [number, number] = [evt.clientX - rect.left, evt.clientY - rect.top];
      const world = viewport.canvasToWorld(canvasPoint) as Point3;
      await syncCrosshair(toPoint3(world));
    };
    element.onwheel = (evt) => {
      evt.preventDefault();
      const viewport = session?.renderingEngine.getViewport(VIEWPORT_IDS[key]) as any;
      if (!viewport?.scroll) return;
      viewport.scroll(evt.deltaY > 0 ? 1 : -1);
      viewport.render();
    };
  });
  setActiveViewport(currentActiveViewport);
}

function setActiveViewport(key: ViewportKey): void {
  (Object.keys(DOM.viewportCards) as ViewportKey[]).forEach((entry) => {
    DOM.viewportCards[entry]?.classList.toggle('active', entry === key);
  });
}

async function syncCrosshair(world: Point3): Promise<void> {
  currentCrosshairWorld = world;
  if (!session) return;
  for (const key of Object.keys(VIEWPORT_IDS) as ViewportKey[]) {
    if (key === 'aux' && currentAuxMode === 'cpr') continue;
    const viewport = session.renderingEngine.getViewport(VIEWPORT_IDS[key]) as any;
    if (viewport?.jumpToWorld) {
      viewport.jumpToWorld(world);
    } else if (viewport?.setCamera) {
      const camera = viewport.getCamera();
      viewport.setCamera({ ...camera, focalPoint: world });
    }
    viewport?.render?.();
  }
  if (currentAuxMode === 'centerline' || currentAuxMode === 'cpr') {
    const idx = findNearestCenterlineIndex(activeCase?.centerline, world);
    currentCenterlineIndex = idx;
    if (DOM.centerlineSlider) DOM.centerlineSlider.value = String(idx);
    updateCenterlineLabel();
    await applyAuxViewportMode();
  }
  updateViewerState();
}

async function applyAuxViewportMode(): Promise<void> {
  if (!session || !activeCase) return;
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
  const target = plane.origin_world ? toPoint3(plane.origin_world) : currentCrosshairWorld;
  if (target && auxViewport.jumpToWorld) auxViewport.jumpToWorld(target);
  auxViewport.render();
  DOM.viewportBadges.aux.textContent = `${currentAuxMode} · ${formatConfidence(plane.confidence)}`;
  if (DOM.viewportFooters.aux) {
    DOM.viewportFooters.aux.innerHTML = `<span>${humanize(currentAuxMode)} plane</span><span>${plane.status || 'derived'}</span>`;
  }
  updateViewerState();
  if (threeRuntime) updateThreePlaneHighlights();
}

async function applyCprViewportMode(auxViewport: any): Promise<void> {
  if (!session || !activeCase || !auxViewport) return;
  if (!isCapabilityAvailable(activeCase.capabilities?.cpr) || !session.cprVolumeId) {
    DOM.viewportBadges.aux.textContent = 'cpr unavailable';
    if (DOM.viewportFooters.aux) {
      DOM.viewportFooters.aux.innerHTML = '<span>Straightened vessel view</span><span>artifact unavailable</span>';
    }
    updateViewerState();
    return;
  }
  await setVolumesForViewports(session.renderingEngine, [{ volumeId: session.cprVolumeId }], [VIEWPORT_IDS.aux]);
  auxViewport.setOrientation(CoreEnums.OrientationAxis.AXIAL, true);
  const sliceSpacing = Number(activeCase.cpr_sources?.reference_json?.slice_spacing_mm || 1);
  const sliceWorld: Point3 = [0, 0, currentCenterlineIndex * Math.max(0.5, sliceSpacing)];
  if (auxViewport.jumpToWorld) auxViewport.jumpToWorld(sliceWorld);
  auxViewport.render?.();
  DOM.viewportBadges.aux.textContent = 'cpr ready';
  if (DOM.viewportFooters.aux) {
    DOM.viewportFooters.aux.innerHTML = `<span>Straightened vessel view</span><span>slice ${currentCenterlineIndex + 1}</span>`;
  }
  updateViewerState();
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
  if (!activeCase) return;
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
  if (!activeCase) return;
  const focus = getBootstrapWorldPoint(activeCase);
  if (focus) void syncCrosshair(focus);
}

function getBootstrapWorldPoint(casePayload: WorkstationCasePayload | null): Point3 {
  if (casePayload?.viewer_bootstrap?.focus_world) return toPoint3(casePayload.viewer_bootstrap.focus_world);
  const annulus = casePayload?.display_planes?.annulus?.origin_world;
  if (annulus) return toPoint3(annulus);
  const centerlineFirst = casePayload?.centerline?.points_world?.[0];
  if (centerlineFirst) return toPoint3(centerlineFirst);
  return [0, 0, 0];
}

function updateHeaderMeta(casePayload: WorkstationCasePayload): void {
  if (DOM.caseMeta) {
    const displayName = typeof casePayload.display_name === 'string'
      ? casePayload.display_name
      : casePayload.display_name?.[currentLocale] || casePayload.display_name?.en || casePayload.display_name?.['zh-CN'] || casePayload.case_id || casePayload.job.id;
    DOM.caseMeta.textContent = [
      String(displayName || casePayload.job.id || '-'),
      `Dataset ${String(casePayload.study_meta?.source_dataset || 'unknown')}`,
      `Phase ${String(casePayload.study_meta?.phase || casePayload.pipeline_run?.selected_phase || 'unknown')}`,
      `Input ${casePayload.volume_source.source_kind}`,
      casePayload.placeholder ? 'Showcase placeholder' : null,
      casePayload.pipeline_run?.inferred ? 'Historical inferred provenance' : null,
    ].filter(Boolean).join(' · ');
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
  DOM.centerlineValue.textContent = `${currentCenterlineIndex + 1} / ${Math.max(total, 1)}`;
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
  renderPearsPanel(casePayload);
  const metricsPayload = {
    ...(pickObject(casePayload.measurements) || {}),
    measurement_contract: casePayload.measurement_contract || null,
    planning_evidence: casePayload.planning_evidence || null,
  };
  const measurementRows = collectMeasurementRows(metricsPayload, casePayload);
  DOM.measurementGrid!.innerHTML = measurementRows.map(renderMetricRow).join('') || `<div class="muted">${escapeHtml(t('message.no_measurements'))}</div>`;

  const planningRows = collectPlanningRows(casePayload);
  DOM.planningGrid!.innerHTML = planningRows.map(renderMetricRow).join('') || `<div class="muted">${escapeHtml(t('message.no_planning'))}</div>`;

  const qaItems = collectQaItems(casePayload);
  DOM.qaList!.innerHTML = qaItems.map((item) => `<li>${item}</li>`).join('') || `<li class="muted">${escapeHtml(t('message.no_qa'))}</li>`;

  const evidenceItems = collectEvidenceItems(casePayload);
  DOM.evidenceList!.innerHTML = evidenceItems.map((item) => `<li class="evidence-item">${item}</li>`).join('') || `<li class="muted">${escapeHtml(t('message.no_evidence'))}</li>`;
  renderDownloadPanel(casePayload);

  updateViewerState();
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

function collectPlanningRows(casePayload: WorkstationCasePayload): MetricRow[] {
  const planningRoot = pickObject(casePayload.planning) || {};
  const sections: Array<[string, Record<string, unknown> | null]> = [
    ['TAVI', pickObject(planningRoot.tavi)],
    ['VSRR', pickObject(planningRoot.vsrr)],
    ['PEARS', pickObject(planningRoot.pears)],
  ];
  const rows: MetricRow[] = [];
  sections.forEach(([sectionLabel, section]) => {
    if (!section) return;
    Object.entries(section).forEach(([key, value]) => {
      const row = metricRowFromValue(`${sectionLabel} · ${humanize(key)}`, key, value, null);
      if (row) rows.push(row);
    });
  });
  return rows;
}

function renderDownloadPanel(casePayload: WorkstationCasePayload): void {
  if (!DOM.downloadList) return;
  const downloads = casePayload.downloads || {};
  const jsonLinks = Array.isArray(downloads.json) ? downloads.json : [];
  const stlLinks = Array.isArray(downloads.stl) ? downloads.stl : [];
  const pdfLink = typeof downloads.pdf === 'string' ? downloads.pdf : null;
  const items: string[] = [];
  jsonLinks.forEach((href, index) => {
    items.push(renderDownloadLink(`JSON ${index + 1}`, href));
  });
  stlLinks.forEach((href, index) => {
    items.push(renderDownloadLink(`STL ${index + 1}`, href));
  });
  if (pdfLink) items.push(renderDownloadLink('PDF report', pdfLink));
  DOM.downloadList.innerHTML = items.join('') || `<div class="muted">${escapeHtml(t('message.no_downloads'))}</div>`;
}

function renderDownloadLink(label: string, href: string): string {
  return `<a class="download-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function collectQaItems(casePayload: WorkstationCasePayload): string[] {
  const items: string[] = [];
  if (casePayload.placeholder || casePayload.not_real_cta) {
    items.push(`${escapeHtml(t('qa.placeholder_case'))}: <span class="badge-warn">placeholder</span>`);
  }
  if (casePayload.pipeline_run) {
    const run = pickObject(casePayload.pipeline_run);
    if (run) {
      const sourceMode = String(run.source_mode || 'unknown');
      const inferred = Boolean(run.inferred);
      items.push(`Pipeline provenance: <span class="badge-${inferred ? 'warn' : 'ok'}">${escapeHtml(sourceMode)}</span>${inferred ? ' · inferred' : ''}`);
    }
  }
  const qaFlags = casePayload.viewer_bootstrap?.qa_flags || null;
  const warnings = casePayload.viewer_bootstrap?.bootstrap_warnings || [];
  if (qaFlags) {
    Object.entries(qaFlags).forEach(([key, value]) => {
      items.push(`${escapeHtml(humanize(key))}: <span class="badge-${value ? 'ok' : 'warn'}">${value ? 'available' : 'missing'}</span>`);
    });
  }
  const capabilities = casePayload.capabilities || {};
  Object.entries(capabilities).forEach(([key, value]) => {
    const state = pickObject(value);
    if (!state) return;
    const suffix = [
      state.source ? `source=${String(state.source)}` : null,
      state.inferred ? 'inferred' : null,
      state.legacy ? 'legacy' : null,
      state.reason ? String(state.reason) : null,
    ].filter(Boolean).join(' · ');
    items.push(
      `${escapeHtml(humanize(key))}: <span class="badge-${state.available ? 'ok' : state.inferred || state.legacy ? 'warn' : 'danger'}">${state.available ? 'available' : state.inferred ? 'inferred' : state.legacy ? 'legacy' : 'unavailable'}</span>${suffix ? ` · ${escapeHtml(suffix)}` : ''}`
    );
  });
  const summary = casePayload.model_landmarks_summary || {};
  const annulus = pickObject(summary.annulus);
  if (annulus) items.push(formatQaLine('Annulus', annulus.status, annulus.confidence));
  const stj = pickObject(summary.stj);
  if (stj) items.push(formatQaLine('STJ', stj.status, stj.confidence));
  const coronary = isCapabilityAvailable(casePayload.capabilities?.coronary_ostia)
    ? pickObject(casePayload.coronary_ostia_summary)
    : null;
  if (coronary) {
    const left = pickObject(coronary.left);
    const right = pickObject(coronary.right);
    if (left) items.push(formatQaLine('Left coronary ostium', left.status, left.confidence, left.reason));
    if (right) items.push(formatQaLine('Right coronary ostium', right.status, right.confidence, right.reason));
  }
  const leafletSummary = pickObject(casePayload.leaflet_geometry_summary);
  const leaflets = isCapabilityAvailable(casePayload.capabilities?.leaflet_geometry) && Array.isArray(leafletSummary?.leaflets)
    ? leafletSummary?.leaflets
    : (Array.isArray(summary.leaflet_status) ? summary.leaflet_status : []);
  leaflets.forEach((leaflet, index) => {
    const record = pickObject(leaflet);
    if (!record) return;
    const label = String(record.cusp_label || record.label || `Leaflet ${index + 1}`);
    items.push(formatQaLine(label, record.status, record.confidence, record.reason));
  });
  if (!items.length && casePayload.centerline?.point_count) {
    items.push(`Centerline points: ${casePayload.centerline.point_count}`);
  }
  warnings.forEach((warning) => {
    items.push(`${escapeHtml(humanize(warning))}: <span class="badge-warn">warning</span>`);
  });
  return items;
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
      aux_mode: currentAuxMode,
      centerline_index: currentCenterlineIndex,
      crosshair_world: currentCrosshairWorld,
      volume_source: activeCase?.volume_source || null,
      runtime_requirements: activeCase?.viewer_bootstrap?.runtime_requirements || null,
      cpr_sources: activeCase?.cpr_sources || null,
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
  scene.background = new THREE.Color(0x020812);
  const camera = new THREE.PerspectiveCamera(40, Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight), 0.1, 5000);
  camera.position.set(0, -130, 130);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
  container.replaceChildren(renderer.domElement);
  DOM.threeFallback?.classList.add('hidden');
  if (DOM.threeFallback) DOM.threeFallback.innerHTML = '';

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  const ambient = new THREE.AmbientLight(0xffffff, 1.35);
  scene.add(ambient);
  const dirA = new THREE.DirectionalLight(0xffffff, 1.1);
  dirA.position.set(120, 120, 180);
  scene.add(dirA);
  const dirB = new THREE.DirectionalLight(0x77aaff, 0.7);
  dirB.position.set(-90, -60, 120);
  scene.add(dirB);

  const rootGroup = new THREE.Group();
  scene.add(rootGroup);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const animate = () => {
    controls.update();
    renderer.render(scene, camera);
    runtime.animationHandle = requestAnimationFrame(animate);
  };
  const resizeHandler = () => resizeThreeRuntime(runtime, container);
  const runtime: ThreeRuntime = { scene, camera, renderer, controls, rootGroup, animationHandle: null, raycaster, pointer, resizeHandler };
  animate();
  window.addEventListener('resize', resizeHandler);
  return runtime;
}

function resizeThreeRuntime(runtime: ThreeRuntime, container: HTMLDivElement): void {
  runtime.camera.aspect = Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight);
  runtime.camera.updateProjectionMatrix();
  runtime.renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
}

async function loadThreeCase(runtime: ThreeRuntime, casePayload: WorkstationCasePayload): Promise<void> {
  const loader = new STLLoader();
  while (runtime.rootGroup.children.length) {
    const child = runtime.rootGroup.children[0];
    runtime.rootGroup.remove(child);
    disposeThreeObject(child);
  }

  const materials = {
    root: new THREE.MeshPhongMaterial({ color: 0x58b8ff, transparent: true, opacity: 0.9, shininess: 40 }),
    ascending: new THREE.MeshPhongMaterial({ color: 0x7ef0c3, transparent: true, opacity: 0.82, shininess: 40 }),
    leaflets: new THREE.MeshPhongMaterial({ color: 0xffd36b, transparent: true, opacity: 0.88, shininess: 30 }),
  };

  await Promise.all([
    maybeLoadStl(casePayload.links.aortic_root_stl, loader, materials.root, runtime.rootGroup),
    maybeLoadStl(casePayload.links.ascending_aorta_stl, loader, materials.ascending, runtime.rootGroup),
    maybeLoadStl(casePayload.links.leaflets_stl, loader, materials.leaflets, runtime.rootGroup),
  ]);

  if (Array.isArray(casePayload.centerline?.points_world) && casePayload.centerline!.points_world!.length > 1) {
    const points = casePayload.centerline!.points_world!.map((point) => new THREE.Vector3(point[0], point[1], point[2]));
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xffffff }));
    line.name = 'centerline';
    runtime.rootGroup.add(line);
  }

  const annulusPlane = casePayload.display_planes?.annulus;
  if (annulusPlane) runtime.rootGroup.add(buildPlaneMesh(annulusPlane, 18, 0xff7b89, 'annulus-plane'));
  const stjPlane = casePayload.display_planes?.stj;
  if (stjPlane) runtime.rootGroup.add(buildPlaneMesh(stjPlane, 18, 0x9f8cff, 'stj-plane'));

  const box = new THREE.Box3().setFromObject(runtime.rootGroup);
  const center = box.isEmpty() ? new THREE.Vector3(0, 0, 0) : box.getCenter(new THREE.Vector3());
  const size = box.isEmpty() ? 120 : box.getSize(new THREE.Vector3()).length();
  runtime.controls.target.copy(center);
  runtime.camera.position.set(center.x + size * 0.8, center.y - size * 0.9, center.z + size * 0.7);
  runtime.camera.lookAt(center);
  runtime.controls.update();
  updateThreePlaneHighlights();
}

async function maybeLoadStl(url: string | undefined, loader: STLLoader, material: THREE.Material, group: THREE.Group): Promise<void> {
  if (!url) return;
  const geometry = await loader.loadAsync(resolveAbsoluteUrl(url));
  geometry.computeVertexNormals?.();
  const object = new THREE.Mesh(geometry, material.clone());
  object.name = url;
  group.add(object);
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

async function destroySession(): Promise<void> {
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
}

function clearMprFailure(): void {
  clearMprWatchdog();
  lastMprError = null;
  if (DOM.mprStatus) DOM.mprStatus.textContent = 'MPR ready. Crosshair synchronization active.';
  (Object.keys(DOM.viewportBadges) as ViewportKey[]).forEach((key) => {
    if (DOM.viewportBadges[key]) DOM.viewportBadges[key].textContent = `${humanize(key)} ready`;
  });
  updateViewerState();
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
  };
}

type MetricRow = {
  label: string;
  value: string;
  meta?: string;
};

function renderMetricRow(row: MetricRow): string {
  return `
    <div class="metric-row">
      <div class="metric-label">
        <span>${escapeHtml(row.label)}</span>
        ${row.meta ? `<span class="metric-meta">${escapeHtml(row.meta)}</span>` : ''}
      </div>
      <div class="metric-value">${escapeHtml(row.value)}</div>
    </div>
  `;
}

function formatQaLine(label: string, status: unknown, confidence: unknown, reason?: unknown): string {
  const conf = typeof confidence === 'number' ? ` · conf ${confidence.toFixed(2)}` : '';
  const why = reason ? ` · ${escapeHtml(String(reason))}` : '';
  return `${escapeHtml(label)}: <span class="badge-${statusBadge(status)}">${escapeHtml(String(status || 'unknown'))}</span>${conf}${why}`;
}

function statusBadge(status: unknown): 'ok' | 'warn' | 'danger' {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'detected' || normalized === 'accepted') return 'ok';
  if (normalized === 'uncertain' || normalized === 'fallback') return 'warn';
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
    if (envelope.value == null) return `null${unit ? ` ${unit}` : ''}`.trim();
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

async function fetchJson<T>(url: string): Promise<T> {
  const resp = await fetch(url, { cache: 'no-store' });
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

function toPoint3(value: unknown): Point3 {
  if (Array.isArray(value) && value.length >= 3) {
    return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
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
