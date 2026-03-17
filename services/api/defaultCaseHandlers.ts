import { createCaseStoreFromBundle, type DefaultCaseStore } from "./defaultCaseStore";
import { resolveCapabilityState } from "./capabilities";
import { base64ToBytes, contentTypeForArtifact, pickObject, safeJsonParse } from "./files";
import { binaryResponse, jsonResponse, textResponse } from "./http";
import { resolvePipelineRun } from "./pipelineRun";
import type { DefaultCaseBundle } from "./contracts";

function pathToDownload(path: string): string {
  const parts = path.split("/");
  if (path.startsWith("artifacts/")) return `/api/cases/default_clinical_case/artifacts/${parts.at(-1)}`;
  if (path.startsWith("meshes/")) return `/api/cases/default_clinical_case/meshes/${parts.at(-1)}`;
  if (path.startsWith("reports/")) return `/api/cases/default_clinical_case/reports/${parts.at(-1)}`;
  if (path.startsWith("imaging_hidden/")) return `/api/cases/default_clinical_case/imaging/${parts.at(-1)}`;
  if (path.startsWith("qa/")) return `/api/cases/default_clinical_case/qa/${parts.at(-1)}`;
  return `/api/cases/default_clinical_case/files/${parts.at(-1)}`;
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
  const artifactIndex = pickObject(manifest.artifact_index) || {};
  const meshIndex = pickObject(manifest.mesh_index) || {};
  const reportIndex = pickObject(manifest.report_index) || {};
  const qaIndex = pickObject(manifest.qa_index) || {};
  const links: Record<string, string> = {};
  for (const [key, value] of Object.entries(artifactIndex)) {
    if (typeof value === "string") links[key] = pathToDownload(value);
  }
  for (const [key, value] of Object.entries(meshIndex)) {
    if (typeof value === "string") links[key] = pathToDownload(value);
  }
  for (const [key, value] of Object.entries(reportIndex)) {
    if (typeof value === "string") links[key] = pathToDownload(value);
  }
  for (const [key, value] of Object.entries(qaIndex)) {
    if (typeof value === "string") links[key] = pathToDownload(value);
  }
  links.raw_ct = "/api/cases/default_clinical_case/imaging/ct_placeholder.nii.gz";
  links.summary = "/api/cases/default_clinical_case/summary";
  links.workstation = "/workstation/cases/default_clinical_case";
  return links;
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

export async function buildDefaultCaseSummary(store: DefaultCaseStore, buildVersion: string) {
  const manifest = await store.getCaseManifest();
  const links = buildLinks(manifest);
  return {
    id: manifest.case_id,
    job_id: manifest.case_id,
    case_id: manifest.case_id,
    display_name: manifest.display_name,
    case_role: manifest.case_role,
    placeholder: manifest.placeholder,
    not_real_cta: manifest.not_real_cta,
    build_version: buildVersion,
    capabilities: manifest.capabilities,
    planning_summary: manifest.planning_summary,
    quality_gates_summary: manifest.quality_gates_summary,
    uncertainty_summary: manifest.uncertainty_summary,
    summary_source: "case_manifest",
    links,
  };
}

export async function buildDefaultCaseWorkstationPayload(store: DefaultCaseStore, buildVersion: string) {
  const manifest = await store.getCaseManifest();
  const model = safeJsonParse(await store.getDefaultCaseArtifact("aortic_root_model.json"));
  const measurements = safeJsonParse(await store.getDefaultCaseArtifact("measurements.json"));
  const planning = safeJsonParse(await store.getDefaultCaseArtifact("planning.json"));
  const leafletModel = safeJsonParse(await store.getDefaultCaseArtifact("leaflet_model.json"));
  const centerline = safeJsonParse(await store.getDefaultCaseArtifact("centerline.json"));
  const qualityGates = safeJsonParse(await store.getDefaultCaseQa("quality_gates.json"));
  const failureFlags = safeJsonParse(await store.getDefaultCaseQa("failure_flags.json"));
  const links = buildLinks(manifest);
  const capabilities = resolveCapabilityState({ manifest, model, leafletModel, planning });
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
      source_dataset: "default_showcase_placeholder",
      phase: "systolic_placeholder",
    },
    pipeline_run: resolvePipelineRun(null, null, buildVersion),
    links,
    downloads: {
      json: [
        links.case_manifest,
        links.measurements,
        links.aortic_root_model,
        links.centerline,
        links.leaflet_model,
        links.planning,
        links.quality_gates,
        links.failure_flags,
      ].filter(Boolean),
      stl: [links.aortic_root, links.annulus_ring, links.leaflet_L, links.leaflet_N, links.leaflet_R].filter(Boolean),
      pdf: links.report_pdf,
    },
    volume_source: {
      source_kind: "nifti",
      loader_kind: "cornerstone-nifti",
      signed_url: links.raw_ct,
      filename: "ct_placeholder.nii.gz",
      content_type: "application/gzip",
    },
    display_planes: {
      annulus: readPlane(model, "annulus_ring"),
      stj: readPlane(model, "sinotubular_junction"),
      centerline: readPlane(model, "annulus_ring"),
    },
    viewer_bootstrap: {
      focus_world: pickObject(model.annulus_ring)?.origin_world || { x: 0, y: 0, z: 4 },
      aux_mode: "annulus",
      centerline_index: 2,
      runtime_requirements: {
        source_kind: "nifti",
        loader_kind: "cornerstone-nifti",
        supports_mpr: true,
        supports_aux_plane: true,
        supports_cpr: false,
      },
      qa_flags: buildQaFlags(capabilities as unknown as Record<string, unknown>, model),
      bootstrap_warnings: [
        "placeholder_case_only",
        "cpr_artifact_missing",
        "leaflet_geometry_legacy_only",
      ],
    },
    capabilities,
    centerline,
    measurements,
    planning,
    aortic_root_model: model,
    pears_geometry: null,
    quality_gates: qualityGates,
    failure_flags: failureFlags,
    coronary_ostia_summary: pickObject(model.coronary_ostia),
    leaflet_geometry_summary: {
      legacy: true,
      source: "leaflet_model.json",
      leaflets: Array.isArray(leafletModel.leaflets) ? leafletModel.leaflets : [],
    },
    planning_summary: manifest.planning_summary,
    uncertainty_summary: manifest.uncertainty_summary,
    model_landmarks_summary: {
      annulus: { status: "available", confidence: pickObject(pickObject(model.annulus_ring)?.evidence)?.confidence || null },
      stj: { status: "available", confidence: pickObject(pickObject(model.sinotubular_junction)?.evidence)?.confidence || null },
      commissures: Array.isArray(model.commissures) ? model.commissures : [],
      coronary_ostia: pickObject(model.coronary_ostia),
      leaflet_status: Array.isArray(leafletModel.leaflets) ? leafletModel.leaflets : [],
    },
  };
}

