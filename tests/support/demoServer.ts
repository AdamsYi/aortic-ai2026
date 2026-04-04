import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import {
  buildDefaultCaseSummary,
  buildDefaultCaseWorkstationPayload,
  handleDefaultCaseArtifact,
  handleDefaultCaseImaging,
  handleDefaultCaseMesh,
  handleDefaultCaseQa,
  handleDefaultCaseReport,
  handleDefaultCaseSummary,
  handleDefaultCaseWorkstation,
} from "../../services/api/defaultCaseHandlers";
import { buildAcceptanceReview } from "../../services/api/acceptance";
import { createCaseStoreFromFs } from "../../services/api/defaultCaseStore.node";
import {
  WORKSTATION_APP_PATH,
  WORKSTATION_BUILD_VERSION,
  WORKSTATION_DICOM_WORKER_PATH,
  WORKSTATION_STYLE_PATH,
} from "../../src/generated/workstationAssets";

const port = Number(process.env.PORT || 4173);
const buildVersion = String(WORKSTATION_BUILD_VERSION || "dev");
const store = createCaseStoreFromFs();
const LATEST_CASE_ID = "latest_case_fixture";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const distRoot = path.join(repoRoot, "dist");
const annotationJobs = new Map<string, { studyId: string; createdAt: number }>();

