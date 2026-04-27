import { createCaseStoreFromAssetFetcher, type AssetFetcherLike, type DefaultCaseStore } from "./defaultCaseStore";
import { buildAcceptanceReview } from "./acceptance";
import { resolveCapabilityState } from "./capabilities";
import { base64ToBytes, contentTypeForArtifact, pickObject, safeJsonParse } from "./files";
import { binaryResponse, jsonResponse, textResponse } from "./http";
import { resolvePipelineRun } from "./pipelineRun";

function pathToDownload(path: string): string {
  const parts = path.split("/");
  if (path.startsWith("artifacts/")) return `/default-case/${path}`;
  if (path.startsWith("meshes/")) return `/default-case/${path}`;
  if (path.startsWith("reports/")) return `/default-case/${path}`;
  if (path.startsWith("imaging_hidden/")) return `/default-case/${path}`;
  if (path.startsWith("qa/")) return `/default-case/${path}`;
  return `/api/cases/default_clinical_case/files/${parts.at(-1)}`;
}

function pathBasename(path: string): string {
  const parts = String(path || "").split("/");
  return parts.at(-1) || path;
}

function normalizeCaseId(manifest: Record<string, unknown>): string {
  const caseId = manifest.case_id;
  return typeof caseId === "string" && caseId.length ? caseId : "default_clinical_case";
}

function normalizeDisplayName(manifest: Record<string, unknown>): string | Record<string, unknown> {
  const displayName = manifest.display_name;
  if (typeof displayName === "string" && displayName.length) return displayName;
  if (displayName && typeof displayName === "object") return displayName as Record<string, unknown>;
  return "Default Clinical Case";
}

function hasIndexedFile(manifest: Record<string, unknown>, key: string): boolean {
  return readPathIndex(manifest, key) !== null;
}

function resolveArtifactName(manifest: Record<string, unknown>, rawName: string): string | null {
  const normalized = decodeURIComponent(rawName || "").trim();
  if (!normalized) return null;
  const candidates = normalized.endsWith(".json") ? [normalized, normalized.slice(0, -5)] : [normalized, `${normalized}.json`];
  const artifactEntries = groupEntries(manifest, "artifact_index");
  for (const candidate of candidates) {
    if (artifactEntries.some(([key, value]) => key === candidate || pathBasename(value) === candidate)) {
      return pathBasename(readPathIndex(manifest, candidate) || candidate);
    }
  }
  return null;
}

function resolveMeshName(manifest: Record<string, unknown>, rawName: string): string | null {
  const normalized = decodeURIComponent(rawName || "").trim();
  if (!normalized) return null;
  const candidates = normalized.endsWith(".stl") ? [normalized, normalized.slice(0, -4)] : [normalized, `${normalized}.stl`];
  const meshEntries = groupEntries(manifest, "mesh_index");
  for (const candidate of candidates) {
    if (meshEntries.some(([key, value]) => key === candidate || pathBasename(value) === candidate)) {
      return pathBasename(readPathIndex(manifest, candidate) || candidate);
    }
  }
  return null;
}

function readPathIndex(manifest: Record<string, unknown>, key: string): string | null {
  const groups = [
    pickObject(manifest.artifact_index),
    pickObject(manifest.mesh_index),
    pickObject(manifest.report_index),
    pickObject(manifest.imaging_index),
    pickObject(manifest.qa_index),
  ];
  for (const group of groups) {
    if (!group) continue;
    const value = group[key];
    if (typeof value === "string" && value.length) return value;
  }
  return null;
}