export function createDefaultCaseStoreFromBundle(bundle: DefaultCaseBundle): DefaultCaseStore {
  return createCaseStoreFromBundle(bundle);
}

export async function handleDefaultCaseSummary(store: DefaultCaseStore, buildVersion: string): Promise<Response> {
  return jsonResponse(await buildDefaultCaseSummary(store, buildVersion));
}

export async function handleDefaultCaseWorkstation(store: DefaultCaseStore, buildVersion: string): Promise<Response> {
  return jsonResponse(await buildDefaultCaseWorkstationPayload(store, buildVersion));
}

export async function handleDefaultCaseArtifact(
  store: DefaultCaseStore,
  _buildVersion: string,
  name: string
): Promise<Response> {
  if (!name) return jsonResponse({ error: "missing_artifact_name" }, 400);
  if (name === "case_manifest.json") {
    return jsonResponse(await store.getCaseManifest());
  }
  const body = await store.getDefaultCaseArtifact(name);
  return textResponse(body, contentTypeForArtifact(name));
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

export async function handleDefaultCaseReport(store: DefaultCaseStore, name = "report.pdf"): Promise<Response> {
  const encoded = await store.getDefaultCaseReport(name);
  return binaryResponse(base64ToBytes(encoded), contentTypeForArtifact(name));
}

export async function handleDefaultCaseImaging(store: DefaultCaseStore, name = "ct_placeholder.nii.gz"): Promise<Response> {
  const encoded = await store.getDefaultCaseVolume(name);
  return binaryResponse(base64ToBytes(encoded), contentTypeForArtifact(name));
}