async function readDistFile(assetPath: string, encoding?: BufferEncoding) {
  const normalized = assetPath.replace(/^\//, "");
  const primaryPath = path.join(distRoot, normalized);
  try {
    return await readFile(primaryPath, encoding as BufferEncoding | undefined);
  } catch (error) {
    if (
      normalized.includes("default-case/imaging_hidden/")
      && (normalized.endsWith(".nii.gz") || normalized.endsWith(".nii"))
    ) {
      const fallbackPath = path.join(distRoot, `${normalized}.bin`);
      return readFile(fallbackPath, encoding as BufferEncoding | undefined);
    }
    throw error;
  }
}

function renderDemoHtml(): string {
  const cssHref = `${WORKSTATION_STYLE_PATH}?v=${buildVersion}`;
  const jsSrc = `${WORKSTATION_APP_PATH}?v=${buildVersion}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="aortic-build-version" content="${buildVersion}" />
  <title>AorticAI Structural Heart Workstation</title>
  <link rel="stylesheet" href="${cssHref}" />
</head>
<body>
  <style>
    body { background: #080c12; color: #f1f5f9; margin: 0; font-family: system-ui, sans-serif; }
    #pre-load { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 16px; }
    .spin { width: 40px; height: 40px; border: 3px solid #1e2738; border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
  <div id="pre-load">
    <div class="spin"></div>
    <div style="font-size:14px;color:#8b9fc5">AorticAI — Loading workstation...</div>
  </div>
  <div id="app"></div>
  <script>window.__AORTIC_BUILD_VERSION__=${JSON.stringify(buildVersion)};</script>
  <script type="module" src="${jsSrc}"></script>
</body>
</html>`;
}

async function writeFetchResponse(nodeRes: http.ServerResponse, response: Response) {
  nodeRes.statusCode = response.status;
  response.headers.forEach((value, key) => nodeRes.setHeader(key, value));
  const body = Buffer.from(await response.arrayBuffer());
  nodeRes.end(body);
}

async function buildLatestCaseFixtureSummary() {
  const workstation = await buildLatestCaseFixtureWorkstation();
  return {
    id: LATEST_CASE_ID,
    job_id: LATEST_CASE_ID,
    case_id: LATEST_CASE_ID,
    case_role: ["latest", "derived_result"],
    display_name: {
      "zh-CN": "最新真实病例",
      en: "Latest Real Case",
    },
    summary_source: "latest_case_fixture",
    build_version: buildVersion,
    display_ready: true,
    completion_state: "display_ready",
    missing_requirements: [],
    downloads: workstation.downloads,
    planning_summary: workstation.planning_summary,
    acceptance_review: workstation.acceptance_review,
    clinical_review: workstation.clinical_review || workstation.acceptance_review,
  };
}

async function buildLatestCaseFixtureWorkstation() {
  const workstation = await buildDefaultCaseWorkstationPayload(store, buildVersion);
  const payload = {
    ...workstation,
    case_id: LATEST_CASE_ID,
    display_ready: true,
    completion_state: "display_ready",
    missing_requirements: [],
    display_name: {
      "zh-CN": "最新真实病例",
      en: "Latest Real Case",
    },
    case_role: ["latest", "derived_result"],
    job: { ...(workstation.job || {}), id: LATEST_CASE_ID, status: "succeeded", mode: "annotation_complete" },
    study_meta: {
      ...(workstation.study_meta || {}),
      id: LATEST_CASE_ID,
      source_dataset: "latest-real-case-fixture",
      phase: "processed_root_case",
    },
    pipeline_run: {
      ...(workstation.pipeline_run || {}),
      source_mode: "stored",
      inferred: false,
      inference_mode: "segmentation_v1",
      provider_target: "mock-demo-provider",
      provider_runtime: "demo-fixture",
      pipeline_version: "aortic_geometry_pipeline_v3",
    },
    data_source: "real_ct_pipeline_output",
  };
  return {
    ...payload,
    acceptance_review: buildAcceptanceReview({
      pipeline_run: payload.pipeline_run,
      viewer_bootstrap: payload.viewer_bootstrap,
      capabilities: payload.capabilities,
      downloads: payload.downloads,
      planning: payload.planning,
      quality_gates_summary: payload.quality_gates_summary,
      coronary_ostia_summary: payload.coronary_ostia_summary,
      leaflet_geometry_summary: payload.leaflet_geometry_summary,
    }),
    clinical_review: buildAcceptanceReview({
      pipeline_run: payload.pipeline_run,
      viewer_bootstrap: payload.viewer_bootstrap,
      capabilities: payload.capabilities,
      downloads: payload.downloads,
      planning: payload.planning,
      quality_gates_summary: payload.quality_gates_summary,
      coronary_ostia_summary: payload.coronary_ostia_summary,
      leaflet_geometry_summary: payload.leaflet_geometry_summary,
    }),
  };
}

async function buildAnnotatedLatestCaseWorkstation(jobId: string, studyId: string) {
  const workstation = await buildDefaultCaseWorkstationPayload(store, buildVersion);
  const payload = {
    ...workstation,
    case_id: jobId,
    display_name: {
      "zh-CN": "最新病例自动标注结果",
      en: "Latest Case Auto Annotation",
    },
    case_role: ["latest", "annotated"],
    job: { ...(workstation.job || {}), id: jobId, status: "succeeded", mode: "annotation_job" },
    study_meta: {
      ...(workstation.study_meta || {}),
      id: studyId,
      source_dataset: "latest-case-fixture",
      phase: "annotated_root_case",
    },
    pipeline_run: {
      ...(workstation.pipeline_run || {}),
      source_mode: "stored",
      inferred: false,
      inference_mode: "segmentation_v1",
      provider_target: "mock-demo-provider",
      provider_runtime: "demo-fixture",
      pipeline_version: "aorticai-root-coronary-leaflet-v1",
    },
  };
  return {
    ...payload,
    acceptance_review: buildAcceptanceReview({
      pipeline_run: payload.pipeline_run,
      viewer_bootstrap: payload.viewer_bootstrap,
      capabilities: payload.capabilities,
      downloads: payload.downloads,
      planning: payload.planning,
      quality_gates_summary: payload.quality_gates_summary,
      coronary_ostia_summary: payload.coronary_ostia_summary,
      leaflet_geometry_summary: payload.leaflet_geometry_summary,
    }),
    clinical_review: buildAcceptanceReview({
      pipeline_run: payload.pipeline_run,
      viewer_bootstrap: payload.viewer_bootstrap,
      capabilities: payload.capabilities,
      downloads: payload.downloads,
      planning: payload.planning,
      quality_gates_summary: payload.quality_gates_summary,
      coronary_ostia_summary: payload.coronary_ostia_summary,
      leaflet_geometry_summary: payload.leaflet_geometry_summary,
    }),
  };
}

function buildJobStatus(jobId: string) {
  const job = annotationJobs.get(jobId);
  if (!job) return null;
  const elapsed = Date.now() - job.createdAt;
  const status = elapsed < 600 ? "queued" : elapsed < 1600 ? "running" : "succeeded";
  return {
    id: jobId,
    study_id: job.studyId,
    status,
    job_type: "segmentation_v1",
    model_tag: "aorticai-root-coronary-leaflet-v1",
  };
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  const path = requestUrl.pathname;

  if (path === "/version") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ build_version: buildVersion }));
    return;
  }

  if (path === "/health") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok: true, build_version: buildVersion }));
    return;
  }

  if (path === WORKSTATION_STYLE_PATH) {
    res.setHeader("content-type", "text/css; charset=utf-8");
    res.end(await readDistFile(path, "utf8"));
    return;
  }

  if (path === WORKSTATION_APP_PATH) {
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.end(await readDistFile(path, "utf8"));
    return;
  }

  if (path === WORKSTATION_DICOM_WORKER_PATH) {
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.end(await readDistFile(path, "utf8"));
    return;
  }

  if (path.startsWith("/default-case/")) {
    const file = await readDistFile(path);
    if (path.endsWith(".json")) res.setHeader("content-type", "application/json; charset=utf-8");
    else if (path.endsWith(".stl")) res.setHeader("content-type", "model/stl");
    else if (path.endsWith(".pdf")) res.setHeader("content-type", "application/pdf");
    else if (path.endsWith(".nii.gz")) res.setHeader("content-type", "application/gzip");
    res.end(file);
    return;
  }

  if (path === "/favicon.ico") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (path === "/demo" || path === "/demo/showcase") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(renderDemoHtml());
    return;
  }

  if (path === "/demo/latest-case") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(await buildLatestCaseFixtureSummary()));
    return;
  }

  if (path === "/providers/inference-health") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({
      ok: true,
      reachable: true,
      provider_url: "https://mock-provider.local/infer",
      health_url: "https://mock-provider.local/health",
      status: 200,
      code: "ok",
      message: "Mock provider is reachable.",
    }));
    return;
  }

  if ((path === "/jobs" || path === "/api/jobs") && req.method === "POST") {
    const raw = await new Promise<string>((resolve, reject) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
    const payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const studyId = typeof payload.study_id === "string" && payload.study_id.trim() ? payload.study_id.trim() : LATEST_CASE_ID;
    const jobId = `annot-${Date.now()}`;
    annotationJobs.set(jobId, { studyId, createdAt: Date.now() });
    res.statusCode = 201;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ job_id: jobId, status: "queued" }));
    return;
  }

  if ((path.startsWith("/jobs/") || path.startsWith("/api/jobs/")) && req.method === "GET" && !path.includes("/artifacts/")) {
    const segments = path.split("/").filter(Boolean);
    const jobsIndex = segments.indexOf("jobs");
    const jobId = jobsIndex >= 0 ? (segments[jobsIndex + 1] || "") : "";
    const payload = buildJobStatus(jobId);
    if (!payload) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "job_not_found" }));
      return;
    }
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(payload));
    return;
  }

  if (path === "/api/cases/default_clinical_case/summary") {
    await writeFetchResponse(res, await handleDefaultCaseSummary(store, buildVersion));
    return;
  }

  if (path === "/workstation/cases/default_clinical_case") {
    await writeFetchResponse(res, await handleDefaultCaseWorkstation(store, buildVersion));
    return;
  }

  if (path === `/workstation/cases/${LATEST_CASE_ID}`) {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(await buildLatestCaseFixtureWorkstation()));
    return;
  }

  if (path.startsWith("/workstation/cases/")) {
    const jobId = path.split("/")[3] || "";
    const annotationJob = annotationJobs.get(jobId);
    if (annotationJob) {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(await buildAnnotatedLatestCaseWorkstation(jobId, annotationJob.studyId)));
      return;
    }
  }

  if (path.startsWith("/api/cases/default_clinical_case/artifacts/")) {
    const rawName = path.split("/").pop() || "";
    const aliasMap: Record<string, string> = {
      case_manifest: "case_manifest.json",
      measurements: "measurements.json",
      planning: "planning.json",
      centerline: "centerline.json",
      annulus_plane: "annulus_plane.json",
      aortic_root_model: "aortic_root_model.json",
      leaflet_model: "leaflet_model.json",
    };
    await writeFetchResponse(res, await handleDefaultCaseArtifact(store, buildVersion, aliasMap[rawName] || rawName));
    return;
  }

  if (path.startsWith("/api/cases/default_clinical_case/meshes/")) {
    await writeFetchResponse(res, await handleDefaultCaseMesh(store, path.split("/").pop() || ""));
    return;
  }

  if (path.startsWith("/api/cases/default_clinical_case/reports/")) {
    await writeFetchResponse(res, await handleDefaultCaseReport(store, path.split("/").pop() || "report.pdf"));
    return;
  }

  if (path.startsWith("/api/cases/default_clinical_case/imaging/")) {
    await writeFetchResponse(res, await handleDefaultCaseImaging(store, path.split("/").pop() || "ct_showcase_root_roi.nii.gz"));
    return;
  }

  if (path.startsWith("/api/cases/default_clinical_case/qa/")) {
    await writeFetchResponse(res, await handleDefaultCaseQa(store, path.split("/").pop() || ""));
    return;
  }

  res.statusCode = 404;
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`AorticAI demo server listening on http://127.0.0.1:${port}`);
});