function groupEntries(manifest: Record<string, unknown>, key: string): Array<[string, string]> {
  const group = pickObject(manifest[key]);
  if (!group) return [];
  return Object.entries(group)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

const DOWNLOAD_LABELS: Record<string, string> = {
  case_manifest: "Case Manifest JSON",
  planning: "Planning JSON",
  centerline: "Centerline JSON",
  annulus_plane: "Annulus Plane JSON",
  aortic_root_model: "Digital Twin JSON",
  measurements: "Measurements JSON",
  leaflet_model: "Leaflet Model JSON",
  pears_model: "PEARS Model JSON",
  pears_coronary_windows: "PEARS Coronary Windows JSON",
  aortic_root_stl: "Aortic Root STL",
  ascending_aorta_stl: "Ascending Aorta STL",
  leaflets_stl: "Leaflets STL",
  annulus_ring_stl: "Annulus Ring STL",
  pears_outer_aorta_stl: "PEARS Aorta Proxy STL",
  pears_support_sleeve_stl: "PEARS Sleeve Preview STL",
  report_pdf: "Planning Report PDF",
  raw_ct: "Raw CT",
  quality_gates: "Quality Gates JSON",
  failure_flags: "Failure Flags JSON",
};

function labelForDownload(key: string): string {
  return DOWNLOAD_LABELS[key] || key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function toPoint3(value: unknown): [number, number, number] | null {
  if (Array.isArray(value) && value.length >= 3) {
    const coords = value.slice(0, 3).map((entry) => Number(entry));
    if (coords.every((entry) => Number.isFinite(entry))) {
      return [coords[0], coords[1], coords[2]];
    }
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const coords = [Number(record.x), Number(record.y), Number(record.z)];
    if (coords.every((entry) => Number.isFinite(entry))) {
      return [coords[0], coords[1], coords[2]];
    }
  }
  return null;
}

function distance3(a: [number, number, number] | null, b: [number, number, number] | null): number | null {
  if (!a || !b) return null;
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function readPlane(model: Record<string, unknown>, key: string) {
  const record = pickObject(model[key]);
  if (!record) return null;
  return {
    id: key,
    status: "available",
    confidence: pickObject(record.evidence)?.confidence ?? null,
    origin_world: record.origin_world || record.point_world || null,
    normal_world: record.normal_world || record.direction_world || null,
    ring_points_world: Array.isArray(record.ring_points_world) ? record.ring_points_world : null,
  };
}

function buildLinks(manifest: Record<string, unknown>): Record<string, string> {
  const links: Record<string, string> = {};
  for (const groupName of ["artifact_index", "mesh_index", "report_index", "imaging_index", "qa_index"]) {
    for (const [key, value] of groupEntries(manifest, groupName)) {
      links[key] = pathToDownload(value);
    }
  }
  links.summary = "/api/cases/default_clinical_case/summary";
  links.workstation = "/workstation/cases/default_clinical_case";
  return links;
}

function buildDownloads(manifest: Record<string, unknown>, links: Record<string, string>) {
  const artifactLinks = groupEntries(manifest, "artifact_index")
    .map(([key]) => (links[key] ? { label: labelForDownload(key), href: links[key] } : null))
    .filter(Boolean);
  const meshLinks = groupEntries(manifest, "mesh_index")
    .map(([key]) => (links[key] ? { label: labelForDownload(key), href: links[key] } : null))
    .filter(Boolean);
  const pdfPath = readPathIndex(manifest, "report_pdf");
  const rawPath = readPathIndex(manifest, "raw_ct");
  return {
    raw: rawPath && links.raw_ct ? { label: labelForDownload("raw_ct"), href: links.raw_ct } : null,
    json: artifactLinks,
    stl: meshLinks,
    pdf: pdfPath && links.report_pdf ? { label: labelForDownload("report_pdf"), href: links.report_pdf } : null,
  };
}

function buildQaFlags(capabilities: Record<string, unknown>, model: Record<string, unknown>) {
  return {
    centerline_available: Array.isArray(pickObject(model.centerline)?.points_world),
    annulus_plane_available: Boolean(pickObject(model.annulus_ring)?.origin_world),
    stj_plane_available: Boolean(pickObject(model.sinotubular_junction)?.origin_world),
    leaflet_summary_available: Array.isArray(model.leaflet_meshes),
    coronary_ostia_available: Boolean(pickObject(capabilities.coronary_ostia)?.available),
    cpr_available: Boolean(pickObject(capabilities.cpr)?.available),
    pears_geometry_available: Boolean(pickObject(capabilities.pears_geometry)?.available),
  };
}

function buildCenterlinePlane(centerline: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!centerline) return null;
  const points = Array.isArray(centerline.points_world) ? centerline.points_world : [];
  const tangents = Array.isArray(centerline.tangents_world) ? centerline.tangents_world : [];
  if (!points.length) return null;
  return {
    id: "centerline",
    status: pickObject(centerline.uncertainty)?.flag === "NONE" ? "available" : "warning",
    confidence: centerline.confidence ?? null,
    origin_world: points[0],
    normal_world: tangents[0] || null,
    source_index: 0,
  };
}

function buildLeafletGeometrySummary(leafletModel: Record<string, unknown>) {
  const leaflets = Array.isArray(leafletModel.leaflets) ? leafletModel.leaflets : [];
  return {
    legacy: false,
    source: "leaflet_model.json",
    reason: null,
    leaflets,
  };
}

function buildPearsGeometry(model: Record<string, unknown>, planning: Record<string, unknown>): Record<string, unknown> | null {
  const annulus = pickObject(model.annulus_ring);
  const stj = pickObject(model.sinotubular_junction);
  const coronary = pickObject(model.coronary_ostia);
  const pearsPlanning = pickObject(planning.pears);
  const externalRoot = pickObject(pearsPlanning?.external_root_geometry_status);
  const supportRegion = pickObject(pearsPlanning?.support_region_status);
  if (!annulus || !stj || !externalRoot || !supportRegion) return null;

  const annulusOrigin = toPoint3(annulus.origin_world);
  const stjOrigin = toPoint3(stj.origin_world);
  const rootSegment = distance3(annulusOrigin, stjOrigin);
  const supportLength = Number(pickObject(supportRegion.value)?.support_segment_length_mm || 0);
  const left = pickObject(coronary?.left);
  const right = pickObject(coronary?.right);

  return {
    geometry: {
      annulus: {
        max_diameter_mm: annulus.max_diameter_mm ?? annulus.equivalent_diameter_mm ?? null,
        equivalent_diameter_mm: annulus.equivalent_diameter_mm ?? null,
        confidence: pickObject(annulus.evidence)?.confidence ?? null,
      },
      stj: {
        max_diameter_mm: stj.max_diameter_mm ?? stj.equivalent_diameter_mm ?? null,
        diameter_mm: stj.equivalent_diameter_mm ?? stj.max_diameter_mm ?? null,
        confidence: pickObject(stj.evidence)?.confidence ?? null,
      },
      sinus: {
        max_diameter_mm: pickObject(externalRoot.value)?.reference_diameter_mm ?? null,
        confidence: pickObject(externalRoot.evidence)?.confidence ?? null,
      },
      sinus_height: {
        height_mm: rootSegment ?? null,
      },
      coronary_heights: {
        left: {
          height_mm: left?.height_mm ?? null,
          status: left?.status === "not_found" ? "not_measured" : left?.status || "unknown",
        },
        right: {
          height_mm: right?.height_mm ?? null,
          status: right?.status === "not_found" ? "not_measured" : right?.status || "unknown",
        },
      },
      ascending_max_diameter_mm: stj.max_diameter_mm ?? null,
    },
    eligibility: {
      status: "derived_preview",
      verdict: "Derived PEARS Preview",
      eligible: true,
      risk_level: "moderate",
      summary: "Derived from the showcase digital twin. Dedicated PEARS provider output is not yet available.",
      criteria: [
        { id: "sinus_diameter", label: "Sinus diameter", severity: "ok", met: true, value_mm: pickObject(externalRoot.value)?.reference_diameter_mm ?? null, icon: "✓", message: "Showcase sinus diameter captured from the digital twin." },
        { id: "stj_reference", label: "STJ reference", severity: "ok", met: true, value_mm: stj.equivalent_diameter_mm ?? stj.max_diameter_mm ?? null, icon: "✓", message: "STJ section available for support planning." },
        { id: "coronary_lca", label: "LCA", severity: "data_missing", met: null, value_mm: left?.height_mm ?? null, icon: "?", message: "Left coronary ostium not detected." },
        { id: "coronary_rca", label: "RCA", severity: "data_missing", met: null, value_mm: right?.height_mm ?? null, icon: "?", message: "Right coronary ostium not detected." },
      ],
      risk_flags: ["derived_from_showcase_root_model", "coronary_heights_missing"],
    },
    surgical_planning: {
      mesh_sizing: {
        sinus_mesh_diameter_mm: pickObject(externalRoot.value)?.reference_diameter_mm ? Number((Number(pickObject(externalRoot.value)?.reference_diameter_mm) * 0.95).toFixed(1)) : null,
        sinus_reference_mm: pickObject(externalRoot.value)?.reference_diameter_mm ?? null,
        stj_mesh_diameter_mm: stj.equivalent_diameter_mm ? Number((Number(stj.equivalent_diameter_mm) * 0.95).toFixed(1)) : null,
        stj_reference_mm: stj.equivalent_diameter_mm ?? stj.max_diameter_mm ?? null,
      },
      support_segment: {
        root_segment_mm: rootSegment ? Number(rootSegment.toFixed(1)) : null,
        ascending_segment_mm: rootSegment ? Number(Math.max(0, supportLength - rootSegment).toFixed(1)) : null,
        total_mm: supportLength || null,
      },
      coronary_windows: {},
    },
    data_quality: {
      annulus_confidence: pickObject(annulus.evidence)?.confidence ?? null,
      stj_confidence: pickObject(stj.evidence)?.confidence ?? null,
      sinus_confidence: pickObject(externalRoot.evidence)?.confidence ?? null,
      lca_confidence: pickObject(left?.evidence)?.confidence ?? null,
      rca_confidence: pickObject(right?.evidence)?.confidence ?? null,
    },
    module_version: "showcase_pears_preview_v1",
    references: ["PEARS_EXOVASC_LIT"],
  };
}

function readScalarMeasurementEnvelope(measurements: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return pickObject(measurements[key]);
}

function readScalarMeasurementValue(measurements: Record<string, unknown>, key: string): number | null {
  const envelope = readScalarMeasurementEnvelope(measurements, key);
  if (!envelope) return null;
  const raw = envelope.value;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function summarizePlanningSection(section: Record<string, unknown> | null): string {
  if (!section) return "unavailable";
  const entries = Object.entries(section).filter(([key]) => !key.endsWith("_metadata"));
  if (!entries.length) return "unavailable";
  let hasValue = false;
  let needsReview = false;
  for (const [, entry] of entries) {
    if (entry === null || entry === undefined || entry === "") {
      needsReview = true;
      continue;
    }
    if (typeof entry === "number" || typeof entry === "string" || typeof entry === "boolean") {
      hasValue = true;
      if (typeof entry === "boolean" && entry) needsReview = true;
      continue;
    }
    const record = pickObject(entry);
    if (!record) continue;
    if ("value" in record) {
      const value = record.value;
      if (value !== null && value !== undefined && value !== "") hasValue = true;
      else needsReview = true;
      const uncertainty = pickObject(record.uncertainty);
      const flag = typeof uncertainty?.flag === "string" ? uncertainty.flag : "NONE";
      if (flag !== "NONE") needsReview = true;
      if (uncertainty?.clinician_review_required === true) needsReview = true;
      continue;
    }
    const nestedValues = Object.entries(record).filter(([nestedKey]) => !nestedKey.endsWith("_metadata"));
    const nestedHasValue = nestedValues.some(([, nestedValue]) => nestedValue !== null && nestedValue !== undefined && nestedValue !== "");
    const nestedHasGap = nestedValues.some(([, nestedValue]) => nestedValue === null || nestedValue === undefined || nestedValue === "");
    if (nestedHasValue) hasValue = true;
    if (nestedHasGap) needsReview = true;
  }
  if (!hasValue) return "unavailable";
  return needsReview ? "review_required" : "available";
}

function derivePlanningSummary(planning: Record<string, unknown>): Record<string, unknown> {
  return {
    tavi_status: summarizePlanningSection(pickObject(planning.tavi)),
    vsrr_status: summarizePlanningSection(pickObject(planning.vsrr)),
    pears_status: summarizePlanningSection(pickObject(planning.pears)),
  };
}

function deriveClinicalGateOverview(qualityGates: Record<string, unknown>) {
  const reviewRequired: string[] = [];
  const notAssessable: string[] = [];
  const failed: string[] = [];
  for (const [key, value] of Object.entries(qualityGates)) {
    const gate = pickObject(value);
    const status = typeof gate?.status === "string" ? gate.status : "not_assessable";
    if (status === "failed") failed.push(key);
    else if (status === "not_assessable") notAssessable.push(key);
    else if (status === "review_required" || status === "borderline") reviewRequired.push(key);
  }
  return {
    review_required: reviewRequired,
    not_assessable: notAssessable,
    failed,
  };
}

function deriveUncertaintySummary(
  measurements: Record<string, unknown>,
  qualityGates: Record<string, unknown>,
  failureFlags: Record<string, unknown>,
): Record<string, unknown> {
  const failureItems = Array.isArray(failureFlags.items) ? failureFlags.items : [];
  const failingFields = failureItems
    .map((item) => pickObject(item))
    .filter(Boolean)
    .map((item) => typeof item?.field === "string" ? item.field : null)
    .filter((item): item is string => Boolean(item));

  const gateOverview = deriveClinicalGateOverview(qualityGates);
  const measurementReviewFields = Object.entries(measurements)
    .filter(([key]) => !key.startsWith("_"))
    .map(([key, value]) => ({ key, envelope: pickObject(value) }))
    .filter((entry) => entry.envelope)
    .filter((entry) => {
      const uncertainty = pickObject(entry.envelope?.uncertainty);
      return uncertainty?.clinician_review_required === true;
    })
    .map((entry) => entry.key);

  const clinicianReviewRequired =
    measurementReviewFields.length > 0
    || gateOverview.review_required.length > 0
    || gateOverview.not_assessable.length > 0
    || gateOverview.failed.length > 0;

  return {
    clinician_review_required: clinicianReviewRequired,
    failing_fields: [...new Set([...failingFields, ...measurementReviewFields])],
    clinical_gate_overview: gateOverview,
    pipeline_risk_flags: failureItems.length,
  };
}

function buildBootstrapWarnings(
  capabilities: Record<string, unknown>,
  failureFlags: Record<string, unknown>,
  measurements: Record<string, unknown>,
): string[] {
  const warnings = new Set<string>();
  if (!pickObject(capabilities.cpr)?.available) warnings.add("cpr_artifact_missing");
  const leftCoronary = readScalarMeasurementEnvelope(measurements, "coronary_height_left_mm");
  const rightCoronary = readScalarMeasurementEnvelope(measurements, "coronary_height_right_mm");
  if (leftCoronary?.value == null || rightCoronary?.value == null) warnings.add("coronary_heights_not_detected");
  for (const item of Array.isArray(failureFlags.items) ? failureFlags.items : []) {
    const record = pickObject(item);
    const reason = typeof record?.reason === "string" ? record.reason : null;
    if (reason) warnings.add(reason);
  }
  return [...warnings];
}

async function loadDefaultCaseArtifacts(store: DefaultCaseStore, buildVersion: string) {
  const manifest = await store.getCaseManifest();
  const model = safeJsonParse(await store.getDefaultCaseArtifact("aortic_root_model.json"));
  const measurements = safeJsonParse(await store.getDefaultCaseArtifact("measurements.json"));
  const planning = safeJsonParse(await store.getDefaultCaseArtifact("planning.json"));
  const leafletModel = safeJsonParse(await store.getDefaultCaseArtifact("leaflet_model.json"));
  const centerline = safeJsonParse(await store.getDefaultCaseArtifact("centerline.json"));
  const qualityGates = safeJsonParse(await store.getDefaultCaseQa("quality_gates.json"));
  const failureFlags = safeJsonParse(await store.getDefaultCaseQa("failure_flags.json"));
  const links = buildLinks(manifest);
  const downloads = buildDownloads(manifest, links);
  const capabilities = resolveCapabilityState({ manifest, model, leafletModel, planning });
  const pearsGeometry = buildPearsGeometry(model, planning);
  const qualityGatesSummary = qualityGates;
  const planningSummary = derivePlanningSummary(planning);
  const uncertaintySummary = deriveUncertaintySummary(measurements, qualityGates, failureFlags);
  const viewerBootstrap = {
    focus_world: pickObject(model.annulus_ring)?.origin_world || { x: 0, y: 0, z: 4 },
    aux_mode: "annulus",
    centerline_index: 2,
    runtime_requirements: {
      source_kind: "nifti",
      loader_kind: "cornerstone-nifti",
      supports_mpr: true,
      supports_aux_plane: true,
      supports_cpr: Boolean(pickObject(capabilities.cpr)?.available),
    },
    qa_flags: buildQaFlags(capabilities as unknown as Record<string, unknown>, model),
    bootstrap_warnings: buildBootstrapWarnings(capabilities as unknown as Record<string, unknown>, failureFlags, measurements),
  };
  const acceptanceReview = buildAcceptanceReview({
    case_role: manifest.case_role,
    capabilities,
    downloads,
    planning,
    quality_gates: qualityGates,
    quality_gates_summary: qualityGatesSummary,
    coronary_ostia_summary: pickObject(model.coronary_ostia),
    leaflet_geometry_summary: buildLeafletGeometrySummary(leafletModel),
    viewer_bootstrap: viewerBootstrap,
  });

  return {
    manifest,
    model,
    measurements,
    planning,
    leafletModel,
    centerline,
    qualityGates,
    qualityGatesSummary,
    failureFlags,
    links,
    downloads,
    capabilities,
    pearsGeometry,
    planningSummary,
    uncertaintySummary,
    viewerBootstrap,
    acceptanceReview,
    buildVersion,
  };
}

export async function buildDefaultCaseSummary(store: DefaultCaseStore, buildVersion: string) {
  const {
    manifest,
    downloads,
    capabilities,
    planningSummary,
    qualityGatesSummary,
    uncertaintySummary,
    links,
    acceptanceReview,
  } = await loadDefaultCaseArtifacts(store, buildVersion);
  return {
    id: manifest.case_id,
    job_id: manifest.case_id,
    case_id: manifest.case_id,
    display_name: manifest.display_name,
    case_role: manifest.case_role,
    placeholder: manifest.placeholder,
    not_real_cta: manifest.not_real_cta,
    build_version: buildVersion,
    capabilities,
    planning_summary: planningSummary,
    quality_gates_summary: qualityGatesSummary,
    uncertainty_summary: uncertaintySummary,
    downloads,
    acceptance_review: acceptanceReview,
    clinical_review: acceptanceReview,
    summary_source: "derived_default_case_bundle",
    links,
  };
}

export async function buildDefaultCaseList(store: DefaultCaseStore, buildVersion: string) {
  const { manifest, capabilities, planningSummary, qualityGatesSummary, links } = await loadDefaultCaseArtifacts(store, buildVersion);
  const caseId = normalizeCaseId(manifest);
  return {
    cases: [
      {
        id: caseId,
        case_id: caseId,
        display_name: normalizeDisplayName(manifest),
        case_role: Array.isArray(manifest.case_role) ? manifest.case_role : [],
        placeholder: manifest.placeholder ?? false,
        not_real_cta: manifest.not_real_cta ?? false,
        status: "completed",
        scan_date: manifest.scan_date ?? null,
        pipeline_version: manifest.pipeline_version ?? null,
        build_version: buildVersion,
        has_planning: hasIndexedFile(manifest, "planning"),
        has_measurements: hasIndexedFile(manifest, "measurements"),
        has_meshes: groupEntries(manifest, "mesh_index").length > 0,
        capabilities,
        planning_summary: planningSummary,
        quality_gates_summary: qualityGatesSummary,
        links,
      },
    ],
    total: 1,
  };
}

export async function buildDefaultCaseWorkstationPayload(store: DefaultCaseStore, buildVersion: string) {
  const {
    manifest,
    model,
    measurements,
    planning,
    leafletModel,
    centerline,
    qualityGates,
    qualityGatesSummary,
    failureFlags,
    links,
    downloads,
    capabilities,
    pearsGeometry,
    planningSummary,
    uncertaintySummary,
    viewerBootstrap,
    acceptanceReview,
  } = await loadDefaultCaseArtifacts(store, buildVersion);
  const rawVolumePath = readPathIndex(manifest, "raw_ct") || "imaging_hidden/ct_showcase_root_roi.nii.gz";
  return {
    build_version: buildVersion,
    case_id: manifest.case_id,
    display_name: manifest.display_name,
    case_role: manifest.case_role,
    placeholder: manifest.placeholder,
    not_real_cta: manifest.not_real_cta,
    job: { id: manifest.case_id, status: "succeeded", mode: "default_case_bundle" },
    study_meta: {
      id: manifest.case_id,
      source_dataset: typeof manifest.source_dataset === "string" ? manifest.source_dataset : "AVT-Dongyang-D1",
      phase: typeof manifest.phase === "string" ? manifest.phase : "real_pipeline_output",
    },
    pipeline_run: resolvePipelineRun(
      {
        inference_mode: "default_case_bundle",
        provider_runtime: "gpu_provider_win",
        pipeline_version: typeof manifest.pipeline_version === "string" ? manifest.pipeline_version : "aortic_geometry_pipeline_v3",
        build_version: buildVersion,
        status: "succeeded",
      },
      null,
      buildVersion,
    ),
    links,
    downloads,
    volume_source: {
      source_kind: "nifti",
      loader_kind: "cornerstone-nifti",
      signed_url: links.raw_ct,
      filename: pathBasename(rawVolumePath),
      content_type: "application/gzip",
    },
    display_planes: {
      annulus: readPlane(model, "annulus_ring"),
      stj: readPlane(model, "sinotubular_junction"),
      centerline: buildCenterlinePlane(centerline),
    },
    viewer_bootstrap: viewerBootstrap,
    capabilities,
    centerline,
    measurements,
    planning,
    aortic_root_model: model,
    pears_geometry: pearsGeometry,
    quality_gates: qualityGates,
    failure_flags: failureFlags,
    coronary_ostia_summary: pickObject(model.coronary_ostia),
    leaflet_geometry_summary: buildLeafletGeometrySummary(leafletModel),
    planning_summary: planningSummary,
    quality_gates_summary: qualityGatesSummary,
    uncertainty_summary: uncertaintySummary,
    acceptance_review: acceptanceReview,
    clinical_review: acceptanceReview,
    model_landmarks_summary: {
      annulus: { status: "available", confidence: pickObject(pickObject(model.annulus_ring)?.evidence)?.confidence || null },
      stj: { status: "available", confidence: pickObject(pickObject(model.sinotubular_junction)?.evidence)?.confidence || null },
      commissures: Array.isArray(model.commissures) ? model.commissures : [],
      coronary_ostia: pickObject(model.coronary_ostia),
      leaflet_status: Array.isArray(leafletModel.leaflets) ? leafletModel.leaflets : [],
    },
  };
}

export function createDefaultCaseStoreFromAssets(fetcher: AssetFetcherLike, digests: Record<string, string> = {}): DefaultCaseStore {
  return createCaseStoreFromAssetFetcher(fetcher, digests);
}

export async function handleDefaultCaseSummary(store: DefaultCaseStore, buildVersion: string): Promise<Response> {
  return jsonResponse(await buildDefaultCaseSummary(store, buildVersion));
}

export async function handleDefaultCaseList(store: DefaultCaseStore, buildVersion: string): Promise<Response> {
  return jsonResponse(await buildDefaultCaseList(store, buildVersion));
}

export async function handleDefaultCaseWorkstation(store: DefaultCaseStore, buildVersion: string): Promise<Response> {
  return jsonResponse(await buildDefaultCaseWorkstationPayload(store, buildVersion));
}

export async function handleDefaultCaseArtifact(
  store: DefaultCaseStore,
  buildVersion: string,
  name: string
): Promise<Response> {
  if (!name) return jsonResponse({ error: "missing_artifact_name" }, 400);
  if (name === "case_manifest.json") {
    const manifest = await store.getCaseManifest();
    return jsonResponse({
      ...manifest,
      build_version: buildVersion,
    });
  }
  const body = await store.getDefaultCaseArtifact(name);
  return textResponse(body, contentTypeForArtifact(name));
}

export async function handleCaseArtifactById(
  store: DefaultCaseStore,
  buildVersion: string,
  caseId: string,
  rawName: string,
): Promise<Response> {
  const manifest = await store.getCaseManifest();
  if (caseId !== normalizeCaseId(manifest)) return jsonResponse({ error: "case_not_found" }, 404);
  const name = resolveArtifactName(manifest, rawName);
  if (!name) return jsonResponse({ error: "artifact_not_found" }, 404);
  return handleDefaultCaseArtifact(store, buildVersion, name);
}

export async function handleDefaultCaseQa(store: DefaultCaseStore, name: string): Promise<Response> {
  if (!name) return jsonResponse({ error: "missing_qa_name" }, 400);
  const body = await store.getDefaultCaseQa(name);
  return textResponse(body, contentTypeForArtifact(name));
}

export async function handleDefaultCaseMesh(store: DefaultCaseStore, name: string): Promise<Response> {
  if (!name) return jsonResponse({ error: "missing_mesh_name" }, 400);
  const encoded = await store.getDefaultCaseMesh(name);
  return binaryResponse(base64ToBytes(encoded), contentTypeForArtifact(name));
}

export async function handleCaseMeshById(
  store: DefaultCaseStore,
  caseId: string,
  rawName: string,
): Promise<Response> {
  const manifest = await store.getCaseManifest();
  if (caseId !== normalizeCaseId(manifest)) return jsonResponse({ error: "case_not_found" }, 404);
  const name = resolveMeshName(manifest, rawName);
  if (!name) return jsonResponse({ error: "mesh_not_found" }, 404);
  return handleDefaultCaseMesh(store, name);
}

export async function handleDefaultCaseReport(store: DefaultCaseStore, name = "report.pdf"): Promise<Response> {
  const encoded = await store.getDefaultCaseReport(name);
  return binaryResponse(base64ToBytes(encoded), contentTypeForArtifact(name));
}

export async function handleDefaultCaseImaging(store: DefaultCaseStore, name = "ct_showcase_root_roi.nii.gz"): Promise<Response> {
  const encoded = await store.getDefaultCaseVolume(name);
  return binaryResponse(base64ToBytes(encoded), contentTypeForArtifact(name));
}
