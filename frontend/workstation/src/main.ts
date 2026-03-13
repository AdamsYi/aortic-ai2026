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
  s_mm?: number[];
};

type ModelLandmarksSummary = {
  annulus?: Record<string, unknown> | null;
  stj?: Record<string, unknown> | null;
  commissures?: Record<string, unknown>[] | null;
  coronary_ostia?: Record<string, unknown> | null;
  leaflet_status?: Record<string, unknown>[] | null;
};

type WorkstationCasePayload = {
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
  viewer_bootstrap?: {
    focus_world?: Point3 | null;
    aux_mode?: AuxMode;
    centerline_index?: number | null;
  } | null;
  centerline?: CenterlinePayload | null;
  model_landmarks_summary?: ModelLandmarksSummary | null;
  measurement_contract?: Record<string, unknown> | null;
  planning_evidence?: Record<string, unknown> | null;
  measurements?: Record<string, unknown> | null;
  aortic_root_model?: Record<string, unknown> | null;
};

type AuxMode = 'annulus' | 'stj' | 'centerline';

type ViewportKey = 'axial' | 'sagittal' | 'coronal' | 'aux';

type ViewerSession = {
  renderingEngine: RenderingEngine;
  viewportIds: Record<ViewportKey, string>;
  toolGroupId: string;
  volumeId: string;
  volumeImageIds: string[];
  syncs: Array<{ destroy?: () => void }>;
  dicomImageIds: string[];
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
};

const BUILD_VERSION = window.__AORTIC_BUILD_VERSION__ || 'dev';
const VIEWPORT_IDS: Record<ViewportKey, string> = {
  axial: 'mpr-axial',
  sagittal: 'mpr-sagittal',
  coronal: 'mpr-coronal',
  aux: 'mpr-aux',
};
const RENDERING_ENGINE_ID = 'aorticai-mpr-engine';
const TOOL_GROUP_ID = 'aorticai-mpr-tools';
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

