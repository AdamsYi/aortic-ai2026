import http from "node:http";
import { URL } from "node:url";
import {
  WORKSTATION_APP_JS,
  WORKSTATION_BUILD_VERSION,
  WORKSTATION_DICOM_WORKER_JS,
  WORKSTATION_STYLE_CSS,
} from "../../src/generated/workstationAssets";
import { DEFAULT_CASE_BUNDLE } from "../../src/generated/defaultCaseBundle";
import {
  createDefaultCaseStoreFromBundle,
  handleDefaultCaseArtifact,
  handleDefaultCaseImaging,
  handleDefaultCaseMesh,
  handleDefaultCaseQa,
  handleDefaultCaseReport,
  handleDefaultCaseSummary,
  handleDefaultCaseWorkstation,
} from "../../services/api/defaultCaseHandlers";

const port = Number(process.env.PORT || 4173);
const buildVersion = String(WORKSTATION_BUILD_VERSION || "dev");
const store = createDefaultCaseStoreFromBundle(DEFAULT_CASE_BUNDLE);

function renderDemoHtml(): string {
  const cssHref = `/assets/style.${buildVersion}.css?v=${buildVersion}`;
  const jsSrc = `/assets/app.${buildVersion}.js?v=${buildVersion}`;
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

  if (path === `/assets/style.${buildVersion}.css`) {
    res.setHeader("content-type", "text/css; charset=utf-8");
    res.end(WORKSTATION_STYLE_CSS);
    return;
  }

  if (path === `/assets/app.${buildVersion}.js`) {
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.end(WORKSTATION_APP_JS);
    return;
  }

  if (path === `/assets/dicom-zip-worker.${buildVersion}.js`) {
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.end(WORKSTATION_DICOM_WORKER_JS);
    return;
  }

  if (path === "/demo") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(renderDemoHtml());
    return;
  }

  if (path === "/demo/latest-case") {
    await writeFetchResponse(res, await handleDefaultCaseSummary(store, buildVersion));
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

  if (path.startsWith("/api/cases/default_clinical_case/artifacts/")) {
    await writeFetchResponse(res, await handleDefaultCaseArtifact(store, buildVersion, path.split("/").pop() || ""));
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
    await writeFetchResponse(res, await handleDefaultCaseImaging(store, path.split("/").pop() || "ct_placeholder.nii.gz"));
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