const DOM = {
  headerStatus: null as HTMLDivElement | null,
  caseMeta: null as HTMLDivElement | null,
  mprStatus: null as HTMLDivElement | null,
  auxMode: null as HTMLSelectElement | null,
  centerlineSlider: null as HTMLInputElement | null,
  centerlineValue: null as HTMLSpanElement | null,
  loadLatestButton: null as HTMLButtonElement | null,
  focusAnnulusButton: null as HTMLButtonElement | null,
  focusStjButton: null as HTMLButtonElement | null,
  focusRootButton: null as HTMLButtonElement | null,
  measurementGrid: null as HTMLDivElement | null,
  planningGrid: null as HTMLDivElement | null,
  qaList: null as HTMLUListElement | null,
  evidenceList: null as HTMLUListElement | null,
  rawBlock: null as HTMLPreElement | null,
  threeStage: null as HTMLDivElement | null,
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
          <h1>AorticAI Structural Heart Workstation</h1>
          <p>Cornerstone3D MPR + Three.js anatomy viewer. Measurements remain read-only outputs from the computational model.</p>
        </div>
        <div class="header-actions">
          <button id="load-latest">Load Latest Case</button>
          <button id="focus-root">Focus Root</button>
          <button id="focus-annulus">Jump Annulus</button>
          <button id="focus-stj">Jump STJ</button>
          <div class="status-chip" id="header-status">Booting workstation...</div>
        </div>
      </header>
      <main class="workspace-grid">
        <section class="panel mpr-panel">
          <div class="panel-head">
            <div>
              <h2>CT Workstation</h2>
              <div class="muted" id="case-meta">Awaiting default case...</div>
            </div>
            <div class="muted" id="mpr-status">Preparing Cornerstone3D engine...</div>
          </div>
          <div class="mpr-toolbar">
            <div class="cluster">
              <label for="aux-mode">Auxiliary MPR</label>
              <select id="aux-mode">
                <option value="annulus">Annulus double-oblique</option>
                <option value="stj">STJ plane</option>
                <option value="centerline">Centerline orthogonal</option>
              </select>
            </div>
            <div class="cluster">
              <label for="centerline-slider">Centerline</label>
              <input id="centerline-slider" type="range" min="0" max="0" value="0" step="1" />
              <span id="centerline-value" class="status-chip">0 / 0</span>
            </div>
          </div>
          <div class="status-strip">
            <div class="status-chip">Axial / Sagittal / Coronal synchronized by patient-space world coordinates</div>
            <div class="status-chip">Aux viewport driven by annulus/STJ/centerline planes from AorticRootComputationalModel</div>
          </div>
          <div class="mpr-grid">
            ${renderViewportCard('axial', 'Axial')}
            ${renderViewportCard('sagittal', 'Sagittal')}
            ${renderViewportCard('coronal', 'Coronal')}
            ${renderViewportCard('aux', 'Auxiliary MPR')}
          </div>
        </section>
        <section class="panel three-panel">
          <div class="panel-head">
            <div>
              <h2>3D Anatomy Viewer</h2>
              <div class="muted">Binary STL + centerline + annulus/STJ planes</div>
            </div>
          </div>
          <div class="three-stage">
            <div class="three-root" id="three-root"></div>
          </div>
          <div class="legend">
            <div class="legend-item"><span class="legend-swatch" style="background:#58b8ff"></span>Aortic root</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#7ef0c3"></span>Ascending aorta</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#ffd36b"></span>Leaflets</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#ff7b89"></span>Annulus plane</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#9f8cff"></span>STJ plane</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#ffffff"></span>Centerline</div>
          </div>
        </section>
        <aside class="panel side-panel">
          <div class="panel-head">
            <div>
              <h2>Planning + QA</h2>
              <div class="muted">Read-only digital twin outputs</div>
            </div>
          </div>
          <div class="status-strip">
            <div class="status-chip">No manual measurement writes back to the authoritative model in this milestone</div>
          </div>
          <div class="side-scroll">
            <section class="info-card">
              <h4>Measurements</h4>
              <div class="metric-grid" id="measurement-grid"></div>
            </section>
            <section class="info-card">
              <h4>Planning</h4>
              <div class="metric-grid" id="planning-grid"></div>
            </section>
            <section class="info-card">
              <h4>Landmark QA</h4>
              <ul class="qa-list" id="qa-list"></ul>
            </section>
            <section class="info-card">
              <h4>Evidence Traceability</h4>
              <ul class="evidence-list" id="evidence-list"></ul>
            </section>
            <section class="info-card">
              <h4>Viewer State</h4>
              <pre class="code-block" id="viewer-state">Waiting for volume...</pre>
            </section>
          </div>
        </aside>
      </main>
    </div>
  `;

  DOM.headerStatus = document.getElementById('header-status') as HTMLDivElement;
  DOM.caseMeta = document.getElementById('case-meta') as HTMLDivElement;
  DOM.mprStatus = document.getElementById('mpr-status') as HTMLDivElement;
  DOM.auxMode = document.getElementById('aux-mode') as HTMLSelectElement;
  DOM.centerlineSlider = document.getElementById('centerline-slider') as HTMLInputElement;
  DOM.centerlineValue = document.getElementById('centerline-value') as HTMLSpanElement;
  DOM.loadLatestButton = document.getElementById('load-latest') as HTMLButtonElement;
  DOM.focusAnnulusButton = document.getElementById('focus-annulus') as HTMLButtonElement;
  DOM.focusStjButton = document.getElementById('focus-stj') as HTMLButtonElement;
  DOM.focusRootButton = document.getElementById('focus-root') as HTMLButtonElement;
  DOM.measurementGrid = document.getElementById('measurement-grid') as HTMLDivElement;
  DOM.planningGrid = document.getElementById('planning-grid') as HTMLDivElement;
  DOM.qaList = document.getElementById('qa-list') as HTMLUListElement;
  DOM.evidenceList = document.getElementById('evidence-list') as HTMLUListElement;
  DOM.rawBlock = document.getElementById('viewer-state') as HTMLPreElement;
  DOM.threeStage = document.getElementById('three-root') as HTMLDivElement;

  (['axial', 'sagittal', 'coronal', 'aux'] as ViewportKey[]).forEach((key) => {
    DOM.viewportElements[key] = document.getElementById(`viewport-${key}`) as HTMLDivElement;
    DOM.viewportCards[key] = document.getElementById(`viewport-card-${key}`) as HTMLDivElement;
    DOM.viewportBadges[key] = document.getElementById(`viewport-badge-${key}`) as HTMLDivElement;
    DOM.viewportFooters[key] = document.getElementById(`viewport-footer-${key}`) as HTMLDivElement;
  });

  DOM.loadLatestButton?.addEventListener('click', () => void loadLatestCase());
  DOM.focusAnnulusButton?.addEventListener('click', () => focusPlane('annulus'));
  DOM.focusStjButton?.addEventListener('click', () => focusPlane('stj'));
  DOM.focusRootButton?.addEventListener('click', () => focusRoot());
  DOM.auxMode?.addEventListener('change', () => {
    currentAuxMode = (DOM.auxMode?.value as AuxMode) || 'annulus';
    void applyAuxViewportMode();
  });
  DOM.centerlineSlider?.addEventListener('input', () => {
    currentCenterlineIndex = Number.parseInt(DOM.centerlineSlider?.value || '0', 10) || 0;
    updateCenterlineLabel();
    void applyAuxViewportMode();
  });
}

function renderViewportCard(key: ViewportKey, label: string): string {
  return `
    <div class="viewport-card" id="viewport-card-${key}">
      <div class="viewport-label">${label}</div>
      <div class="viewport-badge" id="viewport-badge-${key}">idle</div>
      <div class="viewport-element" id="viewport-${key}"></div>
      <div class="viewport-footer" id="viewport-footer-${key}">
        <span>${label} world sync</span>
        <span>cache: no-store</span>
      </div>
    </div>
  `;
}

async function bootstrap(): Promise<void> {
  renderShell();
  await enforceVersionFreshness();
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
  setStatus('Cornerstone3D initialized. Loading default case...');
}

async function loadLatestCase(): Promise<void> {
  setStatus('Resolving latest processed CTA case...');
  const latest = await fetchJson<Record<string, unknown>>('/demo/latest-case');
  const jobId = String(latest.id || latest.job_id || '').trim();
  if (!jobId) throw new Error('latest_case_missing_job_id');
  await loadCase(jobId);
}

async function loadCase(jobId: string): Promise<void> {
  setStatus(`Loading workstation case ${jobId}...`);
  activeCase = await fetchJson<WorkstationCasePayload>(`/workstation/cases/${encodeURIComponent(jobId)}`);
  updateHeaderMeta(activeCase);
  await destroySession();
  session = await createViewerSession(activeCase);
  currentAuxMode = activeCase.viewer_bootstrap?.aux_mode || 'annulus';
  if (DOM.auxMode) DOM.auxMode.value = currentAuxMode;
  currentCenterlineIndex = clampCenterlineIndex(activeCase.viewer_bootstrap?.centerline_index ?? 0);
  updateCenterlineControl(activeCase.centerline);
  attachViewportInteractions();
  await syncCrosshair(getBootstrapWorldPoint(activeCase));
  await applyAuxViewportMode();
  await ensureThreeViewer(activeCase);
  renderSidePanels(activeCase);
  setStatus(`Case ready: ${jobId}`);
}

async function createViewerSession(casePayload: WorkstationCasePayload): Promise<ViewerSession> {
  const renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID);
  renderingEngine.setViewports([
    createViewportInput('axial', CoreEnums.OrientationAxis.AXIAL),
    createViewportInput('sagittal', CoreEnums.OrientationAxis.SAGITTAL),
    createViewportInput('coronal', CoreEnums.OrientationAxis.CORONAL),
    createViewportInput('aux', CoreEnums.OrientationAxis.AXIAL),
  ]);

  const { volumeId, imageIds, dicomImageIds } = await loadVolumeFromSource(casePayload.volume_source, String(casePayload.job.id || 'case'));
  const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds });
  if (typeof (volume as { load?: () => void }).load === 'function') {
    (volume as { load: () => void }).load();
  }

  await setVolumesForViewports(
    renderingEngine,
    [{ volumeId }],
    Object.values(VIEWPORT_IDS)
  );

  const toolGroup = ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
  if (!toolGroup) throw new Error('tool_group_creation_failed');
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

  const syncs = [
    synchronizers.createCameraPositionSynchronizer(`mpr-camera-${Date.now()}`),
    synchronizers.createVOISynchronizer(`mpr-voi-${Date.now()}`, {
      syncInvertState: true,
      syncColormap: false,
    }),
    synchronizers.createZoomPanSynchronizer(`mpr-zoom-${Date.now()}`),
  ];

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
    syncs,
    dicomImageIds,
  };
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
  if (source.loader_kind === 'cornerstone-nifti') {
    const imageIds = await createNiftiImageIdsAndCacheMetadata({ url: source.signed_url });
    const volumeId = `cornerstoneStreamingImageVolume:${caseId}:nifti`;
    return { volumeId, imageIds, dicomImageIds: [] };
  }

  const zipBuffer = await fetchArrayBuffer(source.signed_url);
  const entries = await unzipDicomZip(zipBuffer);
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
    const viewport = session.renderingEngine.getViewport(VIEWPORT_IDS[key]) as any;
    if (viewport?.jumpToWorld) {
      viewport.jumpToWorld(world);
    } else if (viewport?.setCamera) {
      const camera = viewport.getCamera();
      viewport.setCamera({ ...camera, focalPoint: world });
    }
    viewport?.render?.();
  }
  if (currentAuxMode === 'centerline') {
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

function planeForMode(casePayload: WorkstationCasePayload | null, mode: AuxMode, centerlineIndex: number): PlaneDefinition | null {
  if (!casePayload) return null;
  if (mode === 'annulus') return casePayload.display_planes?.annulus || null;
  if (mode === 'stj') return casePayload.display_planes?.stj || null;
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
    DOM.caseMeta.textContent = [
      `Job ${String(casePayload.job.id || '-')}`,
      `Dataset ${String(casePayload.study_meta?.source_dataset || 'unknown')}`,
      `Phase ${String(casePayload.study_meta?.phase || casePayload.pipeline_run?.selected_phase || 'unknown')}`,
      `Input ${casePayload.volume_source.source_kind}`,
    ].join(' · ');
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

function renderSidePanels(casePayload: WorkstationCasePayload): void {
  const metricsPayload = {
    ...(pickObject(casePayload.measurements) || {}),
    measurement_contract: casePayload.measurement_contract || null,
    planning_evidence: casePayload.planning_evidence || null,
  };
  const measurementRows = collectMeasurementRows(metricsPayload);
  DOM.measurementGrid!.innerHTML = measurementRows.map(renderMetricRow).join('') || '<div class="muted">No measurement payload available.</div>';

  const planningRows = collectPlanningRows(metricsPayload);
  DOM.planningGrid!.innerHTML = planningRows.map(renderMetricRow).join('') || '<div class="muted">Planning outputs not yet available for this case.</div>';

  const qaItems = collectQaItems(casePayload);
  DOM.qaList!.innerHTML = qaItems.map((item) => `<li>${item}</li>`).join('') || '<li class="muted">No QA landmarks returned.</li>';

  const evidenceItems = collectEvidenceItems(casePayload);
  DOM.evidenceList!.innerHTML = evidenceItems.map((item) => `<li class="evidence-item">${item}</li>`).join('') || '<li class="muted">No traceability metadata attached.</li>';

  updateViewerState();
}

function collectMeasurementRows(payload: Record<string, unknown> | null | undefined): MetricRow[] {
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

  return candidates
    .map(([key, label]) => metricRowFromValue(label, key, measurementsRoot[key], pickObject(contract[key])))
    .filter(Boolean) as MetricRow[];
}

function collectPlanningRows(payload: Record<string, unknown> | null | undefined): MetricRow[] {
  const planningRoot = pickObject(payload?.planning_metrics) || {};
  const evidence = pickObject(payload?.planning_evidence) || {};
  return Object.entries(planningRoot)
    .map(([key, value]) => metricRowFromValue(humanize(key), key, value, pickObject(evidence[key])))
    .filter(Boolean) as MetricRow[];
}

function collectQaItems(casePayload: WorkstationCasePayload): string[] {
  const items: string[] = [];
  const summary = casePayload.model_landmarks_summary || {};
  const annulus = pickObject(summary.annulus);
  if (annulus) items.push(formatQaLine('Annulus', annulus.status, annulus.confidence));
  const stj = pickObject(summary.stj);
  if (stj) items.push(formatQaLine('STJ', stj.status, stj.confidence));
  const coronary = pickObject(summary.coronary_ostia);
  if (coronary) {
    const left = pickObject(coronary.left);
    const right = pickObject(coronary.right);
    if (left) items.push(formatQaLine('Left coronary ostium', left.status, left.confidence));
    if (right) items.push(formatQaLine('Right coronary ostium', right.status, right.confidence));
  }
  const leaflets = Array.isArray(summary.leaflet_status) ? summary.leaflet_status : [];
  leaflets.forEach((leaflet, index) => {
    const record = pickObject(leaflet);
    if (!record) return;
    items.push(formatQaLine(`Leaflet ${index + 1}`, record.status, record.confidence));
  });
  if (!items.length && casePayload.centerline?.point_count) {
    items.push(`Centerline points: ${casePayload.centerline.point_count}`);
  }
  return items;
}

function collectEvidenceItems(casePayload: WorkstationCasePayload): string[] {
  const items: string[] = [];
  if (casePayload.pipeline_run) {
    items.push(`<strong>Pipeline</strong><span class="muted">${escapeHtml(JSON.stringify(casePayload.pipeline_run))}</span>`);
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
      case_job_id: activeCase?.job?.id || null,
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
  const THREE_URL = 'https://esm.sh/three@0.179.1?bundle';
  const ORBIT_URL = 'https://esm.sh/three@0.179.1/examples/jsm/controls/OrbitControls.js';
  const STL_URL = 'https://esm.sh/three@0.179.1/examples/jsm/loaders/STLLoader.js';
  const [THREE, orbitMod] = await Promise.all([import(THREE_URL), import(ORBIT_URL)]);
  const { OrbitControls } = orbitMod as any;
  const scene = new (THREE as any).Scene();
  scene.background = new (THREE as any).Color(0x020812);
  const camera = new (THREE as any).PerspectiveCamera(40, Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight), 0.1, 5000);
  camera.position.set(0, -130, 130);
  const renderer = new (THREE as any).WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
  container.replaceChildren(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  const ambient = new (THREE as any).AmbientLight(0xffffff, 1.35);
  scene.add(ambient);
  const dirA = new (THREE as any).DirectionalLight(0xffffff, 1.1);
  dirA.position.set(120, 120, 180);
  scene.add(dirA);
  const dirB = new (THREE as any).DirectionalLight(0x77aaff, 0.7);
  dirB.position.set(-90, -60, 120);
  scene.add(dirB);

  const rootGroup = new (THREE as any).Group();
  scene.add(rootGroup);

  const raycaster = new (THREE as any).Raycaster();
  const pointer = new (THREE as any).Vector2();
  const animate = () => {
    controls.update();
    renderer.render(scene, camera);
    runtime.animationHandle = requestAnimationFrame(animate);
  };
  const runtime: ThreeRuntime = { scene, camera, renderer, controls, rootGroup, animationHandle: null, raycaster, pointer };
  animate();
  window.addEventListener('resize', () => resizeThreeRuntime(runtime, container));
  (runtime as any).THREE_URLS = { THREE_URL, STL_URL };
  return runtime;
}

function resizeThreeRuntime(runtime: ThreeRuntime, container: HTMLDivElement): void {
  runtime.camera.aspect = Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight);
  runtime.camera.updateProjectionMatrix();
  runtime.renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
}

async function loadThreeCase(runtime: ThreeRuntime, casePayload: WorkstationCasePayload): Promise<void> {
  const THREE = await import((runtime as any).THREE_URLS.THREE_URL);
  const { STLLoader } = await import((runtime as any).THREE_URLS.STL_URL) as any;
  const loader = new STLLoader();
  runtime.rootGroup.clear();

  const materials = {
    root: new (THREE as any).MeshPhongMaterial({ color: 0x58b8ff, transparent: true, opacity: 0.9, shininess: 40 }),
    ascending: new (THREE as any).MeshPhongMaterial({ color: 0x7ef0c3, transparent: true, opacity: 0.82, shininess: 40 }),
    leaflets: new (THREE as any).MeshPhongMaterial({ color: 0xffd36b, transparent: true, opacity: 0.88, shininess: 30 }),
  };

  await Promise.all([
    maybeLoadStl(THREE, casePayload.links.aortic_root_stl, loader, materials.root, runtime.rootGroup),
    maybeLoadStl(THREE, casePayload.links.ascending_aorta_stl, loader, materials.ascending, runtime.rootGroup),
    maybeLoadStl(THREE, casePayload.links.leaflets_stl, loader, materials.leaflets, runtime.rootGroup),
  ]);

  if (Array.isArray(casePayload.centerline?.points_world) && casePayload.centerline!.points_world!.length > 1) {
    const points = casePayload.centerline!.points_world!.map((point) => new (THREE as any).Vector3(point[0], point[1], point[2]));
    const geometry = new (THREE as any).BufferGeometry().setFromPoints(points);
    const line = new (THREE as any).Line(geometry, new (THREE as any).LineBasicMaterial({ color: 0xffffff }));
    line.name = 'centerline';
    runtime.rootGroup.add(line);
  }

  const annulusPlane = casePayload.display_planes?.annulus;
  if (annulusPlane) runtime.rootGroup.add(buildPlaneMesh(THREE, annulusPlane, 18, 0xff7b89, 'annulus-plane'));
  const stjPlane = casePayload.display_planes?.stj;
  if (stjPlane) runtime.rootGroup.add(buildPlaneMesh(THREE, stjPlane, 18, 0x9f8cff, 'stj-plane'));

  const box = new (THREE as any).Box3().setFromObject(runtime.rootGroup);
  const center = box.isEmpty() ? new (THREE as any).Vector3(0, 0, 0) : box.getCenter(new (THREE as any).Vector3());
  const size = box.isEmpty() ? 120 : box.getSize(new (THREE as any).Vector3()).length();
  runtime.controls.target.copy(center);
  runtime.camera.position.set(center.x + size * 0.8, center.y - size * 0.9, center.z + size * 0.7);
  runtime.camera.lookAt(center);
  runtime.controls.update();
  updateThreePlaneHighlights();
}

async function maybeLoadStl(THREE: any, url: string | undefined, loader: any, material: any, group: any): Promise<void> {
  if (!url) return;
  const geometry = await loader.loadAsync(url);
  geometry.computeVertexNormals?.();
  const object = new THREE.Mesh(geometry, material.clone ? material.clone() : material);
  object.name = url;
  group.add(object);
}

function buildPlaneMesh(THREE: any, plane: PlaneDefinition, radius: number, color: number, name: string): any {
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
  if (existing) threeRuntime.rootGroup.remove(existing);
  if (!aux) return;
  import((threeRuntime as any).THREE_URLS.THREE_URL).then((THREE) => {
    const mesh = buildPlaneMesh(THREE as any, aux, 20, 0xffffff, 'aux-plane');
    mesh.material.opacity = 0.12;
    threeRuntime?.rootGroup.add(mesh);
  }).catch(() => void 0);
}

async function destroySession(): Promise<void> {
  if (session) {
    session.syncs.forEach((sync) => sync.destroy?.());
    try { ToolGroupManager.destroyToolGroup(session.toolGroupId); } catch {}
    try { session.renderingEngine.destroy(); } catch {}
    try { cache.removeVolumeLoadObject(session.volumeId); } catch {}
    try { cache.purgeCache(); } catch {}
    if (session.dicomImageIds.length) {
      try { cornerstoneDICOMImageLoader.wadouri.fileManager.purge(); } catch {}
    }
  }
  session = null;
}

function metricRowFromValue(label: string, key: string, value: unknown, contract: Record<string, unknown> | null): MetricRow | null {
  const numeric = readMetricValue(value);
  if (numeric === null && value == null) return null;
  const unit = inferUnitFromKey(key);
  return {
    label,
    value: numeric === null ? String(value) : `${numeric.toFixed(unit === 'mm²' ? 2 : 2)} ${unit}`.trim(),
    meta: contract ? formatContractMeta(contract) : '',
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

function formatQaLine(label: string, status: unknown, confidence: unknown): string {
  const conf = typeof confidence === 'number' ? ` · conf ${confidence.toFixed(2)}` : '';
  return `${escapeHtml(label)}: <span class="badge-${statusBadge(status)}">${escapeHtml(String(status || 'unknown'))}</span>${conf}`;
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

function setStatus(text: string): void {
  if (DOM.headerStatus) DOM.headerStatus.textContent = text;
  if (DOM.mprStatus) DOM.mprStatus.textContent = text;
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
  console.error(error);
  document.body.innerHTML = `
    <div class="error-screen">
      <div class="error-card">
        <h1>Workstation bootstrap failed</h1>
        <p>The MPR workstation could not initialize. This milestone keeps clinical measurements authoritative on the backend model, so frontend bootstrap failures must be visible instead of silently falling back.</p>
        <pre class="code-block">${escapeHtml(error instanceof Error ? error.stack || error.message : String(error))}</pre>
      </div>
    </div>
  `;
});
