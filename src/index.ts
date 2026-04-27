import {
  WORKSTATION_APP_PATH,
  WORKSTATION_APP_SHA256,
  WORKSTATION_ASSET_DIGEST,
  WORKSTATION_BUILD_VERSION,
  WORKSTATION_DICOM_WORKER_PATH,
  WORKSTATION_DICOM_WORKER_SHA256,
  WORKSTATION_STYLE_PATH,
  WORKSTATION_STYLE_SHA256,
} from "./generated/workstationAssets";
import {
  DEFAULT_CASE_DIGEST,
  DEFAULT_CASE_FILE_DIGESTS,
} from "./generated/defaultCaseBundle";
import {
  createDefaultCaseStoreFromAssets,
  handleCaseArtifactById,
  handleCaseMeshById,
  handleDefaultCaseList,
  handleDefaultCaseArtifact,
  handleDefaultCaseImaging,
  handleDefaultCaseMesh,
  handleDefaultCaseQa,
  handleDefaultCaseReport,
  handleDefaultCaseSummary,
  handleDefaultCaseWorkstation,
} from "../services/api/defaultCaseHandlers";
import { buildAcceptanceReview } from "../services/api/acceptance";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  R2_RAW: R2Bucket;
  R2_MASK: R2Bucket;
  SEG_QUEUE: Queue;
  ENVIRONMENT?: string;
  UPLOAD_URL_TTL_SECONDS: string;
  INFERENCE_MODE?: string;
  INFERENCE_WEBHOOK_TIMEOUT_MS?: string;
  INFERENCE_MAX_INPUT_BYTES?: string;
  INFERENCE_SKIP_SEGMENTATION?: string;
  PROVIDER_URL?: string;
  PROVIDER_HEALTH_URL?: string;
  PROVIDER_SECRET?: string;
  API_BASE_URL?: string;
  ARTIFACT_LINK_SECRET?: string;
  ARTIFACT_LINK_TTL_SECONDS?: string;
  ANNOTATION_PASSWORD?: string;
  ANNOTATION_TOKEN_TTL_SECONDS?: string;
}

type JobStatus = "queued" | "running" | "succeeded" | "failed";

type InferenceMode = "mock" | "webhook";

interface SegQueuePayload {
  job_id: string;
  study_id: string;
  image_key: string;
  patient_id?: string | null;
  requested_at: string;
}

interface CallbackMetric {
  name: string;
  value: number;
  unit?: string;
}

interface CallbackArtifact {
  artifact_type?: string;
  filename?: string;
  content_type?: string;
  base64?: string;
}

interface InferenceCallbackPayload {
  job_id: string;
  status: string;
  provider_job_id?: string;
  error_message?: string;
  result_case_id?: string;
  result_json?: Record<string, unknown>;
  mask_base64?: string;
  mask_filename?: string;
  mask_content_type?: string;
  artifacts?: CallbackArtifact[];
  metrics?: CallbackMetric[];
}

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0, s-maxage=0",
  "pragma": "no-cache",
  "expires": "0",
  "cdn-cache-control": "no-store",
  "cloudflare-cdn-cache-control": "no-store",
  "surrogate-control": "no-store",
};

const FALLBACK_BUILD_VERSION = "dev-unset";
const DEFAULT_SIGNED_LINK_TTL_SECONDS = 3600;
const DEFAULT_CASE_ID = "default_clinical_case";
const PRIMARY_REAL_CASE_ID = "mao_mianqiang_preop";

function getBuildVersion(): string {
  const raw = String(WORKSTATION_BUILD_VERSION || "").trim();
  return raw || FALLBACK_BUILD_VERSION;
}

function getLegacyEnvBuildVersion(env?: Env): string | null {
  const candidate = env && "BUILD_VERSION" in env ? String((env as Env & { BUILD_VERSION?: string }).BUILD_VERSION || "").trim() : "";
  return candidate || null;
}

function getWorkstationAssetHashes(): Record<string, string> {
  return {
    asset_digest: String(WORKSTATION_ASSET_DIGEST || "").trim(),
    app_sha256: String(WORKSTATION_APP_SHA256 || "").trim(),
    style_sha256: String(WORKSTATION_STYLE_SHA256 || "").trim(),
    dicom_worker_sha256: String(WORKSTATION_DICOM_WORKER_SHA256 || "").trim(),
    default_case_digest: String(DEFAULT_CASE_DIGEST || "").trim(),
  };
}

function getDefaultCaseStore(env: Env, request: Request) {
  const assetOrigin = new URL(request.url).origin;
  return createDefaultCaseStoreFromAssets(
    {
      fetch(input, init) {
        const target = input instanceof Request ? new URL(input.url, assetOrigin) : new URL(String(input), assetOrigin);
        return env.ASSETS.fetch(new Request(target.toString(), init));
      },
    },
    DEFAULT_CASE_FILE_DIGESTS
  );
}

function getArtifactLinkSecret(env?: Env): string {
  return String(env?.ARTIFACT_LINK_SECRET || "").trim();
}

function getArtifactLinkTtlSeconds(env?: Env): number {
  return parsePositiveInt(env?.ARTIFACT_LINK_TTL_SECONDS, DEFAULT_SIGNED_LINK_TTL_SECONDS);
}

function getAnnotationPassword(env?: Env): string {
  return String(env?.ANNOTATION_PASSWORD || "").trim();
}

function getAnnotationTokenTtlSeconds(env?: Env): number {
  return parsePositiveInt(env?.ANNOTATION_TOKEN_TTL_SECONDS, 3600);
}

function getAnnotationTokenSecret(env?: Env): string {
  // Prefer a dedicated secret; fall back to ARTIFACT_LINK_SECRET so deployments
  // that only set one secret still get a distinct signature (passphrase-prefixed).
  const dedicated = getArtifactLinkSecret(env);
  return dedicated ? `annotation:${dedicated}` : "";
}

function getInferenceHealthUrl(env?: Env): string | null {
  const explicitHealth = String(env?.PROVIDER_HEALTH_URL || "").trim();
  if (explicitHealth) return explicitHealth;
  const raw = String(env?.PROVIDER_URL || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.pathname.endsWith("/infer")) {
      url.pathname = url.pathname.replace(/\/infer$/, "/health");
    } else if (!url.pathname.endsWith("/health")) {
      url.pathname = `${url.pathname.replace(/\/$/, "")}/health`;
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function getInferenceProviderHealth(env: Env): Promise<Response> {
  const providerUrl = String(env.PROVIDER_URL || "").trim() || null;
  const healthUrl = getInferenceHealthUrl(env);
  if (!healthUrl) {
    return json({
      ok: false,
      reachable: false,
      provider_url: providerUrl,
      health_url: null,
      status: null,
      code: "provider_url_missing",
      message: "Inference provider URL is not configured.",
    });
  }
  try {
    const resp = await fetch(healthUrl, {
      method: "GET",
      headers: { accept: "application/json,text/plain,*/*" },
      signal: AbortSignal.timeout(8000),
    });
    const message = (await resp.text().catch(() => "")).trim();
    return json({
      ok: resp.ok,
      reachable: resp.ok,
      provider_url: providerUrl,
      health_url: healthUrl,
      status: resp.status,
      code: resp.ok ? "ok" : `provider_http_${resp.status}`,
      message: message || (resp.ok ? "Provider is reachable." : "Provider returned a non-success response."),
    });
  } catch (error) {
    return json({
      ok: false,
      reachable: false,
      provider_url: providerUrl,
      health_url: healthUrl,
      status: null,
      code: "provider_unreachable",
      message: asError(error).message,
    });
  }
}

function getEnvironment(env?: Env): "development" | "production" {
  return String(env?.ENVIRONMENT || "production").trim().toLowerCase() === "development" ? "development" : "production";
}

function resolveCorsOrigin(request: Request, env?: Env): string {
  const requestOrigin = (request.headers.get("origin") || "").trim();
  const environment = getEnvironment(env);
  if (environment === "development") {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(requestOrigin)) return requestOrigin;
    return "http://localhost:5173";
  }
  if (requestOrigin === "https://heartvalvepro.edu.kg") return requestOrigin;
  return "https://heartvalvepro.edu.kg";
}

function corsHeadersForRequest(request: Request, env?: Env): Record<string, string> {
  return {
    "access-control-allow-origin": resolveCorsOrigin(request, env),
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, X-Provider-Secret",
    "vary": "Origin",
  };
}

function withCors(response: Response, request: Request, env?: Env): Response {
  const headers = new Headers(response.headers);
  const cors = corsHeadersForRequest(request, env);
  for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function textResponse(body: string, contentType: string): Response {
  const headers = new Headers(jsonHeaders);
  headers.set("content-type", contentType);
  return new Response(body, { status: 200, headers });
}

function sanitizePublicValue(input: unknown): unknown {
  if (Array.isArray(input)) return input.map((item) => sanitizePublicValue(item));
  if (!input || typeof input !== "object") return input;
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const blocked = new Set([
    "pipeline_cmd",
    "stdout_tail",
    "stderr_tail",
    "artifacts_manifest",
    "work_dir",
    "output_dir",
    "object_key",
    "bucket",
    "upload_token_hash",
    "raw_payload"
  ]);
  for (const [key, value] of Object.entries(src)) {
    if (blocked.has(key)) continue;
    if (key === "runtime" && value && typeof value === "object") {
      const runtime = sanitizePublicValue(value) as Record<string, unknown>;
      delete runtime.pipeline_cmd;
      delete runtime.stdout_tail;
      delete runtime.stderr_tail;
      out[key] = runtime;
      continue;
    }
    out[key] = sanitizePublicValue(value);
  }
  return out;
}

function sanitizePublicResultJson(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object") return undefined;
  return sanitizePublicValue(input) as Record<string, unknown>;
}

function sanitizeProviderReceipt(input: Record<string, unknown>): Record<string, unknown> {
  const receipt = {
    status: readRecordString(input, "status") || null,
    job_id: readRecordString(input, "job_id") || null,
    provider_job_id: readRecordString(input, "provider_job_id") || null,
    error_message: readRecordString(input, "error_message") || null,
    metrics: Array.isArray(input.metrics) ? input.metrics : [],
    artifact_types: Array.isArray(input.artifacts)
      ? (input.artifacts as Array<Record<string, unknown>>).map((a) => String(a?.artifact_type || "provider_artifact"))
      : []
  } satisfies Record<string, unknown>;
  return sanitizePublicValue(receipt) as Record<string, unknown>;
}

function toPublicArtifactRecord(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    artifact_type: row.artifact_type,
    sha256: row.sha256,
    bytes: row.bytes,
    created_at: row.created_at
  };
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function buildSignedPath(path: string, env: Env, ttlSeconds?: number): Promise<string> {
  const secret = getArtifactLinkSecret(env);
  if (!secret) return path;
  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds || getArtifactLinkTtlSeconds(env));
  const sig = await hmacSha256Hex(secret, `${path}|${expiresAt}`);
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}exp=${expiresAt}&sig=${sig}`;
}

function sanitizeRawFilename(filename: string | null | undefined, fallbackStudyId: string): string {
  const raw = String(filename || "").trim();
  const safe = raw
    .split(/[\\/]/)
    .pop()
    ?.replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+/, "")
    .trim();
  if (safe) return safe;
  return `${fallbackStudyId}.bin`;
}

async function buildStudyRawPath(studyId: string, env: Env): Promise<string> {
  const row = await safeFirst(
    env.DB.prepare(
      `SELECT s.image_key, sr.raw_filename
       FROM studies s
       LEFT JOIN study_repository sr ON sr.study_id = s.id
       WHERE s.id = ?1`
    )
      .bind(studyId)
      .first<Record<string, unknown>>()
  );
  const rawFilename =
    nullableString(row?.raw_filename)
    || nullableString(row?.image_key)?.split("/").pop()
    || `${studyId}.bin`;
  return `/studies/${encodeURIComponent(studyId)}/raw/${encodeURIComponent(sanitizeRawFilename(rawFilename, studyId))}`;
}

async function requireSignedAccess(request: Request, env: Env): Promise<Response | null> {
  const secret = getArtifactLinkSecret(env);
  if (!secret) return null;
  const url = new URL(request.url);
  const expRaw = url.searchParams.get("exp") || "";
  const sig = (url.searchParams.get("sig") || "").trim();
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || exp <= 0) return json({ error: "signed_url_required" }, 401);
  if (Math.floor(Date.now() / 1000) > exp) return json({ error: "signed_url_expired" }, 401);
  if (!sig) return json({ error: "signed_url_required" }, 401);
  const expected = await hmacSha256Hex(secret, `${url.pathname}|${exp}`);
  if (!timingSafeHexEqual(sig, expected)) return json({ error: "invalid_signature" }, 401);
  return null;
}

function deepMergeRecord(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const cur = out[key];
      out[key] =
        cur && typeof cur === "object" && !Array.isArray(cur)
          ? deepMergeRecord(cur as Record<string, unknown>, value as Record<string, unknown>)
          : deepMergeRecord({}, value as Record<string, unknown>);
      continue;
    }
    out[key] = value;
  }
  return out;
}

async function safeFirst<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

async function safeAll(promise: Promise<D1Result<Record<string, unknown>>>): Promise<Array<Record<string, unknown>>> {
  try {
    const out = await promise;
    return (out.results as Array<Record<string, unknown>>) || [];
  } catch {
    return [];
  }
}

async function safeRun(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return true;
  } catch {
    return false;
  }
}

function safeParseJsonText(text: unknown): Record<string, unknown> {
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function upsertStudyRepository(
  env: Env,
  studyId: string,
  patch: Record<string, unknown>,
  attrs?: {
    rawFilename?: string | null;
    imageBytes?: number | null;
    imageSha256?: string | null;
    ingestionFormat?: string | null;
  }
): Promise<void> {
  const current = await safeFirst(
    env.DB.prepare(`SELECT metadata_json, raw_filename, image_bytes, image_sha256, ingestion_format FROM study_repository WHERE study_id = ?1`)
      .bind(studyId)
      .first<Record<string, unknown>>()
  );
  const merged = deepMergeRecord(safeParseJsonText(current?.metadata_json), patch);
  await safeRun(
    env.DB.prepare(
      `INSERT INTO study_repository (study_id, raw_filename, image_bytes, image_sha256, ingestion_format, metadata_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(study_id) DO UPDATE SET
         raw_filename = COALESCE(excluded.raw_filename, study_repository.raw_filename),
         image_bytes = COALESCE(excluded.image_bytes, study_repository.image_bytes),
         image_sha256 = COALESCE(excluded.image_sha256, study_repository.image_sha256),
         ingestion_format = COALESCE(excluded.ingestion_format, study_repository.ingestion_format),
         metadata_json = excluded.metadata_json,
         updated_at = CURRENT_TIMESTAMP`
    )
      .bind(
        studyId,
        attrs?.rawFilename ?? (current?.raw_filename as string | null) ?? null,
        attrs?.imageBytes ?? (current?.image_bytes as number | null) ?? null,
        attrs?.imageSha256 ?? (current?.image_sha256 as string | null) ?? null,
        attrs?.ingestionFormat ?? (current?.ingestion_format as string | null) ?? null,
        JSON.stringify(merged)
      )
      .run()
  );
}

function summarizePipelineRun(
  resultJson: Record<string, unknown>,
  source: string,
  providerJobId: string | null,
  env: Env,
  options?: { historical?: boolean }
): Record<string, unknown> {
  const historical = options?.historical === true;
  const inputMeta = (resultJson.input_metadata && typeof resultJson.input_metadata === "object"
    ? (resultJson.input_metadata as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const pipeline = (resultJson.pipeline && typeof resultJson.pipeline === "object"
    ? (resultJson.pipeline as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const pipelineVersion = (resultJson.pipeline_version && typeof resultJson.pipeline_version === "object"
    ? (resultJson.pipeline_version as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const runtime = (resultJson.runtime && typeof resultJson.runtime === "object"
    ? (resultJson.runtime as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const model = (resultJson.aortic_root_computational_model && typeof resultJson.aortic_root_computational_model === "object"
    ? (resultJson.aortic_root_computational_model as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const phaseMeta = (model.phase_metadata && typeof model.phase_metadata === "object"
    ? (model.phase_metadata as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const sourceMode = historical ? "historical_inferred" : source;
  const inferenceMode = historical ? "historical_inferred" : (source === "mock" ? "mock" : getInferenceMode(env));
  const providerTarget = historical
    ? nullableString(runtime.provider_target)
    : nullableString(runtime.provider_target) || (inferenceMode === "webhook" ? nullableString(env.PROVIDER_URL) : null);
  const providerRuntime = nullableString(runtime.provider_runtime);
  const buildVersion = historical
    ? stringOr(pipelineVersion.build_version, stringOr(runtime.build_version, "historical_inferred"))
    : getBuildVersion();
  return {
    provider_job_id: providerJobId,
    source_mode: sourceMode,
    inference_mode: inferenceMode,
    inferred: historical,
    provider_target: providerTarget,
    provider_runtime: providerRuntime,
    pipeline_version: stringOr(pipelineVersion.pipeline_version, stringOr(pipeline.pipeline_version, "unknown")),
    build_version: buildVersion,
    computational_model: stringOr(pipelineVersion.computational_model, stringOr(model.type, "unknown")),
    centerline_method: stringOr(pipelineVersion.centerline_method, stringOr((resultJson.centerline as Record<string, unknown> | undefined)?.method, "unknown")),
    measurement_method: stringOr(pipelineVersion.measurement_method, stringOr(pipeline.measurement_method, "unknown")),
    input_kind: stringOr(inputMeta.input_kind, stringOr((pipeline.input_prep as Record<string, unknown> | undefined)?.input_kind, "unknown")),
    reported_phase: stringOr(phaseMeta.reported_phase, stringOr(inputMeta.reported_phase, "unknown")),
    selected_phase: stringOr(phaseMeta.phase_guess, stringOr(inputMeta.phase_guess, "unknown")),
    runtime_seconds: typeof pipeline.runtime_seconds === "number" ? pipeline.runtime_seconds : null,
    stage_timings_json: JSON.stringify(resultJson.stage_timings_seconds || {}),
    run_summary_json: JSON.stringify(
      sanitizePublicValue({
        input_metadata: inputMeta,
        pipeline,
        pipeline_version: pipelineVersion,
        runtime: {
          ...runtime,
          provider_target: providerTarget,
          provider_runtime: providerRuntime,
          inference_mode: inferenceMode,
          build_version: buildVersion,
        },
        phase_metadata: phaseMeta,
        provenance: model.provenance,
        risk_flags: resultJson.risk_flags,
      }) || {}
    ),
  };
}

async function recordPipelineRun(
  env: Env,
  jobId: string,
  studyId: string,
  resultJson: Record<string, unknown>,
  source: "mock" | "inline" | "callback",
  providerJobId: string | null
): Promise<void> {
  const summary = summarizePipelineRun(resultJson, source, providerJobId, env);
  await safeRun(
    env.DB.prepare(
      `INSERT INTO pipeline_runs (
         id, job_id, study_id, provider_job_id, source_mode, pipeline_version, build_version, computational_model,
         centerline_method, measurement_method, input_kind, reported_phase, selected_phase, runtime_seconds,
         stage_timings_json, run_summary_json
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
       ON CONFLICT(job_id) DO UPDATE SET
         provider_job_id = excluded.provider_job_id,
         source_mode = excluded.source_mode,
         pipeline_version = excluded.pipeline_version,
         build_version = excluded.build_version,
         computational_model = excluded.computational_model,
         centerline_method = excluded.centerline_method,
         measurement_method = excluded.measurement_method,
         input_kind = excluded.input_kind,
         reported_phase = excluded.reported_phase,
         selected_phase = excluded.selected_phase,
         runtime_seconds = excluded.runtime_seconds,
         stage_timings_json = excluded.stage_timings_json,
         run_summary_json = excluded.run_summary_json,
         updated_at = CURRENT_TIMESTAMP`
    )
      .bind(
        crypto.randomUUID(),
        jobId,
        studyId,
        nullableString(summary.provider_job_id),
        nullableString(summary.source_mode),
        nullableString(summary.pipeline_version),
        nullableString(summary.build_version),
        nullableString(summary.computational_model),
        nullableString(summary.centerline_method),
        nullableString(summary.measurement_method),
        nullableString(summary.input_kind),
        nullableString(summary.reported_phase),
        nullableString(summary.selected_phase),
        summary.runtime_seconds,
        String(summary.stage_timings_json || "{}"),
        String(summary.run_summary_json || "{}")
      )
      .run()
  );
}

async function getPipelineRun(jobId: string, env: Env): Promise<Record<string, unknown> | null> {
  const row = await safeFirst(
    env.DB.prepare(
      `SELECT provider_job_id, source_mode, pipeline_version, build_version, computational_model,
              centerline_method, measurement_method, input_kind, reported_phase, selected_phase,
              runtime_seconds, stage_timings_json, run_summary_json, created_at, updated_at
       FROM pipeline_runs WHERE job_id = ?1`
    )
      .bind(jobId)
      .first<Record<string, unknown>>()
  );
  if (!row) return null;
  return {
    ...row,
    stage_timings: safeParseJsonText(row.stage_timings_json),
    run_summary: safeParseJsonText(row.run_summary_json),
  };
}

function materializePipelineRun(record: Record<string, unknown>, env: Env, inferred = false): Record<string, unknown> {
  const stageTimings = safeParseJsonText(record.stage_timings_json);
  const runSummary = safeParseJsonText(record.run_summary_json);
  const sourceMode = inferred ? "historical_inferred" : stringOr(record.source_mode, "unknown");
  const inferenceMode = nullableString(record.inference_mode)
    || readNestedString(runSummary, ["runtime", "inference_mode"])
    || (sourceMode === "mock" ? "mock" : inferred ? "historical_inferred" : getInferenceMode(env));
  const providerTarget = nullableString(record.provider_target)
    || nullableString(runSummary.provider_target)
    || readNestedString(runSummary, ["runtime", "provider_target"])
    || (!inferred && inferenceMode === "webhook" ? nullableString(env.PROVIDER_URL) : null);
  const providerRuntime = nullableString(record.provider_runtime)
    || nullableString(runSummary.provider_runtime)
    || readNestedString(runSummary, ["runtime", "provider_runtime"]);
  const buildVersion = nullableString(record.build_version)
    || readNestedString(runSummary, ["runtime", "build_version"])
    || (inferred ? "historical_inferred" : getBuildVersion());
  const pipelineVersion = nullableString(record.pipeline_version)
    || nullableString(runSummary.pipeline_version)
    || readNestedString(runSummary, ["pipeline_version"])
    || "unknown";
  return sanitizePublicValue({
    ...record,
    source_mode: sourceMode,
    inference_mode: inferenceMode,
    inferred,
    provider_target: providerTarget,
    provider_runtime: providerRuntime,
    build_version: buildVersion,
    pipeline_version: pipelineVersion,
    stage_timings: stageTimings,
    run_summary: runSummary,
  }) as Record<string, unknown>;
}

async function resolvePipelineRun(
  jobId: string,
  env: Env,
  resultJson?: Record<string, unknown> | null
): Promise<Record<string, unknown> | null> {
  const stored = await getPipelineRun(jobId, env);
  if (stored) {
    return materializePipelineRun(stored, env, false);
  }
  if (resultJson) {
    return materializePipelineRun(
      summarizePipelineRun(resultJson, "historical_inferred", null, env, { historical: true }),
      env,
      true
    );
  }
  return null;
}

async function recordArtifactAccess(
  env: Env,
  request: Request,
  scope: "study_raw" | "job_artifact",
  studyId: string | null,
  jobId: string | null,
  artifactType: string | null,
  accessMode: "signed" | "unsigned"
): Promise<void> {
  await safeRun(
    env.DB.prepare(
      `INSERT INTO artifact_access_audit (id, scope, study_id, job_id, artifact_type, access_mode, client_ip, user_agent)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
      .bind(
        crypto.randomUUID(),
        scope,
        studyId,
        jobId,
        artifactType,
        accessMode,
        nullableString(request.headers.get("cf-connecting-ip")),
        nullableString(request.headers.get("user-agent"))
      )
      .run()
  );
}

async function buildJobLinks(jobId: string, studyId: string, env: Env): Promise<Record<string, string>> {
  const links = {
    raw_ct: await buildStudyRawPath(studyId, env),
    mask_multiclass: `/jobs/${jobId}/artifacts/mask_output`,
    segmentation_mask_nifti: `/jobs/${jobId}/artifacts/segmentation_mask_nifti`,
    result_json: `/jobs/${jobId}/artifacts/result_json`,
    provider_receipt: `/jobs/${jobId}/artifacts/provider_receipt`,
    measurements_json: `/jobs/${jobId}/artifacts/measurements_json`,
    planning_report_pdf: `/jobs/${jobId}/artifacts/planning_report_pdf`,
    aortic_root_stl: `/jobs/${jobId}/artifacts/aortic_root_stl`,
    ascending_aorta_stl: `/jobs/${jobId}/artifacts/ascending_aorta_stl`,
    leaflets_stl: `/jobs/${jobId}/artifacts/leaflets_stl`,
    annulus_ring_stl: `/jobs/${jobId}/artifacts/annulus_ring_stl`,
    pears_outer_aorta_stl: `/jobs/${jobId}/artifacts/pears_outer_aorta_stl`,
    pears_support_sleeve_stl: `/jobs/${jobId}/artifacts/pears_support_sleeve_stl`,
    centerline_json: `/jobs/${jobId}/artifacts/centerline_json`,
    annulus_plane_json: `/jobs/${jobId}/artifacts/annulus_plane_json`,
    aortic_root_model_json: `/jobs/${jobId}/artifacts/aortic_root_model_json`,
    leaflet_model_json: `/jobs/${jobId}/artifacts/leaflet_model_json`,
    pears_model_json: `/jobs/${jobId}/artifacts/pears_model_json`,
    pears_coronary_windows_json: `/jobs/${jobId}/artifacts/pears_coronary_windows_json`,
    pears_visual_qa_json: `/jobs/${jobId}/artifacts/pears_visual_qa_json`,
    cpr_reference_json: `/jobs/${jobId}/artifacts/cpr_reference_json`,
    cpr_straightened_nifti: `/jobs/${jobId}/artifacts/cpr_straightened_nifti`,
    job_api: `/jobs/${jobId}`,
  };
  const out: Record<string, string> = {};
  for (const [key, path] of Object.entries(links)) out[key] = await buildSignedPath(path, env);
  return out;
}

function buildLegacyDownloads(
  links: Record<string, string>,
  artifactTypes: Set<string>
): {
  raw: { label: string; href: string } | null;
  json: Array<{ label: string; href: string }>;
  stl: Array<{ label: string; href: string }>;
  pdf: { label: string; href: string } | null;
} {
  const json: Array<{ label: string; href: string }> = [];
  const stl: Array<{ label: string; href: string }> = [];

  if (artifactTypes.has("measurements_json") && links.measurements_json) {
    json.push({ label: "Measurements JSON", href: links.measurements_json });
  }
  if (artifactTypes.has("centerline_json") && links.centerline_json) {
    json.push({ label: "Centerline JSON", href: links.centerline_json });
  }
  if (artifactTypes.has("aortic_root_model_json") && links.aortic_root_model_json) {
    json.push({ label: "Digital Twin JSON", href: links.aortic_root_model_json });
  }
  if (artifactTypes.has("leaflet_model_json") && links.leaflet_model_json) {
    json.push({ label: "Leaflet Model JSON", href: links.leaflet_model_json });
  }
  if (artifactTypes.has("pears_model_json") && links.pears_model_json) {
    json.push({ label: "PEARS Model JSON", href: links.pears_model_json });
  }
  if (artifactTypes.has("pears_coronary_windows_json") && links.pears_coronary_windows_json) {
    json.push({ label: "PEARS Coronary Windows JSON", href: links.pears_coronary_windows_json });
  }
  if (artifactTypes.has("result_json") && links.result_json) {
    json.push({ label: "Segmentation Result JSON", href: links.result_json });
  }

  if (artifactTypes.has("aortic_root_stl") && links.aortic_root_stl) {
    stl.push({ label: "Aortic Root STL", href: links.aortic_root_stl });
  }
  if (artifactTypes.has("ascending_aorta_stl") && links.ascending_aorta_stl) {
    stl.push({ label: "Ascending Aorta STL", href: links.ascending_aorta_stl });
  }
  if (artifactTypes.has("leaflets_stl") && links.leaflets_stl) {
    stl.push({ label: "Leaflets STL", href: links.leaflets_stl });
  }
  if (artifactTypes.has("annulus_ring_stl") && links.annulus_ring_stl) {
    stl.push({ label: "Annulus Ring STL", href: links.annulus_ring_stl });
  }
  if (artifactTypes.has("pears_outer_aorta_stl") && links.pears_outer_aorta_stl) {
    stl.push({ label: "PEARS Aorta Proxy STL", href: links.pears_outer_aorta_stl });
  }
  if (artifactTypes.has("pears_support_sleeve_stl") && links.pears_support_sleeve_stl) {
    stl.push({ label: "PEARS Sleeve Preview STL", href: links.pears_support_sleeve_stl });
  }

  return {
    raw: links.raw_ct ? { label: "Raw CT", href: links.raw_ct } : null,
    json,
    stl,
    pdf: artifactTypes.has("planning_report_pdf") && links.planning_report_pdf
      ? { label: "Planning Report PDF", href: links.planning_report_pdf }
      : null,
  };
}

function finiteNumberOrNull(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildLegacyEvidence(
  method: string,
  sourceType: "guideline" | "literature" | "algorithm" | "device_ifu" | "manual" | "other",
  sourceRef: string,
  confidence: number
): Record<string, unknown> {
  return {
    method,
    source_type: sourceType,
    source_ref: sourceRef,
    confidence,
  };
}

function buildLegacyUncertainty(
  flag: "NONE" | "MISSING_INPUT" | "DETECTION_FAILED" | "LOW_CONFIDENCE" | "ANATOMY_CONSTRAINT_VIOLATION" | "OUT_OF_RANGE" | "IMAGE_QUALITY_LIMITATION" | "MODEL_INCONSISTENCY" | "PLACEHOLDER_ONLY" | "NOT_AVAILABLE",
  message: string,
  clinicianReviewRequired = false
): Record<string, unknown> {
  return {
    flag,
    message,
    clinician_review_required: clinicianReviewRequired,
  };
}

function buildLegacyEnvelope(
  value: unknown,
  unit: string,
  method: string,
  sourceType: "guideline" | "literature" | "algorithm" | "device_ifu" | "manual" | "other",
  sourceRef: string,
  confidence: number,
  uncertainty?: Record<string, unknown>
): Record<string, unknown> {
  return {
    value,
    unit,
    evidence: buildLegacyEvidence(method, sourceType, sourceRef, confidence),
    uncertainty: uncertainty || buildLegacyUncertainty("NONE", "Legacy planning metric accepted.", false),
  };
}

function buildLegacyUnavailableEnvelope(section: string, key: string, message?: string): Record<string, unknown> {
  return buildLegacyEnvelope(
    null,
    "status",
    "legacy_case_absent",
    "other",
    "LEGACY_CASE_NO_PLANNING",
    0,
    buildLegacyUncertainty(
      "NOT_AVAILABLE",
      message || `Legacy case does not provide ${section} ${key}.`,
      true
    )
  );
}

function deriveLegacyPlanningPayload(
  measurementsJson: Record<string, unknown> | null,
  coronaryOstiaSummary: Record<string, unknown> | null,
  leafletGeometrySummary: Record<string, unknown> | null,
  pearsGeometry: Record<string, unknown> | null
): Record<string, unknown> {
  const planningMetrics = pickObject(measurementsJson?.planning_metrics);
  const taviMetrics = pickObject(planningMetrics?.tavi);
  const vsrrMetrics = pickObject(planningMetrics?.vsrr);
  const pearsMetrics = pickObject(planningMetrics?.pears);
  const coronaryDetection = pickObject(measurementsJson?.coronary_detection);
  const leftCoronary = pickObject(coronaryDetection?.left);
  const rightCoronary = pickObject(coronaryDetection?.right);
  const leafletCount = Array.isArray(leafletGeometrySummary?.leaflets) ? leafletGeometrySummary.leaflets.length : 0;

  const tavi: Record<string, unknown> = {
    valve_size_suggestion: taviMetrics?.area_derived_valve_size
      ? buildLegacyEnvelope(
          sanitizePublicValue(taviMetrics.area_derived_valve_size),
          "status",
          "legacy_tavi_area_projection",
          "algorithm",
          "GE_TAVI_ANALYSIS",
          0.74
        )
      : buildLegacyUnavailableEnvelope("TAVI", "valve_size_suggestion"),
    coronary_obstruction_risk: taviMetrics && "coronary_risk_flag" in taviMetrics
      ? buildLegacyEnvelope(
          sanitizePublicValue({
            coronary_risk_flag: Boolean(taviMetrics.coronary_risk_flag),
            left_height_mm: finiteNumberOrNull(leftCoronary?.height_mm),
            right_height_mm: finiteNumberOrNull(rightCoronary?.height_mm),
            left_status: leftCoronary?.status || "unknown",
            right_status: rightCoronary?.status || "unknown",
          }),
          "status",
          "legacy_coronary_risk_projection",
          "guideline",
          "SCCT_TAVI_CT_CONSENSUS",
          finiteNumberOrNull(leftCoronary?.height_mm) !== null || finiteNumberOrNull(rightCoronary?.height_mm) !== null ? 0.62 : 0.28,
          (finiteNumberOrNull(leftCoronary?.height_mm) === null && finiteNumberOrNull(rightCoronary?.height_mm) === null)
            ? buildLegacyUncertainty("NOT_AVAILABLE", "Coronary heights are not reliably available in this historical case.", true)
            : buildLegacyUncertainty("LOW_CONFIDENCE", "Historical coronary risk projection should be reviewed with the original study.", true)
        )
      : buildLegacyUnavailableEnvelope("TAVI", "coronary_obstruction_risk"),
    optimal_projection_angle: buildLegacyUnavailableEnvelope("TAVI", "optimal_projection_angle", "Legacy case does not provide a standardized coplanar projection artifact."),
    access_route_assessment: buildLegacyUnavailableEnvelope("TAVI", "access_route_assessment", "Legacy case does not include a dedicated access route assessment artifact."),
  };

  const vsrr: Record<string, unknown> = {
    commissural_geometry_status: buildLegacyUnavailableEnvelope("VSRR", "commissural_geometry_status", "Legacy case does not expose a structured commissural symmetry artifact."),
    leaflet_geometry_status: leafletCount || vsrrMetrics
      ? buildLegacyEnvelope(
          sanitizePublicValue({
            leaflet_count: leafletCount || null,
            effective_height_mean_mm: finiteNumberOrNull(vsrrMetrics?.effective_height_mean_mm),
            coaptation_height_mm: finiteNumberOrNull(vsrrMetrics?.coaptation_height_mm),
            coaptation_reserve_mm: finiteNumberOrNull(vsrrMetrics?.coaptation_reserve_mm),
          }),
          "status",
          "legacy_vsrr_leaflet_projection",
          "literature",
          "VSRR_EFFECTIVE_HEIGHT_LIT",
          0.58,
          buildLegacyUncertainty("LOW_CONFIDENCE", "Historical leaflet geometry is reconstructed from legacy metrics and should be reviewed.", true)
        )
      : buildLegacyUnavailableEnvelope("VSRR", "leaflet_geometry_status"),
    graft_sizing: vsrrMetrics && finiteNumberOrNull(vsrrMetrics.recommended_graft_size_mm) !== null
      ? buildLegacyEnvelope(
          sanitizePublicValue({
            recommended_graft_size_mm: finiteNumberOrNull(vsrrMetrics.recommended_graft_size_mm),
            annulus_stj_mismatch_mm: finiteNumberOrNull(vsrrMetrics.annulus_stj_mismatch_mm),
          }),
          "mm",
          "legacy_vsrr_graft_sizing_projection",
          "literature",
          "VSRR_EFFECTIVE_HEIGHT_LIT",
          0.71,
          buildLegacyUncertainty("LOW_CONFIDENCE", "Historical VSRR sizing should be reviewed against the original root geometry.", true)
        )
      : buildLegacyUnavailableEnvelope("VSRR", "graft_sizing"),
  };

  const pears: Record<string, unknown> = {
    external_root_geometry_status: pearsMetrics?.root_external_geometry || pearsGeometry
      ? buildLegacyEnvelope(
          sanitizePublicValue(pearsMetrics?.root_external_geometry || pearsGeometry?.geometry || pearsGeometry),
          "status",
          "legacy_pears_root_geometry_projection",
          "algorithm",
          "PEARS_EXOVASC_LIT",
          0.69,
          buildLegacyUncertainty("LOW_CONFIDENCE", "Historical PEARS geometry is reconstructed from stored model outputs.", true)
        )
      : buildLegacyUnavailableEnvelope("PEARS", "external_root_geometry_status"),
    support_region_status: finiteNumberOrNull(pearsMetrics?.support_segment_length_mm) !== null || pickObject(pearsGeometry?.surgical_planning?.support_segment)
      ? buildLegacyEnvelope(
          sanitizePublicValue({
            support_segment_length_mm: finiteNumberOrNull(pearsMetrics?.support_segment_length_mm),
            support_segment: pickObject(pearsGeometry?.surgical_planning?.support_segment) || null,
          }),
          "mm",
          "legacy_pears_support_region_projection",
          "algorithm",
          "PEARS_EXOVASC_LIT",
          0.64,
          buildLegacyUncertainty("LOW_CONFIDENCE", "Historical PEARS support region should be reviewed before surgical use.", true)
        )
      : buildLegacyUnavailableEnvelope("PEARS", "support_region_status"),
  };

  return { tavi, vsrr, pears };
}

function summarizePlanningSection(section: Record<string, unknown> | null): string {
  if (!section) return "unavailable";
  const entries = Object.values(section).map((value) => pickObject(value));
  if (!entries.length) return "unavailable";
  const hasEnvelopeEntries = entries.some((envelope) => Boolean(envelope && ("value" in envelope || "uncertainty" in envelope)));
  if (!hasEnvelopeEntries) {
    return hasMeaningfulPlanningSignal(section) ? "review_required" : "unavailable";
  }
  let hasValue = false;
  let requiresReview = false;
  for (const envelope of entries) {
    if (!envelope) continue;
    if (envelope.value !== null && envelope.value !== undefined) hasValue = true;
    const uncertainty = pickObject(envelope.uncertainty);
    if (uncertainty?.clinician_review_required) requiresReview = true;
    const flag = String(uncertainty?.flag || "NONE").toUpperCase();
    if (flag !== "NONE" && flag !== "PLACEHOLDER_ONLY") requiresReview = true;
  }
  if (!hasValue) return "unavailable";
  return requiresReview ? "review_required" : "available";
}

function hasMeaningfulPlanningSignal(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => hasMeaningfulPlanningSignal(item));
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) => hasMeaningfulPlanningSignal(item));
  }
  return false;
}

function deriveLegacyQualityGates(measurementsJson: Record<string, unknown> | null): Record<string, unknown> {
  const planningMetrics = pickObject(measurementsJson?.planning_metrics);
  const taviMetrics = pickObject(planningMetrics?.tavi);
  const vsrrMetrics = pickObject(planningMetrics?.vsrr);
  const coronaryDetection = pickObject(measurementsJson?.coronary_detection);
  const leftCoronary = pickObject(coronaryDetection?.left);
  const rightCoronary = pickObject(coronaryDetection?.right);
  const annulus = finiteNumberOrNull(taviMetrics?.annulus_diameter_long_mm) ?? finiteNumberOrNull(vsrrMetrics?.annulus_diameter_mm);
  const sinus = finiteNumberOrNull(taviMetrics?.sinus_width_mm) ?? finiteNumberOrNull(vsrrMetrics?.sinus_diameter_mm);
  const stj = finiteNumberOrNull(taviMetrics?.stj_diameter_mm) ?? finiteNumberOrNull(vsrrMetrics?.stj_diameter_mm);
  const leftHeight = finiteNumberOrNull(leftCoronary?.height_mm);
  const rightHeight = finiteNumberOrNull(rightCoronary?.height_mm);

  const sinusAnnulusStatus =
    annulus === null || sinus === null ? "not_assessable"
    : sinus >= annulus ? "normal"
    : sinus >= annulus - 2 ? "review_required"
    : "failed";
  const stjSinusStatus =
    stj === null || sinus === null ? "not_assessable"
    : stj <= sinus ? "normal"
    : stj <= sinus + 2 ? "review_required"
    : "failed";

  return {
    sinus_annulus_relation: {
      status: sinusAnnulusStatus,
      summary: annulus === null || sinus === null
        ? "Historical case does not expose enough data to assess sinus versus annulus geometry."
        : sinus >= annulus
          ? "Sinus reference remains larger than annulus in this historical case."
          : "Sinus and annulus relationship needs clinical review in this historical case.",
      clinician_review_required: sinusAnnulusStatus !== "normal",
      evidence: buildLegacyEvidence("legacy_geometry_reasonableness_check", "guideline", "SCCT_TAVI_CT_CONSENSUS", annulus !== null && sinus !== null ? 0.67 : 0),
      observed_value: { annulus_diameter_mm: annulus, sinus_diameter_mm: sinus },
      expected_context: "Sinus-to-annulus relationships are judged clinically and are not treated as a rigid pass/fail threshold without context.",
      impact: ["tavi.valve_size_suggestion", "vsrr.graft_sizing", "pears.external_root_geometry_status"],
      reason_codes: annulus === null || sinus === null ? ["legacy_geometry_missing"] : sinus >= annulus ? ["clinically_consistent_root_profile"] : ["root_geometry_requires_review"],
    },
    stj_sinus_relation: {
      status: stjSinusStatus,
      summary: stj === null || sinus === null
        ? "Historical case does not expose enough data to assess STJ versus sinus geometry."
        : stj <= sinus
          ? "STJ reference remains narrower than sinus diameter in this historical case."
          : "STJ and sinus relationship needs review before planning use.",
      clinician_review_required: stjSinusStatus !== "normal",
      evidence: buildLegacyEvidence("legacy_geometry_reasonableness_check", "guideline", "SCCT_TAVI_CT_CONSENSUS", stj !== null && sinus !== null ? 0.66 : 0),
      observed_value: { stj_diameter_mm: stj, sinus_diameter_mm: sinus },
      expected_context: "STJ morphology is reviewed in context and only fails when the relationship is clearly not credible.",
      impact: ["vsrr.graft_sizing", "pears.support_region_status"],
      reason_codes: stj === null || sinus === null ? ["legacy_geometry_missing"] : stj <= sinus ? ["stj_consistent_with_sinus"] : ["stj_requires_review"],
    },
    commissure_symmetry: {
      status: "not_assessable",
      summary: "Historical latest-case payload does not expose a structured commissure symmetry artifact.",
      clinician_review_required: true,
      evidence: buildLegacyEvidence("legacy_commissure_review", "other", "LEGACY_CASE_NO_PLANNING", 0),
      observed_value: null,
      expected_context: "Commissure symmetry should be judged from explicit landmark geometry rather than inferred from incomplete historical payloads.",
      impact: ["vsrr.commissural_geometry_status"],
      reason_codes: ["commissure_artifact_missing"],
    },
    coronary_height_assessment: {
      status: leftHeight === null && rightHeight === null ? "not_assessable" : "review_required",
      summary: leftHeight === null && rightHeight === null
        ? "Coronary ostia were not detected reliably in this historical case."
        : "Coronary heights are partially available and should be reviewed before relying on obstruction risk.",
      clinician_review_required: true,
      evidence: buildLegacyEvidence("legacy_coronary_height_review", "guideline", "SCCT_TAVI_CT_CONSENSUS", leftHeight === null && rightHeight === null ? 0 : 0.44),
      observed_value: {
        left_height_mm: leftHeight,
        right_height_mm: rightHeight,
        left_status: leftCoronary?.status || "unknown",
        right_status: rightCoronary?.status || "unknown",
      },
      expected_context: "Coronary height is only fully accepted when ostia are confidently localized on a suitable acquisition.",
      impact: ["tavi.coronary_obstruction_risk"],
      reason_codes: leftHeight === null && rightHeight === null ? ["coronary_ostia_not_detected"] : ["coronary_height_requires_review"],
    },
  };
}

function deriveLegacyUncertaintySummary(
  planning: Record<string, unknown> | null,
  qualityGates: Record<string, unknown> | null
): Record<string, unknown> {
  const counts = {
    review_required: 0,
    unavailable: 0,
    failed: 0,
  };
  if (planning) {
    Object.values(planning).forEach((section) => {
      const record = pickObject(section);
      if (!record) return;
      Object.values(record).forEach((entry) => {
        const envelope = pickObject(entry);
        const uncertainty = pickObject(envelope?.uncertainty);
        const flag = String(uncertainty?.flag || "NONE").toUpperCase();
        if (flag === "NOT_AVAILABLE" || flag === "MISSING_INPUT") counts.unavailable += 1;
        else if (flag !== "NONE" && flag !== "PLACEHOLDER_ONLY") counts.review_required += 1;
      });
    });
  }
  if (qualityGates) {
    Object.values(qualityGates).forEach((entry) => {
      const gate = pickObject(entry);
      const status = String(gate?.status || "").toLowerCase();
      if (status === "failed") counts.failed += 1;
      else if (status === "review_required" || status === "not_assessable" || status === "borderline") counts.review_required += 1;
    });
  }
  const overall_status = counts.failed ? "failed" : counts.review_required ? "review_required" : counts.unavailable ? "partial" : "normal";
  return {
    overall_status,
    review_required_count: counts.review_required,
    unavailable_count: counts.unavailable,
    failed_count: counts.failed,
  };
}

function buildLatestCaseSummaryFromWorkstationPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const job = pickObject(payload.job);
  const caseId = String(payload.case_id || job?.result_case_id || job?.id || "");
  const jobId = String(job?.id || caseId || "");
  const studyMeta = pickObject(payload.study_meta);
  const planning = pickObject(payload.planning);
  const qualityGates = pickObject(payload.quality_gates_summary) || pickObject(payload.quality_gates);
  const uncertaintySummary = pickObject(payload.uncertainty_summary)
    || deriveLegacyUncertaintySummary(planning, qualityGates);
  return {
    id: jobId,
    job_id: jobId,
    case_id: caseId,
    case_role: ["latest", "legacy"],
    display_name: payload.display_name || {
      "zh-CN": "最新真实病例",
      en: "Latest Real Case",
    },
    build_version: payload.build_version || getBuildVersion(),
    summary_source: "latest_case_workstation",
    links: payload.links || null,
    downloads: payload.downloads || null,
    capabilities: payload.capabilities || null,
    planning_summary: payload.planning_summary || {
      tavi_status: summarizePlanningSection(pickObject(planning?.tavi)),
      vsrr_status: summarizePlanningSection(pickObject(planning?.vsrr)),
      pears_status: summarizePlanningSection(pickObject(planning?.pears)),
    },
    quality_gates_summary: qualityGates || null,
    uncertainty_summary: uncertaintySummary,
    acceptance_review: payload.acceptance_review || buildAcceptanceReview({
      pipeline_run: payload.pipeline_run,
      viewer_bootstrap: payload.viewer_bootstrap,
      capabilities: payload.capabilities,
      downloads: payload.downloads,
      planning,
      quality_gates: payload.quality_gates,
      quality_gates_summary: qualityGates,
      coronary_ostia_summary: payload.coronary_ostia_summary,
      leaflet_geometry_summary: payload.leaflet_geometry_summary,
    }),
    clinical_review: payload.clinical_review || payload.acceptance_review || buildAcceptanceReview({
      pipeline_run: payload.pipeline_run,
      viewer_bootstrap: payload.viewer_bootstrap,
      capabilities: payload.capabilities,
      downloads: payload.downloads,
      planning,
      quality_gates: payload.quality_gates,
      quality_gates_summary: qualityGates,
      coronary_ostia_summary: payload.coronary_ostia_summary,
      leaflet_geometry_summary: payload.leaflet_geometry_summary,
    }),
    pipeline_run: payload.pipeline_run || null,
    volume_source: payload.volume_source || null,
    study_meta: studyMeta ? {
      id: studyMeta.id || null,
      source_dataset: studyMeta.source_dataset || null,
      phase: studyMeta.phase || null,
    } : null,
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const respond = (response: Response): Response => withCors(response, request, env);
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") {
        return respond(new Response(null, {
          status: 204,
          headers: corsHeadersForRequest(request, env),
        }));
      }

      if (request.method === "GET" && path === "/health") {
        return respond(json({
          ok: true,
          version: getBuildVersion(),
          timestamp: new Date().toISOString(),
          default_case: "loaded",
          provider_url: env.PROVIDER_URL ?? "not_configured",
        }));
      }

      if (request.method === "GET" && path === "/version") {
        const legacyEnvBuildVersion = getLegacyEnvBuildVersion(env);
        return respond(json({
          ok: true,
          build_version: getBuildVersion(),
          asset_hashes: getWorkstationAssetHashes(),
          legacy_env_build_version: legacyEnvBuildVersion,
          build_consistency_ok: !legacyEnvBuildVersion || legacyEnvBuildVersion === getBuildVersion(),
        }));
      }

      if (request.method === "GET" && path === "/favicon.ico") {
        return respond(new Response(null, {
          status: 204,
          headers: jsonHeaders
        }));
      }

      if ((request.method === "GET" || request.method === "HEAD") && path === WORKSTATION_STYLE_PATH) {
        return env.ASSETS.fetch(request);
      }

      if ((request.method === "GET" || request.method === "HEAD") && path === WORKSTATION_APP_PATH) {
        return env.ASSETS.fetch(request);
      }

      if ((request.method === "GET" || request.method === "HEAD") && path === WORKSTATION_DICOM_WORKER_PATH) {
        return env.ASSETS.fetch(request);
      }

      if ((request.method === "GET" || request.method === "HEAD") && path.startsWith("/default-case/")) {
        // Build script stores default-case imaging assets as *.bin for stable asset serving.
        if (path.includes("/imaging_hidden/") && !path.endsWith(".bin")) {
          const rewritten = new URL(request.url);
          rewritten.pathname = path + ".bin";
          return env.ASSETS.fetch(new Request(rewritten.toString(), request));
        }
        return env.ASSETS.fetch(request);
      }

      if ((request.method === "GET" || request.method === "HEAD") && path === "/") {
        return respond(html(renderLandingPage(getBuildVersion())));
      }

      if ((request.method === "GET" || request.method === "HEAD") && path === "/app") {
        return respond(html(renderDemoHtml(getBuildVersion())));
      }

      if ((request.method === "GET" || request.method === "HEAD") && path === "/debug-mpr") {
        return respond(html(renderDemoHtml(getBuildVersion())));
      }

      if ((request.method === "GET" || request.method === "HEAD") && path === "/demo") {
        return respond(html(renderDemoHtml(getBuildVersion())));
      }

      if ((request.method === "GET" || request.method === "HEAD") && path === "/demo/showcase") {
        return respond(html(renderDemoHtml(getBuildVersion())));
      }

      if ((request.method === "GET" || request.method === "HEAD") && path === "/demo/legacy") {
        return respond(html(renderLegacyDemoHtml(getBuildVersion())));
      }

      if (request.method === "GET" && path === "/api/cases") {
        const defaultListResponse = await handleDefaultCaseList(getDefaultCaseStore(env, request), getBuildVersion());
        const defaultListPayload = await defaultListResponse.clone().json() as { cases?: Array<Record<string, unknown>> };
        const defaultCases = Array.isArray(defaultListPayload.cases) ? defaultListPayload.cases : [];
        const caseResultRows = (await listCaseResultRows(env))
          .filter((row) => row.case_id && row.case_id !== DEFAULT_CASE_ID)
          .filter((row) => !defaultCases.some((entry) => String(entry.case_id || entry.id || "") === row.case_id));
        const extraCases = await Promise.all(
          caseResultRows.map((row) => buildCaseResultListEntry(env, row, getBuildVersion()))
        );
        extraCases.sort((a, b) => {
          const aPrimary = String(a.id || a.case_id || "") === PRIMARY_REAL_CASE_ID ? 0 : 1;
          const bPrimary = String(b.id || b.case_id || "") === PRIMARY_REAL_CASE_ID ? 0 : 1;
          return aPrimary - bPrimary;
        });
        const cases = extraCases.length ? extraCases : defaultCases;
        return respond(json({ cases, total: cases.length }));
      }

      if (request.method === "GET" && /^\/api\/cases\/[^/]+\/summary$/.test(path)) {
        const parts = path.split("/");
        const caseId = decodeURIComponent(parts[3] || "");
        if (caseId === DEFAULT_CASE_ID) {
          return respond(await handleDefaultCaseSummary(getDefaultCaseStore(env, request), getBuildVersion()));
        }
        const workstationResponse = await getWorkstationCase(caseId, env, request);
        if (!workstationResponse.ok) {
          return respond(workstationResponse);
        }
        const workstationPayload = await workstationResponse.clone().json() as Record<string, unknown>;
        return respond(json(buildLatestCaseSummaryFromWorkstationPayload(workstationPayload)));
      }

      if (request.method === "POST" && path === "/api/annotations/auth") {
        return respond(await handleAnnotationAuth(request, env));
      }

      if (request.method === "POST" && /^\/api\/cases\/[^/]+\/annotations$/.test(path)) {
        const parts = path.split("/");
        const caseId = decodeURIComponent(parts[3] || "");
        const authError = await requireAnnotationToken(request, env);
        if (authError) return respond(authError);
        const payload = await readJson(request);
        return respond(await saveManualAnnotation(caseId, payload, env));
      }

      if (request.method === "GET" && /^\/api\/cases\/[^/]+\/annotations$/.test(path)) {
        const parts = path.split("/");
        const caseId = decodeURIComponent(parts[3] || "");
        return respond(await getManualAnnotations(caseId, env));
      }

      if (request.method === "GET" && path === "/api/cases/default_clinical_case/summary") {
        return respond(await handleDefaultCaseSummary(getDefaultCaseStore(env, request), getBuildVersion()));
      }

      if (request.method === "GET" && /^\/api\/cases\/[^/]+\/artifacts\/[^/]+$/.test(path)) {
        const parts = path.split("/");
        const caseId = decodeURIComponent(parts[3] || "");
        const rawName = parts[5] || "";
        // Measurements go through the manual-annotation merge pipeline so the
        // coronary-height P0 fallback actually surfaces to the UI.
        const normalizedArtifact = decodeURIComponent(rawName || "").trim().toLowerCase();
        if (normalizedArtifact === "measurements" || normalizedArtifact === "measurements.json") {
          const mergedResponse = await handleCaseMeasurementsWithOverrides(caseId, env, request);
          if (mergedResponse.status !== 404) {
            return respond(mergedResponse);
          }
          return respond(await handleCaseResultArtifact(caseId, rawName, env));
        }
        const defaultArtifactResponse = await handleCaseArtifactById(
          getDefaultCaseStore(env, request),
          getBuildVersion(),
          caseId,
          rawName
        );
        if (defaultArtifactResponse.status !== 404) {
          return respond(defaultArtifactResponse);
        }
        return respond(await handleCaseResultArtifact(caseId, rawName, env));
      }

      if (request.method === "GET" && /^\/api\/cases\/[^/]+\/meshes\/[^/]+$/.test(path)) {
        const parts = path.split("/");
        const caseId = decodeURIComponent(parts[3] || "");
        const rawName = parts[5] || "";
        return respond(await handleCaseMeshById(getDefaultCaseStore(env, request), caseId, rawName));
      }

      if (request.method === "GET" && path.startsWith("/api/cases/default_clinical_case/reports/")) {
        const name = path.split("/").pop() || "report.pdf";
        return respond(await handleDefaultCaseReport(getDefaultCaseStore(env, request), name));
      }

      if (request.method === "GET" && path.startsWith("/api/cases/default_clinical_case/imaging/")) {
        const name = path.split("/").pop() || "ct_showcase_root_roi.nii.gz";
        return respond(await handleDefaultCaseImaging(getDefaultCaseStore(env, request), name));
      }

      if (request.method === "GET" && path.startsWith("/api/cases/default_clinical_case/qa/")) {
        const name = path.split("/").pop() || "";
        return respond(await handleDefaultCaseQa(getDefaultCaseStore(env, request), name));
      }

      if (request.method === "GET" && path === "/demo/latest-case") {
        return respond(await getLatestDemoCase(env, request));
      }

      if (request.method === "GET" && path === "/providers/inference-health") {
        return respond(await getInferenceProviderHealth(env));
      }

      if (request.method === "POST" && path === "/upload-url") {
        const payload = await readJson(request);
        return respond(await createUploadUrl(payload, env));
      }

      if (request.method === "POST" && path === "/api/upload") {
        return respond(await uploadCaseMultipart(request, env));
      }

      if (request.method === "PUT" && path.startsWith("/upload/")) {
        const sessionId = path.split("/").pop();
        return respond(await consumeUploadSession(request, env, sessionId ?? ""));
      }

      if (request.method === "POST" && path === "/jobs") {
        const payload = await readJson(request);
        return respond(await createJob(payload, env));
      }

      if (request.method === "POST" && path === "/api/jobs") {
        const payload = await readJson(request);
        return respond(await createJob(payload, env));
      }

      if (request.method === "GET" && /^\/api\/jobs\/[^/]+\/status$/.test(path)) {
        const parts = path.split("/");
        const jobId = decodeURIComponent(parts[3] || "");
        return respond(await getJobStatus(jobId, env));
      }

      if (request.method === "POST" && /^\/api\/jobs\/[^/]+\/status$/.test(path)) {
        const parts = path.split("/");
        const jobId = decodeURIComponent(parts[3] || "");
        const payload = await readJson(request);
        return respond(await updateJobStatusFromProvider(request, jobId, payload, env));
      }

      if (request.method === "POST" && /^\/api\/jobs\/[^/]+\/callback$/.test(path)) {
        const parts = path.split("/");
        const jobId = decodeURIComponent(parts[3] || "");
        const payload = await readJson(request);
        return respond(await handleSimpleJobCallback(request, jobId, payload, env));
      }

      if (request.method === "GET" && /^\/api\/jobs\/[^/]+\/input$/.test(path)) {
        const parts = path.split("/");
        const jobId = decodeURIComponent(parts[3] || "");
        return respond(await streamJobInputForProvider(request, jobId, env));
      }

      if (request.method === "GET" && /^\/api\/jobs\/[^/]+$/.test(path)) {
        const parts = path.split("/");
        const jobId = decodeURIComponent(parts[3] || "");
        return respond(await getJob(jobId, env));
      }

      if ((request.method === "GET" || request.method === "HEAD") && /^\/studies\/[^/]+\/raw(?:\/[^/]+)?$/.test(path)) {
        const parts = path.split("/");
        return respond(await streamStudyRaw(request, parts[2] ?? "", env));
      }

      if (request.method === "GET" && path.startsWith("/studies/") && path.endsWith("/meta")) {
        const parts = path.split("/");
        return respond(await getStudyMeta(parts[2] ?? "", env));
      }

      if (request.method === "GET" && path.startsWith("/studies/") && path.endsWith("/repository")) {
        const parts = path.split("/");
        return respond(await getStudyRepository(parts[2] ?? "", env));
      }

      if (request.method === "GET" && path.startsWith("/workstation/cases/")) {
        const parts = path.split("/");
        return respond(await getWorkstationCase(parts[3] ?? "", env, request));
      }

      if (request.method === "GET" && path.startsWith("/jobs/") && path.includes("/artifacts/")) {
        const parts = path.split("/");
        return respond(await streamJobArtifact(request, parts[2] ?? "", parts[4] ?? "", env));
      }

      if (request.method === "GET" && path.startsWith("/jobs/")) {
        const jobId = path.split("/").pop();
        return respond(await getJob(jobId ?? "", env));
      }

      if (request.method === "POST" && path === "/callbacks/inference") {
        const payload = (await readJson(request)) as InferenceCallbackPayload;
        return respond(await handleInferenceCallback(request, payload, env));
      }

      if (request.method === "POST" && path === "/providers/mock-inference") {
        const payload = await readJson(request);
        return respond(await handleMockInferenceProvider(payload));
      }

      return respond(json({ error: "not_found" }, 404));
    } catch (error) {
      return respond(json({ error: "internal_error", message: asError(error).message }, 500));
    }
  },

  async queue(batch: MessageBatch<SegQueuePayload>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      await processSegmentationJob(msg.body, env);
      msg.ack();
    }
  }
} satisfies ExportedHandler<Env, SegQueuePayload>;

async function createUploadUrl(payload: any, env: Env): Promise<Response> {
  const studyId = stringOr(payload.study_id, "").trim() || crypto.randomUUID();
  const filename = stringOr(payload.filename, "scan.nii.gz").trim();
  const safeFilename = sanitizeFilename(filename);
  const objectKey = `studies/${studyId}/raw/${Date.now()}-${safeFilename}`;
  const now = Date.now();
  const ttlSec = parseInt(env.UPLOAD_URL_TTL_SECONDS || "900", 10);
  const expiresAt = new Date(now + ttlSec * 1000).toISOString();
  const sessionId = crypto.randomUUID();
  const uploadToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const tokenHash = await sha256Hex(uploadToken);

  await env.DB.prepare(
    `INSERT INTO studies (id, patient_code, source_dataset, image_key, image_format, modality, phase)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(id) DO UPDATE SET
       patient_code = COALESCE(excluded.patient_code, studies.patient_code),
       source_dataset = COALESCE(excluded.source_dataset, studies.source_dataset),
       image_key = excluded.image_key,
       image_format = excluded.image_format,
       modality = excluded.modality,
       phase = excluded.phase,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(
      studyId,
      nullableString(payload.patient_code),
      nullableString(payload.source_dataset),
      objectKey,
      stringOr(payload.image_format, "nifti"),
      stringOr(payload.modality, "CTA"),
      nullableString(payload.phase)
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO upload_sessions (id, study_id, object_key, upload_token_hash, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(sessionId, studyId, objectKey, tokenHash, expiresAt)
    .run();

  await upsertStudyRepository(
    env,
    studyId,
    {
      upload_request: {
        filename: safeFilename,
        modality: stringOr(payload.modality, "CTA"),
        image_format: stringOr(payload.image_format, "nifti"),
        source_dataset: nullableString(payload.source_dataset),
        phase: nullableString(payload.phase),
        created_at: new Date().toISOString(),
      },
      repository: {
        raw_object_key: objectKey,
      },
    },
    {
      rawFilename: safeFilename,
      ingestionFormat: stringOr(payload.image_format, "nifti"),
    }
  );

  return json(
    {
      study_id: studyId,
      session_id: sessionId,
      expires_at: expiresAt,
      upload_url: `/upload/${sessionId}?token=${uploadToken}`,
      method: "PUT"
    },
    201
  );
}

function handleMockInferenceProvider(payload: Record<string, unknown>): Response {
  const jobId = stringOr(payload.job_id, "").trim() || crypto.randomUUID();
  const studyId = stringOr(payload.study_id, "").trim() || "unknown-study";
  const model = "mock-webhook-provider-v1";
  const now = new Date().toISOString();

  return json(
    {
      status: "succeeded",
      job_id: jobId,
      provider_job_id: `mock-${Date.now()}`,
      result_json: {
        model,
        study_id: studyId,
        generated_at: now,
        labels: {
          0: "LVOT/background",
          1: "aortic_root",
          2: "leaflets",
          3: "ascending_aorta"
        }
      },
      metrics: [
        { name: "provider_inference_seconds", value: 0.6, unit: "s" },
        { name: "provider_total_seconds", value: 0.9, unit: "s" }
      ]
    },
    200
  );
}

async function consumeUploadSession(request: Request, env: Env, sessionId: string): Promise<Response> {
  if (!sessionId) return json({ error: "invalid_session" }, 400);

  const token = new URL(request.url).searchParams.get("token") || "";
  if (!token) return json({ error: "missing_token" }, 400);

  const row = await env.DB.prepare(
    `SELECT study_id, object_key, upload_token_hash, expires_at, consumed
     FROM upload_sessions WHERE id = ?1`
  )
    .bind(sessionId)
    .first<{
      study_id: string;
      object_key: string;
      upload_token_hash: string;
      expires_at: string;
      consumed: number;
    }>();

  if (!row) return json({ error: "session_not_found" }, 404);
  if (row.consumed) return json({ error: "session_already_used" }, 409);
  if (Date.parse(row.expires_at) < Date.now()) return json({ error: "session_expired" }, 410);

  const tokenHash = await sha256Hex(token);
  if (tokenHash !== row.upload_token_hash) return json({ error: "invalid_token" }, 401);

  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  if (!bodyBytes.byteLength) return json({ error: "missing_body" }, 400);
  const putResult = await env.R2_RAW.put(row.object_key, bodyBytes, {
    httpMetadata: {
      contentType: request.headers.get("content-type") || "application/octet-stream"
    }
  });

  await env.DB.prepare(`UPDATE upload_sessions SET consumed = 1 WHERE id = ?1`).bind(sessionId).run();
  await env.DB.prepare(`UPDATE studies SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1`).bind(row.study_id).run();
  await upsertStudyRepository(
    env,
    String(row.study_id),
    {
      upload_result: {
        etag: putResult?.etag ?? null,
        version: putResult?.version ?? null,
        uploaded_at: new Date().toISOString(),
        content_type: request.headers.get("content-type") || "application/octet-stream",
      },
    },
    {
      imageBytes: bodyBytes.byteLength,
      imageSha256: await sha256HexFromBytes(bodyBytes),
    }
  );

  return json({
    ok: true,
    study_id: row.study_id,
    etag: putResult?.etag ?? null,
    version: putResult?.version ?? null
  });
}

async function uploadCaseMultipart(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const fileCandidate = form.get("file") ?? form.get("ct") ?? form.get("scan");
  if (!(fileCandidate instanceof File)) {
    return json({ error: "missing_file" }, 400);
  }
  const bytes = new Uint8Array(await fileCandidate.arrayBuffer());
  if (!bytes.byteLength) return json({ error: "missing_body" }, 400);

  const maxInputBytes = parsePositiveInt(env.INFERENCE_MAX_INPUT_BYTES, 100 * 1024 * 1024);
  if (bytes.byteLength > maxInputBytes) {
    return json({ error: "input_too_large", max_bytes: maxInputBytes }, 413);
  }

  const patientId = stringOr(form.get("patient_id"), "").trim() || null;
  const studyId = stringOr(form.get("study_id"), "").trim() || crypto.randomUUID();
  const { filename, imageFormat } = normalizeUploadFileDescriptor(
    sanitizeFilename(fileCandidate.name || "upload.nii.gz"),
    fileCandidate.type || ""
  );
  const objectKey = `studies/${studyId}/raw/${Date.now()}-${filename}`;

  await env.R2_RAW.put(objectKey, bytes, {
    httpMetadata: {
      contentType: fileCandidate.type || "application/octet-stream",
    },
  });

  await env.DB.prepare(
    `INSERT INTO studies (id, patient_code, source_dataset, image_key, image_format, modality, phase)
     VALUES (?1, ?2, ?3, ?4, ?5, 'CTA', ?6)
     ON CONFLICT(id) DO UPDATE SET
       patient_code = COALESCE(excluded.patient_code, studies.patient_code),
       source_dataset = COALESCE(excluded.source_dataset, studies.source_dataset),
       image_key = excluded.image_key,
       image_format = excluded.image_format,
       phase = COALESCE(excluded.phase, studies.phase),
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(
      studyId,
      patientId,
      "web_upload",
      objectKey,
      imageFormat,
      nullableString(form.get("phase"))
    )
    .run();

  await upsertStudyRepository(
    env,
    studyId,
    {
      upload_request: {
        filename,
        source_dataset: "web_upload",
        phase: nullableString(form.get("phase")),
        created_at: new Date().toISOString(),
      },
      upload_result: {
        uploaded_at: new Date().toISOString(),
        content_type: fileCandidate.type || "application/octet-stream",
      },
      repository: {
        raw_object_key: objectKey,
      },
    },
    {
      rawFilename: filename,
      ingestionFormat: imageFormat,
      imageBytes: bytes.byteLength,
      imageSha256: await sha256HexFromBytes(bytes),
    }
  );

  const jobId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO jobs (id, study_id, job_type, status, model_tag)
     VALUES (?1, ?2, 'segmentation_v1', 'queued', ?3)`
  )
    .bind(jobId, studyId, "submit_case_ui")
    .run();

  await tryUpdateJobExtendedFields(env, jobId, {
    patient_id: patientId,
    r2_key: objectKey,
    progress: 0,
    result_case_id: null,
    updated_at: new Date().toISOString(),
  });

  const queuePayload: SegQueuePayload = {
    job_id: jobId,
    study_id: studyId,
    image_key: objectKey,
    patient_id: patientId,
    requested_at: new Date().toISOString(),
  };
  await env.SEG_QUEUE.send(queuePayload);

  return json({ job_id: jobId, upload_key: objectKey }, 201);
}

async function createJob(payload: any, env: Env): Promise<Response> {
  const studyId = stringOr(payload.study_id, "").trim();
  if (!studyId) return json({ error: "missing_study_id" }, 400);

  const study = await env.DB.prepare(`SELECT id, image_key, patient_code FROM studies WHERE id = ?1`)
    .bind(studyId)
    .first<{ id: string; image_key: string; patient_code?: string }>();

  if (!study) return json({ error: "study_not_found" }, 404);

  const jobId = crypto.randomUUID();
  const jobType = stringOr(payload.job_type, "segmentation_v1");
  const modelTag = nullableString(payload.model_tag);

  await env.DB.prepare(
    `INSERT INTO jobs (id, study_id, job_type, status, model_tag)
     VALUES (?1, ?2, ?3, 'queued', ?4)`
  )
    .bind(jobId, studyId, jobType, modelTag)
    .run();

  await tryUpdateJobExtendedFields(env, jobId, {
    patient_id: nullableString(study.patient_code),
    r2_key: study.image_key,
    progress: 0,
    stage: "queued",
    result_case_id: null,
    updated_at: new Date().toISOString(),
  });

  const queuePayload: SegQueuePayload = {
    job_id: jobId,
    study_id: studyId,
    image_key: study.image_key,
    patient_id: nullableString(study.patient_code),
    requested_at: new Date().toISOString()
  };

  await env.SEG_QUEUE.send(queuePayload);

  return json({ job_id: jobId, status: "queued" satisfies JobStatus }, 201);
}

async function getJob(jobId: string, env: Env): Promise<Response> {
  if (!jobId) return json({ error: "missing_job_id" }, 400);

  const job = await env.DB.prepare(
    `SELECT id, study_id, job_type, status, model_tag, error_message, created_at, started_at, finished_at
     FROM jobs WHERE id = ?1`
  )
    .bind(jobId)
    .first<Record<string, unknown>>();

  if (!job) return json({ error: "job_not_found" }, 404);

  const artifacts = await env.DB.prepare(
    `SELECT id, artifact_type, bucket, object_key, sha256, bytes, created_at
     FROM artifacts WHERE job_id = ?1 ORDER BY created_at ASC`
  )
    .bind(jobId)
    .all();

  const metrics = await env.DB.prepare(
    `SELECT id, metric_name, metric_value, unit, created_at
     FROM metrics WHERE job_id = ?1 ORDER BY created_at ASC`
  )
    .bind(jobId)
    .all();

  const links = await buildJobLinks(jobId, String(job.study_id), env);
  const resultArtifact = (artifacts.results as Array<Record<string, unknown>>).find(
    (a) => String(a.artifact_type || "") === "result_json"
  );
  const resultObjectKey = typeof resultArtifact?.object_key === "string" ? resultArtifact.object_key : null;
  let resultPayload: Record<string, unknown> | null = null;
  if (resultObjectKey) {
    const resultObj = await env.R2_MASK.get(resultObjectKey);
    if (resultObj) {
      resultPayload = safeJsonObject(await resultObj.text());
    }
  }
  const pipelineRun = await resolvePipelineRun(jobId, env, resultPayload);

  return json({
    ...job,
    artifacts: (artifacts.results as Array<Record<string, unknown>>).map((row) => toPublicArtifactRecord(row)),
    metrics: metrics.results,
    links,
    pipeline_run: pipelineRun
  });
}

async function tryUpdateJobExtendedFields(
  env: Env,
  jobId: string,
  fields: {
    patient_id?: string | null;
    r2_key?: string | null;
    progress?: number | null;
    result_case_id?: string | null;
    stage?: string | null;
    updated_at?: string | null;
  }
): Promise<void> {
  const nowIso = fields.updated_at || new Date().toISOString();
  try {
    await env.DB.prepare(
      `UPDATE jobs
       SET patient_id = COALESCE(?2, patient_id),
           r2_key = COALESCE(?3, r2_key),
           progress = COALESCE(?4, progress),
           result_case_id = COALESCE(?5, result_case_id),
           stage = COALESCE(?6, stage),
           updated_at = ?7
       WHERE id = ?1`
    )
      .bind(jobId, fields.patient_id ?? null, fields.r2_key ?? null, fields.progress ?? null, fields.result_case_id ?? null, fields.stage ?? null, nowIso)
      .run();
  } catch {
    // Backward-compatible path for environments without Sprint 10 migration.
    await env.DB.prepare(`UPDATE jobs SET status = status WHERE id = ?1`).bind(jobId).run();
  }
}

async function getJobStatus(jobId: string, env: Env): Promise<Response> {
  if (!jobId) return json({ error: "missing_job_id" }, 400);
  const row = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?1`).bind(jobId).first<Record<string, unknown>>();
  if (!row) return json({ error: "job_not_found" }, 404);
  const status = String(row.status || "queued");
  const progress = Number(row.progress ?? (status === "queued" ? 0 : status === "running" ? 45 : status === "succeeded" ? 100 : 100));
  const resultCaseId = nullableString(row.result_case_id) || (status === "succeeded" ? String(row.id || "") : null);
  const stage = nullableString(row.stage) || null;
  return json({
    job_id: String(row.id || jobId),
    status,
    progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0,
    result_case_id: resultCaseId,
    stage,
    error_message: nullableString(row.error_message),
  });
}

async function updateJobStatusFromProvider(request: Request, jobId: string, payload: any, env: Env): Promise<Response> {
  const expectedSecret = (env.PROVIDER_SECRET || "").trim();
  if (expectedSecret) {
    const provided = request.headers.get("x-callback-secret") || request.headers.get("x-provider-secret") || "";
    if (provided !== expectedSecret) return json({ error: "unauthorized_provider" }, 401);
  }
  const statusRaw = stringOr(payload?.status, "").toLowerCase();
  const stage = nullableString(payload?.stage);
  const progressRaw = Number(payload?.progress);
  const progress = Number.isFinite(progressRaw) ? Math.max(0, Math.min(100, Math.round(progressRaw))) : null;
  const mappedStatus: JobStatus =
    statusRaw === "failed"
      ? "failed"
      : statusRaw === "completed" || statusRaw === "succeeded"
        ? "succeeded"
        : "running";

  await env.DB.prepare(
    `UPDATE jobs
     SET status = ?2, error_message = CASE WHEN ?2 = 'failed' THEN COALESCE(?3, error_message) ELSE NULL END
     WHERE id = ?1`
  )
    .bind(jobId, mappedStatus, nullableString(payload?.detail) || nullableString(payload?.error_message))
    .run();

  await tryUpdateJobExtendedFields(env, jobId, {
    progress,
    stage,
    result_case_id: nullableString(payload?.result_case_id),
    updated_at: new Date().toISOString(),
  });
  return getJobStatus(jobId, env);
}

async function handleSimpleJobCallback(request: Request, jobId: string, payload: any, env: Env): Promise<Response> {
  const expectedSecret = (env.PROVIDER_SECRET || "").trim();
  if (expectedSecret) {
    const provided = request.headers.get("x-callback-secret") || request.headers.get("x-provider-secret") || "";
    if (provided !== expectedSecret) return json({ error: "unauthorized_callback" }, 401);
  }
  const statusRaw = stringOr(payload?.status, "").toLowerCase();
  if (!statusRaw) return json({ error: "missing_status" }, 400);

  if (statusRaw === "failed") {
    await markJobFailed(env, jobId, stringOr(payload?.error_message, "provider_reported_failure"));
    await tryUpdateJobExtendedFields(env, jobId, {
      progress: 100,
      stage: "failed",
      result_case_id: nullableString(payload?.result_case_id),
      updated_at: new Date().toISOString(),
    });
    return json({ ok: true, job_id: jobId, status: "failed" });
  }

  const resultCaseId = nullableString(payload?.result_case_id) || jobId;
  const caseResult = await hydrateCaseResultRow(env, resultCaseId, jobId);
  const readiness = evaluateCaseDisplayReadiness({
    measurements: caseResult?.measurements_json ?? null,
    planning: caseResult?.planning_json ?? null,
    artifactTypes: await getJobArtifactTypeSet(env, jobId),
  });

  await env.DB.prepare(`UPDATE jobs SET status = 'succeeded', finished_at = ?2, error_message = NULL WHERE id = ?1`)
    .bind(jobId, new Date().toISOString())
    .run();
  await tryUpdateJobExtendedFields(env, jobId, {
    progress: 100,
    stage: readiness.display_ready ? "completed" : "completed_incomplete",
    result_case_id: resultCaseId,
    updated_at: new Date().toISOString(),
  });
  return json({ ok: true, job_id: jobId, status: "succeeded" });
}

async function streamJobInputForProvider(request: Request, jobId: string, env: Env): Promise<Response> {
  const expectedSecret = (env.PROVIDER_SECRET || "").trim();
  if (expectedSecret) {
    const provided = request.headers.get("x-provider-secret") || request.headers.get("x-callback-secret") || "";
    if (provided !== expectedSecret) return json({ error: "unauthorized_provider" }, 401);
  }
  const row = await env.DB.prepare(`SELECT study_id FROM jobs WHERE id = ?1`).bind(jobId).first<{ study_id: string }>();
  if (!row?.study_id) return json({ error: "job_not_found" }, 404);
  const study = await env.DB.prepare(`SELECT image_key FROM studies WHERE id = ?1`).bind(row.study_id).first<{ image_key: string }>();
  if (!study?.image_key) return json({ error: "study_not_found" }, 404);
  const obj = await env.R2_RAW.get(study.image_key);
  if (!obj?.body) return json({ error: "raw_object_not_found" }, 404);

  const headers = new Headers(jsonHeaders);
  const contentType = obj.httpMetadata?.contentType || "application/octet-stream";
  headers.set("content-type", contentType);
  headers.set("content-disposition", `inline; filename=\"${sanitizeFilename(study.image_key.split("/").pop() || "input.nii.gz")}\"`);
  return new Response(obj.body, { status: 200, headers });
}

async function getLatestDemoCase(env: Env, request: Request): Promise<Response> {
  try {
    return await getLatestDemoCaseLegacy(env, request);
  } catch (error) {
    console.error("latest-case lookup failed", error instanceof Error ? error.message : String(error));
    return json({ error: "latest_case_lookup_failed" }, 503);
  }
}

async function getLatestDemoCaseLegacy(env: Env, request: Request): Promise<Response> {
  try {
    const primaryCase = await hydrateCaseResultRow(env, PRIMARY_REAL_CASE_ID, PRIMARY_REAL_CASE_ID);
    if (primaryCase?.case_id || primaryCase?.job_id) {
      const workstationResponse = await getWorkstationCase(PRIMARY_REAL_CASE_ID, env, request);
      if (workstationResponse.ok) {
        const workstationPayload = await workstationResponse.clone().json() as Record<string, unknown>;
        return json(buildLatestCaseSummaryFromWorkstationPayload(workstationPayload));
      }
    }
  } catch {
    // Fall through to historical latest-case lookup.
  }

  const jobRows = await env.DB.prepare(
    `SELECT
       j.id,
       j.study_id,
       j.result_case_id,
       j.status,
       j.model_tag,
       j.created_at,
       j.started_at,
       j.finished_at,
       EXISTS(
         SELECT 1 FROM artifacts a
         WHERE a.job_id = j.id AND a.artifact_type IN ('segmentation_mask_nifti', 'mask_output', 'mask_multiclass')
       ) AS has_seg
     FROM jobs j
     WHERE j.status = 'succeeded'
     ORDER BY
       COALESCE(j.updated_at, j.finished_at, j.started_at, j.created_at) DESC
     LIMIT 20`
  ).all<Record<string, unknown>>();

  const candidates = Array.isArray(jobRows.results) ? jobRows.results : [];

  for (const candidate of candidates) {
    try {
      const studyId = String(candidate.study_id || "");
      if (!studyId) continue;
      const candidateStudy = await env.DB.prepare(`SELECT id, image_key, source_dataset, phase FROM studies WHERE id = ?1`)
        .bind(studyId)
        .first<{ id: string; image_key: string; source_dataset: string | null; phase: string | null }>();
      const imageKey = String(candidateStudy?.image_key || "").trim();
      if (!imageKey) continue;
      const head = await env.R2_RAW.head(imageKey);
      if (!head?.size) continue;
      const caseId = nullableString(candidate.result_case_id) || String(candidate.id || "").trim();
      if (!caseId) continue;
      const caseResult = await hydrateCaseResultRow(env, caseId, String(candidate.id || "").trim());
      const artifactTypes = await getJobArtifactTypeSet(env, String(candidate.id || "").trim());
      const readiness = evaluateCaseDisplayReadiness({
        measurements: caseResult?.measurements_json ?? null,
        planning: caseResult?.planning_json ?? null,
        artifactTypes,
      });
      const measurementsObject = parseJsonColumn(caseResult?.measurements_json);
      const gate = derivePublishedCaseGate(readiness, measurementsObject?.pears_geometry);
      if (!gate.display_ready) continue;
      const workstationResponse = await getWorkstationCase(String(candidate.id || "").trim(), env, request);
      if (!workstationResponse.ok) continue;
      const workstationPayload = await workstationResponse.clone().json() as Record<string, unknown>;
      return json(buildLatestCaseSummaryFromWorkstationPayload(workstationPayload));
    } catch {
      continue;
    }
  }

  return json({ error: "no_display_ready_case_yet" }, 404);
}

async function getWorkstationCase(jobId: string, env: Env, request: Request): Promise<Response> {
  if (!jobId) return json({ error: "missing_job_id" }, 400);
  if (jobId === DEFAULT_CASE_ID) {
    return handleDefaultCaseWorkstation(getDefaultCaseStore(env, request), getBuildVersion());
  }

  let resolvedCaseId = jobId;
  let caseResultRow = await hydrateCaseResultRow(env, jobId, jobId);
  let job = await env.DB.prepare(
    `SELECT id, study_id, job_type, status, model_tag, error_message, result_case_id, created_at, started_at, finished_at, updated_at
     FROM jobs WHERE id = ?1`
  )
    .bind(jobId)
    .first<Record<string, unknown>>();
  if (!job && caseResultRow?.job_id) {
    job = await env.DB.prepare(
      `SELECT id, study_id, job_type, status, model_tag, error_message, result_case_id, created_at, started_at, finished_at, updated_at
       FROM jobs WHERE id = ?1`
    )
      .bind(caseResultRow.job_id)
      .first<Record<string, unknown>>();
  }
  if (!job && caseResultRow?.case_id) {
    job = await env.DB.prepare(
      `SELECT id, study_id, job_type, status, model_tag, error_message, result_case_id, created_at, started_at, finished_at, updated_at
       FROM jobs WHERE result_case_id = ?1
       ORDER BY COALESCE(updated_at, created_at) DESC
       LIMIT 1`
    )
      .bind(caseResultRow.case_id)
      .first<Record<string, unknown>>();
  }
  if (!job) return json({ error: "job_not_found" }, 404);
  if (!caseResultRow) {
    const rowCaseId = nullableString(job.result_case_id);
    if (rowCaseId) {
      caseResultRow = await hydrateCaseResultRow(env, rowCaseId, String(job.id));
      if (caseResultRow?.case_id) resolvedCaseId = caseResultRow.case_id;
    }
  } else {
    resolvedCaseId = caseResultRow.case_id;
  }

  const study = await env.DB.prepare(
    `SELECT id, patient_code, source_dataset, image_key, image_format, modality, phase, created_at, updated_at
     FROM studies WHERE id = ?1`
  )
    .bind(String(job.study_id))
    .first<Record<string, unknown>>();
  if (!study) return json({ error: "study_not_found" }, 404);

  const repository = await safeFirst(
    env.DB.prepare(
      `SELECT raw_filename, image_bytes, image_sha256, ingestion_format, metadata_json, created_at, updated_at
       FROM study_repository WHERE study_id = ?1`
    )
      .bind(String(study.id))
      .first<Record<string, unknown>>()
  );
  const artifactRows = await safeAll(
    env.DB.prepare(
      `SELECT artifact_type FROM artifacts WHERE job_id = ?1 ORDER BY created_at ASC`
    )
      .bind(String(job.id))
      .all()
  );
  const artifactTypes = new Set(
    artifactRows.map((row) => String(row.artifact_type || "").trim()).filter(Boolean)
  );
  const links = await buildJobLinks(String(job.id), String(study.id), env);
  const caseResultMeasurements = parseJsonColumn(caseResultRow?.measurements_json);
  const caseResultPlanning = parseJsonColumn(caseResultRow?.planning_json);
  const rawHead = await env.R2_RAW.head(String(study.image_key));
  const resultJson = await readArtifactJson(env, String(job.id), "result_json");
  const measurementsJson = await readArtifactJson(env, String(job.id), "measurements_json");
  const modelJson = await readArtifactJson(env, String(job.id), "aortic_root_model_json");
  const annulusPlaneJson = await readArtifactJson(env, String(job.id), "annulus_plane_json");
  const centerlineJson = await readArtifactJson(env, String(job.id), "centerline_json");
  const leafletModelJson = await readArtifactJson(env, String(job.id), "leaflet_model_json");
  const effectiveMeasurementsJson = measurementsJson || caseResultMeasurements;

  const pipelineRun = await resolvePipelineRun(String(job.id), env, resultJson);
  const model = pickObject(modelJson) || {};
  const measurements = pickObject(effectiveMeasurementsJson) || pickObject(resultJson?.measurements) || pickObject(resultJson) || null;
  const measurementContract =
    pickObject(effectiveMeasurementsJson?.measurement_contract)
    || pickObject(resultJson?.measurement_contract)
    || pickObject(resultJson?.planning_evidence)
    || null;
  const planningEvidence =
    pickObject(effectiveMeasurementsJson?.planning_evidence)
    || pickObject(resultJson?.planning_evidence)
    || null;

  const annulusPlane = normalizePlaneDefinition(
    pickObject(annulusPlaneJson)
    || pickObject(model.annulus_plane)
    || pickObject(model.annulus_ring),
    "annulus"
  );
  const stjPlane = normalizePlaneDefinition(
    pickObject(model.sinotubular_junction),
    "stj"
  );
  const centerline =
    normalizeCenterline(centerlineJson)
    || normalizeCenterline(model.centerline);
  const bootstrapPoint =
    toPointArray(annulusPlane?.origin_world)
    || toPointArray(stjPlane?.origin_world)
    || (Array.isArray(centerline?.points_world) && centerline.points_world.length ? toPointArray(centerline.points_world[0]) : null);
  const initialCenterlineIndex = Number.isFinite(Number(annulusPlane?.source_index))
    ? Number(annulusPlane?.source_index)
    : 0;
  const volumeSourceKind = inferVolumeSourceKind(study, repository);
  const runtimeWarnings: string[] = [];
  if (centerlineJson && !("points_world" in centerlineJson) && "points" in centerlineJson) {
    runtimeWarnings.push("legacy_centerline_payload");
  }
  if (pipelineRun?.inferred) {
    runtimeWarnings.push("historical_pipeline_run_inferred");
  }
  const cprReferenceJson = artifactTypes.has("cpr_reference_json")
    ? await readArtifactJson(env, String(job.id), "cpr_reference_json")
    : null;
  const hasCprNifti = artifactTypes.has("cpr_straightened_nifti");
  const cprSources = (cprReferenceJson || hasCprNifti)
    ? sanitizePublicValue({
        source: hasCprNifti ? "artifact" : "reference_only",
        inferred: false,
        reference_json: cprReferenceJson,
        straightened_nifti: hasCprNifti ? links.cpr_straightened_nifti : null,
      })
    : null;
  const coronaryOstiaSummary = buildCoronaryOstiaSummary(model, effectiveMeasurementsJson);
  const leafletGeometrySummary = buildLeafletGeometrySummary(model, leafletModelJson);
  const pearsGeometryArtifact = pickObject(effectiveMeasurementsJson?.pears_geometry);
  const pearsGeometryFallback = pearsGeometryArtifact ? null : derivePearsGeometryFromModel(model);
  const planningPayload =
    pickObject(caseResultPlanning)
    || pickObject(effectiveMeasurementsJson?.planning)
    || deriveLegacyPlanningPayload(effectiveMeasurementsJson, coronaryOstiaSummary, leafletGeometrySummary, pearsGeometryArtifact || pearsGeometryFallback);
  const qualityGates =
    pickObject(effectiveMeasurementsJson?.quality_gates)
    || deriveLegacyQualityGates(effectiveMeasurementsJson);
  const planningSummary = {
    tavi_status: summarizePlanningSection(pickObject(planningPayload?.tavi)),
    vsrr_status: summarizePlanningSection(pickObject(planningPayload?.vsrr)),
    pears_status: summarizePlanningSection(pickObject(planningPayload?.pears)),
  };
  const uncertaintySummary = deriveLegacyUncertaintySummary(planningPayload, qualityGates);
  const capabilityState = {
    cpr: {
      available: Boolean(hasCprNifti),
      inferred: false,
      legacy: false,
      source: hasCprNifti ? "artifact" : "unavailable",
      reason: hasCprNifti ? null : "cpr_artifact_missing",
    },
    coronary_ostia: {
      available: Boolean(coronaryOstiaSummary && coronaryOstiaSummary.source !== "unavailable"),
      inferred: false,
      legacy: false,
      source: coronaryOstiaSummary?.source || "unavailable",
      reason: coronaryOstiaSummary?.reason || null,
    },
    leaflet_geometry: {
      available: Boolean(leafletGeometrySummary && !leafletGeometrySummary.legacy),
      inferred: false,
      legacy: Boolean(leafletGeometrySummary?.legacy),
      source: leafletGeometrySummary?.source || "unavailable",
      reason: leafletGeometrySummary?.reason || null,
    },
    pears_geometry: {
      available: Boolean(pearsGeometryArtifact),
      inferred: Boolean(!pearsGeometryArtifact && pearsGeometryFallback),
      legacy: false,
      source: pearsGeometryArtifact ? "measurements_artifact" : pearsGeometryFallback ? "model_fallback" : "unavailable",
      reason: pearsGeometryArtifact ? null : pearsGeometryFallback ? "historical_model_fallback" : "pears_geometry_missing",
    },
  };
  if (!capabilityState.cpr.available) runtimeWarnings.push("cpr_artifact_missing");
  if (!capabilityState.coronary_ostia.available) runtimeWarnings.push("coronary_ostia_unavailable");
  if (capabilityState.leaflet_geometry.legacy) runtimeWarnings.push("leaflet_geometry_legacy_summary_only");
  if (capabilityState.pears_geometry.inferred) runtimeWarnings.push("pears_geometry_inferred_from_model");
  const qaFlags = {
    centerline_available: Array.isArray(centerline?.points_world) && centerline.points_world.length > 0,
    annulus_plane_available: Boolean(annulusPlane?.origin_world && annulusPlane?.normal_world),
    stj_plane_available: Boolean(stjPlane?.origin_world && stjPlane?.normal_world),
    leaflet_summary_available: Boolean(model.leaflet_meshes || leafletModelJson),
    coronary_ostia_available: capabilityState.coronary_ostia.available,
    cpr_available: capabilityState.cpr.available,
    pears_geometry_available: capabilityState.pears_geometry.available,
  };
  const downloads = buildLegacyDownloads(links, artifactTypes);
  const caseLinks = caseResultRow ? buildCaseResultLinks(resolvedCaseId) : null;
  const ctPreviewLinks = resolvedCaseId === PRIMARY_REAL_CASE_ID
    ? {
        ct_preview_axial_png: `/ct-preview/${PRIMARY_REAL_CASE_ID}/axial.png`,
        ct_preview_sagittal_png: `/ct-preview/${PRIMARY_REAL_CASE_ID}/sagittal.png`,
        ct_preview_coronal_png: `/ct-preview/${PRIMARY_REAL_CASE_ID}/coronal.png`,
      }
    : {};
  const downloadJsonLinks = [
    ...(Array.isArray(downloads.json) ? downloads.json : []),
    ...(caseResultMeasurements ? [{ label: "Measurements JSON", href: `/api/cases/${encodeURIComponent(resolvedCaseId)}/artifacts/measurements` }] : []),
    ...(caseResultPlanning ? [{ label: "Planning JSON", href: `/api/cases/${encodeURIComponent(resolvedCaseId)}/artifacts/planning` }] : []),
  ];
  const caseReadiness = evaluateCaseDisplayReadiness({
    measurements: caseResultRow?.measurements_json ?? caseResultMeasurements ?? null,
    planning: caseResultRow?.planning_json ?? caseResultPlanning ?? null,
    artifactTypes,
  });
  const caseGate = derivePublishedCaseGate(caseReadiness, pearsGeometryArtifact || pearsGeometryFallback);
  const acceptanceReview = buildAcceptanceReview({
    pipeline_run: pipelineRun,
    viewer_bootstrap: {
      runtime_requirements: {
        source_kind: volumeSourceKind,
        loader_kind: volumeSourceKind === "dicom_zip" ? "cornerstone-dicom-zip" : "cornerstone-nifti",
        supports_mpr: Boolean(links.raw_ct),
        supports_aux_plane: Boolean(qaFlags.annulus_plane_available || qaFlags.stj_plane_available || qaFlags.centerline_available),
        supports_cpr: capabilityState.cpr.available,
      },
      qa_flags: qaFlags,
      bootstrap_warnings: runtimeWarnings,
    },
    capabilities: capabilityState,
    downloads,
    planning: planningPayload,
    quality_gates: qualityGates,
    quality_gates_summary: qualityGates,
    coronary_ostia_summary: sanitizePublicValue(coronaryOstiaSummary),
    leaflet_geometry_summary: sanitizePublicValue(leafletGeometrySummary),
  });

  const isPrimaryRealCase = resolvedCaseId === PRIMARY_REAL_CASE_ID;
  const payload = {
    build_version: getBuildVersion(),
    case_id: resolvedCaseId,
    display_ready: caseGate.display_ready,
    completion_state: caseGate.completion_state,
    missing_requirements: caseReadiness.missing_requirements,
    status: caseGate.status,
    review_status: caseGate.review_status,
    pears_visual_ready: caseGate.pears_visual_ready,
    display_name: isPrimaryRealCase
      ? {
          "zh-CN": "Mao 术前真实 CTA",
          en: "Mao Preop Real CTA",
        }
      : {
          "zh-CN": "最新真实病例",
          en: "Latest Real Case",
        },
    case_role: isPrimaryRealCase ? ["primary_real_case", "pears_planning"] : ["latest", "legacy"],
    placeholder: false,
    not_real_cta: false,
    job,
    study_meta: {
      id: study.id,
      patient_code: study.patient_code,
      source_dataset: study.source_dataset,
      image_format: study.image_format,
      modality: study.modality,
      phase: study.phase,
      repository: repository
        ? {
            raw_filename: repository.raw_filename,
            image_bytes: repository.image_bytes,
            image_sha256: repository.image_sha256,
            ingestion_format: repository.ingestion_format,
            metadata: safeParseJsonText(repository.metadata_json),
          }
        : null,
    },
    pipeline_run: pipelineRun,
    links: {
      ...links,
      ...(caseLinks || {}),
      ...ctPreviewLinks,
      workstation: `/workstation/cases/${encodeURIComponent(resolvedCaseId)}`,
    },
    downloads: {
      ...downloads,
      json: downloadJsonLinks,
    },
    cpr_sources: cprSources,
    volume_source: {
      source_kind: volumeSourceKind,
      loader_kind: volumeSourceKind === "dicom_zip" ? "cornerstone-dicom-zip" : "cornerstone-nifti",
      signed_url: links.raw_ct,
      content_type: rawHead?.httpMetadata?.contentType || null,
      filename: String(repository?.raw_filename || String(study.image_key || "").split("/").pop() || ""),
      frame_of_reference_hint: readNestedString(model, ["phase_metadata", "frame_of_reference_uid"]),
      spacing_hint: readNumberArray(model.spacing_mm),
      direction_hint: readNumberArray(model.direction),
    },
    display_planes: {
      annulus: annulusPlane,
      stj: stjPlane,
      centerline: buildCenterlinePlane(centerline, initialCenterlineIndex),
    },
    viewer_bootstrap: {
      focus_world: bootstrapPoint,
      aux_mode: "annulus",
      centerline_index: initialCenterlineIndex,
      runtime_requirements: {
        source_kind: volumeSourceKind,
        loader_kind: volumeSourceKind === "dicom_zip" ? "cornerstone-dicom-zip" : "cornerstone-nifti",
        supports_mpr: Boolean(links.raw_ct),
        supports_aux_plane: Boolean(qaFlags.annulus_plane_available || qaFlags.stj_plane_available || qaFlags.centerline_available),
        supports_cpr: capabilityState.cpr.available,
      },
      qa_flags: qaFlags,
      bootstrap_warnings: runtimeWarnings,
    },
    centerline,
    model_landmarks_summary: buildModelLandmarksSummary(model, leafletModelJson),
    capabilities: capabilityState,
    coronary_ostia_summary: sanitizePublicValue(coronaryOstiaSummary),
    leaflet_geometry_summary: sanitizePublicValue(leafletGeometrySummary),
    measurement_contract: sanitizePublicValue(measurementContract),
    planning_evidence: sanitizePublicValue(planningEvidence),
    measurements: sanitizePublicValue(measurements),
    planning: sanitizePublicValue(planningPayload),
    aortic_root_model: sanitizePublicValue(modelJson || null),
    pears_geometry: sanitizePublicValue(
      pearsGeometryArtifact
      || pearsGeometryFallback
      || null
    ),
    quality_gates: sanitizePublicValue(qualityGates),
    quality_gates_summary: sanitizePublicValue(qualityGates),
    planning_summary: sanitizePublicValue(planningSummary),
    uncertainty_summary: sanitizePublicValue(uncertaintySummary),
    acceptance_review: acceptanceReview,
    clinical_review: acceptanceReview,
  };

  return json(payload);
}

/**
 * Derive a PEARS geometry payload directly from the aortic_root_model
 * when pears_planner_v3 output is not yet available in measurements.json.
 * Cloudflare-side fallback — pure arithmetic from stored landmarks.
 * Clinical basis: Treasure/Pepper criteria (Heart 2014), Conci 2025 (JTCVS Techniques)
 */
function derivePearsGeometryFromModel(model: Record<string, unknown>): Record<string, unknown> | null {
  if (!model || Object.keys(model).length === 0) return null;

  const annulusRing = pickObject(model.annulus_ring);
  const stj = pickObject(model.sinotubular_junction);
  const sinusPeaks = Array.isArray(model.sinus_peaks) ? model.sinus_peaks as Record<string, unknown>[] : [];
  const coronaryOstia = pickObject(model.coronary_ostia);

  // Annulus geometry (from hinge_curve PCA)
  const annMaxDiam = typeof annulusRing?.max_diameter_mm === 'number' ? Math.round(annulusRing.max_diameter_mm * 10) / 10 : null;
  const annMinDiam = typeof annulusRing?.min_diameter_mm === 'number' ? Math.round(annulusRing.min_diameter_mm * 10) / 10 : null;
  const annArea    = typeof annulusRing?.area_mm2 === 'number' ? Math.round(annulusRing.area_mm2 * 10) / 10 : null;
  const annEquivDiam = annArea ? Math.round(2 * Math.sqrt(annArea / Math.PI) * 10) / 10 : null;
  const annConf    = typeof annulusRing?.confidence === 'number' ? annulusRing.confidence : 0.5;

  // STJ geometry (from orthogonal section)
  // Real data uses max_diameter_mm / equivalent_diameter_mm; fallback to diameter_mm for legacy compatibility
  const stjMaxDiam = typeof stj?.max_diameter_mm === 'number' ? Math.round(stj.max_diameter_mm * 10) / 10 : null;
  const stjEquivDiam = typeof stj?.equivalent_diameter_mm === 'number' ? Math.round(stj.equivalent_diameter_mm * 10) / 10 : null;
  const stjDiam    = stjMaxDiam ?? (typeof stj?.diameter_mm === 'number' ? Math.round(stj.diameter_mm * 10) / 10 : null);
  const stjConf    = typeof stj?.confidence === 'number' ? stj.confidence : 0.5;

  // Sinus of Valsalva (from sinus_peaks radial profile)
  const sinusRadii = sinusPeaks
    .map((p) => typeof p.radius_mm === 'number' ? p.radius_mm : null)
    .filter((r): r is number => r !== null);
  const sinusMaxDiam = sinusRadii.length > 0 ? Math.round(Math.max(...sinusRadii) * 2 * 10) / 10 : null;
  const sinusMeanDiam = sinusRadii.length > 0
    ? Math.round(sinusRadii.reduce((a, b) => a + b, 0) / sinusRadii.length * 2 * 10) / 10
    : null;
  const sinusConf = sinusRadii.length >= 3 ? 0.75 : sinusRadii.length > 0 ? 0.5 : 0.2;

  // Coronary heights (from coronary_ostia)
  const lcaData = pickObject(coronaryOstia?.left_coronary ?? coronaryOstia?.left);
  const rcaData = pickObject(coronaryOstia?.right_coronary ?? coronaryOstia?.right);
  const lcaHeight = typeof lcaData?.height_above_annulus_mm === 'number' ? lcaData.height_above_annulus_mm
    : typeof lcaData?.height_mm === 'number' ? lcaData.height_mm : null;
  const rcaHeight = typeof rcaData?.height_above_annulus_mm === 'number' ? rcaData.height_above_annulus_mm
    : typeof rcaData?.height_mm === 'number' ? rcaData.height_mm : null;
  const lcaStatus = lcaHeight !== null ? 'measured' : 'estimated_statistical';
  const rcaStatus = rcaHeight !== null ? 'measured' : 'estimated_statistical';
  const lcaConf = lcaHeight !== null ? 0.75 : 0.3;
  const rcaConf = rcaHeight !== null ? 0.75 : 0.3;

  // Ascending aorta
  const ascDiam = typeof model.ascending_aorta_diameter_mm === 'number' ? model.ascending_aorta_diameter_mm
    : typeof pickObject(model.ascending_aorta)?.diameter_mm === 'number'
    ? (pickObject(model.ascending_aorta) as Record<string, unknown>).diameter_mm as number
    : null;

  // Eligibility criteria (Treasure/Pepper + Conci 2025)
  const criteria: Record<string, unknown>[] = [];
  let eligible = true;
  const riskFlags: string[] = [];

  // 1. Sinus diameter 40-55mm (primary indication, Treasure/Pepper)
  if (sinusMaxDiam !== null) {
    const met = sinusMaxDiam >= 40 && sinusMaxDiam <= 55;
    if (!met) eligible = false;
    criteria.push({
      id: 'sinus_diameter', label: 'Sinus diameter 40–55 mm',
      met, value_mm: sinusMaxDiam,
      severity: met ? 'ok' : (sinusMaxDiam < 40 ? 'not_indicated' : 'high_risk'),
      icon: met ? '✓' : '✗',
      message: met ? `${sinusMaxDiam} mm — within Treasure/Pepper range`
        : sinusMaxDiam < 40 ? `${sinusMaxDiam} mm — below 40 mm threshold (not indicated)`
        : `${sinusMaxDiam} mm — exceeds 55 mm (consider VSRR/Bentall)`,
    });
    if (sinusMaxDiam > 55) riskFlags.push('sinus_exceeds_55mm');
  } else {
    criteria.push({ id: 'sinus_diameter', label: 'Sinus diameter', met: null,
      severity: 'data_missing', icon: '?', message: 'Sinus measurement unavailable' });
  }

  // 2. STJ anatomy check
  if (stjDiam !== null && sinusMaxDiam !== null) {
    const met = stjDiam < sinusMaxDiam;
    criteria.push({
      id: 'stj_reference', label: 'STJ < Sinus (anatomy check)',
      met, value_mm: stjDiam,
      severity: met ? 'ok' : 'caution',
      icon: met ? '✓' : '⚠',
      message: met ? `STJ ${stjDiam} mm < Sinus ${sinusMaxDiam} mm — normal anatomy`
        : `STJ ${stjDiam} mm ≥ Sinus ${sinusMaxDiam} mm — verify anatomy`,
    });
  }

  // 3. LCA height ≥ 10mm
  if (lcaHeight !== null) {
    const met = lcaHeight >= 10;
    if (!met) { eligible = false; riskFlags.push('lca_low_origin'); }
    criteria.push({
      id: 'coronary_lca', label: 'LCA height ≥ 10 mm',
      met, value_mm: lcaHeight,
      severity: met ? 'ok' : 'high_risk',
      icon: met ? '✓' : '✗',
      message: met ? `LCA ${lcaHeight} mm — adequate clearance`
        : `LCA ${lcaHeight} mm — high risk of coronary compression`,
    });
  } else {
    criteria.push({ id: 'coronary_lca', label: 'LCA height ≥ 10 mm', met: null,
      severity: 'data_missing', icon: '?', message: 'LCA ostium not detected — manual verification required' });
  }

  // 4. RCA height ≥ 10mm
  if (rcaHeight !== null) {
    const met = rcaHeight >= 10;
    if (!met) { eligible = false; riskFlags.push('rca_low_origin'); }
    criteria.push({
      id: 'coronary_rca', label: 'RCA height ≥ 10 mm',
      met, value_mm: rcaHeight,
      severity: met ? 'ok' : 'high_risk',
      icon: met ? '✓' : '✗',
      message: met ? `RCA ${rcaHeight} mm — adequate clearance`
        : `RCA ${rcaHeight} mm — high risk of coronary compression`,
    });
  } else {
    criteria.push({ id: 'coronary_rca', label: 'RCA height ≥ 10 mm', met: null,
      severity: 'data_missing', icon: '?', message: 'RCA ostium not detected — manual verification required' });
  }

  // 5. Ascending aorta < 55mm
  if (ascDiam !== null) {
    const met = (ascDiam as number) < 55;
    if (!met) { eligible = false; riskFlags.push('ascending_exceeds_55mm'); }
    criteria.push({
      id: 'ascending_diameter', label: 'Ascending aorta < 55 mm',
      met, value_mm: ascDiam,
      severity: met ? 'ok' : 'high_risk',
      icon: met ? '✓' : '✗',
      message: met ? `Ascending ${ascDiam} mm — within range`
        : `Ascending ${ascDiam} mm — consider total arch replacement`,
    });
  }

  // 6. Annulus reference
  if (annMaxDiam !== null) {
    criteria.push({
      id: 'annulus_reference', label: 'Annulus (reference only)',
      met: true, value_mm: annMaxDiam,
      severity: 'info', icon: 'ℹ',
      message: `Annulus max ${annMaxDiam} mm — used for mesh sizing`,
    });
  }

  // Verdict
  const notIndicated = criteria.some((c) => c['severity'] === 'not_indicated');
  const hasHighRisk = riskFlags.length > 0;
  let status: string;
  let verdict: string;
  let riskLevel: string;

  if (notIndicated) {
    status = 'not_indicated'; verdict = 'NOT INDICATED'; eligible = false; riskLevel = 'none';
  } else if (!eligible) {
    status = 'not_indicated_risk'; verdict = 'NOT INDICATED — HIGH RISK'; riskLevel = 'high';
  } else if (hasHighRisk) {
    status = 'eligible_with_caution'; verdict = 'POTENTIALLY ELIGIBLE — CAUTION'; riskLevel = 'moderate';
  } else if (sinusMaxDiam === null) {
    status = 'data_insufficient'; verdict = 'DATA INSUFFICIENT'; riskLevel = 'unknown'; eligible = false;
  } else {
    status = 'potentially_eligible'; verdict = 'POTENTIALLY ELIGIBLE'; riskLevel = 'low';
  }

  // Mesh sizing (Conci 2025: 95% of measured inner diameter)
  const meshSizing: Record<string, unknown> = {};
  if (sinusMaxDiam !== null) {
    meshSizing.sinus_reference_mm = sinusMaxDiam;
    meshSizing.sinus_mesh_diameter_mm = Math.round(sinusMaxDiam * 0.95 * 10) / 10;
  }
  if (stjDiam !== null) {
    meshSizing.stj_reference_mm = stjDiam;
    meshSizing.stj_mesh_diameter_mm = Math.round(stjDiam * 0.95 * 10) / 10;
  }
  if (ascDiam !== null) {
    meshSizing.ascending_reference_mm = ascDiam;
    meshSizing.ascending_mesh_diameter_mm = Math.round((ascDiam as number) * 0.95 * 10) / 10;
  }

  // Support segment estimate
  const supportSegment: Record<string, unknown> = {};
  const sinusHeightObj = pickObject(model.sinus_height);
  const sinusHeight = typeof sinusHeightObj?.height_mm === 'number' ? sinusHeightObj.height_mm : null;
  if (sinusHeight !== null) {
    supportSegment.root_segment_mm = Math.round(sinusHeight * 10) / 10;
    if (ascDiam !== null) {
      supportSegment.ascending_segment_mm = Math.round((ascDiam as number) * 1.5 * 10) / 10;
      supportSegment.total_mm = Math.round((sinusHeight + (ascDiam as number) * 1.5) * 10) / 10;
    } else {
      supportSegment.total_mm = Math.round(sinusHeight * 10) / 10;
    }
    supportSegment.note = 'Estimate only — verify intraoperatively (Conci 2025)';
  }

  const summary = notIndicated
    ? `Sinus ${sinusMaxDiam ?? '?'} mm — below 40 mm threshold. PEARS not indicated.`
    : !eligible
    ? `Anatomical risk factors preclude PEARS. Review criteria.`
    : `Sinus ${sinusMaxDiam ?? '?'} mm — within Treasure/Pepper range (40–55 mm). Surgical planning required.`;

  return {
    module_version: 'pears_planner_v3.0-cf-fallback',
    source: 'cloudflare_worker_fallback',
    geometry: {
      annulus: { max_diameter_mm: annMaxDiam, min_diameter_mm: annMinDiam,
        equivalent_diameter_mm: annEquivDiam, area_mm2: annArea, confidence: annConf, method: 'hinge_curve_pca' },
      stj: { diameter_mm: stjDiam, max_diameter_mm: stjMaxDiam ?? stjDiam, equivalent_diameter_mm: stjEquivDiam ?? stjDiam, confidence: stjConf, method: 'orthogonal_section' },
      sinus: { max_diameter_mm: sinusMaxDiam, mean_diameter_mm: sinusMeanDiam,
        confidence: sinusConf, method: 'sinus_peaks_radial' },
      sinus_height: sinusHeight !== null ? { height_mm: sinusHeight } : null,
      coronary_heights: {
        left: { height_mm: lcaHeight, status: lcaStatus, confidence: lcaConf },
        right: { height_mm: rcaHeight, status: rcaStatus, confidence: rcaConf },
      },
      ascending_max_diameter_mm: ascDiam,
    },
    eligibility: { eligible, status, verdict, risk_level: riskLevel, summary, criteria, risk_flags: riskFlags },
    surgical_planning: {
      mesh_sizing: Object.keys(meshSizing).length > 0 ? meshSizing : null,
      support_segment: Object.keys(supportSegment).length > 0 ? supportSegment : null,
      coronary_windows: {
        lca: lcaHeight !== null ? { height_mm: lcaHeight, status: lcaStatus } : null,
        rca: rcaHeight !== null ? { height_mm: rcaHeight, status: rcaStatus } : null,
        note: 'Windows cut from ostial holes to longitudinal end of mesh (Conci 2025)',
      },
    },
    data_quality: {
      annulus_confidence: annConf, stj_confidence: stjConf, sinus_confidence: sinusConf,
      lca_confidence: lcaConf, rca_confidence: rcaConf,
    },
    references: [
      'Treasure T et al. Heart 2014;100:1582-1586 (Marfan PEARS, 30-case ITA)',
      'Conci E et al. JTCVS Techniques 2025 (PEARS surgical technique)',
      'Kougioumtzoglou A et al. JTCVS 2025 (Dutch PEARS experience)',
    ],
  };
}

async function readArtifactJson(env: Env, jobId: string, artifactType: string): Promise<Record<string, unknown> | null> {
  const artifact = await safeFirst(
    env.DB.prepare(
      `SELECT object_key FROM artifacts WHERE job_id = ?1 AND artifact_type = ?2 ORDER BY created_at DESC LIMIT 1`
    )
      .bind(jobId, artifactType)
      .first<{ object_key: string }>()
  );
  if (!artifact?.object_key) return null;
  const obj = await env.R2_MASK.get(artifact.object_key);
  if (!obj) return null;
  return safeJsonObject(await obj.text());
}

type CaseResultRow = {
  case_id: string;
  job_id: string | null;
  measurements_json: string | null;
  planning_json: string | null;
  created_at: number | null;
};

type CaseDisplayReadiness = {
  display_ready: boolean;
  completion_state: "display_ready" | "incomplete_case_result";
  missing_requirements: string[];
  has_measurements: boolean;
  has_planning: boolean;
  has_centerline: boolean;
  has_root_model: boolean;
  has_leaflet_model: boolean;
  has_root_stl: boolean;
  has_report_pdf: boolean;
};

type PublishedCaseGate = {
  display_ready: boolean;
  completion_state: "display_ready" | "incomplete_case_result";
  status: "completed" | "incomplete";
  review_status: "ready" | "review_required";
  pears_visual_ready: boolean;
  manufacturing_ready: boolean | null;
  intended_use: string | null;
  blockers: string[];
  warnings: string[];
};

function parseCaseResultObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") return parseJsonColumn(value);
  return pickObject(value);
}

function evaluateCaseDisplayReadiness(input: {
  measurements: unknown;
  planning: unknown;
  artifactTypes?: Iterable<string> | null;
}): CaseDisplayReadiness {
  const measurements = parseCaseResultObject(input.measurements);
  const planning = parseCaseResultObject(input.planning);
  const artifactTypes = new Set(Array.from(input.artifactTypes || []).map((entry) => String(entry || "").trim()).filter(Boolean));

  const hasMeasurements = Boolean(measurements);
  const hasPlanning = Boolean(planning);
  const hasCenterline = artifactTypes.has("centerline_json");
  const hasRootModel = artifactTypes.has("aortic_root_model_json");
  const hasLeafletModel = artifactTypes.has("leaflet_model_json");
  const hasRootStl = artifactTypes.has("aortic_root_stl");
  const hasReportPdf = artifactTypes.has("planning_report_pdf");

  const missingRequirements = [
    ...(hasMeasurements ? [] : ["measurements_json"]),
    ...(hasPlanning ? [] : ["planning_json"]),
    ...(hasCenterline ? [] : ["centerline_json"]),
    ...(hasRootModel ? [] : ["aortic_root_model_json"]),
    ...(hasLeafletModel ? [] : ["leaflet_model_json"]),
    ...(hasRootStl ? [] : ["aortic_root_stl"]),
    ...(hasReportPdf ? [] : ["planning_report_pdf"]),
  ];

  return {
    display_ready: missingRequirements.length === 0,
    completion_state: missingRequirements.length === 0 ? "display_ready" : "incomplete_case_result",
    missing_requirements: missingRequirements,
    has_measurements: hasMeasurements,
    has_planning: hasPlanning,
    has_centerline: hasCenterline,
    has_root_model: hasRootModel,
    has_leaflet_model: hasLeafletModel,
    has_root_stl: hasRootStl,
    has_report_pdf: hasReportPdf,
  };
}

function derivePublishedCaseGate(
  readiness: CaseDisplayReadiness,
  pearsGeometry: unknown
): PublishedCaseGate {
  const pears = pickObject(pearsGeometry);
  const blockers = stringList(pears?.blockers);
  const warnings = stringList(pears?.warnings);
  const intendedUse = nullableString(pears?.intended_use);
  const manufacturingReady = typeof pears?.manufacturing_ready === "boolean" ? pears.manufacturing_ready : null;
  const visualReady = Boolean(pears?.visual_ready);
  const quality = pickObject(pears?.quality);
  const sourceCta = pickObject(quality?.source_cta);
  const dataQuality = pickObject(pears?.data_quality);
  const visualOnly =
    intendedUse === "visual_planning_only"
    || manufacturingReady === false
    || Boolean(dataQuality && dataQuality.passes_sizing_gate === false)
    || Boolean(sourceCta && sourceCta.passes_pears_sizing_gate === false);
  const reviewRequired = !readiness.display_ready || (visualOnly && (blockers.length > 0 || manufacturingReady === false));
  const displayReady = readiness.display_ready && !reviewRequired;
  return {
    display_ready: displayReady,
    completion_state: displayReady ? "display_ready" : "incomplete_case_result",
    status: displayReady ? "completed" : "incomplete",
    review_status: displayReady ? "ready" : "review_required",
    pears_visual_ready: visualReady,
    manufacturing_ready: manufacturingReady,
    intended_use: intendedUse,
    blockers,
    warnings,
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => nullableString(entry)).filter((entry): entry is string => Boolean(entry));
}

function stringifyJsonColumn(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

function parseJsonColumn(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return safeJsonObject(value);
}

function normalizeCaseResultPayloads(resultJson: Record<string, unknown> | null): {
  measurements: Record<string, unknown> | null;
  planning: Record<string, unknown> | null;
} {
  return deriveCaseResultPayloads({
    resultJson,
  });
}

function normalizeMeasurementsPayload(input: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!input) return null;
  return (
    pickObject(input.measurements)
    || pickObject(input.measurements_regularized)
    || pickObject(input.measurements_structured)
    || pickObject(input.measurements_structured_regularized)
    || (pickObject(input.annulus) || pickObject(input.sinus_of_valsalva) || pickObject(input.stj) ? input : null)
  );
}

function normalizePlanningPayload(input: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!input) return null;
  const measurements = normalizeMeasurementsPayload(input);
  return (
    pickObject(input.planning)
    || pickObject(input.planning_metrics)
    || pickObject(measurements?.planning)
    || pickObject(measurements?.planning_metrics)
    || null
  );
}

function deriveCaseResultPayloads(input: {
  existingMeasurements?: Record<string, unknown> | null;
  existingPlanning?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
  measurementsArtifactJson?: Record<string, unknown> | null;
}): {
  measurements: Record<string, unknown> | null;
  planning: Record<string, unknown> | null;
} {
  const resultMeasurements = normalizeMeasurementsPayload(input.resultJson || null);
  const artifactMeasurements = normalizeMeasurementsPayload(input.measurementsArtifactJson || null);
  const measurements = input.existingMeasurements || resultMeasurements || artifactMeasurements || null;
  const planning =
    input.existingPlanning
    || normalizePlanningPayload(input.resultJson || null)
    || normalizePlanningPayload(input.measurementsArtifactJson || null)
    || normalizePlanningPayload(measurements)
    || null;
  return { measurements, planning };
}

async function hydrateCaseResultRow(
  env: Env,
  caseId: string,
  jobIdHint?: string | null,
  existingRow?: CaseResultRow | null
): Promise<CaseResultRow | null> {
  if (!caseId) return null;
  const row = typeof existingRow === "undefined" ? await getCaseResultRow(env, caseId) : existingRow;
  const existingMeasurements = parseJsonColumn(row?.measurements_json);
  const existingPlanning = parseJsonColumn(row?.planning_json);
  if (existingMeasurements && existingPlanning) return row || null;

  const jobId = nullableString(jobIdHint) || nullableString(row?.job_id) || caseId;
  if (!jobId) return row || null;

  const [resultJson, measurementsArtifactJson] = await Promise.all([
    readArtifactJson(env, jobId, "result_json"),
    readArtifactJson(env, jobId, "measurements_json"),
  ]);

  const derived = deriveCaseResultPayloads({
    existingMeasurements,
    existingPlanning,
    resultJson,
    measurementsArtifactJson,
  });

  const shouldPersist =
    (!existingMeasurements && Boolean(derived.measurements))
    || (!existingPlanning && Boolean(derived.planning));

  if (!shouldPersist) return row || null;

  await upsertCaseResult(env, {
    case_id: row?.case_id || caseId,
    job_id: row?.job_id || jobId,
    measurements: derived.measurements,
    planning: derived.planning,
  });

  return {
    case_id: row?.case_id || caseId,
    job_id: row?.job_id || jobId,
    measurements_json: stringifyJsonColumn(derived.measurements),
    planning_json: stringifyJsonColumn(derived.planning),
    created_at: row?.created_at || Date.now(),
  };
}

async function getCaseResultRow(env: Env, caseId: string): Promise<CaseResultRow | null> {
  if (!caseId) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT case_id, job_id, measurements_json, planning_json, created_at
       FROM case_results WHERE case_id = ?1`
    )
      .bind(caseId)
      .first<CaseResultRow>();
    return row || null;
  } catch {
    return null;
  }
}

async function listCaseResultRows(env: Env): Promise<CaseResultRow[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT case_id, job_id, measurements_json, planning_json, created_at
       FROM case_results
       ORDER BY created_at DESC`
    ).all<CaseResultRow>();
    return Array.isArray(rows.results) ? rows.results : [];
  } catch {
    return [];
  }
}

async function getJobArtifactTypeSet(env: Env, jobId: string | null): Promise<Set<string>> {
  if (!jobId) return new Set();
  try {
    const rows = await env.DB.prepare(
      `SELECT artifact_type
       FROM artifacts
       WHERE job_id = ?1`
    )
      .bind(jobId)
      .all<{ artifact_type: string | null }>();
    return new Set(
      (Array.isArray(rows.results) ? rows.results : [])
        .map((row) => String(row.artifact_type || "").trim())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

async function upsertCaseResult(
  env: Env,
  input: {
    case_id: string;
    job_id: string | null;
    measurements: unknown;
    planning: unknown;
  }
): Promise<void> {
  if (!input.case_id) return;
  await ensureCaseResultsTable(env);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO case_results (
       case_id, job_id, measurements_json, planning_json, created_at
     )
     VALUES (?1, ?2, ?3, ?4, ?5)
`
  )
    .bind(
      input.case_id,
      input.job_id,
      stringifyJsonColumn(input.measurements),
      stringifyJsonColumn(input.planning),
      Date.now()
    )
    .run();
}

async function ensureCaseResultsTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS case_results (
       case_id TEXT PRIMARY KEY,
       job_id TEXT,
       measurements_json TEXT,
       planning_json TEXT,
       created_at INTEGER
     )`
  ).run();
}

async function ensureManualAnnotationsTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS manual_annotations (
       id TEXT PRIMARY KEY,
       case_id TEXT,
       annotator TEXT,
       annotation_json TEXT,
       created_at INTEGER
     )`
  ).run();
}

async function saveManualAnnotation(caseId: string, payload: unknown, env: Env): Promise<Response> {
  if (!caseId) return json({ error: "missing_case_id" }, 400);
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (!record) return json({ error: "invalid_payload" }, 400);

  await ensureManualAnnotationsTable(env);
  const annotationId = crypto.randomUUID();
  const createdAt = Date.now();
  const annotator = nullableString(record.annotator) || "unknown_annotator";
  const normalized = {
    ...record,
    case_id: caseId,
    annotator,
    annotation_date: nullableString(record.annotation_date) || new Date().toISOString(),
  };

  await env.DB.prepare(
    `INSERT INTO manual_annotations (id, case_id, annotator, annotation_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(annotationId, caseId, annotator, JSON.stringify(normalized), createdAt)
    .run();

  return json({
    ok: true,
    id: annotationId,
    case_id: caseId,
    annotator,
    created_at: createdAt,
  });
}

// ── Annotation auth ────────────────────────────────────────────────────────
// Simple signed-token scheme. Frontend POSTs the shared password to
// /api/annotations/auth, gets back a short-lived HMAC token, and sends it back
// as X-Annotation-Token on subsequent annotation writes. Stateless — no D1
// session row. Keeps the surface small and survives Worker instance churn.

async function buildAnnotationToken(env: Env): Promise<string | null> {
  const secret = getAnnotationTokenSecret(env);
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + getAnnotationTokenTtlSeconds(env);
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const payload = `${exp}.${nonce}`;
  const sig = await hmacSha256Hex(secret, payload);
  return `${payload}.${sig}`;
}

async function verifyAnnotationToken(token: string, env: Env): Promise<boolean> {
  const secret = getAnnotationTokenSecret(env);
  if (!secret || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expRaw, nonce, sig] = parts;
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  if (Math.floor(Date.now() / 1000) > exp) return false;
  if (!nonce) return false;
  const expected = await hmacSha256Hex(secret, `${expRaw}.${nonce}`);
  return timingSafeHexEqual(sig, expected);
}

async function handleAnnotationAuth(request: Request, env: Env): Promise<Response> {
  const expected = getAnnotationPassword(env);
  if (!expected) {
    return json(
      { ok: false, error: "annotation_password_not_configured" },
      503,
    );
  }
  const body = await readJson(request);
  const candidate =
    body && typeof body === "object"
      ? nullableString((body as Record<string, unknown>).password) || ""
      : "";
  if (!candidate) return json({ ok: false, error: "missing_password" }, 400);
  // Timing-safe compare over equal-length strings.
  const aPadded = candidate.padEnd(Math.max(candidate.length, expected.length), "\0");
  const bPadded = expected.padEnd(aPadded.length, "\0");
  let diff = candidate.length ^ expected.length;
  for (let i = 0; i < aPadded.length; i += 1) {
    diff |= aPadded.charCodeAt(i) ^ bPadded.charCodeAt(i);
  }
  if (diff !== 0) return json({ ok: false, error: "invalid_password" }, 401);

  const token = await buildAnnotationToken(env);
  if (!token) {
    return json(
      { ok: false, error: "annotation_token_secret_missing" },
      503,
    );
  }
  return json({
    ok: true,
    token,
    ttl_seconds: getAnnotationTokenTtlSeconds(env),
  });
}

async function requireAnnotationToken(request: Request, env: Env): Promise<Response | null> {
  // Allow unguarded writes only when no password is configured (local/dev).
  if (!getAnnotationPassword(env)) return null;
  const token = (request.headers.get("X-Annotation-Token") || "").trim();
  if (!token) return json({ error: "annotation_token_required" }, 401);
  const ok = await verifyAnnotationToken(token, env);
  if (!ok) return json({ error: "invalid_annotation_token" }, 401);
  return null;
}

// ── Summary merge: manual annotation overrides null auto values ──────────────
// Rules:
//   1. Only overwrite when auto value is null (never clobber a non-null auto).
//   2. Stamp evidence.source_type='manual_annotation' and provenance.
//   3. Flip uncertainty.flag NOT_AVAILABLE -> MANUAL_OVERRIDE; clear review flag.
// This is route-level glue; keeps defaultCaseHandlers pure (no D1 dep).

const MANUAL_MERGEABLE_KEYS = [
  "coronary_height_left_mm",
  "coronary_height_right_mm",
] as const;

async function getLatestManualAnnotation(
  caseId: string,
  env: Env,
): Promise<Record<string, unknown> | null> {
  try {
    await ensureManualAnnotationsTable(env);
    const row = await safeFirst(
      env.DB.prepare(
        `SELECT id, annotator, annotation_json, created_at
         FROM manual_annotations
         WHERE case_id = ?1
         ORDER BY created_at DESC
         LIMIT 1`,
      )
        .bind(caseId)
        .first<Record<string, unknown>>(),
    );
    if (!row) return null;
    const parsed = parseJsonColumn(row.annotation_json);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      id: row.id,
      annotator: row.annotator,
      created_at: row.created_at,
      ...parsed,
    };
  } catch {
    return null;
  }
}

function mergeManualIntoMeasurements(
  measurements: Record<string, unknown>,
  manual: Record<string, unknown>,
): Record<string, unknown> {
  const manualMeasurements = (manual.measurements as Record<string, unknown>) || {};
  const out: Record<string, unknown> = { ...measurements };
  const overrides: Array<{ key: string; value: number }> = [];
  for (const key of MANUAL_MERGEABLE_KEYS) {
    const autoEntry = out[key] as Record<string, unknown> | undefined;
    const manualEntry = manualMeasurements[key] as Record<string, unknown> | undefined;
    if (!manualEntry) continue;
    const manualValue = manualEntry.value;
    if (typeof manualValue !== "number" || !Number.isFinite(manualValue)) continue;
    const autoValue = autoEntry?.value;
    if (autoValue !== null && autoValue !== undefined) continue; // never clobber auto
    overrides.push({ key, value: manualValue });
    out[key] = {
      value: manualValue,
      unit: (autoEntry?.unit as string) || "mm",
      evidence: {
        method: (manualEntry.method as string) || "manual_mpr_click",
        confidence: 1.0,
        source_type: "manual_annotation",
        source_ref: `manual_annotations:${String(manual.id || "unknown")}`,
      },
      uncertainty: {
        flag: "MANUAL_OVERRIDE",
        clinician_review_required: false,
      },
    };
  }
  if (overrides.length) {
    out._manual_overrides = {
      annotator: manual.annotator,
      annotation_date: manual.annotation_date,
      annotation_id: manual.id,
      overridden_keys: overrides.map((o) => o.key),
    };
  }
  return out;
}

async function handleCaseMeasurementsWithOverrides(
  caseId: string,
  env: Env,
  request: Request,
): Promise<Response> {
  const store = getDefaultCaseStore(env, request);
  const baseResponse = await handleCaseArtifactById(
    store,
    getBuildVersion(),
    caseId,
    "measurements",
  );
  if (baseResponse.status !== 200) return baseResponse;
  let measurements: Record<string, unknown>;
  try {
    measurements = (await baseResponse.clone().json()) as Record<string, unknown>;
  } catch {
    return baseResponse; // non-JSON or parse failure — return raw
  }
  const manual = await getLatestManualAnnotation(caseId, env);
  if (!manual) return json(measurements);
  return json(mergeManualIntoMeasurements(measurements, manual));
}

async function getManualAnnotations(caseId: string, env: Env): Promise<Response> {
  if (!caseId) return json({ error: "missing_case_id" }, 400);
  await ensureManualAnnotationsTable(env);

  const rows = await safeAll(
    env.DB.prepare(
      `SELECT id, case_id, annotator, annotation_json, created_at
       FROM manual_annotations
       WHERE case_id = ?1
       ORDER BY created_at DESC`
    )
      .bind(caseId)
      .all()
  );

  const annotations = rows.map((row) => ({
    id: row.id,
    case_id: row.case_id,
    annotator: row.annotator,
    created_at: row.created_at,
    annotation: parseJsonColumn(row.annotation_json) || {},
  }));

  return json({ case_id: caseId, annotations, total: annotations.length });
}

async function handleCaseResultArtifact(caseId: string, rawName: string, env: Env): Promise<Response> {
  const normalized = decodeURIComponent(rawName || "").trim().toLowerCase();
  const jsonArtifactMap: Record<string, string> = {
    "pears_model": "pears_model_json",
    "pears_model.json": "pears_model_json",
    "pears_coronary_windows": "pears_coronary_windows_json",
    "pears_coronary_windows.json": "pears_coronary_windows_json",
    "pears_visual_qa": "pears_visual_qa_json",
    "pears_visual_qa.json": "pears_visual_qa_json",
  };
  if (
    normalized !== "measurements"
    && normalized !== "measurements.json"
    && normalized !== "planning"
    && normalized !== "planning.json"
    && !(normalized in jsonArtifactMap)
  ) {
    return json({ error: "artifact_not_found" }, 404);
  }

  const row = await hydrateCaseResultRow(env, caseId);
  if (!row) return json({ error: "case_not_found" }, 404);
  if (normalized in jsonArtifactMap) {
    const jobId = nullableString(row.job_id) || caseId;
    const payload = await readArtifactJson(env, jobId, jsonArtifactMap[normalized]);
    return payload ? json(payload) : json({ error: "artifact_not_found" }, 404);
  }
  if (normalized === "measurements" || normalized === "measurements.json") {
    return json(parseJsonColumn(row.measurements_json) || {});
  }
  return json(parseJsonColumn(row.planning_json) || {});
}
function buildCaseResultLinks(caseId: string): Record<string, string> {
  return {
    measurements: `/api/cases/${encodeURIComponent(caseId)}/artifacts/measurements`,
    planning: `/api/cases/${encodeURIComponent(caseId)}/artifacts/planning`,
    workstation: `/workstation/cases/${encodeURIComponent(caseId)}`,
  };
}

async function buildCaseResultListEntry(env: Env, row: CaseResultRow, buildVersion: string): Promise<Record<string, unknown>> {
  const hydratedRow = await hydrateCaseResultRow(env, row.case_id, row.job_id, row) || row;
  const isPrimary = hydratedRow.case_id === PRIMARY_REAL_CASE_ID;
  const artifactTypes = await getJobArtifactTypeSet(env, hydratedRow.job_id);
  const measurementsObject = parseJsonColumn(hydratedRow.measurements_json);
  const readiness = evaluateCaseDisplayReadiness({
    measurements: hydratedRow.measurements_json,
    planning: hydratedRow.planning_json,
    artifactTypes,
  });
  const gate = derivePublishedCaseGate(readiness, measurementsObject?.pears_geometry);
  return {
    id: hydratedRow.case_id,
    job_id: hydratedRow.job_id,
    case_id: hydratedRow.case_id,
    display_name: isPrimary
      ? {
          "zh-CN": "Mao 术前真实 CTA",
          en: "Mao Preop Real CTA",
        }
      : {
          "zh-CN": `结果病例 ${row.case_id}`,
          en: `Result Case ${row.case_id}`,
        },
    case_role: isPrimary ? ["primary_real_case", "pears_planning"] : ["latest", "derived_result"],
    placeholder: false,
    not_real_cta: false,
    status: gate.status,
    review_status: gate.review_status,
    scan_date: null,
    pipeline_version: null,
    build_version: buildVersion,
    has_planning: readiness.has_planning,
    has_measurements: readiness.has_measurements,
    has_meshes: readiness.has_root_stl,
    display_ready: gate.display_ready,
    completion_state: gate.completion_state,
    missing_requirements: readiness.missing_requirements,
    pears_visual_ready: gate.pears_visual_ready,
    manufacturing_ready: gate.manufacturing_ready,
    capabilities: {
      pears_geometry: {
        available: gate.pears_visual_ready,
        inferred: false,
        legacy: false,
        source: gate.pears_visual_ready ? "measurements_artifact" : "unavailable",
        reason: gate.pears_visual_ready ? null : "pears_geometry_missing",
      },
    },
    planning_summary: {},
    quality_gates_summary: {
      intended_use: gate.intended_use,
      manufacturing_ready: gate.manufacturing_ready,
      blockers: gate.blockers,
      warnings: gate.warnings,
    },
    links: buildCaseResultLinks(hydratedRow.case_id),
  };
}

function inferVolumeSourceKind(study: Record<string, unknown>, repository: Record<string, unknown> | null): "nifti" | "dicom_zip" {
  const format = String(study.image_format || repository?.ingestion_format || "").toLowerCase();
  const filename = String(repository?.raw_filename || study.image_key || "").toLowerCase();
  if (format.includes("dicom") || filename.endsWith(".zip") || filename.endsWith(".dicom.zip")) return "dicom_zip";
  return "nifti";
}

function normalizePlaneDefinition(input: Record<string, unknown> | null, fallbackId: string): Record<string, unknown> | null {
  if (!input) return null;
  const origin =
    toPointArray(input.origin_world)
    || toPointArray(input.center_world)
    || toPointArray(input.origin_voxel)
    || null;
  const normal =
    toPointArray(input.normal_world)
    || null;
  const basisU = toPointArray(input.basis_u_world);
  const basisV = toPointArray(input.basis_v_world);
  if (!origin || !normal) return null;
  return {
    id: String(input.label || fallbackId),
    label: String(input.label || fallbackId),
    status: nullableString(input.status) || nullableString(input.detection_method) || "derived",
    confidence: readFiniteNumber(input.confidence),
    origin_world: origin,
    normal_world: normal,
    basis_u_world: basisU || null,
    basis_v_world: basisV || null,
    ring_points_world: Array.isArray(input.ring_points_world) ? input.ring_points_world.map((point) => toPointArray(point)).filter(Boolean) : null,
    source_index: readFiniteNumber(input.index),
  };
}

function normalizeCenterline(input: unknown): Record<string, unknown> | null {
  const record = pickObject(input);
  if (!record) return null;
  let points = Array.isArray(record.points_world)
    ? record.points_world.map((point) => toPointArray(point)).filter(Boolean)
    : [];
  let sMm = Array.isArray(record.s_mm) ? record.s_mm.map((value) => Number(value)).filter(Number.isFinite) : [];
  let tangentsWorld: Array<[number, number, number]> | null = null;
  if (!points.length && Array.isArray(record.points)) {
    const legacyPoints = record.points
      .map((entry) => pickObject(entry))
      .filter(Boolean) as Array<Record<string, unknown>>;
    points = legacyPoints
      .map((entry) => toPointArray(entry.world) || toPointArray(entry.point_world) || toPointArray(entry.voxel))
      .filter((value): value is [number, number, number] => Boolean(value));
    const legacySMm = legacyPoints
      .map((entry) => readFiniteNumber(entry.s_mm))
      .filter((value): value is number => typeof value === "number");
    if (legacySMm.length === points.length) sMm = legacySMm;
    const legacyTangents = legacyPoints
      .map((entry) => toPointArray(entry.tangent_world))
      .filter((value): value is [number, number, number] => Boolean(value));
    if (legacyTangents.length === points.length) tangentsWorld = legacyTangents;
  }
  if (!points.length) return null;
  return {
    point_count: points.length,
    points_world: points,
    s_mm: sMm.length === points.length ? sMm : null,
    tangents_world: tangentsWorld,
    method: nullableString(record.method) || null,
  };
}

function buildCenterlinePlane(centerline: Record<string, unknown> | null, index: number): Record<string, unknown> | null {
  if (!centerline || !Array.isArray(centerline.points_world) || !centerline.points_world.length) return null;
  const points = centerline.points_world as Array<unknown>;
  const clamped = Math.max(0, Math.min(points.length - 1, Math.round(index || 0)));
  const origin = toPointArray(points[clamped]);
  if (!origin) return null;
  const tangent =
    (Array.isArray(centerline.tangents_world) ? toPointArray(centerline.tangents_world[clamped]) : null)
    || computeCenterlineTangent(points, clamped);
  const basisU = normalizeVector(crossProduct(tangent, [0, 1, 0])) || normalizeVector(crossProduct(tangent, [1, 0, 0]));
  const basisV = basisU ? normalizeVector(crossProduct(basisU, tangent)) : null;
  return {
    id: "centerline",
    label: "centerline_orthogonal",
    status: "derived",
    confidence: 1,
    origin_world: origin,
    normal_world: tangent,
    basis_u_world: basisU,
    basis_v_world: basisV,
    source_index: clamped,
  };
}

function buildModelLandmarksSummary(
  model: Record<string, unknown>,
  leafletModelJson: Record<string, unknown> | null
): Record<string, unknown> {
  const coronary = pickObject(model.coronary_ostia);
  const leaflets = leafletModelJson && Array.isArray((leafletModelJson as Record<string, unknown>).leaflets)
    ? ((leafletModelJson as Record<string, unknown>).leaflets as Array<unknown>)
        .map((entry) => pickObject(entry))
        .filter(Boolean)
        .map((entry) => ({
          label: String(entry?.label || entry?.cusp || "leaflet"),
          status: nullableString(entry?.status) || "unknown",
          confidence: readFiniteNumber(entry?.confidence),
        }))
    : [];
  return {
    annulus: normalizeLandmarkSummary(pickObject(model.annulus_plane) || pickObject(model.annulus_ring)),
    stj: normalizeLandmarkSummary(pickObject(model.sinotubular_junction)),
    commissures: Array.isArray(model.commissures)
      ? (model.commissures as Array<unknown>).map((entry) => normalizeLandmarkSummary(pickObject(entry))).filter(Boolean)
      : [],
    coronary_ostia: coronary
      ? {
          left: normalizeLandmarkSummary(pickObject(coronary.left)),
          right: normalizeLandmarkSummary(pickObject(coronary.right)),
        }
      : null,
    leaflet_status: leaflets,
  };
}

function buildCoronaryOstiaSummary(
  model: Record<string, unknown>,
  measurementsJson: Record<string, unknown> | null
): Record<string, unknown> | null {
  const measurementsCoronary = pickObject(measurementsJson?.coronary_ostia);
  const modelCoronary = pickObject(model.coronary_ostia);
  const coronary = measurementsCoronary || modelCoronary;
  if (!coronary) {
    return {
      source: "unavailable",
      inferred: false,
      reason: "coronary_ostia_missing",
      left: null,
      right: null,
    };
  }
  const left = normalizeCoronaryOstiumSummary(pickObject(coronary.left));
  const right = normalizeCoronaryOstiumSummary(pickObject(coronary.right));
  const hasMeasuredHeight = [left, right].some((entry) => typeof entry?.height_mm === "number" && Number.isFinite(entry.height_mm));
  return {
    source: hasMeasuredHeight ? (measurementsCoronary ? "measurements_artifact" : "model_artifact") : "unavailable",
    inferred: false,
    reason: hasMeasuredHeight ? null : "coronary_ostia_not_measurable",
    left,
    right,
  };
}

function normalizeCoronaryOstiumSummary(input: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!input) return null;
  return {
    status: nullableString(input.status) || "unknown",
    confidence: readFiniteNumber(input.confidence),
    reason: nullableString(input.reason),
    point_world: toPointArray(input.point_world) || toPointArray(input.origin_world),
    height_mm: readFiniteNumber(input.height_mm) ?? readFiniteNumber(input.height_above_annulus_mm),
    method: nullableString(input.method),
    source_fields: Array.isArray(input.source_fields) ? input.source_fields : null,
  };
}

function buildLeafletGeometrySummary(
  model: Record<string, unknown>,
  leafletModelJson: Record<string, unknown> | null
): Record<string, unknown> | null {
  const artifactLeaflets = Array.isArray(leafletModelJson?.leaflets)
    ? (leafletModelJson.leaflets as Array<unknown>).map((entry) => normalizeLeafletSummaryRecord(pickObject(entry))).filter(Boolean)
    : [];
  if (artifactLeaflets.length) {
    return {
      source: "leaflet_model_artifact",
      inferred: false,
      legacy: false,
      reason: null,
      leaflets: artifactLeaflets,
    };
  }

  const modelLeaflets = Array.isArray(model.leaflet_meshes)
    ? (model.leaflet_meshes as Array<unknown>).map((entry) => normalizeLeafletSummaryRecord(pickObject(entry))).filter(Boolean)
    : [];
  if (modelLeaflets.length) {
    return {
      source: "legacy_model_summary",
      inferred: false,
      legacy: true,
      reason: "leaflet_geometry_legacy_summary_only",
      leaflets: modelLeaflets,
    };
  }

  return {
    source: "unavailable",
    inferred: false,
    legacy: false,
    reason: "leaflet_geometry_missing",
    leaflets: [],
  };
}

function normalizeLeafletSummaryRecord(input: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!input) return null;
  return {
    leaflet_id: nullableString(input.leaflet_id),
    cusp_label: nullableString(input.cusp_label) || nullableString(input.label) || nullableString(input.name) || "leaflet",
    status: nullableString(input.status) || "unknown",
    confidence: readFiniteNumber(input.confidence),
    reason: nullableString(input.reason),
    geometric_height_mm: readFiniteNumber(input.geometric_height_mm),
    effective_height_mm: readFiniteNumber(input.effective_height_mm),
    coaptation_height_mm: readFiniteNumber(input.coaptation_height_mm),
    coaptation_surface_area_mm2: readFiniteNumber(input.coaptation_surface_area_mm2),
    raw_geometric_height_mm: readFiniteNumber(input.raw_geometric_height_mm),
    raw_effective_height_mm: readFiniteNumber(input.raw_effective_height_mm),
    raw_coaptation_height_mm: readFiniteNumber(input.raw_coaptation_height_mm),
    hinge_curve_world: Array.isArray(input.hinge_curve_world) ? input.hinge_curve_world : null,
    free_edge_world: Array.isArray(input.free_edge_world) ? input.free_edge_world : null,
  };
}

function normalizeLandmarkSummary(input: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!input) return null;
  return {
    label: String(input.label || input.id || "landmark"),
    status: nullableString(input.status) || nullableString(input.detection_method) || "derived",
    confidence: readFiniteNumber(input.confidence),
    origin_world: toPointArray(input.origin_world) || toPointArray(input.center_world) || null,
  };
}

function toPointArray(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const out: [number, number, number] = [Number(value[0]), Number(value[1]), Number(value[2])];
  return out.every(Number.isFinite) ? out : null;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function readNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.map((item) => Number(item)).filter(Number.isFinite);
  return out.length ? out : null;
}

function computeCenterlineTangent(points: Array<unknown>, index: number): [number, number, number] {
  const prev = toPointArray(points[Math.max(0, index - 1)]) || toPointArray(points[index]) || [0, 0, 0];
  const next = toPointArray(points[Math.min(points.length - 1, index + 1)]) || prev;
  return normalizeVector([next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]]) || [0, 0, 1];
}

function crossProduct(
  a: [number, number, number],
  b: [number, number, number]
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalizeVector(
  value: [number, number, number]
): [number, number, number] | null {
  const len = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(len) || len < 1e-8) return null;
  return [value[0] / len, value[1] / len, value[2] / len];
}

function readNestedString(root: Record<string, unknown>, path: string[]): string | null {
  let current: unknown = root;
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return nullableString(current);
}

async function streamStudyRaw(request: Request, studyId: string, env: Env): Promise<Response> {
  if (!studyId) return json({ error: "missing_study_id" }, 400);
  const authError = await requireSignedAccess(request, env);
  if (authError) return authError;

  const study = await env.DB.prepare(`SELECT image_key FROM studies WHERE id = ?1`)
    .bind(studyId)
    .first<{ image_key: string }>();

  if (!study?.image_key) return json({ error: "study_not_found" }, 404);

  const obj = await env.R2_RAW.get(study.image_key);
  if (!obj?.body) return json({ error: "raw_object_not_found" }, 404);

  const repository = await safeFirst(
    env.DB.prepare(`SELECT raw_filename FROM study_repository WHERE study_id = ?1`)
      .bind(studyId)
      .first<Record<string, unknown>>()
  );
  const filename = sanitizeRawFilename(
    nullableString(repository?.raw_filename) || study.image_key.split("/").pop(),
    studyId
  );
  const headers = new Headers(jsonHeaders);
  const inferredContentType =
    filename.endsWith(".nii.gz") ? "application/gzip"
    : filename.endsWith(".nii") ? "application/x-nifti"
    : filename.endsWith(".zip") ? "application/zip"
    : obj.httpMetadata?.contentType || "application/octet-stream";
  headers.set("content-type", inferredContentType);
  headers.set("content-disposition", `inline; filename="${filename}"`);
  headers.set("content-length", String(obj.size));
  await recordArtifactAccess(env, request, "study_raw", studyId, null, "raw_ct", getArtifactLinkSecret(env) ? "signed" : "unsigned");
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}

async function getStudyMeta(studyId: string, env: Env): Promise<Response> {
  if (!studyId) return json({ error: "missing_study_id" }, 400);
  const study = await env.DB.prepare(
    `SELECT id, patient_code, source_dataset, image_format, modality, phase, created_at, updated_at
     FROM studies WHERE id = ?1`
  )
    .bind(studyId)
    .first<Record<string, unknown>>();
  if (!study) return json({ error: "study_not_found" }, 404);
  const repository = await safeFirst(
    env.DB.prepare(
      `SELECT raw_filename, image_bytes, image_sha256, ingestion_format, metadata_json, created_at, updated_at
       FROM study_repository WHERE study_id = ?1`
    )
      .bind(studyId)
      .first<Record<string, unknown>>()
  );
  const latestRun = await safeFirst(
    env.DB.prepare(
      `SELECT job_id, pipeline_version, computational_model, centerline_method, measurement_method,
              input_kind, reported_phase, selected_phase, runtime_seconds, updated_at
       FROM pipeline_runs WHERE study_id = ?1 ORDER BY updated_at DESC LIMIT 1`
    )
      .bind(studyId)
      .first<Record<string, unknown>>()
  );
  return json({
    ...study,
    repository: repository
      ? {
          ...repository,
          metadata: safeParseJsonText(repository.metadata_json),
          raw_ct_link: await buildSignedPath(await buildStudyRawPath(studyId, env), env),
        }
      : null,
    latest_pipeline_run: latestRun || null,
  });
}

async function getStudyRepository(studyId: string, env: Env): Promise<Response> {
  if (!studyId) return json({ error: "missing_study_id" }, 400);
  const study = await env.DB.prepare(
    `SELECT id, patient_code, source_dataset, image_format, modality, phase, created_at, updated_at
     FROM studies WHERE id = ?1`
  )
    .bind(studyId)
    .first<Record<string, unknown>>();
  if (!study) return json({ error: "study_not_found" }, 404);
  const repository = await safeFirst(
    env.DB.prepare(
      `SELECT raw_filename, image_bytes, image_sha256, ingestion_format, metadata_json, created_at, updated_at
       FROM study_repository WHERE study_id = ?1`
    )
      .bind(studyId)
      .first<Record<string, unknown>>()
  );
  const jobs = await safeAll(
    env.DB.prepare(
      `SELECT id, status, job_type, model_tag, created_at, started_at, finished_at
       FROM jobs WHERE study_id = ?1 ORDER BY created_at DESC LIMIT 10`
    )
      .bind(studyId)
      .all()
  );
  const runs = await safeAll(
    env.DB.prepare(
      `SELECT job_id, pipeline_version, computational_model, centerline_method, measurement_method,
              input_kind, reported_phase, selected_phase, runtime_seconds, updated_at
       FROM pipeline_runs WHERE study_id = ?1 ORDER BY updated_at DESC LIMIT 10`
    )
      .bind(studyId)
      .all()
  );
  return json({
    study,
    repository: repository
      ? {
          ...repository,
          metadata: safeParseJsonText(repository.metadata_json),
          raw_ct_link: await buildSignedPath(await buildStudyRawPath(studyId, env), env),
        }
      : null,
    jobs,
    pipeline_runs: runs,
  });
}

async function streamJobArtifact(request: Request, jobId: string, artifactType: string, env: Env): Promise<Response> {
  if (!jobId) return json({ error: "missing_job_id" }, 400);
  if (!artifactType) return json({ error: "missing_artifact_type" }, 400);
  const authError = await requireSignedAccess(request, env);
  if (authError) return authError;

  const artifact = await env.DB.prepare(
    `SELECT object_key, job_id FROM artifacts WHERE job_id = ?1 AND artifact_type = ?2 ORDER BY created_at DESC LIMIT 1`
  )
    .bind(jobId, artifactType)
    .first<{ object_key: string; job_id: string }>();

  if (!artifact?.object_key) return json({ error: "artifact_not_found" }, 404);

  const obj = await env.R2_MASK.get(artifact.object_key);
  if (!obj?.body) return json({ error: "artifact_object_not_found" }, 404);

  const filename = artifact.object_key.split("/").pop() || `${jobId}-${artifactType}.bin`;
  const headers = new Headers(jsonHeaders);
  const contentType = obj.httpMetadata?.contentType || "application/octet-stream";
  headers.set("content-type", contentType);
  headers.set("content-disposition", `attachment; filename="${filename}"`);
  headers.set("content-length", String(obj.size));
  const job = await safeFirst(
    env.DB.prepare(`SELECT study_id FROM jobs WHERE id = ?1`).bind(jobId).first<{ study_id: string }>()
  );
  await recordArtifactAccess(
    env,
    request,
    "job_artifact",
    job?.study_id || null,
    jobId,
    artifactType,
    getArtifactLinkSecret(env) ? "signed" : "unsigned"
  );

  if (artifactType.endsWith("_json") || contentType.includes("application/json")) {
    const text = await obj.text();
    const parsed = safeJsonObject(text);
    let sanitized: unknown = parsed;
    if (parsed) {
      if (artifactType === "provider_receipt") sanitized = sanitizeProviderReceipt(parsed);
      else if (artifactType === "result_json") sanitized = sanitizePublicResultJson(parsed);
      else sanitized = sanitizePublicValue(parsed);
    }
    const body = JSON.stringify(sanitized ?? {}, null, 2);
    headers.set("content-length", String(body.length));
    return new Response(body, { status: 200, headers });
  }

  return new Response(obj.body, { status: 200, headers });
}

async function handleInferenceCallback(
  request: Request,
  payload: InferenceCallbackPayload,
  env: Env
): Promise<Response> {
  const expectedSecret = (env.PROVIDER_SECRET || "").trim();
  if (expectedSecret) {
    const provided = request.headers.get("x-callback-secret") || "";
    if (provided !== expectedSecret) {
      return json({ error: "unauthorized_callback" }, 401);
    }
  }

  const jobId = stringOr(payload.job_id, "").trim();
  if (!jobId) return json({ error: "missing_job_id" }, 400);

  const job = await env.DB.prepare(`SELECT id, study_id, status FROM jobs WHERE id = ?1`)
    .bind(jobId)
    .first<{ id: string; study_id: string; status: JobStatus }>();

  if (!job) return json({ error: "job_not_found" }, 404);
  if (job.status === "succeeded" || job.status === "failed") {
    return json({ ok: true, ignored: true, reason: "job_already_terminal" });
  }

  const status = stringOr(payload.status, "").toLowerCase();
  if (status !== "succeeded" && status !== "completed" && status !== "failed") {
    return json({ error: "invalid_callback_status" }, 400);
  }

  if (status === "failed") {
    await markJobFailed(env, job.id, payload.error_message || "provider_reported_failure");
    return json({ ok: true, job_id: job.id, status: "failed" });
  }

  await applyInferenceOutputToJob(env, job.id, job.study_id, payload, "callback");
  return json({ ok: true, job_id: job.id, status: "succeeded" });
}

async function processSegmentationJob(payload: SegQueuePayload, env: Env): Promise<void> {
  const lock = await env.DB.prepare(
    `UPDATE jobs
     SET status = 'running', started_at = COALESCE(started_at, ?2), error_message = NULL
     WHERE id = ?1 AND status = 'queued'`
  )
    .bind(payload.job_id, new Date().toISOString())
    .run();

  const changes = lock.meta?.changes || 0;
  if (changes === 0) {
    return;
  }
  await tryUpdateJobExtendedFields(env, payload.job_id, {
    progress: 5,
    stage: "queued",
    updated_at: new Date().toISOString(),
  });

  try {
    const srcHead = await env.R2_RAW.head(payload.image_key);
    if (!srcHead) throw new Error("source_image_not_found");
    await tryUpdateJobExtendedFields(env, payload.job_id, {
      progress: 15,
      stage: "segmentation",
      updated_at: new Date().toISOString(),
    });

    const mode = getInferenceMode(env);
    if (mode === "webhook") {
      await dispatchToInferenceWebhook(env, payload);
      return;
    }

    await runMockInference(env, payload);
  } catch (error) {
    await markJobFailed(env, payload.job_id, asError(error).message);
  }
}

async function dispatchToInferenceWebhook(
  env: Env,
  payload: SegQueuePayload
): Promise<void> {
  const webhookUrl = (env.PROVIDER_URL || "").trim();
  if (!webhookUrl) {
    throw new Error("provider_url_missing");
  }

  const timeoutMs = parsePositiveInt(env.INFERENCE_WEBHOOK_TIMEOUT_MS, 25000);

  const callbackSecret = (env.PROVIDER_SECRET || "").trim();
  const callbackUrl = buildCallbackUrl(env);
  const apiBase = (env.API_BASE_URL || "").trim();
  const normalizedBase = apiBase ? apiBase.replace(/\/$/, "") : "";
  const statusUrl = normalizedBase ? `${normalizedBase}/api/jobs/${encodeURIComponent(payload.job_id)}/status` : null;
  const simpleCallbackUrl = normalizedBase ? `${normalizedBase}/api/jobs/${encodeURIComponent(payload.job_id)}/callback` : null;
  const inputUrl = normalizedBase ? `${normalizedBase}/api/jobs/${encodeURIComponent(payload.job_id)}/input` : null;
  const skipSegmentation = parseBooleanLike(env.INFERENCE_SKIP_SEGMENTATION);

  let downloadUrl: string | null = null;
  let fileContentB64: string | null = null;

  const rawHead = await env.R2_RAW.head(payload.image_key);
  const rawSize = Number(rawHead?.size ?? 0);
  const base64ThresholdBytes = 50 * 1024 * 1024;

  if (rawSize > 0 && rawSize <= base64ThresholdBytes) {
    const srcObj = await env.R2_RAW.get(payload.image_key);
    if (!srcObj) throw new Error("raw_object_missing_for_webhook_payload");
    const srcBuf = await srcObj.arrayBuffer();
    fileContentB64 = arrayBufferToBase64(srcBuf);
  } else {
    const bucketAny = env.R2_RAW as unknown as {
      createPresignedUrl?: (method: "GET" | "PUT", key: string, options?: { expiresIn?: number }) => Promise<string>;
    };
    if (typeof bucketAny.createPresignedUrl === "function") {
      try {
        downloadUrl = await bucketAny.createPresignedUrl("GET", payload.image_key, { expiresIn: 3600 });
      } catch {
        downloadUrl = null;
      }
    }
  }

  const reqBody = {
    job_id: payload.job_id,
    study_id: payload.study_id,
    patient_id: payload.patient_id ?? null,
    image_key: payload.image_key,
    r2_key: payload.image_key,
    download_url: downloadUrl,
    file_content_b64: fileContentB64,
    input_url: inputUrl,
    requested_at: payload.requested_at,
    skip_segmentation: skipSegmentation,
    callback_url: simpleCallbackUrl,
    status_url: statusUrl,
    callback: {
      url: callbackUrl,
      header: callbackSecret ? "x-callback-secret" : null,
      secret: callbackSecret || null
    }
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-provider-secret": callbackSecret,
    },
    body: JSON.stringify(reqBody),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`webhook_dispatch_failed:${response.status}`);
  }

  const receipt = (await response.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))) as Record<
    string,
    unknown
  >;
  await writeJsonArtifact(env, payload.job_id, payload.study_id, "provider_receipt", "provider-receipt.json", sanitizeProviderReceipt(receipt));

  const inlineStatus = readRecordString(receipt, "status").toLowerCase();
  if (inlineStatus === "succeeded") {
    const inlinePayload = toInferenceCallbackPayload(receipt, payload.job_id, "succeeded");
    await applyInferenceOutputToJob(env, payload.job_id, payload.study_id, inlinePayload, "inline");
    return;
  }

  if (inlineStatus === "failed") {
    const message = readRecordString(receipt, "error_message") || "provider_inline_failed";
    throw new Error(message);
  }

  // Accepted/queued path: keep job in running status and wait for callback.
}

async function runMockInference(env: Env, payload: SegQueuePayload): Promise<void> {
  const result = {
    study_id: payload.study_id,
    job_id: payload.job_id,
    model: "placeholder-v2",
    mode: "mock",
    source_image_key: payload.image_key,
    generated_at: new Date().toISOString(),
    labels: {
      0: "LVOT/background",
      1: "aortic_root",
      2: "leaflets",
      3: "ascending_aorta"
    }
  };

  await applyInferenceOutputToJob(
    env,
    payload.job_id,
    payload.study_id,
    {
      job_id: payload.job_id,
      status: "succeeded",
      result_json: result,
      metrics: [{ name: "pipeline_latency_seconds", value: 1.0, unit: "s" }]
    },
    "mock"
  );
}

async function applyInferenceOutputToJob(
  env: Env,
  jobId: string,
  studyId: string,
  payload: InferenceCallbackPayload,
  source: "mock" | "inline" | "callback"
): Promise<void> {
  const hasResultJson = payload.result_json && typeof payload.result_json === "object";
  let safeResultJson: Record<string, unknown> | null = null;
  const resultCaseId = nullableString(payload.result_case_id) || jobId;
  const writtenArtifactTypes = new Set<string>();

  if (hasResultJson) {
    safeResultJson = sanitizePublicResultJson(payload.result_json as Record<string, unknown>) || {};
    await writeJsonArtifact(env, jobId, studyId, "result_json", "result.json", {
      ...safeResultJson,
      _source: source,
      _provider_job_id: payload.provider_job_id || null
    });
    await recordPipelineRun(env, jobId, studyId, safeResultJson, source, payload.provider_job_id || null);
    await upsertStudyRepository(
      env,
      studyId,
      {
        input_metadata: (safeResultJson.input_metadata && typeof safeResultJson.input_metadata === "object"
          ? (safeResultJson.input_metadata as Record<string, unknown>)
          : {}),
        latest_pipeline: (safeResultJson.pipeline && typeof safeResultJson.pipeline === "object"
          ? (safeResultJson.pipeline as Record<string, unknown>)
          : {}),
        pipeline_version: (safeResultJson.pipeline_version && typeof safeResultJson.pipeline_version === "object"
          ? (safeResultJson.pipeline_version as Record<string, unknown>)
          : {}),
        last_job_id: jobId,
        updated_from_source: source,
      }
    );
  }

  if (payload.mask_base64) {
    const maskFilename = sanitizeFilename(payload.mask_filename || "mask-output.bin");
    const maskBytes = base64ToUint8Array(payload.mask_base64);
    await writeBinaryArtifact(
      env,
      jobId,
      studyId,
      "mask_output",
      maskFilename,
      maskBytes,
      payload.mask_content_type || "application/octet-stream"
    );
    await writeBinaryArtifact(
      env,
      jobId,
      studyId,
      "segmentation_mask_nifti",
      "segmentation_mask.nii.gz",
      maskBytes,
      payload.mask_content_type || "application/octet-stream"
    );
    writtenArtifactTypes.add("mask_output");
    writtenArtifactTypes.add("segmentation_mask_nifti");
  }

  if (Array.isArray(payload.artifacts)) {
    for (const artifact of payload.artifacts) {
      if (!artifact?.base64) continue;
      const artifactType = sanitizeFilename(artifact.artifact_type || "provider_artifact");
      const filename = sanitizeFilename(artifact.filename || `${artifactType}.bin`);
      const bytes = base64ToUint8Array(artifact.base64);
      await writeBinaryArtifact(
        env,
        jobId,
        studyId,
        artifactType,
        filename,
        bytes,
        artifact.content_type || "application/octet-stream"
      );
      writtenArtifactTypes.add(artifactType);
    }
  }

  if (!hasResultJson && !payload.mask_base64 && (!payload.artifacts || payload.artifacts.length === 0)) {
    await writeJsonArtifact(env, jobId, studyId, "result_json", "result.json", {
      status: "succeeded",
      provider_job_id: payload.provider_job_id || null,
      source,
      note: "No explicit output payload received."
    });
  }

  if (safeResultJson) {
    const measurementsArtifactJson = await readArtifactJson(env, jobId, "measurements_json");
    const normalizedCaseResult = deriveCaseResultPayloads({
      resultJson: safeResultJson,
      measurementsArtifactJson,
    });
    await upsertCaseResult(env, {
      case_id: resultCaseId,
      job_id: jobId,
      measurements: normalizedCaseResult.measurements,
      planning: normalizedCaseResult.planning,
    });

    const readiness = evaluateCaseDisplayReadiness({
      measurements: normalizedCaseResult.measurements,
      planning: normalizedCaseResult.planning,
      artifactTypes: writtenArtifactTypes,
    });

    await env.DB.prepare(`UPDATE jobs SET status = 'succeeded', finished_at = ?2, error_message = NULL WHERE id = ?1`)
      .bind(jobId, new Date().toISOString())
      .run();
    await tryUpdateJobExtendedFields(env, jobId, {
      progress: 100,
      stage: readiness.display_ready ? "completed" : "completed_incomplete",
      result_case_id: resultCaseId,
      updated_at: new Date().toISOString(),
    });
  } else {
    await env.DB.prepare(`UPDATE jobs SET status = 'succeeded', finished_at = ?2, error_message = NULL WHERE id = ?1`)
      .bind(jobId, new Date().toISOString())
      .run();
    await tryUpdateJobExtendedFields(env, jobId, {
      progress: 100,
      stage: "completed_incomplete",
      result_case_id: resultCaseId,
      updated_at: new Date().toISOString(),
    });
  }

  if (Array.isArray(payload.metrics)) {
    for (const metric of payload.metrics) {
      if (!metric || typeof metric.name !== "string") continue;
      if (!Number.isFinite(metric.value)) continue;
      await env.DB.prepare(
        `INSERT INTO metrics (id, job_id, metric_name, metric_value, unit)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      )
        .bind(crypto.randomUUID(), jobId, metric.name.trim(), metric.value, nullableString(metric.unit))
        .run();
    }
  }

}

async function markJobFailed(env: Env, jobId: string, message: string): Promise<void> {
  await env.DB.prepare(`UPDATE jobs SET status = 'failed', error_message = ?2, finished_at = ?3 WHERE id = ?1`)
    .bind(jobId, message, new Date().toISOString())
    .run();
  await tryUpdateJobExtendedFields(env, jobId, {
    progress: 100,
    stage: "failed",
    updated_at: new Date().toISOString(),
  });
}

async function writeJsonArtifact(
  env: Env,
  jobId: string,
  studyId: string,
  artifactType: string,
  filename: string,
  data: unknown
): Promise<void> {
  const objectKey = `studies/${studyId}/jobs/${jobId}/${filename}`;
  const body = JSON.stringify(data, null, 2);
  await env.R2_MASK.put(objectKey, body, { httpMetadata: { contentType: "application/json" } });
  await insertArtifactRecord(env, jobId, artifactType, objectKey, body.length, null);
}

async function writeBinaryArtifact(
  env: Env,
  jobId: string,
  studyId: string,
  artifactType: string,
  filename: string,
  bytes: Uint8Array,
  contentType: string
): Promise<void> {
  const objectKey = `studies/${studyId}/jobs/${jobId}/${filename}`;
  await env.R2_MASK.put(objectKey, bytes, { httpMetadata: { contentType } });
  const sha = await sha256HexFromBytes(bytes);
  await insertArtifactRecord(env, jobId, artifactType, objectKey, bytes.byteLength, sha);
}

async function insertArtifactRecord(
  env: Env,
  jobId: string,
  artifactType: string,
  objectKey: string,
  bytes: number,
  sha256: string | null
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO artifacts (id, job_id, artifact_type, bucket, object_key, sha256, bytes)
     VALUES (?1, ?2, ?3, 'aortic-mask-out', ?4, ?5, ?6)`
  )
    .bind(crypto.randomUUID(), jobId, artifactType, objectKey, sha256, bytes)
    .run();
}

function getInferenceMode(env: Env): InferenceMode {
  const raw = (env.INFERENCE_MODE || "mock").trim().toLowerCase();
  return raw === "webhook" ? "webhook" : "mock";
}

function buildCallbackUrl(env: Env): string | null {
  const base = (env.API_BASE_URL || "").trim().replace(/\/$/, "");
  if (!base) return null;
  return `${base}/callbacks/inference`;
}

function parsePositiveInt(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const x = Number.parseInt(v, 10);
  if (!Number.isFinite(x) || x <= 0) return fallback;
  return x;
}

function parseBooleanLike(v: string | undefined): boolean {
  const raw = String(v || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function html(markup: string, status = 200): Response {
  const headers = new Headers(jsonHeaders);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(markup, { status, headers });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: jsonHeaders
  });
}

async function readJson(request: Request): Promise<any> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error("content_type_must_be_application_json");
  }
  return request.json();
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v : fallback;
}

function nullableString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const x = v.trim();
  return x ? x : null;
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeUploadFileDescriptor(filenameRaw: string, contentTypeRaw: string): {
  filename: string;
  imageFormat: "nifti" | "dicom_zip";
} {
  const filename = sanitizeFilename(filenameRaw || "upload.nii.gz");
  const lowerName = filename.toLowerCase();
  const lowerType = String(contentTypeRaw || "").toLowerCase();

  const isZipLike =
    lowerName.endsWith(".zip")
    || lowerType.includes("zip")
    || lowerType.includes("dicom");

  if (isZipLike) {
    const normalized = lowerName.endsWith(".zip") ? filename : `${filename}.zip`;
    return { filename: normalized, imageFormat: "dicom_zip" };
  }

  if (lowerName.endsWith(".nii.gz") || lowerName.endsWith(".nii")) {
    return { filename, imageFormat: "nifti" };
  }

  const normalized = `${filename}.nii.gz`;
  return { filename: normalized, imageFormat: "nifti" };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256HexFromBytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readRecordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function secondsBetween(a: unknown, b: unknown): number | null {
  const ta = parseDateLike(a);
  const tb = parseDateLike(b);
  if (ta === null || tb === null) return null;
  return Math.max(0, Number(((tb - ta) / 1000).toFixed(3)));
}

function parseDateLike(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const x = v.trim();
  if (!x) return null;
  const normalized = x.includes("T") ? x : `${x.replace(" ", "T")}Z`;
  const t = Date.parse(normalized);
  if (!Number.isFinite(t)) return null;
  return t;
}

function safeJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function pickObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractLabelKeys(resultPayload: Record<string, unknown> | null): string[] {
  if (!resultPayload) return [];
  const labels = resultPayload.labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return [];
  return Object.keys(labels as Record<string, unknown>).sort();
}

function buildClinicalTargets(labelKeys: string[]): Record<string, unknown> {
  const hasRoot = labelKeys.includes("1");
  const hasLeaflets = labelKeys.includes("2");
  const hasAscAorta = labelKeys.includes("3");
  const hasCoreMulticlass = hasRoot && hasLeaflets && hasAscAorta;

  const pearsReadyCount = [hasRoot, hasAscAorta].filter(Boolean).length;
  const vsrrReadyCount = [hasRoot, hasLeaflets].filter(Boolean).length;
  const taviReadyCount = [hasRoot, hasLeaflets, hasAscAorta].filter(Boolean).length;

  return {
    standard_version: "evidence-standard-2026-03-11",
    pears: {
      objective: "个体化PEARS术前3D打印网罩设计与安全边界校核",
      readiness: {
        stage: hasCoreMulticlass ? "partial-ready" : "not-ready",
        score: Number((pearsReadyCount / 2).toFixed(2))
      },
      required_outputs: [
        { key: "external_surface_root_to_ascending", status: hasRoot && hasAscAorta ? "available" : "missing" },
        { key: "coronary_ostia_landmarks", status: "missing" },
        { key: "avj_vbr_plane", status: "missing" },
        { key: "stj_ring_and_distal_extent", status: hasAscAorta ? "available" : "missing" }
      ],
      key_scalars_mm: [
        "VBR diameter",
        "max sinus diameter",
        "STJ diameter",
        "distance: VBR to each coronary ostium",
        "supported segment length"
      ],
      standards: [
        {
          id: "pears_s1",
          title: "根部-升主动脉连续外表面",
          rule: "必须有 root(1) 与 ascending(3) 的连续分割面，且STJ可识别；直径在中心线正交切面测量",
          evidence: "PEARS定制外支撑依赖连续几何外形；血管直径需在中心线垂直平面测量以避免斜切误差"
        },
        {
          id: "pears_s2",
          title: "冠脉开口避让",
          rule: "需定位左右冠脉开口中心并保留安全开窗",
          evidence: "PEARS制造/术中对冠脉开孔定位是关键安全约束"
        },
        {
          id: "pears_s3",
          title: "早期预防性干预窗口",
          rule: "优先用于尚未发生夹层、以保瓣与保留自体血管为目标的人群",
          evidence: "PEARS长期随访研究强调在高危遗传性根部扩张中的早期应用价值"
        }
      ]
    },
    vsrr: {
      objective: "VSRR（David）术前几何重建评估与缝合位点规划",
      readiness: {
        stage: hasCoreMulticlass ? "partial-ready" : "not-ready",
        score: Number((vsrrReadyCount / 2).toFixed(2))
      },
      required_outputs: [
        { key: "vbr_annulus_geometry", status: hasRoot ? "available" : "missing" },
        { key: "commissural_positions_3d", status: "missing" },
        { key: "commissural_heights", status: "missing" },
        { key: "leaflet_geometric_effective_height", status: hasLeaflets ? "available" : "missing" },
        { key: "annulus_cusp_mismatch_risk", status: "missing" }
      ],
      key_scalars_mm: [
        "VBR area/perimeter/equivalent diameter",
        "intercommissural distances and angular map",
        "commissural heights",
        "leaflet geometric height / effective height",
        "predicted coaptation reserve"
      ],
      standards: [
        {
          id: "vsrr_s1",
          title: "VBR/瓣环-STJ几何匹配",
          rule: "必须给出VBR与STJ在双斜位/中心线正交切面的直径及差值，用于移植物尺寸决策",
          evidence: "VSRR耐久性与瓣环-管径几何匹配高度相关；双斜位/正交测量可提高几何一致性"
        },
        {
          id: "vsrr_s2",
          title: "Commissure三点定位",
          rule: "需提供三交界点角度映射（近似120°拓扑）与高度平面",
          evidence: "CT术前预测可显著减少术中反复调整缝合位点"
        },
        {
          id: "vsrr_s3",
          title: "瓣叶对合储备",
          rule: "需评估几何高度/有效高度与annulus-cusp mismatch风险",
          evidence: "annulus-cusp mismatch与术后返流及再干预风险相关"
        }
      ]
    },
    tavi: {
      objective: "TAVI术前精准影像规划（瓣环尺寸、冠脉风险、入路评估）",
      readiness: {
        stage: hasCoreMulticlass ? "partial-ready" : "not-ready",
        score: Number((taviReadyCount / 3).toFixed(2))
      },
      required_outputs: [
        { key: "annulus_area_perimeter_diameter_double_oblique", status: hasRoot ? "available" : "missing" },
        { key: "sinus_stj_ascending_geometry", status: hasRoot && hasAscAorta ? "available" : "missing" },
        { key: "leaflet_calcification_load", status: hasLeaflets ? "available" : "missing" },
        { key: "coronary_ostia_heights", status: "missing" },
        { key: "vtc_vtstj_virtual_valve", status: "missing" },
        { key: "aorto_iliofemoral_access", status: "missing" }
      ],
      key_scalars_mm: [
        "Annulus area/perimeter/equivalent diameter",
        "Annulus major/minor diameter and eccentricity",
        "Sinus of Valsalva max diameter",
        "STJ diameter",
        "Ascending aorta diameter",
        "Coronary height (L/R)",
        "VTC / VTSTJ",
        "Access route minimal lumen diameter"
      ],
      standards: [
        {
          id: "tavi_s1",
          title: "双斜位瓣环测量",
          rule: "瓣环面积/周长/直径必须在中心线正交（double-oblique）切面测量",
          evidence: "SCCT与TAVI术前CT文献强调双斜位/正交测量可降低斜切误差"
        },
        {
          id: "tavi_s2",
          title: "冠脉阻塞风险评估",
          rule: "需提供冠脉开口高度与VTC/VTSTJ，结合窦部/STJ几何评估高危解剖",
          evidence: "冠脉阻塞风险文献将冠脉高度、VTC/VTSTJ与窦部几何列为核心指标"
        },
        {
          id: "tavi_s3",
          title: "经股入路评估",
          rule: "需评估主动脉-髂股路径最小管径、钙化与迂曲度以判断入路可行性",
          evidence: "TAVI术前CT工作流将入路最小管径与血管病变作为关键安全门槛"
        }
      ]
    },
    evidence_refs: [
      {
        topic: "Default full CTA demo source (CTACardio)",
        url: "https://github.com/supervisely-ecosystem/demo-volumes"
      },
      {
        topic: "nnU-Net (Nature Methods, 2021)",
        url: "https://doi.org/10.1038/s41592-020-01008-z"
      },
      {
        topic: "TotalSegmentator paper (Radiology: AI, 2023)",
        url: "https://doi.org/10.1148/ryai.230024"
      },
      {
        topic: "Automatic aortic valve cusps segmentation (J Imaging, 2022)",
        url: "https://pubmed.ncbi.nlm.nih.gov/35049852/"
      },
      {
        topic: "SCCT CT imaging consensus for TAVI/TAVR (2019)",
        url: "https://pubmed.ncbi.nlm.nih.gov/30630686/"
      },
      {
        topic: "Guide for pre-procedural imaging for TAVR",
        url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC7690031/"
      },
      {
        topic: "TAVI procedural steps and current advances (part 2)",
        url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC8212161/"
      },
      {
        topic: "UK CT-TAVI reporting practice survey",
        url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC7254150/"
      },
      {
        topic: "Coronary obstruction risk: ELOD and cusp height mismatch",
        url: "https://pubmed.ncbi.nlm.nih.gov/34917750/"
      },
      {
        topic: "Aortic diameter by centerline-perpendicular planes (J Card Surg, 2020)",
        url: "https://pubmed.ncbi.nlm.nih.gov/30673817/"
      },
      {
        topic: "TEVAR reporting standards (SVS, centerline reconstruction emphasis)",
        url: "https://pubmed.ncbi.nlm.nih.gov/32628988/"
      },
      {
        topic: "AortaSeg24 challenge (CTA multi-class benchmark)",
        url: "https://aortaseg24.grand-challenge.org"
      },
      {
        topic: "ASOCA coronary CTA dataset/challenge",
        url: "https://asoca.grand-challenge.org/"
      },
      {
        topic: "PEARS technique and outcomes",
        url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9205243/"
      },
      {
        topic: "PEARS intention-to-treat long-term outcomes",
        url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC4033204/"
      },
      {
        topic: "VSRR CT-based commissural prediction",
        url: "https://pubmed.ncbi.nlm.nih.gov/39626488/"
      },
      {
        topic: "Aortic valve repair and cusp effective height concept",
        url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC6562088/"
      },
      {
        topic: "Annulus-cusp mismatch impact after VSRR",
        url: "https://academic.oup.com/icvts/article/40/1/ivaf048/7999382"
      },
      {
        topic: "CT timing and aortic root measurement before TAVI",
        url: "https://pubmed.ncbi.nlm.nih.gov/25708961/"
      }
    ]
  };
}

function toInferenceCallbackPayload(
  record: Record<string, unknown>,
  fallbackJobId: string,
  fallbackStatus: string
): InferenceCallbackPayload {
  return {
    job_id: readRecordString(record, "job_id") || fallbackJobId,
    status: readRecordString(record, "status") || fallbackStatus,
    provider_job_id: readRecordString(record, "provider_job_id") || undefined,
    error_message: readRecordString(record, "error_message") || undefined,
    result_json:
      record.result_json && typeof record.result_json === "object"
        ? (record.result_json as Record<string, unknown>)
        : undefined,
    mask_base64: readRecordString(record, "mask_base64") || undefined,
    mask_filename: readRecordString(record, "mask_filename") || undefined,
    mask_content_type: readRecordString(record, "mask_content_type") || undefined,
    artifacts: Array.isArray(record.artifacts) ? (record.artifacts as CallbackArtifact[]) : undefined,
    metrics: Array.isArray(record.metrics) ? (record.metrics as CallbackMetric[]) : undefined
  };
}

const DEMO_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="icon" href="data:," />
  <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate, max-age=0" />
  <meta http-equiv="Pragma" content="no-cache" />
  <meta http-equiv="Expires" content="0" />
  <title>Aortic AI Surgical Planning Workstation</title>
  <style>
    :root {
      --bg: #0b1220;
      --panel: #111827;
      --panel2: #0f172a;
      --line: #253247;
      --ink: #e5edf7;
      --muted: #9fb0c4;
      --accent: #22d3ee;
      --good: #16a34a;
      --warn: #f59e0b;
      --bad: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background: radial-gradient(1200px 650px at 16% -10%, #1e3a5f 0%, #0b1220 48%);
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial;
    }
    .wrap { max-width: 1500px; margin: 0 auto; padding: 14px; }
    .top {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      background: linear-gradient(180deg, #121a2a, #0e1624);
      border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; margin-bottom: 12px;
    }
    .title { font-size: 22px; font-weight: 800; letter-spacing: .3px; }
    .subtitle { color: var(--muted); font-size: 13px; margin-top: 3px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .btn {
      border: 1px solid #2b3b52; background: #132033; color: #dbe9f8; border-radius: 10px;
      padding: 8px 12px; font-weight: 700; cursor: pointer; font-size: 13px;
    }
    .btn:hover { border-color: #38bdf8; }
    .btn.active { border-color: #38bdf8; background: #10304d; }
    .btn:disabled { opacity: .55; cursor: not-allowed; border-color: #2b3b52; }
    .layout { display: grid; grid-template-columns: 320px 1fr 380px; gap: 12px; }
    .layout-bottom { margin-top: 12px; }
    .bottom-table { width: 100%; border-collapse: collapse; }
    .bottom-table th, .bottom-table td { border-bottom: 1px solid var(--line); padding: 7px 5px; text-align: left; font-size: 12px; }
    .bottom-table th { color: var(--muted); font-weight: 700; }
    .panel {
      background: linear-gradient(180deg, var(--panel) 0%, var(--panel2) 100%);
      border: 1px solid var(--line); border-radius: 14px; padding: 12px;
    }
    .sec { margin-top: 12px; }
    .sec:first-child { margin-top: 0; }
    .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .7px; margin-bottom: 6px; }
    .v { font-size: 14px; font-weight: 700; word-break: break-word; }
    .small { font-size: 12px; color: var(--muted); }
    .row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; margin-bottom: 7px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
    .input, .range, .select {
      width: 100%; border-radius: 9px; border: 1px solid #2b3b52; background: #0b1422; color: #dbe9f8; padding: 7px;
    }
    .viewer-wrap { position: relative; min-height: 760px; }
    #viewer {
      width: 100%;
      height: 760px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #02060d;
      cursor: grab;
      display: block;
      image-rendering: auto;
    }
    .mpr-grid {
      margin-top: 8px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .mpr-card {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 6px;
      background: rgba(8, 14, 24, .9);
    }
    .mpr-title {
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 5px;
      text-transform: uppercase;
      letter-spacing: .5px;
    }
    #viewerSagittal, #viewerCoronal {
      width: 100%;
      height: 190px;
      border: 1px solid #21324a;
      border-radius: 8px;
      background: #040a14;
      display: block;
      image-rendering: auto;
    }
    #viewer3d {
      width: 100%;
      height: 360px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: radial-gradient(circle at 30% 20%, #10243f 0%, #070d19 52%, #040811 100%);
      display: block;
      cursor: grab;
      margin-top: 8px;
    }
    #viewer3d.dragging { cursor: grabbing; }
    .recon3d-tools { margin-top: 8px; }
    #viewer.dragging { cursor: grabbing; }
    .overlay-badge {
      position: absolute; left: 12px; top: 12px;
      background: rgba(11, 17, 29, .78); border: 1px solid #27405a;
      border-radius: 10px; padding: 7px 9px; font-size: 12px; line-height: 1.45;
    }
    .overlay-badge div { color: #d9e9fb; }
    .badge-key { color: #fef08a; }
    .chip { display: inline-block; border: 1px solid #2a3d56; border-radius: 999px; padding: 1px 8px; font-size: 11px; margin-right: 4px; }
    .chip.ok { border-color: #1f8b4d; color: #7ef2af; }
    .chip.warn { border-color: #866104; color: #ffd17d; }
    .chip.bad { border-color: #9a3030; color: #ff9f9f; }
    a { color: #7dd3fc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; }
    th, td { border-bottom: 1px solid var(--line); padding: 7px 5px; text-align: left; font-size: 12px; }
    th { color: var(--muted); font-weight: 700; }
    pre {
      margin: 0; padding: 10px; border-radius: 10px; background: #0a1321; border: 1px solid #223148;
      max-height: 180px; overflow: auto; color: #dce8f7; font-size: 11px; line-height: 1.35;
    }
    .legend { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .dot { width: 10px; height: 10px; border-radius: 999px; display: inline-block; margin-right: 5px; vertical-align: middle; }
    .muted { color: var(--muted); }
    .lang-modal {
      position: fixed; inset: 0; z-index: 50;
      background: rgba(2, 6, 14, .72);
      display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(2px);
    }
    .lang-modal.hidden { display: none; }
    .lang-card {
      width: min(92vw, 420px);
      background: linear-gradient(180deg, #121a2a, #0d1422);
      border: 1px solid #2a3b54;
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 16px 50px rgba(0, 0, 0, .45);
    }
    .lang-title { font-size: 18px; font-weight: 800; margin-bottom: 6px; }
    .lang-sub { font-size: 12px; color: var(--muted); margin-bottom: 12px; }
    .lang-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    @media (max-width: 1320px) {
      .layout { grid-template-columns: 1fr; }
      .viewer-wrap { min-height: 560px; }
      #viewer { height: 560px; }
    }
  </style>
</head>
<body>
  <div id="langModal" class="lang-modal hidden">
    <div class="lang-card">
      <div class="lang-title" id="langTitle">选择语言 / Choose language</div>
      <div class="lang-sub" id="langSub">首次使用请选择界面语言，之后可随时在右上角切换。</div>
      <div class="lang-grid">
        <button class="btn" id="btnLangModalZh">中文</button>
        <button class="btn" id="btnLangModalEn">English</button>
      </div>
    </div>
  </div>

  <div class="wrap">
    <div class="top">
      <div>
        <div class="title" id="titleMain">Aortic AI Surgical Planning Workstation</div>
        <div class="subtitle" id="subtitleMain">PEARS 网罩规划 + VSRR 几何评估 + TAVI 术前规划，单页可视化与自动标注</div>
      </div>
      <div class="actions">
        <button class="btn" id="btnReloadCase">刷新病例</button>
        <button class="btn" id="btnAutoSeg">自动分割</button>
        <button class="btn" id="btnResetView">重置视图</button>
        <button class="btn" id="btnShowPlan">查看全部方案</button>
        <button class="btn" id="btnLangSwitch">中文 / EN</button>
      </div>
    </div>

    <div class="layout">
      <div class="panel">
        <div class="sec">
          <div class="k" id="kCase">Case</div>
          <div class="v" id="studyId">-</div>
          <div class="small"><span id="lblJob">Job</span>: <span id="jobId">-</span></div>
          <div class="small"><span id="lblStatus">Status</span>: <span id="jobStatus">-</span></div>
          <div class="small"><span id="lblDataset">Dataset</span>: <span id="datasetName">-</span></div>
          <div class="small"><span id="lblPhase">Phase</span>: <span id="datasetPhase">-</span></div>
        </div>

        <div class="sec">
          <div class="k" id="kCloud">Cloud Inference</div>
          <input id="ctFileInput" class="input" type="file" accept=".nii,.nii.gz,.zip,.dcm,application/gzip,application/zip,application/dicom,application/octet-stream" />
          <div class="small" style="margin-top:6px;" id="cloudHint">选择 CTA 文件（.nii/.nii.gz/.zip/.dcm）</div>
          <div class="grid2" style="margin-top:8px;">
            <button class="btn" id="btnRunCloud">上传并跑任务</button>
            <button class="btn" id="btnLoadLatest">载入最新成功病例</button>
          </div>
          <div class="small muted" id="cloudProgress" style="margin-top:8px;">待机</div>
        </div>

        <div class="sec">
          <div class="k" id="kViewer">Viewer Controls</div>
          <div class="row"><span class="small" id="lblSlice">Slice</span><span class="small" id="sliceLabel">-</span></div>
          <input id="sliceRange" class="range" type="range" min="0" max="0" value="0" />

          <div class="row" style="margin-top:8px;"><span class="small" id="lblWw">Window Width</span><span class="small" id="wwLabel">350</span></div>
          <input id="wwRange" class="range" type="range" min="50" max="2000" value="350" />

          <div class="row" style="margin-top:8px;"><span class="small" id="lblWl">Window Level</span><span class="small" id="wlLabel">40</span></div>
          <input id="wlRange" class="range" type="range" min="-300" max="600" value="40" />

          <div class="row" style="margin-top:8px;"><span class="small" id="lblOverlay">Overlay Opacity</span><span class="small" id="opLabel">0.35</span></div>
          <input id="overlayOpacity" class="range" type="range" min="0" max="1" step="0.01" value="0.35" />

          <div class="grid2" style="margin-top:8px;">
            <button class="btn" id="btnZoomIn">放大</button>
            <button class="btn" id="btnZoomOut">缩小</button>
          </div>
          <div class="grid2" style="margin-top:8px;">
            <button class="btn" id="btnPrev">上一层</button>
            <button class="btn" id="btnNext">下一层</button>
          </div>
          <div class="small muted" style="margin-top:8px;" id="viewerHint">鼠标滚轮切层；按住 Ctrl + 滚轮缩放；拖拽平移。</div>
        </div>

        <div class="sec">
          <div class="k" id="kKeySlices">Key Slices</div>
          <div class="grid2">
            <button class="btn" id="btnJumpVbr">VBR</button>
            <button class="btn" id="btnJumpStj">STJ</button>
          </div>
          <div class="grid2" style="margin-top:8px;">
            <button class="btn" id="btnJumpLeaf">Leaflet</button>
            <button class="btn" id="btnJumpRootMax">Root Max</button>
          </div>
          <div class="grid2" style="margin-top:8px;">
            <button class="btn" id="btnJumpAscMax">Asc Max</button>
            <button class="btn" id="btnJumpBest">Best Slice</button>
          </div>
          <div class="small muted" style="margin-top:8px;" id="keySliceHint">一键跳转关键切片并显示测量线。</div>
        </div>

        <div class="sec">
          <div class="k" id="kFiles">Case Files</div>
          <div class="small"><a id="rawLink" href="#">下载原始CT</a></div>
          <div class="small"><a id="segMaskLink" href="#">下载分割掩码 NIfTI</a></div>
          <div class="small"><a id="resultLink" href="#">下载分割结果JSON</a></div>
          <div class="small"><a id="measurementsLink" href="#">下载测量结果 JSON</a></div>
          <div class="small"><a id="reportPdfLink" href="#">下载规划报告 PDF</a></div>
          <div class="small"><a id="rootStlLink" href="#">下载主动脉根部 STL</a></div>
          <div class="small"><a id="ascStlLink" href="#">下载升主动脉 STL</a></div>
          <div class="small"><a id="leafletsStlLink" href="#">下载瓣叶 STL</a></div>
          <div class="small"><a id="rootModelLink" href="#">下载数字孪生模型 JSON</a></div>
          <div class="small"><a id="leafletModelLink" href="#">下载瓣叶模型 JSON</a></div>
          <div class="small"><a id="receiptLink" href="#">下载Provider回执</a></div>
          <div class="small"><a id="jobApiLink" href="#">查看Job API</a></div>
        </div>

        <div class="sec">
          <div class="k" id="kLegend">Legend</div>
          <div class="legend">
            <span class="small" id="legendLeaf"><span class="dot" style="background:#facc15"></span>Valve Leaflets</span>
            <span class="small" id="legendRoot"><span class="dot" style="background:#ef4444"></span>Aortic Root</span>
            <span class="small" id="legendAsc"><span class="dot" style="background:#22d3ee"></span>Ascending Aorta</span>
          </div>
        </div>
      </div>

      <div class="panel viewer-wrap">
        <canvas id="viewer"></canvas>
        <div class="overlay-badge">
          <div><span id="badgeLabelSlice">Slice</span>: <span id="badgeSlice">-</span></div>
          <div><span id="badgeLabelZoom">Zoom</span>: <span id="badgeZoom">1.00x</span></div>
          <div><span id="badgeLabelVoxel">Voxel(mm)</span>: <span id="badgeVoxel">-</span></div>
          <div><span id="badgeLabelSeg">Auto-Seg</span>: <span id="badgeSeg">pending</span></div>
          <div><span id="badgeLabelKey">Key Slice</span>: <span id="badgeKey" class="badge-key">-</span></div>
        </div>
        <div class="mpr-grid">
          <div class="mpr-card">
            <div class="mpr-title">Sagittal MPR</div>
            <canvas id="viewerSagittal"></canvas>
          </div>
          <div class="mpr-card">
            <div class="mpr-title">Coronal MPR</div>
            <canvas id="viewerCoronal"></canvas>
          </div>
        </div>
        <div class="sec recon3d-tools">
          <div class="k" id="kRecon3d">CTA 3D Reconstruction</div>
          <div class="grid3">
            <button class="btn active" id="btn3dRoot">Root</button>
            <button class="btn active" id="btn3dLeaf">Leaflets</button>
            <button class="btn active" id="btn3dAsc">Ascending</button>
          </div>
          <div class="grid2" style="margin-top:8px;">
            <button class="btn" id="btnRebuild3d">重建 3D</button>
            <button class="btn" id="btnReset3d">重置 3D 视角</button>
          </div>
          <div class="small muted" style="margin-top:8px;" id="recon3dHint">拖拽旋转，滚轮缩放，双击重置；使用当前真实分割重建。</div>
          <div class="small muted" style="margin-top:6px;" id="recon3dStatus">等待分割完成...</div>
          <canvas id="viewer3d"></canvas>
        </div>
      </div>

      <div class="panel">
        <div class="sec">
          <div class="k" id="kDisplayMode">Measurement Display</div>
          <div class="grid2">
            <button class="btn active" id="btnDispCt">CT Overlay</button>
            <button class="btn" id="btnDispPanel">Panel Only</button>
          </div>
          <div class="small muted" style="margin-top:8px;" id="measureModeState">当前模式：CT叠加显示</div>
        </div>

        <div class="sec">
          <div class="k" id="kPears">PEARS Planning</div>
          <div id="pearsState" class="chip warn">partial-ready</div>
          <table>
            <tbody id="pearsMetrics"></tbody>
          </table>
        </div>

        <div class="sec">
          <div class="k" id="kVsrr">VSRR Planning</div>
          <div id="vsrrState" class="chip warn">partial-ready</div>
          <table>
            <tbody id="vsrrMetrics"></tbody>
          </table>
        </div>

        <div class="sec">
          <div class="k" id="kTavi">TAVI Planning</div>
          <div id="taviState" class="chip warn">partial-ready</div>
          <table>
            <tbody id="taviMetrics"></tbody>
          </table>
        </div>

        <div class="sec">
          <div class="k" id="kPlan">One-Click Surgical Plan</div>
          <div class="grid2">
            <button class="btn" id="btnMakePears">生成 PEARS 方案</button>
            <button class="btn" id="btnMakeVsrr">生成 VSRR 方案</button>
          </div>
          <div style="margin-top:8px;">
            <button class="btn" id="btnMakeTavi" style="width:100%;">生成 TAVI 方案</button>
          </div>
          <pre id="planPreview" style="margin-top:8px;">等待生成...</pre>
        </div>

        <div class="sec">
          <div class="k" id="kMetrics">Pipeline Metrics</div>
          <table>
            <thead><tr><th id="thName">Name</th><th id="thValue">Value</th><th id="thUnit">Unit</th></tr></thead>
            <tbody id="pipelineMetrics"></tbody>
          </table>
        </div>

        <div class="sec">
          <div class="k" id="kEvidence">Evidence Links</div>
          <div id="evidenceLinks" class="small"></div>
        </div>

        <div class="sec">
          <div class="k" id="kLatest">Latest Result JSON</div>
          <pre id="resultPreview">loading...</pre>
        </div>
      </div>
    </div>
    <div class="panel layout-bottom">
      <div class="k" id="kBottomMeasure">Live Measurement Board</div>
      <table class="bottom-table">
        <thead>
          <tr>
            <th id="bottomThMetric">Metric</th>
            <th id="bottomThValue">Value</th>
            <th id="bottomThUnit">Unit</th>
            <th id="bottomThSource">Source</th>
          </tr>
        </thead>
        <tbody id="bottomMeasurements"></tbody>
      </table>
    </div>
  </div>

  <script type="module">
    const $ = (id) => document.getElementById(id);
    const fmt = (v, n = 2) => (v === null || v === undefined || Number.isNaN(v) ? '-' : Number(v).toFixed(n));
    const fmtInt = (v) => (v === null || v === undefined ? '-' : String(v));
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const NIFTI_TYPES = {
      UINT8: 2,
      INT16: 4,
      INT32: 8,
      FLOAT32: 16,
      FLOAT64: 64,
      INT8: 256,
      UINT16: 512,
      UINT32: 768
    };

    const state = {
      caseData: null,
      lang: 'zh',
      header: null,
      vol: null,
      slope: 1,
      inter: 0,
      dims: { x: 0, y: 0, z: 0 },
      vox: { dx: 1, dy: 1, dz: 1 },
      slice: 0,
      ww: 350,
      wl: 40,
      zoom: 1,
      panX: 0,
      panY: 0,
      dragging: false,
      dragStartX: 0,
      dragStartY: 0,
      seg: null,
      segReady: false,
      segSource: 'none',
      contourCache: new Map(),
      overlayOpacity: 0.35,
      measureDisplay: 'ct',
      bestSlice: 0,
      keySliceMap: {},
      lastPlanKind: 'pears',
      stats: null,
      pipelineResult: null,
      centerlineData: null,
      annulusPlaneData: null,
      rootModelData: null,
      leafletModelData: null,
      bodyBounds: null,
      recon3d: {
        lib: null,
        renderer: null,
        scene: null,
        camera: null,
        group: null,
        canvas: null,
        controls: null,
        animationHandle: 0,
        initialized: false,
        classVisible: { 1: true, 2: true, 3: true },
        triangleCount: 0
      }
    };

    const I18N = {
      zh: {
        langTitle: '选择语言 / Choose language',
        langSub: '首次使用请选择界面语言，之后可随时在右上角切换。',
        titleMain: '主动脉 AI 术前规划工作站',
        subtitleMain: 'PEARS 网罩规划 + VSRR 几何评估 + TAVI 术前规划，单页可视化与自动标注',
        btnReloadCase: '刷新病例',
        btnAutoSeg: '载入真实分割',
        btnResetView: '重置视图',
        btnShowPlan: '查看全部方案',
        btnRunCloud: '上传并跑任务',
        btnLoadLatest: '载入最新成功病例',
        btnZoomIn: '放大',
        btnZoomOut: '缩小',
        btnPrev: '上一层',
        btnNext: '下一层',
        btnMakePears: '生成 PEARS 方案',
        btnMakeVsrr: '生成 VSRR 方案',
        btnMakeTavi: '生成 TAVI 方案',
        btnRebuild3d: '重建 3D',
        btnReset3d: '重置 3D 视角',
        btn3dRoot: '根部',
        btn3dLeaf: '瓣叶',
        btn3dAsc: '升主动脉',
        btnLangSwitch: '中文 / EN',
        btnJumpVbr: 'VBR',
        btnJumpStj: 'STJ',
        btnJumpLeaf: '瓣叶层',
        btnJumpRootMax: '根部最大层',
        btnJumpAscMax: '升主动脉最大层',
        btnJumpBest: '最佳层',
        btnDispCt: 'CT 叠加',
        btnDispPanel: '仅侧栏',
        kCase: '病例',
        kCloud: '云端推理',
        kViewer: '阅片控制',
        kKeySlices: '关键切片',
        kDisplayMode: '测量显示',
        kFiles: '病例文件',
        kLegend: '图例',
        kPears: 'PEARS 规划',
        kVsrr: 'VSRR 规划',
        kTavi: 'TAVI 规划',
        kRecon3d: 'CTA 三维重建',
        kPlan: '一键手术方案',
        kMetrics: '流水线指标',
        kEvidence: '证据链接',
        kLatest: '最新结果 JSON',
        lblJob: '任务',
        lblStatus: '状态',
        lblDataset: '数据集',
        lblPhase: '期相',
        lblSlice: '层面',
        lblWw: '窗宽',
        lblWl: '窗位',
        lblOverlay: '叠加透明度',
        viewerHint: '鼠标滚轮切层；按住 Ctrl + 滚轮缩放；拖拽平移。',
        keySliceHint: '一键跳转关键切片并显示测量线。',
        recon3dHint: '左键旋转，右键平移，滚轮缩放，双击重置；使用当前真实 STL/数字孪生重建。',
        recon3dStatusIdle: '等待分割完成...',
        recon3dStatusBuilding: '正在重建 3D ...',
        recon3dStatusReady: '3D 重建完成',
        recon3dStatusNoSeg: '尚无可用分割，无法重建 3D',
        recon3dStatusLibFail: '3D 库加载失败，请检查网络',
        cloudHint: '选择 CTA 文件（.nii/.nii.gz/.zip/.dcm）',
        cloudIdle: '待机',
        legendLeaf: '瓣叶',
        legendRoot: '主动脉根部',
        legendAsc: '升主动脉',
        badgeLabelSlice: '层面',
        badgeLabelZoom: '缩放',
        badgeLabelVoxel: '体素(mm)',
        badgeLabelSeg: '自动分割',
        badgeLabelKey: '关键切片',
        rawLink: '下载原始CT',
        segMaskLink: '下载分割掩码 NIfTI',
        resultLink: '下载分割结果JSON',
        measurementsLink: '下载测量结果 JSON',
        reportPdfLink: '下载规划报告 PDF',
        rootStlLink: '下载主动脉根部 STL',
        ascStlLink: '下载升主动脉 STL',
        leafletsStlLink: '下载瓣叶 STL',
        rootModelLink: '下载数字孪生模型 JSON',
        leafletModelLink: '下载瓣叶模型 JSON',
        receiptLink: '下载Provider回执',
        jobApiLink: '查看Job API',
        kBottomMeasure: '实时测量面板',
        bottomThMetric: '指标',
        bottomThValue: '数值',
        bottomThUnit: '单位',
        bottomThSource: '来源',
        thName: '名称',
        thValue: '数值',
        thUnit: '单位',
        loadingResult: 'loading...',
        resultUnavailable: 'result_json 不可用',
        resultLoadFailed: '加载 result_json 失败',
        waitPlan: '正在等待自动分割完成后生成方案...',
        initText: '初始化中...',
        segPending: 'pending',
        segRunning: 'running',
        segFailed: 'failed',
        segDoneReal: 'done(real)',
        segNoModel: 'no-validated-model',
        planWaiting: '请先加载可验证分割结果。',
        noModelHint: '当前病例没有可验证的分割结果。请使用带真实mask的病例，或接入真实推理服务后再分割。',
        volumeLoaded: '影像已加载',
        cloudStep1: '1/4 创建上传会话...',
        cloudStep2: '2/4 上传 CT 文件...',
        cloudStep3: '3/4 创建分割任务...',
        cloudStep4: '4/4 任务运行中...',
        cloudLoad: '加载结果到工作站...',
        cloudDone: '完成',
        cloudFailed: '失败',
        measureModeCt: '当前模式：CT叠加显示',
        measureModePanel: '当前模式：仅侧栏显示',
        keyNone: '无',
        keyVbr: 'VBR 层',
        keyStj: 'STJ 层',
        keyLeaf: '瓣叶层',
        keyRootMax: '根部最大层',
        keyAscMax: '升主动脉最大层',
        keyBest: '最佳层',
        measureVbrDiam: 'VBR 直径（中心线正交）',
        measureStjDiam: 'STJ 直径（中心线正交）',
        measureRootMaxDiam: '根部最大直径（中心线正交）',
        measureAscMaxDiam: '升主动脉最大直径（中心线正交）',
        measureLeafletDiam: '瓣叶区直径（中心线正交）',
        readinessPartial: 'partial-ready',
        readinessNot: 'not-ready',
        readinessReadyLabel: '就绪',
        readinessPartialLabel: '部分就绪',
        readinessNotLabel: '未就绪',
        labelMapTitle: '关键测量',
        btnLangModalZh: '中文',
        btnLangModalEn: 'English'
      },
      en: {
        langTitle: 'Choose Language / 选择语言',
        langSub: 'Pick a UI language on first launch. You can switch anytime from the top-right.',
        titleMain: 'Aortic AI Surgical Planning Workstation',
        subtitleMain: 'PEARS mesh planning + VSRR geometric assessment + TAVI pre-op planning, single-page visualization and auto labeling',
        btnReloadCase: 'Reload Case',
        btnAutoSeg: 'Load Validated Seg',
        btnResetView: 'Reset View',
        btnShowPlan: 'Show All Plans',
        btnRunCloud: 'Upload & Run',
        btnLoadLatest: 'Load Latest Case',
        btnZoomIn: 'Zoom In',
        btnZoomOut: 'Zoom Out',
        btnPrev: 'Previous',
        btnNext: 'Next',
        btnMakePears: 'Generate PEARS',
        btnMakeVsrr: 'Generate VSRR',
        btnMakeTavi: 'Generate TAVI',
        btnRebuild3d: 'Rebuild 3D',
        btnReset3d: 'Reset 3D View',
        btn3dRoot: 'Root',
        btn3dLeaf: 'Leaflets',
        btn3dAsc: 'Ascending',
        btnLangSwitch: 'EN / 中文',
        btnJumpVbr: 'VBR',
        btnJumpStj: 'STJ',
        btnJumpLeaf: 'Leaflet',
        btnJumpRootMax: 'Root Max',
        btnJumpAscMax: 'Asc Max',
        btnJumpBest: 'Best Slice',
        btnDispCt: 'CT Overlay',
        btnDispPanel: 'Panel Only',
        kCase: 'Case',
        kCloud: 'Cloud Inference',
        kViewer: 'Viewer Controls',
        kKeySlices: 'Key Slices',
        kDisplayMode: 'Measurement Display',
        kFiles: 'Case Files',
        kLegend: 'Legend',
        kPears: 'PEARS Planning',
        kVsrr: 'VSRR Planning',
        kTavi: 'TAVI Planning',
        kRecon3d: 'CTA 3D Reconstruction',
        kPlan: 'One-Click Surgical Plan',
        kMetrics: 'Pipeline Metrics',
        kEvidence: 'Evidence Links',
        kLatest: 'Latest Result JSON',
        lblJob: 'Job',
        lblStatus: 'Status',
        lblDataset: 'Dataset',
        lblPhase: 'Phase',
        lblSlice: 'Slice',
        lblWw: 'Window Width',
        lblWl: 'Window Level',
        lblOverlay: 'Overlay Opacity',
        viewerHint: 'Mouse wheel to scroll slices; Ctrl + wheel to zoom; drag to pan.',
        keySliceHint: 'One-click jump to key slices with measurement annotations.',
        recon3dHint: 'Left drag rotates, right drag pans, wheel zooms, double-click resets. Built from current validated STL/digital twin artifacts.',
        recon3dStatusIdle: 'Waiting for segmentation...',
        recon3dStatusBuilding: 'Building 3D model...',
        recon3dStatusReady: '3D reconstruction ready',
        recon3dStatusNoSeg: 'No validated segmentation available for 3D',
        recon3dStatusLibFail: 'Failed to load 3D library; check network access',
        cloudHint: 'Select CTA file (.nii/.nii.gz/.zip/.dcm)',
        cloudIdle: 'idle',
        legendLeaf: 'Valve Leaflets',
        legendRoot: 'Aortic Root',
        legendAsc: 'Ascending Aorta',
        badgeLabelSlice: 'Slice',
        badgeLabelZoom: 'Zoom',
        badgeLabelVoxel: 'Voxel(mm)',
        badgeLabelSeg: 'Auto-Seg',
        badgeLabelKey: 'Key Slice',
        rawLink: 'Download Raw CT',
        segMaskLink: 'Download Segmentation Mask NIfTI',
        resultLink: 'Download Segmentation JSON',
        measurementsLink: 'Download Measurements JSON',
        reportPdfLink: 'Download Planning Report PDF',
        rootStlLink: 'Download Aortic Root STL',
        ascStlLink: 'Download Ascending Aorta STL',
        leafletsStlLink: 'Download Leaflets STL',
        rootModelLink: 'Download Digital Twin Model JSON',
        leafletModelLink: 'Download Leaflet Model JSON',
        receiptLink: 'Download Provider Receipt',
        jobApiLink: 'Open Job API',
        kBottomMeasure: 'Live Measurement Board',
        bottomThMetric: 'Metric',
        bottomThValue: 'Value',
        bottomThUnit: 'Unit',
        bottomThSource: 'Source',
        thName: 'Name',
        thValue: 'Value',
        thUnit: 'Unit',
        loadingResult: 'loading...',
        resultUnavailable: 'result_json unavailable',
        resultLoadFailed: 'failed to load result_json',
        waitPlan: 'Waiting for segmentation to generate surgical plan...',
        initText: 'initializing...',
        segPending: 'pending',
        segRunning: 'running',
        segFailed: 'failed',
        segDoneReal: 'done(real)',
        segNoModel: 'no-validated-model',
        planWaiting: 'Load validated segmentation first.',
        noModelHint: 'No validated segmentation output exists for this case. Use a case with real mask, or connect a real inference provider.',
        volumeLoaded: 'volume loaded',
        cloudStep1: '1/4 Creating upload session...',
        cloudStep2: '2/4 Uploading CT file...',
        cloudStep3: '3/4 Creating segmentation job...',
        cloudStep4: '4/4 Job running...',
        cloudLoad: 'Loading outputs to workstation...',
        cloudDone: 'done',
        cloudFailed: 'failed',
        measureModeCt: 'Mode: CT overlay annotations',
        measureModePanel: 'Mode: side-panel only',
        keyNone: 'none',
        keyVbr: 'VBR slice',
        keyStj: 'STJ slice',
        keyLeaf: 'Leaflet slice',
        keyRootMax: 'Root max slice',
        keyAscMax: 'Ascending max slice',
        keyBest: 'Best slice',
        measureVbrDiam: 'VBR diameter (orthogonal)',
        measureStjDiam: 'STJ diameter (orthogonal)',
        measureRootMaxDiam: 'Root max diameter (orthogonal)',
        measureAscMaxDiam: 'Ascending max diameter (orthogonal)',
        measureLeafletDiam: 'Leaflet-zone diameter (orthogonal)',
        readinessPartial: 'partial-ready',
        readinessNot: 'not-ready',
        readinessReadyLabel: 'ready',
        readinessPartialLabel: 'partial-ready',
        readinessNotLabel: 'not-ready',
        labelMapTitle: 'Key Measurements',
        btnLangModalZh: '中文',
        btnLangModalEn: 'English'
      }
    };

    const canvas = $('viewer');
    const ctx = canvas.getContext('2d');
    const canvasSag = $('viewerSagittal');
    const ctxSag = canvasSag ? canvasSag.getContext('2d') : null;
    const canvasCor = $('viewerCoronal');
    const ctxCor = canvasCor ? canvasCor.getContext('2d') : null;
    const off = document.createElement('canvas');
    const offCtx = off.getContext('2d');
    const ov = document.createElement('canvas');
    const ovCtx = ov.getContext('2d');
    const offSag = document.createElement('canvas');
    const offSagCtx = offSag.getContext('2d');
    const offCor = document.createElement('canvas');
    const offCorCtx = offCor.getContext('2d');

    function setCanvasSize() {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(2, Math.floor(rect.width * ratio));
      canvas.height = Math.max(2, Math.floor(rect.height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (canvasSag && ctxSag) {
        const rs = canvasSag.getBoundingClientRect();
        canvasSag.width = Math.max(2, Math.floor(rs.width * ratio));
        canvasSag.height = Math.max(2, Math.floor(rs.height * ratio));
        ctxSag.setTransform(ratio, 0, 0, ratio, 0, 0);
      }
      if (canvasCor && ctxCor) {
        const rc = canvasCor.getBoundingClientRect();
        canvasCor.width = Math.max(2, Math.floor(rc.width * ratio));
        canvasCor.height = Math.max(2, Math.floor(rc.height * ratio));
        ctxCor.setTransform(ratio, 0, 0, ratio, 0, 0);
      }
      render();
    }

    function indexOf(x, y, z) {
      return z * state.dims.x * state.dims.y + y * state.dims.x + x;
    }

    function isGzipBuffer(buf) {
      const u8 = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
      return u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
    }

    async function gunzipArrayBuffer(buf) {
      if (!isGzipBuffer(buf)) return buf;
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('browser_does_not_support_gzip_decompression');
      }
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([buf]).stream().pipeThrough(ds);
      const out = await new Response(stream).arrayBuffer();
      return out;
    }

    function readAscii(view, offset, len) {
      let s = '';
      for (let i = 0; i < len; i += 1) {
        const c = view.getUint8(offset + i);
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s;
    }

    function ensureTyped(dataBuf, datatype, littleEndian) {
      if (littleEndian) {
        switch (datatype) {
          case NIFTI_TYPES.UINT8: return new Uint8Array(dataBuf);
          case NIFTI_TYPES.INT16: return new Int16Array(dataBuf);
          case NIFTI_TYPES.INT32: return new Int32Array(dataBuf);
          case NIFTI_TYPES.FLOAT32: return new Float32Array(dataBuf);
          case NIFTI_TYPES.FLOAT64: return new Float64Array(dataBuf);
          case NIFTI_TYPES.INT8: return new Int8Array(dataBuf);
          case NIFTI_TYPES.UINT16: return new Uint16Array(dataBuf);
          case NIFTI_TYPES.UINT32: return new Uint32Array(dataBuf);
          default: return new Float32Array(dataBuf);
        }
      }

      const dv = new DataView(dataBuf);
      const n = (() => {
        switch (datatype) {
          case NIFTI_TYPES.UINT8:
          case NIFTI_TYPES.INT8: return dataBuf.byteLength;
          case NIFTI_TYPES.INT16:
          case NIFTI_TYPES.UINT16: return dataBuf.byteLength / 2;
          case NIFTI_TYPES.INT32:
          case NIFTI_TYPES.UINT32:
          case NIFTI_TYPES.FLOAT32: return dataBuf.byteLength / 4;
          case NIFTI_TYPES.FLOAT64: return dataBuf.byteLength / 8;
          default: return dataBuf.byteLength / 4;
        }
      })();

      switch (datatype) {
        case NIFTI_TYPES.UINT8: return new Uint8Array(dataBuf);
        case NIFTI_TYPES.INT8: return new Int8Array(dataBuf);
        case NIFTI_TYPES.INT16: {
          const out = new Int16Array(n);
          for (let i = 0; i < n; i += 1) out[i] = dv.getInt16(i * 2, false);
          return out;
        }
        case NIFTI_TYPES.UINT16: {
          const out = new Uint16Array(n);
          for (let i = 0; i < n; i += 1) out[i] = dv.getUint16(i * 2, false);
          return out;
        }
        case NIFTI_TYPES.INT32: {
          const out = new Int32Array(n);
          for (let i = 0; i < n; i += 1) out[i] = dv.getInt32(i * 4, false);
          return out;
        }
        case NIFTI_TYPES.UINT32: {
          const out = new Uint32Array(n);
          for (let i = 0; i < n; i += 1) out[i] = dv.getUint32(i * 4, false);
          return out;
        }
        case NIFTI_TYPES.FLOAT32: {
          const out = new Float32Array(n);
          for (let i = 0; i < n; i += 1) out[i] = dv.getFloat32(i * 4, false);
          return out;
        }
        case NIFTI_TYPES.FLOAT64: {
          const out = new Float64Array(n);
          for (let i = 0; i < n; i += 1) out[i] = dv.getFloat64(i * 8, false);
          return out;
        }
        default: {
          const out = new Float32Array(n);
          for (let i = 0; i < n; i += 1) out[i] = dv.getFloat32(i * 4, false);
          return out;
        }
      }
    }

    function parseNifti1(buf) {
      if (!buf || buf.byteLength < 352) throw new Error('nifti_buffer_too_small');
      const view = new DataView(buf);
      const hdrLE = view.getInt32(0, true);
      const hdrBE = view.getInt32(0, false);
      const littleEndian = hdrLE === 348 ? true : (hdrBE === 348 ? false : null);
      if (littleEndian === null) throw new Error('not_nifti_1');

      const dims = [];
      for (let i = 0; i < 8; i += 1) dims.push(view.getInt16(40 + i * 2, littleEndian));
      const datatypeCode = view.getInt16(70, littleEndian);
      const pixDims = [];
      for (let i = 0; i < 8; i += 1) pixDims.push(view.getFloat32(76 + i * 4, littleEndian));
      let voxOffset = view.getFloat32(108, littleEndian);
      if (!Number.isFinite(voxOffset) || voxOffset < 352) voxOffset = 352;
      const slope = view.getFloat32(112, littleEndian);
      const inter = view.getFloat32(116, littleEndian);
      const magic = readAscii(view, 344, 4);
      if (!magic.startsWith('n+1') && !magic.startsWith('ni1')) {
        throw new Error('unsupported_nifti_magic');
      }

      const nx = Math.max(1, dims[1] || 0);
      const ny = Math.max(1, dims[2] || 0);
      const nz = Math.max(1, dims[3] || 0);
      const nvox = nx * ny * nz;
      const bytesPerVoxel = (() => {
        switch (datatypeCode) {
          case NIFTI_TYPES.UINT8:
          case NIFTI_TYPES.INT8: return 1;
          case NIFTI_TYPES.INT16:
          case NIFTI_TYPES.UINT16: return 2;
          case NIFTI_TYPES.INT32:
          case NIFTI_TYPES.UINT32:
          case NIFTI_TYPES.FLOAT32: return 4;
          case NIFTI_TYPES.FLOAT64: return 8;
          default: return 4;
        }
      })();

      const start = Math.floor(voxOffset);
      const end = start + nvox * bytesPerVoxel;
      if (end > buf.byteLength) throw new Error('nifti_image_out_of_range');
      const imageBuf = buf.slice(start, end);
      const typed = ensureTyped(imageBuf, datatypeCode, littleEndian);

      return {
        typed,
        header: {
          dims: [dims[0], nx, ny, nz],
          pixDims: [pixDims[0], pixDims[1] || 1, pixDims[2] || 1, pixDims[3] || 1],
          datatypeCode,
          scl_slope: slope,
          scl_inter: inter
        }
      };
    }

    const EVIDENCE_REFS = [
      { topic: 'Default full CTA demo source (CTACardio)', url: 'https://github.com/supervisely-ecosystem/demo-volumes' },
      { topic: 'nnU-Net (Nature Methods, 2021)', url: 'https://doi.org/10.1038/s41592-020-01008-z' },
      { topic: 'TotalSegmentator paper (Radiology: AI, 2023)', url: 'https://doi.org/10.1148/ryai.230024' },
      { topic: 'TotalSegmentator project repository', url: 'https://github.com/wasserth/TotalSegmentator' },
      { topic: 'Automatic aortic valve cusps segmentation (J Imaging, 2022)', url: 'https://pubmed.ncbi.nlm.nih.gov/35049852/' },
      { topic: 'SCCT CT imaging consensus for TAVI/TAVR (2019)', url: 'https://pubmed.ncbi.nlm.nih.gov/30630686/' },
      { topic: 'Guide for pre-procedural imaging for TAVR', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7690031/' },
      { topic: 'TAVI procedural steps and current advances (part 2)', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC8212161/' },
      { topic: 'UK CT-TAVI reporting practice survey', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7254150/' },
      { topic: 'Coronary obstruction risk: ELOD and cusp height mismatch', url: 'https://pubmed.ncbi.nlm.nih.gov/34917750/' },
      { topic: 'Aortic diameter by centerline-perpendicular planes (J Card Surg, 2020)', url: 'https://pubmed.ncbi.nlm.nih.gov/30673817/' },
      { topic: 'TEVAR reporting standards (SVS, centerline reconstruction emphasis)', url: 'https://pubmed.ncbi.nlm.nih.gov/32628988/' },
      { topic: 'AortaSeg24 challenge (CTA multi-class benchmark)', url: 'https://aortaseg24.grand-challenge.org' },
      { topic: 'ASOCA coronary CTA dataset/challenge', url: 'https://asoca.grand-challenge.org/' },
      { topic: 'PEARS technique and outcomes', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9205243/' },
      { topic: 'PEARS intention-to-treat long-term outcomes', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4033204/' },
      { topic: 'VSRR CT-based commissural prediction', url: 'https://pubmed.ncbi.nlm.nih.gov/39626488/' },
      { topic: 'Aortic valve repair principles and annuloplasty rationale', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6562088/' },
      { topic: 'Annulus-cusp mismatch impact after VSRR', url: 'https://academic.oup.com/icvts/article/40/1/ivaf048/7999382' },
      { topic: 'CT timing and aortic root measurement before TAVI', url: 'https://pubmed.ncbi.nlm.nih.gov/25708961/' }
    ];

    const EVIDENCE_TOPIC_ZH = {
      'Default full CTA demo source (CTACardio)': '默认完整 CTA 示例来源（CTACardio）',
      'nnU-Net (Nature Methods, 2021)': 'nnU-Net（Nature Methods，2021）',
      'TotalSegmentator paper (Radiology: AI, 2023)': 'TotalSegmentator 论文（Radiology: AI，2023）',
      'TotalSegmentator project repository': 'TotalSegmentator 项目仓库',
      'Automatic aortic valve cusps segmentation (J Imaging, 2022)': '主动脉瓣叶自动分割（J Imaging，2022）',
      'SCCT CT imaging consensus for TAVI/TAVR (2019)': 'SCCT TAVI/TAVR CT 影像共识（2019）',
      'Guide for pre-procedural imaging for TAVR': 'TAVR 术前影像规划指南综述',
      'TAVI procedural steps and current advances (part 2)': 'TAVI 术式流程与进展（下篇）',
      'UK CT-TAVI reporting practice survey': '英国 CT-TAVI 报告实践调查',
      'Coronary obstruction risk: ELOD and cusp height mismatch': '冠脉阻塞风险：ELOD 与瓣叶高度失配',
      'Aortic diameter by centerline-perpendicular planes (J Card Surg, 2020)': '中心线垂直切面主动脉直径测量（J Card Surg，2020）',
      'TEVAR reporting standards (SVS, centerline reconstruction emphasis)': 'TEVAR 报告标准（SVS，强调中心线重建）',
      'AortaSeg24 challenge (CTA multi-class benchmark)': 'AortaSeg24 挑战赛（CTA 多类别基准）',
      'ASOCA coronary CTA dataset/challenge': 'ASOCA 冠脉 CTA 数据集/挑战赛',
      'PEARS technique and outcomes': 'PEARS 术式与结局',
      'PEARS intention-to-treat long-term outcomes': 'PEARS 意向治疗长期结局',
      'VSRR CT-based commissural prediction': 'VSRR 基于 CT 的交界点预测',
      'Aortic valve repair principles and annuloplasty rationale': '主动脉瓣修复原则与瓣环成形依据',
      'Annulus-cusp mismatch impact after VSRR': 'VSRR 后瓣环-瓣叶失配影响',
      'CT timing and aortic root measurement before TAVI': 'TAVI 术前 CT 时相与根部测量'
    };

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function t(key) {
      return (I18N[state.lang] && I18N[state.lang][key]) || I18N.zh[key] || key;
    }

    function L(zh, en) {
      return state.lang === 'en' ? en : zh;
    }

    function setText(id, key) {
      const el = $(id);
      if (!el) return;
      el.textContent = t(key);
    }

    function applyLocale(lang, persist = true) {
      state.lang = lang === 'en' ? 'en' : 'zh';
      if (persist) localStorage.setItem('aortic_ui_lang', state.lang);
      document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN';
      const ids = [
        'langTitle', 'langSub',
        'titleMain', 'subtitleMain',
        'btnReloadCase', 'btnAutoSeg', 'btnResetView', 'btnShowPlan', 'btnRunCloud', 'btnLoadLatest',
        'btnZoomIn', 'btnZoomOut', 'btnPrev', 'btnNext', 'btnMakePears', 'btnMakeVsrr', 'btnMakeTavi', 'btnRebuild3d', 'btnReset3d', 'btn3dRoot', 'btn3dLeaf', 'btn3dAsc', 'btnLangSwitch',
        'btnJumpVbr', 'btnJumpStj', 'btnJumpLeaf', 'btnJumpRootMax', 'btnJumpAscMax', 'btnJumpBest',
        'btnDispCt', 'btnDispPanel',
        'kCase', 'kCloud', 'kViewer', 'kKeySlices', 'kDisplayMode', 'kFiles', 'kLegend', 'kPears', 'kVsrr', 'kTavi', 'kRecon3d', 'kPlan', 'kMetrics', 'kEvidence', 'kLatest',
        'kBottomMeasure',
        'lblJob', 'lblStatus', 'lblDataset', 'lblPhase', 'lblSlice', 'lblWw', 'lblWl', 'lblOverlay',
        'viewerHint', 'keySliceHint', 'cloudHint', 'recon3dHint',
        'badgeLabelSlice', 'badgeLabelZoom', 'badgeLabelVoxel', 'badgeLabelSeg', 'badgeLabelKey',
        'thName', 'thValue', 'thUnit', 'bottomThMetric', 'bottomThValue', 'bottomThUnit', 'bottomThSource', 'btnLangModalZh', 'btnLangModalEn'
      ];
      for (const id of ids) setText(id, id);

      $('legendLeaf').innerHTML = '<span class="dot" style="background:#facc15"></span>' + t('legendLeaf');
      $('legendRoot').innerHTML = '<span class="dot" style="background:#ef4444"></span>' + t('legendRoot');
      $('legendAsc').innerHTML = '<span class="dot" style="background:#22d3ee"></span>' + t('legendAsc');
      $('rawLink').textContent = t('rawLink');
      $('segMaskLink').textContent = t('segMaskLink');
      $('resultLink').textContent = t('resultLink');
      $('measurementsLink').textContent = t('measurementsLink');
      $('reportPdfLink').textContent = t('reportPdfLink');
      $('rootStlLink').textContent = t('rootStlLink');
      $('ascStlLink').textContent = t('ascStlLink');
      $('leafletsStlLink').textContent = t('leafletsStlLink');
      $('rootModelLink').textContent = t('rootModelLink');
      $('leafletModelLink').textContent = t('leafletModelLink');
      $('receiptLink').textContent = t('receiptLink');
      $('jobApiLink').textContent = t('jobApiLink');
      updateKeySliceButtons();
      if ($('cloudProgress').textContent.trim() === '待机' || $('cloudProgress').textContent.trim() === 'idle') {
        $('cloudProgress').textContent = t('cloudIdle');
      }
      if ($('resultPreview').textContent.trim() === 'loading...') {
        $('resultPreview').textContent = t('loadingResult');
      }
      if ($('recon3dStatus').textContent.trim() === '等待分割完成...' || $('recon3dStatus').textContent.trim() === 'Waiting for segmentation...') {
        $('recon3dStatus').textContent = t('recon3dStatusIdle');
      }
      setMeasureDisplay(state.measureDisplay);
      if (state.caseData) {
        bindCasePanel(state.caseData);
      }
      if (state.stats) {
        fillPlanningTables();
        renderPlan(state.lastPlanKind || 'pears');
      } else {
        $('planPreview').textContent = t('waitPlan');
      }
    }

    function initLanguage() {
      const saved = localStorage.getItem('aortic_ui_lang');
      if (saved === 'zh' || saved === 'en') {
        applyLocale(saved, false);
        $('langModal').classList.add('hidden');
        return;
      }
      applyLocale('zh', true);
      $('langModal').classList.add('hidden');
    }

    function chooseLanguage(lang) {
      applyLocale(lang, true);
      $('langModal').classList.add('hidden');
    }

    function initMeasureDisplay() {
      setMeasureDisplay('ct');
    }

    function absLink(path) {
      if (!path || path === '#') return '#';
      if (path.startsWith('http://') || path.startsWith('https://')) return path;
      return new URL(path, location.origin).toString();
    }

    function setReadinessChip(id, stage) {
      const el = $(id);
      const norm = stage || 'partial-ready';
      const label = norm === 'ready'
        ? t('readinessReadyLabel')
        : (norm === 'not-ready' ? t('readinessNotLabel') : t('readinessPartialLabel'));
      el.textContent = label;
      el.classList.remove('ok', 'warn', 'bad');
      if (norm === 'ready') el.classList.add('ok');
      else if (norm === 'not-ready') el.classList.add('bad');
      else el.classList.add('warn');
    }

    function renderEvidenceLinks(list) {
      const ev = Array.isArray(list) && list.length ? list : EVIDENCE_REFS;
      $('evidenceLinks').innerHTML = '';
      for (const e of ev) {
        const div = document.createElement('div');
        const a = document.createElement('a');
        a.href = e.url;
        const topic = String(e.topic || '');
        a.textContent = state.lang === 'zh' ? (EVIDENCE_TOPIC_ZH[topic] || topic) : topic;
        a.target = '_blank';
        a.rel = 'noreferrer';
        div.appendChild(a);
        $('evidenceLinks').appendChild(div);
      }
    }

    function localizeJobStatus(status) {
      const s = String(status || '').toLowerCase();
      if (state.lang === 'en') return status || '-';
      if (s === 'succeeded') return '成功';
      if (s === 'running') return '运行中';
      if (s === 'queued') return '排队中';
      if (s === 'failed') return '失败';
      return status || '-';
    }

    function renderPipelineMetrics(metrics) {
      const rows = Array.isArray(metrics) ? metrics : [];
      $('pipelineMetrics').innerHTML = '';
      for (const m of rows) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + (m.metric_name || '-') + '</td><td>' + (m.metric_value ?? '-') + '</td><td>' + (m.unit || '-') + '</td>';
        $('pipelineMetrics').appendChild(tr);
      }
    }

    function deriveReadinessFromResult(resultJson) {
      const labels = resultJson?.labels;
      if (!labels || typeof labels !== 'object') return 'not-ready';
      const keys = Object.keys(labels);
      const hasCore = keys.includes('1') && keys.includes('2') && keys.includes('3');
      return hasCore ? 'partial-ready' : 'not-ready';
    }

    async function loadResultPreview(resultUrl) {
      if (!resultUrl || resultUrl === '#') {
        $('resultPreview').textContent = t('resultUnavailable');
        return null;
      }
      try {
        const r = await fetch(resultUrl, { cache: 'no-store' });
        const text = await r.text();
        $('resultPreview').textContent = text;
        return JSON.parse(text);
      } catch {
        $('resultPreview').textContent = t('resultLoadFailed');
        return null;
      }
    }

    function finiteOrNull(v) {
      const x = Number(v);
      return Number.isFinite(x) ? x : null;
    }

    function mapBackendRiskFlags(flags) {
      const list = Array.isArray(flags) ? flags : [];
      const out = [];
      for (const f of list) {
        const id = String(f?.id || f || '').trim();
        if (!id) continue;
        if (id === 'heavy_valve_calcification') out.push('calc_high');
        else if (id === 'small_sinus') out.push('stj_rel_small');
        else if (id === 'low_coronary_height') out.push('low_coronary_height');
        else out.push(id);
      }
      return out;
    }

    function applyBackendMeasurements(resultJson) {
      state.pipelineResult = resultJson && typeof resultJson === 'object' ? resultJson : null;
      if (!state.stats || !state.pipelineResult) return;
      const m = state.pipelineResult?.measurements || {};
      const cal = m?.valve_calcium_burden || {};
      const annulus = finiteOrNull(m.annulus_diameter_mm);
      const annulusArea = finiteOrNull(m.annulus_area_mm2);
      const annulusPerim = finiteOrNull(m.annulus_perimeter_mm);
      const sinus = finiteOrNull(m.sinus_of_valsalva_diameter_mm ?? m.sinus_diameter_mm);
      const stj = finiteOrNull(m.stj_diameter_mm);
      const asc = finiteOrNull(m.ascending_aorta_diameter_mm);
      const lvot = finiteOrNull(m.lvot_diameter_mm);
      const leftH = finiteOrNull(m.coronary_height_left_mm);
      const rightH = finiteOrNull(m.coronary_height_right_mm);
      const calcVol = finiteOrNull(cal.calc_volume_ml);
      const calcThr = finiteOrNull(cal.threshold_hu);

      if (annulus !== null) state.stats.vbrDiameterMm = annulus;
      if (annulusArea !== null) state.stats.vbrAreaMm2 = annulusArea;
      if (annulusPerim !== null) state.stats.vbrPerimeterMm = annulusPerim;
      if (sinus !== null) state.stats.rootMaxDiameterMm = sinus;
      if (stj !== null) state.stats.stjDiameterMm = stj;
      if (asc !== null) state.stats.ascMaxDiameterMm = asc;
      if (lvot !== null) state.stats.lvotDiameterMm = lvot;
      state.stats.taviCoronaryHeightLeftMm = leftH;
      state.stats.taviCoronaryHeightRightMm = rightH;
      state.stats.taviCoronaryHeightMm = (leftH !== null && rightH !== null) ? Math.min(leftH, rightH) : (leftH ?? rightH ?? null);
      if (calcVol !== null) {
        state.stats.rootLeafCalcVolumeMl = calcVol;
      }
      if (calcThr !== null) {
        state.stats.calcificationThresholdHU = calcThr;
      }
      state.stats.taviRiskFlags = mapBackendRiskFlags(state.pipelineResult?.risk_flags);

      const annulusPlane = state.pipelineResult?.landmarks?.annulus_plane;
      if (annulusPlane && typeof annulusPlane === 'object') {
        state.annulusPlaneData = annulusPlane;
        const oz = finiteOrNull(annulusPlane?.origin_voxel?.[2]);
        if (oz !== null) {
          state.stats.vbrZ = oz;
        }
      }
    }

    async function loadAuxArtifacts(data) {
      state.centerlineData = null;
      state.annulusPlaneData = null;
      state.rootModelData = null;
      state.leafletModelData = null;
      const centerlineUrl = findArtifactLink(data, ['centerline_json']);
      const annulusUrl = findArtifactLink(data, ['annulus_plane_json']);
      const rootModelUrl = findArtifactLink(data, ['aortic_root_model_json']);
      const leafletModelUrl = findArtifactLink(data, ['leaflet_model_json']);
      if (centerlineUrl) {
        try {
          const r = await fetch(centerlineUrl, { cache: 'no-store' });
          if (r.ok) {
            const obj = await r.json();
            state.centerlineData = obj;
          }
        } catch {}
      }
      if (annulusUrl) {
        try {
          const r = await fetch(annulusUrl, { cache: 'no-store' });
          if (r.ok) {
            const obj = await r.json();
            state.annulusPlaneData = obj;
          }
        } catch {}
      }
      if (rootModelUrl) {
        try {
          const r = await fetch(rootModelUrl, { cache: 'no-store' });
          if (r.ok) state.rootModelData = await r.json();
        } catch {}
      }
      if (leafletModelUrl) {
        try {
          const r = await fetch(leafletModelUrl, { cache: 'no-store' });
          if (r.ok) state.leafletModelData = await r.json();
        } catch {}
      }
    }

    function bindCasePanel(data) {
      state.caseData = data;
      $('studyId').textContent = data.study_id || '-';
      $('jobId').textContent = data.id || '-';
      $('jobStatus').textContent = localizeJobStatus(data.status);
      $('datasetName').textContent = data.study_meta?.source_dataset || 'public-cta';
      $('datasetPhase').textContent = data.study_meta?.phase || 'unknown';
      $('rawLink').href = absLink(data.links?.raw_ct);
      $('segMaskLink').href = absLink(data.links?.segmentation_mask_nifti);
      $('resultLink').href = absLink(data.links?.result_json);
      $('measurementsLink').href = absLink(data.links?.measurements_json);
      $('reportPdfLink').href = absLink(data.links?.planning_report_pdf);
      $('rootStlLink').href = absLink(data.links?.aortic_root_stl);
      $('ascStlLink').href = absLink(data.links?.ascending_aorta_stl);
      $('leafletsStlLink').href = absLink(data.links?.leaflets_stl);
      $('rootModelLink').href = absLink(data.links?.aortic_root_model_json);
      $('leafletModelLink').href = absLink(data.links?.leaflet_model_json);
      $('receiptLink').href = absLink(data.links?.provider_receipt);
      $('jobApiLink').href = absLink(data.links?.job_api);
      setReadinessChip('pearsState', data.clinical_targets?.pears?.readiness?.stage || 'partial-ready');
      setReadinessChip('vsrrState', data.clinical_targets?.vsrr?.readiness?.stage || 'partial-ready');
      setReadinessChip('taviState', data.clinical_targets?.tavi?.readiness?.stage || 'partial-ready');
      renderEvidenceLinks(data.clinical_targets?.evidence_refs);
      renderPipelineMetrics(data.metrics);
    }

    function findArtifactLink(data, preferredTypes) {
      const linkMap = (data && typeof data === 'object' && data.links && typeof data.links === 'object') ? data.links : null;
      for (const type of preferredTypes) {
        const fromLinks = linkMap && typeof linkMap[type] === 'string' && linkMap[type].trim() ? linkMap[type] : null;
        if (fromLinks) return absLink(fromLinks);
      }
      const list = Array.isArray(data?.artifacts) ? data.artifacts : [];
      for (const type of preferredTypes) {
        const hit = list.find((a) => String(a?.artifact_type || '') === type);
        if (hit?.download_url && typeof hit.download_url === 'string') return absLink(hit.download_url);
        if (hit) return absLink('/jobs/' + encodeURIComponent(data.id) + '/artifacts/' + encodeURIComponent(type));
      }
      if (list.length > 0) return null;
      return null;
    }

    async function loadSegmentationMask(url) {
      if (!url || url === '#') return false;
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return false;
      let buf = await r.arrayBuffer();
      buf = await gunzipArrayBuffer(buf);
      const parsed = parseNifti1(buf);
      const header = parsed.header;
      const typed = parsed.typed;
      const mx = header.dims[1] || 1;
      const my = header.dims[2] || 1;
      const mz = header.dims[3] || 1;
      if (mx !== state.dims.x || my !== state.dims.y || mz !== state.dims.z) {
        throw new Error('mask_dims_mismatch');
      }
      const out = new Uint8Array(mx * my * mz);
      const zCounts = new Uint32Array(mz);
      let fgCount = 0;
      for (let i = 0; i < out.length; i += 1) {
        const v = Number(typed[i] ?? 0);
        const cls = v < 0.5 ? 0 : (v < 1.5 ? 1 : (v < 2.5 ? 2 : 3));
        out[i] = cls;
        if (cls > 0) {
          fgCount += 1;
          const z = Math.floor(i / (mx * my));
          zCounts[z] += 1;
        }
      }
      if (fgCount < 100) {
        throw new Error('mask_empty_or_invalid');
      }
      state.seg = out;
      state.segReady = true;
      state.segSource = 'real-mask';
      state.contourCache.clear();
      $('badgeSeg').textContent = t('segDoneReal');
      state.stats = computeStats(out);
      applyBackendMeasurements(state.pipelineResult);
      const orthBestZ = Number.isFinite(state.stats?.rootMaxZ) ? state.stats.rootMaxZ : -1;
      let bestZ = state.slice;
      let bestCount = 0;
      for (let z = 0; z < zCounts.length; z += 1) {
        if (zCounts[z] > bestCount) {
          bestCount = zCounts[z];
          bestZ = z;
        }
      }
      if (orthBestZ >= 0) {
        state.bestSlice = orthBestZ;
        state.slice = clamp(orthBestZ, 0, state.dims.z - 1);
        $('sliceRange').value = String(state.slice);
      } else if (bestCount > 0) {
        state.bestSlice = bestZ;
        state.slice = clamp(bestZ, 0, state.dims.z - 1);
        $('sliceRange').value = String(state.slice);
      } else if (state.stats?.byClass?.[1]?.maxAreaZ !== undefined) {
        state.bestSlice = state.stats.byClass[1].maxAreaZ;
        state.slice = clamp(state.stats.byClass[1].maxAreaZ, 0, state.dims.z - 1);
        $('sliceRange').value = String(state.slice);
      }
      fillPlanningTables();
      renderPlan('pears');
      render();
      rebuild3dModel().catch(() => {
        setRecon3dStatus('recon3dStatusLibFail');
      });
      return true;
    }

    async function loadCaseData(data) {
      bindCasePanel(data);
      $('planPreview').textContent = t('waitPlan');
      const resultJson = await loadResultPreview(absLink(data.links?.result_json));
      state.pipelineResult = resultJson;
      await loadNiftiVolume(absLink(data.links?.raw_ct));
      await loadValidatedSegmentation(data, { appendErrorToPreview: true });
      await loadAuxArtifacts(data);
      applyBackendMeasurements(resultJson);
      fillPlanningTables();
      renderPlan(state.lastPlanKind || 'pears');
      render();
    }

    async function loadLatestCase() {
      const caseResp = await fetch('/demo/latest-case', { cache: 'no-store' });
      if (!caseResp.ok) throw new Error('No completed case');
      const data = await caseResp.json();
      await loadCaseData(data);
    }

    async function loadCaseByJob(jobId, studyId) {
      const jobResp = await fetch('/jobs/' + encodeURIComponent(jobId), { cache: 'no-store' });
      if (!jobResp.ok) throw new Error('failed to query job');
      const job = await jobResp.json();
      let studyMeta = { source_dataset: 'web_upload', phase: 'unknown' };
      try {
        const sResp = await fetch('/studies/' + encodeURIComponent(studyId) + '/meta', { cache: 'no-store' });
        if (sResp.ok) {
          const s = await sResp.json();
          studyMeta = {
            source_dataset: s.source_dataset || 'web_upload',
            phase: s.phase || 'unknown'
          };
        }
      } catch {}

      const links = job.links || {
        raw_ct: '/studies/' + studyId + '/raw/' + encodeURIComponent(String((job.study_meta?.repository?.raw_filename || '') || 'input.nii.gz')),
        segmentation_mask_nifti: '/jobs/' + jobId + '/artifacts/segmentation_mask_nifti',
        result_json: '/jobs/' + jobId + '/artifacts/result_json',
        provider_receipt: '/jobs/' + jobId + '/artifacts/provider_receipt',
        measurements_json: '/jobs/' + jobId + '/artifacts/measurements_json',
        planning_report_pdf: '/jobs/' + jobId + '/artifacts/planning_report_pdf',
        aortic_root_stl: '/jobs/' + jobId + '/artifacts/aortic_root_stl',
        ascending_aorta_stl: '/jobs/' + jobId + '/artifacts/ascending_aorta_stl',
        leaflets_stl: '/jobs/' + jobId + '/artifacts/leaflets_stl',
        centerline_json: '/jobs/' + jobId + '/artifacts/centerline_json',
        annulus_plane_json: '/jobs/' + jobId + '/artifacts/annulus_plane_json',
        aortic_root_model_json: '/jobs/' + jobId + '/artifacts/aortic_root_model_json',
        leaflet_model_json: '/jobs/' + jobId + '/artifacts/leaflet_model_json',
        job_api: '/jobs/' + jobId
      };
      const resultJson = await loadResultPreview(absLink(links.result_json));
      const stage = deriveReadinessFromResult(resultJson);
      const data = {
        id: jobId,
        study_id: studyId,
        status: job.status || 'unknown',
        artifacts: job.artifacts || [],
        metrics: job.metrics || [],
        pipeline_run: job.pipeline_run || null,
        study_meta: studyMeta,
        links,
        clinical_targets: {
          pears: { readiness: { stage }, standards: defaultStandards('pears') },
          vsrr: { readiness: { stage }, standards: defaultStandards('vsrr') },
          tavi: { readiness: { stage }, standards: defaultStandards('tavi') },
          evidence_refs: EVIDENCE_REFS
        }
      };
      await loadCaseData(data);
    }

    async function runCloudPipeline(file) {
      if (!file) throw new Error('请选择 CT 文件（.nii/.nii.gz/.zip/.dcm）');

      const btn = $('btnRunCloud');
      btn.disabled = true;
      const studyId = 'webct-' + Date.now();
      try {
        const lowerName = String(file.name || '').toLowerCase();
        const imageFormat = (lowerName.endsWith('.nii') || lowerName.endsWith('.nii.gz'))
          ? 'nifti'
          : (lowerName.endsWith('.zip') ? 'dicom_zip' : 'dicom');
        $('cloudProgress').textContent = t('cloudStep1');
        const sResp = await fetch('/upload-url', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            study_id: studyId,
            filename: file.name || (studyId + '.nii.gz'),
            image_format: imageFormat,
            modality: 'CTA',
            source_dataset: 'web_upload'
          })
        });
        if (!sResp.ok) throw new Error('创建上传会话失败');
        const s = await sResp.json();

        $('cloudProgress').textContent = t('cloudStep2');
        const upUrl = absLink(s.upload_url);
        const upResp = await fetch(upUrl, {
          method: 'PUT',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file
        });
        if (!upResp.ok) throw new Error('上传失败');

        $('cloudProgress').textContent = t('cloudStep3');
        const jResp = await fetch('/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            study_id: studyId,
            job_type: 'segmentation_v1',
            model_tag: 'web-ui'
          })
        });
        if (!jResp.ok) throw new Error('创建任务失败');
        const j = await jResp.json();
        const jobId = j.job_id;
        if (!jobId) throw new Error('未收到job_id');
        $('jobId').textContent = jobId;
        $('studyId').textContent = studyId;

        $('cloudProgress').textContent = t('cloudStep4');
        let finalStatus = 'queued';
        for (let i = 0; i < 120; i += 1) {
          const poll = await fetch('/jobs/' + encodeURIComponent(jobId), { cache: 'no-store' });
          if (poll.ok) {
            const pr = await poll.json();
            finalStatus = pr.status || finalStatus;
            $('jobStatus').textContent = finalStatus;
            if (finalStatus === 'succeeded') break;
            if (finalStatus === 'failed') throw new Error(pr.error_message || 'cloud_job_failed');
          }
          await sleep(2500);
        }
        if (finalStatus !== 'succeeded') throw new Error('任务超时未完成');

        $('cloudProgress').textContent = t('cloudLoad');
        await loadCaseByJob(jobId, studyId);
        setCanvasSize();
        render();
        $('cloudProgress').textContent = t('cloudDone');
      } finally {
        btn.disabled = false;
      }
    }

    async function loadNiftiVolume(url) {
      if (!url) throw new Error('raw_ct link missing');
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('failed to fetch raw CT');
      let buf = await r.arrayBuffer();
      buf = await gunzipArrayBuffer(buf);
      const parsed = parseNifti1(buf);
      const header = parsed.header;
      const typed = parsed.typed;
      const slope = (header.scl_slope && header.scl_slope !== 0) ? header.scl_slope : 1;
      const inter = header.scl_inter || 0;

      state.header = header;
      state.vol = typed;
      state.slope = slope;
      state.inter = inter;
      state.dims = { x: header.dims[1] || 1, y: header.dims[2] || 1, z: header.dims[3] || 1 };
      state.vox = { dx: header.pixDims[1] || 1, dy: header.pixDims[2] || 1, dz: header.pixDims[3] || 1 };
      state.slice = Math.floor(state.dims.z / 2);
      state.seg = null;
      state.segReady = false;
      state.segSource = 'none';
      state.contourCache.clear();
      state.bestSlice = state.slice;
      state.keySliceMap = {};
      state.stats = null;
      state.centerlineData = null;
      state.annulusPlaneData = null;
      state.bodyBounds = null;
      $('badgeSeg').textContent = t('segPending');
      setRecon3dStatus('recon3dStatusIdle');
      clear3dGroup();
      if (state.recon3d.renderer && state.recon3d.scene && state.recon3d.camera) {
        state.recon3d.renderer.render(state.recon3d.scene, state.recon3d.camera);
      }

      $('sliceRange').max = String(Math.max(0, state.dims.z - 1));
      $('sliceRange').value = String(state.slice);
      $('badgeVoxel').textContent = state.vox.dx.toFixed(2) + ' x ' + state.vox.dy.toFixed(2) + ' x ' + state.vox.dz.toFixed(2);
      $('jobStatus').textContent = localizeJobStatus(state.caseData?.status || '-') + ' | ' + t('volumeLoaded');

      const p5 = percentileSampled(typed, slope, inter, 0.05);
      const p95 = percentileSampled(typed, slope, inter, 0.95);
      state.ww = Math.max(120, p95 - p5);
      state.wl = (p95 + p5) / 2;
      state.bodyBounds = estimateBodyBounds(typed, state.dims, slope, inter);
      updateKeySliceButtons();
      syncControlLabels();
      resetView();
    }

    function percentileSampled(arr, slope, inter, p) {
      const targetSamples = 120000;
      const step = Math.max(1, Math.floor(arr.length / targetSamples));
      const copy = [];
      for (let i = 0; i < arr.length; i += step) {
        copy.push(Number(arr[i]) * slope + inter);
      }
      copy.sort((a, b) => a - b);
      const idx = clamp(Math.floor(p * (copy.length - 1)), 0, copy.length - 1);
      return copy[idx];
    }

    function estimateBodyBounds(vol, dims, slope, inter) {
      const nx = dims.x || 0;
      const ny = dims.y || 0;
      const nz = dims.z || 0;
      if (!vol || nx < 2 || ny < 2 || nz < 2) return null;
      const zStep = Math.max(1, Math.floor(nz / 36));
      const xyStep = Math.max(1, Math.floor(Math.min(nx, ny) / 256));
      const huThr = -520;
      let minX = nx - 1;
      let minY = ny - 1;
      let maxX = 0;
      let maxY = 0;
      let hit = 0;
      for (let z = 0; z < nz; z += zStep) {
        const zOff = z * nx * ny;
        for (let y = 0; y < ny; y += xyStep) {
          const yOff = zOff + y * nx;
          for (let x = 0; x < nx; x += xyStep) {
            const hu = Number(vol[yOff + x]) * slope + inter;
            if (hu > huThr) {
              hit += 1;
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }
      }
      if (hit < 32 || maxX <= minX || maxY <= minY) return null;
      const padX = Math.max(8, Math.floor((maxX - minX + 1) * 0.08));
      const padY = Math.max(8, Math.floor((maxY - minY + 1) * 0.08));
      return {
        minX: clamp(minX - padX, 0, nx - 1),
        maxX: clamp(maxX + padX, 0, nx - 1),
        minY: clamp(minY - padY, 0, ny - 1),
        maxY: clamp(maxY + padY, 0, ny - 1)
      };
    }

    function syncControlLabels() {
      $('sliceLabel').textContent = String(state.slice + 1) + ' / ' + String(state.dims.z || 0);
      $('badgeSlice').textContent = String(state.slice + 1) + ' / ' + String(state.dims.z || 0);
      $('wwLabel').textContent = String(Math.round(state.ww));
      $('wlLabel').textContent = String(Math.round(state.wl));
      $('opLabel').textContent = Number(state.overlayOpacity).toFixed(2);
      $('badgeZoom').textContent = Number(state.zoom).toFixed(2) + 'x';
      $('badgeKey').textContent = currentKeySliceName(state.slice);
    }

    function formatSliceTag(z) {
      return z >= 0 ? (' #' + (z + 1)) : '';
    }

    function updateKeySliceMap() {
      const s = state.stats;
      if (!s) {
        state.keySliceMap = {};
        return;
      }
      const vbrZ = Number.isFinite(s.vbrZ) ? s.vbrZ : (s.rootStart >= 0 ? s.rootStart : -1);
      const stjZ = Number.isFinite(s.stjZ) ? s.stjZ : (s.rootEnd >= 0 ? s.rootEnd : -1);
      const leafZ = Number.isFinite(s.leafletMaxZ) ? s.leafletMaxZ : (((s.byClass?.[2]?.maxArea || 0) > 0) ? s.byClass[2].maxAreaZ : -1);
      const rootMaxZ = Number.isFinite(s.rootMaxZ) ? s.rootMaxZ : (((s.byClass?.[1]?.maxArea || 0) > 0) ? s.byClass[1].maxAreaZ : -1);
      const ascMaxZ = Number.isFinite(s.ascMaxZ) ? s.ascMaxZ : (((s.byClass?.[3]?.maxArea || 0) > 0) ? s.byClass[3].maxAreaZ : -1);
      state.keySliceMap = {
        vbr: vbrZ,
        stj: stjZ,
        leaf: leafZ,
        rootMax: rootMaxZ,
        ascMax: ascMaxZ,
        best: state.bestSlice >= 0 ? state.bestSlice : rootMaxZ
      };
    }

    function updateKeySliceButtons() {
      const m = state.keySliceMap || {};
      const map = [
        ['btnJumpVbr', 'btnJumpVbr', m.vbr],
        ['btnJumpStj', 'btnJumpStj', m.stj],
        ['btnJumpLeaf', 'btnJumpLeaf', m.leaf],
        ['btnJumpRootMax', 'btnJumpRootMax', m.rootMax],
        ['btnJumpAscMax', 'btnJumpAscMax', m.ascMax],
        ['btnJumpBest', 'btnJumpBest', m.best]
      ];
      for (const [id, key, z] of map) {
        const btn = $(id);
        if (!btn) continue;
        btn.textContent = t(key) + formatSliceTag(Number.isFinite(z) ? z : -1);
        btn.disabled = !(Number.isFinite(z) && z >= 0);
      }
    }

    function getViewerFocusBounds() {
      const nx = state.dims.x || 1;
      const ny = state.dims.y || 1;
      const fallback = state.bodyBounds || { minX: 0, maxX: nx - 1, minY: 0, maxY: ny - 1 };
      const bounds = state.stats?.classBounds;
      if (!bounds) return fallback;
      const root = bounds[1];
      const leaf = bounds[2];
      const asc = bounds[3];
      const selected = [root, leaf, asc].filter((b) => b && b.maxX >= b.minX && b.maxY >= b.minY);
      if (!selected.length) return fallback;
      let minX = nx - 1;
      let minY = ny - 1;
      let maxX = 0;
      let maxY = 0;
      for (const b of selected) {
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxY > maxY) maxY = b.maxY;
      }
      if (maxX <= minX || maxY <= minY) return fallback;
      const padX = Math.max(8, Math.floor((maxX - minX + 1) * 0.1));
      const padY = Math.max(8, Math.floor((maxY - minY + 1) * 0.1));
      return {
        minX: clamp(minX - padX, 0, nx - 1),
        maxX: clamp(maxX + padX, 0, nx - 1),
        minY: clamp(minY - padY, 0, ny - 1),
        maxY: clamp(maxY + padY, 0, ny - 1)
      };
    }

    function currentKeySliceName(z) {
      const m = state.keySliceMap || {};
      const names = [];
      if (m.vbr === z) names.push(t('keyVbr'));
      if (m.stj === z) names.push(t('keyStj'));
      if (m.leaf === z) names.push(t('keyLeaf'));
      if (m.rootMax === z) names.push(t('keyRootMax'));
      if (m.ascMax === z) names.push(t('keyAscMax'));
      if (m.best === z && names.length === 0) names.push(t('keyBest'));
      return names.length ? names.join(' / ') : t('keyNone');
    }

    function jumpToKeySlice(key) {
      const z = state.keySliceMap?.[key];
      if (!(Number.isFinite(z) && z >= 0)) return;
      state.slice = clamp(z, 0, state.dims.z - 1);
      $('sliceRange').value = String(state.slice);
      render();
    }

    function setMeasureDisplay(mode) {
      state.measureDisplay = mode === 'panel' ? 'panel' : 'ct';
      $('btnDispCt').classList.toggle('active', state.measureDisplay === 'ct');
      $('btnDispPanel').classList.toggle('active', state.measureDisplay === 'panel');
      $('measureModeState').textContent = state.measureDisplay === 'ct' ? t('measureModeCt') : t('measureModePanel');
      render();
    }

    function resetView() {
      const rect = canvas.getBoundingClientRect();
      if (state.dims.x > 0 && state.dims.y > 0 && rect.width > 0 && rect.height > 0) {
        const b = getViewerFocusBounds();
        const bw = Math.max(1, b.maxX - b.minX + 1);
        const bh = Math.max(1, b.maxY - b.minY + 1);
        const fit = Math.min((rect.width * 0.96) / bw, (rect.height * 0.96) / bh);
        state.zoom = clamp(fit, 0.35, 12);
      } else {
        state.zoom = 1;
      }
      state.panX = 0;
      state.panY = 0;
      syncControlLabels();
      render();
    }

    function appendResultNote(line) {
      const note = String(line || '').trim();
      if (!note) return;
      const cur = $('resultPreview').textContent || '';
      if (cur.includes(note)) return;
      $('resultPreview').textContent = cur + '\\n\\n' + note;
    }

    function markNoValidatedSegmentation(reason) {
      state.seg = null;
      state.segReady = false;
      state.segSource = 'none';
      state.contourCache.clear();
      state.stats = null;
      state.keySliceMap = {};
      state.bestSlice = state.slice;
      $('badgeSeg').textContent = t('segNoModel');
      $('planPreview').textContent = t('noModelHint');
      setRecon3dStatus('recon3dStatusNoSeg');
      clear3dGroup();
      if (state.recon3d.renderer && state.recon3d.scene && state.recon3d.camera) {
        state.recon3d.renderer.render(state.recon3d.scene, state.recon3d.camera);
      }
      updateKeySliceButtons();
      const bm = $('bottomMeasurements');
      if (bm) bm.innerHTML = '';
      syncControlLabels();
      render();
      if (reason) appendResultNote('mask_load_error: ' + String(reason));
    }

    async function loadValidatedSegmentation(caseData, opts = {}) {
      const data = caseData || state.caseData;
      if (!state.vol || !data) {
        markNoValidatedSegmentation('volume_or_case_missing');
        return false;
      }
      const maskUrl = findArtifactLink(data, ['segmentation_mask_nifti', 'mask_multiclass', 'mask_output']);
      if (!maskUrl) {
        markNoValidatedSegmentation('no_mask_artifact');
        return false;
      }
      $('badgeSeg').textContent = t('segRunning');
      try {
        const loaded = await loadSegmentationMask(maskUrl);
        if (!loaded) {
          markNoValidatedSegmentation('mask_fetch_failed');
          return false;
        }
        return true;
      } catch (e) {
        if (opts?.appendErrorToPreview) {
          appendResultNote('mask_load_error: ' + String(e));
        }
        markNoValidatedSegmentation(String(e));
        return false;
      }
    }

    function normalize3(x, y, z) {
      const n = Math.hypot(x, y, z);
      if (!Number.isFinite(n) || n <= 1e-8) return [0, 0, 1];
      return [x / n, y / n, z / n];
    }

    function cross3(a, b) {
      return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]
      ];
    }

    function buildCenterlinePoints(seg, classSet) {
      const { x: nx, y: ny, z: nz } = state.dims;
      const raw = [];
      for (let z = 0; z < nz; z += 1) {
        let sx = 0, sy = 0, n = 0;
        for (let y = 0; y < ny; y += 1) {
          for (let x = 0; x < nx; x += 1) {
            if (!classSet.has(seg[indexOf(x, y, z)])) continue;
            sx += x;
            sy += y;
            n += 1;
          }
        }
        if (n >= 8) raw.push({ z, x: sx / n, y: sy / n, n });
      }
      if (!raw.length) return [];
      if (raw.length === 1) return raw;

      const dense = [];
      for (let i = 0; i < raw.length - 1; i += 1) {
        const a = raw[i];
        const b = raw[i + 1];
        dense.push(a);
        const dz = b.z - a.z;
        if (dz <= 1) continue;
        for (let k = 1; k < dz; k += 1) {
          const t = k / dz;
          dense.push({
            z: a.z + k,
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            n: a.n + (b.n - a.n) * t
          });
        }
      }
      dense.push(raw[raw.length - 1]);

      const w = 2;
      const smooth = dense.map((p, i) => {
        let sx = 0, sy = 0, sw = 0;
        for (let j = Math.max(0, i - w); j <= Math.min(dense.length - 1, i + w); j += 1) {
          const ww = dense[j].n || 1;
          sx += dense[j].x * ww;
          sy += dense[j].y * ww;
          sw += ww;
        }
        const inv = sw > 0 ? (1 / sw) : 1;
        return { z: p.z, x: sx * inv, y: sy * inv, n: p.n };
      });
      return smooth;
    }

    function tangentAtCenterline(points, idx) {
      if (!points.length) return [0, 0, 1];
      const i0 = Math.max(0, idx - 2);
      const i1 = Math.min(points.length - 1, idx + 2);
      const p0 = points[i0];
      const p1 = points[i1];
      const vx = (p1.x - p0.x) * state.vox.dx;
      const vy = (p1.y - p0.y) * state.vox.dy;
      const vz = (p1.z - p0.z) * state.vox.dz;
      return normalize3(vx, vy, vz);
    }

    function orthBasisFromTangent(t) {
      let ref = Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      let u = cross3(t, ref);
      if (Math.hypot(u[0], u[1], u[2]) <= 1e-8) {
        ref = [0, 1, 0];
        u = cross3(t, ref);
      }
      u = normalize3(u[0], u[1], u[2]);
      const vRaw = cross3(t, u);
      const v = normalize3(vRaw[0], vRaw[1], vRaw[2]);
      return { u, v };
    }

    function sampleOrthSection(seg, cls, centerW, tangent, radiusMm) {
      const { x: nx, y: ny, z: nz } = state.dims;
      const { dx, dy, dz } = state.vox;
      const stepMm = Math.max(0.8, Math.min(dx, dy, dz));
      const r = Math.max(stepMm * 3, radiusMm || 30);
      const n = Math.max(4, Math.ceil(r / stepMm));
      const { u, v } = orthBasisFromTangent(tangent);

      let count = 0;
      let sumU = 0;
      let sumV = 0;
      let sumUU = 0;
      let sumVV = 0;
      let sumUV = 0;

      for (let j = -n; j <= n; j += 1) {
        for (let i = -n; i <= n; i += 1) {
          const du = i * stepMm;
          const dv = j * stepMm;
          if (du * du + dv * dv > r * r) continue;
          const wx = centerW[0] + u[0] * du + v[0] * dv;
          const wy = centerW[1] + u[1] * du + v[1] * dv;
          const wz = centerW[2] + u[2] * du + v[2] * dv;
          const xv = Math.round(wx / dx);
          const yv = Math.round(wy / dy);
          const zv = Math.round(wz / dz);
          if (xv < 0 || yv < 0 || zv < 0 || xv >= nx || yv >= ny || zv >= nz) continue;
          if (seg[indexOf(xv, yv, zv)] !== cls) continue;
          count += 1;
          sumU += du;
          sumV += dv;
          sumUU += du * du;
          sumVV += dv * dv;
          sumUV += du * dv;
        }
      }

      if (count < 10) return null;
      const meanU = sumU / count;
      const meanV = sumV / count;
      const covUU = Math.max(0, sumUU / count - meanU * meanU);
      const covVV = Math.max(0, sumVV / count - meanV * meanV);
      const covUV = sumUV / count - meanU * meanV;
      const tr = covUU + covVV;
      const det = covUU * covVV - covUV * covUV;
      const disc = Math.sqrt(Math.max(0, tr * tr * 0.25 - det));
      let l1 = Math.max(0, tr * 0.5 + disc);
      let l2 = Math.max(0, tr * 0.5 - disc);
      if (l2 > l1) {
        const tmp = l1;
        l1 = l2;
        l2 = tmp;
      }
      const majorDiamMm = 4 * Math.sqrt(l1);
      const minorDiamMm = 4 * Math.sqrt(l2);
      const areaMm2 = count * stepMm * stepMm;
      const eqDiamMm = 2 * Math.sqrt(areaMm2 / Math.PI);

      let evU = 1;
      let evV = 0;
      if (Math.abs(covUV) > 1e-6) {
        evU = l1 - covVV;
        evV = covUV;
      } else if (covVV > covUU) {
        evU = 0;
        evV = 1;
      }
      const evN = Math.hypot(evU, evV) || 1;
      evU /= evN;
      evV /= evN;

      const dirW = normalize3(
        u[0] * evU + v[0] * evV,
        u[1] * evU + v[1] * evV,
        u[2] * evU + v[2] * evV
      );
      const half = majorDiamMm * 0.5;
      const p1w = [centerW[0] - dirW[0] * half, centerW[1] - dirW[1] * half, centerW[2] - dirW[2] * half];
      const p2w = [centerW[0] + dirW[0] * half, centerW[1] + dirW[1] * half, centerW[2] + dirW[2] * half];

      return {
        areaMm2,
        eqDiamMm,
        majorDiamMm,
        minorDiamMm,
        line: {
          x1: p1w[0] / dx, y1: p1w[1] / dy, z1: p1w[2] / dz,
          x2: p2w[0] / dx, y2: p2w[1] / dy, z2: p2w[2] / dz
        }
      };
    }

    function nearestCenterlineIndex(points, zTarget) {
      if (!points.length || !Number.isFinite(zTarget) || zTarget < 0) return -1;
      let best = -1;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < points.length; i += 1) {
        const d = Math.abs(points[i].z - zTarget);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    }

    function centerlineArcLengthMm(points, i0, i1) {
      if (!points.length || i0 < 0 || i1 < 0) return null;
      let a = Math.min(i0, i1);
      let b = Math.max(i0, i1);
      if (a === b) return 0;
      let total = 0;
      for (let i = a; i < b; i += 1) {
        const p = points[i];
        const q = points[i + 1];
        const dx = (q.x - p.x) * state.vox.dx;
        const dy = (q.y - p.y) * state.vox.dy;
        const dz = (q.z - p.z) * state.vox.dz;
        total += Math.hypot(dx, dy, dz);
      }
      return total;
    }

    function measureOrthAtZ(seg, cls, points, z, radiusMm) {
      const idx = nearestCenterlineIndex(points, z);
      if (idx < 0) return null;
      const p = points[idx];
      const centerW = [p.x * state.vox.dx, p.y * state.vox.dy, p.z * state.vox.dz];
      const tangent = tangentAtCenterline(points, idx);
      const sec = sampleOrthSection(seg, cls, centerW, tangent, radiusMm);
      if (!sec) return null;
      return { ...sec, z: p.z, idx };
    }

    function scanMaxOrthDiameter(seg, cls, points, zLo, zHi, radiusMm) {
      if (!points.length || !Number.isFinite(zLo) || !Number.isFinite(zHi) || zLo < 0 || zHi < 0 || zHi < zLo) return null;
      const candidateIdx = [];
      for (let i = 0; i < points.length; i += 1) {
        const z = points[i].z;
        if (z >= zLo && z <= zHi) candidateIdx.push(i);
      }
      if (!candidateIdx.length) return null;
      const stride = candidateIdx.length > 200 ? 2 : 1;
      let best = null;
      for (let k = 0; k < candidateIdx.length; k += stride) {
        const i = candidateIdx[k];
        const p = points[i];
        const centerW = [p.x * state.vox.dx, p.y * state.vox.dy, p.z * state.vox.dz];
        const tangent = tangentAtCenterline(points, i);
        const sec = sampleOrthSection(seg, cls, centerW, tangent, radiusMm);
        if (!sec) continue;
        if (!best || sec.eqDiamMm > best.eqDiamMm) {
          best = { ...sec, z: p.z, idx: i };
        }
      }
      return best;
    }

    function ellipsePerimeterFromDiameters(majorMm, minorMm) {
      if (!(Number.isFinite(majorMm) && Number.isFinite(minorMm))) return null;
      const a = Math.max(majorMm, minorMm) * 0.5;
      const b = Math.min(majorMm, minorMm) * 0.5;
      if (a <= 0 || b <= 0) return null;
      const term = (3 * a + b) * (a + 3 * b);
      return Math.PI * (3 * (a + b) - Math.sqrt(Math.max(0, term)));
    }

    function computeStats(seg) {
      const { x: nx, y: ny, z: nz } = state.dims;
      const { dx, dy, dz } = state.vox;
      const voxelMl = (dx * dy * dz) / 1000.0;
      const stats = {
        byClass: {
          1: { vox: 0, maxArea: 0, maxAreaZ: 0 },
          2: { vox: 0, maxArea: 0, maxAreaZ: 0 },
          3: { vox: 0, maxArea: 0, maxAreaZ: 0 }
        },
        classBounds: {
          1: { minX: nx, minY: ny, minZ: nz, maxX: -1, maxY: -1, maxZ: -1 },
          2: { minX: nx, minY: ny, minZ: nz, maxX: -1, maxY: -1, maxZ: -1 },
          3: { minX: nx, minY: ny, minZ: nz, maxX: -1, maxY: -1, maxZ: -1 }
        },
        rootStart: -1,
        rootEnd: -1,
        leafletStart: -1,
        leafletEnd: -1,
        ascStart: -1,
        ascEnd: -1,
        measurementMethod: 'centerline_orthogonal_mpr_v1'
      };

      for (let z = 0; z < nz; z += 1) {
        let a1 = 0, a2 = 0, a3 = 0;
        for (let y = 0; y < ny; y += 1) {
          for (let x = 0; x < nx; x += 1) {
            const c = seg[indexOf(x, y, z)];
            if (c === 1 || c === 2 || c === 3) {
              const b = stats.classBounds[c];
              if (x < b.minX) b.minX = x;
              if (y < b.minY) b.minY = y;
              if (z < b.minZ) b.minZ = z;
              if (x > b.maxX) b.maxX = x;
              if (y > b.maxY) b.maxY = y;
              if (z > b.maxZ) b.maxZ = z;
            }
            if (c === 1) { a1 += 1; stats.byClass[1].vox += 1; }
            else if (c === 2) { a2 += 1; stats.byClass[2].vox += 1; }
            else if (c === 3) { a3 += 1; stats.byClass[3].vox += 1; }
          }
        }
        if (a1 > stats.byClass[1].maxArea) { stats.byClass[1].maxArea = a1; stats.byClass[1].maxAreaZ = z; }
        if (a2 > stats.byClass[2].maxArea) { stats.byClass[2].maxArea = a2; stats.byClass[2].maxAreaZ = z; }
        if (a3 > stats.byClass[3].maxArea) { stats.byClass[3].maxArea = a3; stats.byClass[3].maxAreaZ = z; }
        if (a1 > 8) { if (stats.rootStart < 0) stats.rootStart = z; stats.rootEnd = z; }
        if (a2 > 8) { if (stats.leafletStart < 0) stats.leafletStart = z; stats.leafletEnd = z; }
        if (a3 > 8) { if (stats.ascStart < 0) stats.ascStart = z; stats.ascEnd = z; }
      }

      const eqDiamFromAreaPx = (areaPx) => 2.0 * Math.sqrt((areaPx * dx * dy) / Math.PI);
      const fallbackRootEq = eqDiamFromAreaPx(stats.byClass[1].maxArea);
      const fallbackLeafEq = eqDiamFromAreaPx(stats.byClass[2].maxArea);
      const fallbackAscEq = eqDiamFromAreaPx(stats.byClass[3].maxArea);

      stats.rootVolumeMl = stats.byClass[1].vox * voxelMl;
      stats.leafletVolumeMl = stats.byClass[2].vox * voxelMl;
      stats.ascVolumeMl = stats.byClass[3].vox * voxelMl;

      const centerline = buildCenterlinePoints(seg, new Set([1, 3]));
      stats.centerlinePointCount = centerline.length;
      const rootRadiusMm = Number.isFinite(fallbackRootEq) ? Math.max(18, Math.min(48, fallbackRootEq * 0.9)) : 32;
      const ascRadiusMm = Number.isFinite(fallbackAscEq) ? Math.max(14, Math.min(42, fallbackAscEq * 0.9)) : 28;
      const leafletRadiusMm = Number.isFinite(fallbackLeafEq) ? Math.max(12, Math.min(32, fallbackLeafEq * 0.9)) : 22;

      const vbrSec = centerline.length >= 3 ? measureOrthAtZ(seg, 1, centerline, stats.rootStart, rootRadiusMm) : null;
      const stjSec = centerline.length >= 3 ? measureOrthAtZ(seg, 1, centerline, stats.rootEnd, rootRadiusMm) : null;
      const rootMaxSec = centerline.length >= 3 ? scanMaxOrthDiameter(seg, 1, centerline, stats.rootStart, stats.rootEnd, rootRadiusMm) : null;
      const ascMaxSec = centerline.length >= 3 ? scanMaxOrthDiameter(seg, 3, centerline, stats.ascStart, stats.ascEnd, ascRadiusMm) : null;
      const leafletSec = centerline.length >= 3 ? measureOrthAtZ(seg, 2, centerline, stats.byClass[2].maxAreaZ, leafletRadiusMm) : null;

      stats.vbrDiameterMm = vbrSec?.eqDiamMm ?? (stats.rootStart >= 0 ? estimateSliceDiameter(seg, 1, stats.rootStart) : null);
      stats.vbrMajorDiameterMm = vbrSec?.majorDiamMm ?? null;
      stats.vbrMinorDiameterMm = vbrSec?.minorDiamMm ?? null;
      stats.vbrAreaMm2 = vbrSec?.areaMm2 ?? null;
      stats.vbrPerimeterMm = ellipsePerimeterFromDiameters(stats.vbrMajorDiameterMm, stats.vbrMinorDiameterMm)
        ?? (Number.isFinite(stats.vbrDiameterMm) ? Math.PI * stats.vbrDiameterMm : null);
      stats.vbrEccentricity = (Number.isFinite(stats.vbrMajorDiameterMm) && Number.isFinite(stats.vbrMinorDiameterMm) && stats.vbrMajorDiameterMm > 0)
        ? (1 - (stats.vbrMinorDiameterMm / stats.vbrMajorDiameterMm))
        : null;
      stats.vbrZ = Number.isFinite(vbrSec?.z) ? vbrSec.z : (stats.rootStart >= 0 ? stats.rootStart : -1);

      stats.stjDiameterMm = stjSec?.eqDiamMm ?? (stats.rootEnd >= 0 ? estimateSliceDiameter(seg, 1, stats.rootEnd) : null);
      stats.stjMajorDiameterMm = stjSec?.majorDiamMm ?? null;
      stats.stjMinorDiameterMm = stjSec?.minorDiamMm ?? null;
      stats.stjAreaMm2 = stjSec?.areaMm2 ?? null;
      stats.stjPerimeterMm = ellipsePerimeterFromDiameters(stats.stjMajorDiameterMm, stats.stjMinorDiameterMm)
        ?? (Number.isFinite(stats.stjDiameterMm) ? Math.PI * stats.stjDiameterMm : null);
      stats.stjZ = Number.isFinite(stjSec?.z) ? stjSec.z : (stats.rootEnd >= 0 ? stats.rootEnd : -1);

      stats.rootMaxDiameterMm = rootMaxSec?.eqDiamMm ?? fallbackRootEq;
      stats.rootMaxMajorDiameterMm = rootMaxSec?.majorDiamMm ?? null;
      stats.rootMaxMinorDiameterMm = rootMaxSec?.minorDiamMm ?? null;
      stats.rootMaxZ = Number.isFinite(rootMaxSec?.z) ? rootMaxSec.z : stats.byClass[1].maxAreaZ;

      stats.leafletMaxDiameterMm = leafletSec?.eqDiamMm ?? fallbackLeafEq;
      stats.leafletMaxMajorDiameterMm = leafletSec?.majorDiamMm ?? null;
      stats.leafletMaxMinorDiameterMm = leafletSec?.minorDiamMm ?? null;
      stats.leafletMaxZ = Number.isFinite(leafletSec?.z) ? leafletSec.z : stats.byClass[2].maxAreaZ;

      stats.ascMaxDiameterMm = ascMaxSec?.eqDiamMm ?? fallbackAscEq;
      stats.ascMaxMajorDiameterMm = ascMaxSec?.majorDiamMm ?? null;
      stats.ascMaxMinorDiameterMm = ascMaxSec?.minorDiamMm ?? null;
      stats.ascMaxZ = Number.isFinite(ascMaxSec?.z) ? ascMaxSec.z : stats.byClass[3].maxAreaZ;
      stats.measureLines = {
        vbr: vbrSec?.line || null,
        stj: stjSec?.line || null,
        rootMax: rootMaxSec?.line || null,
        leaf: leafletSec?.line || null,
        ascMax: ascMaxSec?.line || null
      };

      if (centerline.length >= 3 && stats.rootStart >= 0 && stats.ascEnd >= 0) {
        const i0 = nearestCenterlineIndex(centerline, stats.rootStart);
        const i1 = nearestCenterlineIndex(centerline, stats.ascEnd);
        stats.supportLengthMm = centerlineArcLengthMm(centerline, i0, i1);
      } else {
        stats.supportLengthMm = (stats.rootStart >= 0 && stats.ascEnd >= 0) ? ((stats.ascEnd - stats.rootStart + 1) * dz) : null;
      }

      if (centerline.length >= 3 && stats.leafletStart >= 0 && stats.leafletEnd >= 0) {
        const i0 = nearestCenterlineIndex(centerline, stats.leafletStart);
        const i1 = nearestCenterlineIndex(centerline, stats.leafletEnd);
        stats.leafletBandMm = centerlineArcLengthMm(centerline, i0, i1);
      } else {
        stats.leafletBandMm = (stats.leafletStart >= 0 && stats.leafletEnd >= 0) ? ((stats.leafletEnd - stats.leafletStart + 1) * dz) : null;
      }

      if (centerline.length >= 3 && Number.isFinite(stats.vbrZ) && stats.vbrZ >= 0) {
        const iv = nearestCenterlineIndex(centerline, stats.vbrZ);
        if (iv >= 0) {
          const t = tangentAtCenterline(centerline, iv);
          const zAxis = [0, 0, 1];
          const dot = Math.max(-1, Math.min(1, t[0] * zAxis[0] + t[1] * zAxis[1] + t[2] * zAxis[2]));
          stats.aorticRootAxisAngleDeg = Math.acos(Math.abs(dot)) * 180 / Math.PI;
        } else {
          stats.aorticRootAxisAngleDeg = null;
        }
      } else {
        stats.aorticRootAxisAngleDeg = null;
      }

      let annulusCalcVox = 0;
      let rootLeafCalcVox = 0;
      const huThr = 130;
      for (let i = 0; i < seg.length; i += 1) {
        const cls = seg[i];
        if (cls !== 1 && cls !== 2) continue;
        const hu = Number(state.vol[i]) * state.slope + state.inter;
        if (hu < huThr) continue;
        rootLeafCalcVox += 1;
        if (Number.isFinite(stats.vbrZ) && stats.vbrZ >= 0) {
          const z = Math.floor(i / (nx * ny));
          if (Math.abs(z - stats.vbrZ) <= 6) annulusCalcVox += 1;
        }
      }
      stats.calcificationThresholdHU = huThr;
      stats.rootLeafCalcVolumeMl = rootLeafCalcVox * voxelMl;
      stats.annulusCalcVolumeMl = annulusCalcVox * voxelMl;
      stats.lvotDiameterMm = null;
      stats.taviCoronaryHeightMm = null;
      stats.taviCoronaryHeightLeftMm = null;
      stats.taviCoronaryHeightRightMm = null;
      stats.taviVtcMm = null;
      stats.taviVtstjMm = null;
      stats.taviAccessMinLumenMm = null;
      stats.taviAccessTortuosity = null;
      stats.taviRiskFlags = [];
      if (Number.isFinite(stats.rootLeafCalcVolumeMl) && stats.rootLeafCalcVolumeMl > 0.35) {
        stats.taviRiskFlags.push('calc_high');
      }
      if (Number.isFinite(stats.vbrEccentricity) && stats.vbrEccentricity > 0.35) {
        stats.taviRiskFlags.push('annulus_ecc_high');
      }
      if (Number.isFinite(stats.stjDiameterMm) && Number.isFinite(stats.vbrDiameterMm) && stats.stjDiameterMm < stats.vbrDiameterMm * 0.9) {
        stats.taviRiskFlags.push('stj_rel_small');
      }

      stats.commissuralAnglesDeg = [0, 120, 240];
      stats.commissureZ = Number.isFinite(stats.rootMaxZ) ? stats.rootMaxZ : stats.byClass[1].maxAreaZ;
      for (const cls of [1, 2, 3]) {
        const b = stats.classBounds[cls];
        if (!b || b.maxX < b.minX || b.maxY < b.minY || b.maxZ < b.minZ) {
          stats.classBounds[cls] = null;
        }
      }
      return stats;
    }

    function estimateSliceDiameter(seg, cls, z) {
      const { x: nx, y: ny } = state.dims;
      let area = 0;
      for (let y = 0; y < ny; y += 1) {
        for (let x = 0; x < nx; x += 1) {
          if (seg[indexOf(x, y, z)] === cls) area += 1;
        }
      }
      const mm2 = area * state.vox.dx * state.vox.dy;
      if (mm2 <= 0) return null;
      return 2.0 * Math.sqrt(mm2 / Math.PI);
    }

    function formatTaviRiskFlags(flags) {
      const list = Array.isArray(flags) ? flags : [];
      if (!list.length) return L('低-中', 'low-to-moderate');
      const map = {
        calc_high: L('根部/瓣叶钙化负荷偏高', 'High root/leaflet calcification burden'),
        annulus_ecc_high: L('瓣环偏心较明显', 'Marked annulus eccentricity'),
        stj_rel_small: L('STJ 相对偏小，需关注冠脉阻塞风险', 'Relatively narrow STJ; review coronary obstruction risk'),
        low_coronary_height: L('冠脉开口高度偏低', 'Low coronary ostial height')
      };
      return list.map((x) => map[x] || String(x)).join('；');
    }

    function setRecon3dStatus(key, extra = '') {
      const base = t(key);
      $('recon3dStatus').textContent = extra ? (base + ' | ' + extra) : base;
    }

    async function ensure3dLib() {
      if (state.recon3d.lib) return state.recon3d.lib;
      const three = await import('https://esm.sh/three@0.179.1');
      const controlsModule = await import('https://esm.sh/three@0.179.1/examples/jsm/controls/OrbitControls.js');
      const stlModule = await import('https://esm.sh/three@0.179.1/examples/jsm/loaders/STLLoader.js');
      state.recon3d.lib = {
        THREE: three,
        OrbitControls: controlsModule.OrbitControls,
        STLLoader: stlModule.STLLoader
      };
      return state.recon3d.lib;
    }

    function resize3dCanvas() {
      const r3 = state.recon3d;
      if (!r3.initialized || !r3.canvas || !r3.renderer || !r3.camera) return;
      const rect = r3.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      r3.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      r3.renderer.setSize(rect.width, rect.height, false);
      r3.camera.aspect = rect.width / rect.height;
      r3.camera.updateProjectionMatrix();
      render3dCanvas();
    }

    function start3dAnimationLoop() {
      const r3 = state.recon3d;
      if (r3.animationHandle) return;
      const tick = () => {
        if (!r3.initialized || !r3.renderer || !r3.scene || !r3.camera) {
          r3.animationHandle = 0;
          return;
        }
        if (r3.controls && typeof r3.controls.update === 'function') {
          r3.controls.update();
        }
        r3.renderer.render(r3.scene, r3.camera);
        r3.animationHandle = window.requestAnimationFrame(tick);
      };
      r3.animationHandle = window.requestAnimationFrame(tick);
    }

    async function init3dViewer() {
      const r3 = state.recon3d;
      if (r3.initialized) return true;
      const canvas3d = $('viewer3d');
      if (!canvas3d) return false;
      const lib = await ensure3dLib();
      const THREE = lib.THREE;
      const renderer = new THREE.WebGLRenderer({
        canvas: canvas3d,
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance'
      });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.setClearColor(0x07111d, 1.0);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x07111d);

      const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 6000);
      camera.position.set(0, -130, 120);

      const controls = new lib.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.enablePan = true;
      controls.enableZoom = true;
      controls.enableRotate = true;
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN
      };

      const ambient = new THREE.AmbientLight(0xffffff, 0.85);
      const hemi = new THREE.HemisphereLight(0x7dd3fc, 0x0f172a, 0.65);
      const dir = new THREE.DirectionalLight(0xffffff, 1.2);
      dir.position.set(120, -100, 180);

      const group = new THREE.Group();
      scene.add(ambient);
      scene.add(hemi);
      scene.add(dir);
      scene.add(group);

      r3.canvas = canvas3d;
      r3.renderer = renderer;
      r3.scene = scene;
      r3.camera = camera;
      r3.controls = controls;
      r3.group = group;
      r3.initialized = true;
      canvas3d.addEventListener('contextmenu', (e) => e.preventDefault());
      canvas3d.addEventListener('dblclick', () => reset3dView());
      resize3dCanvas();
      start3dAnimationLoop();
      return true;
    }

    function dispose3dNode(node) {
      if (!node) return;
      if (node.geometry && typeof node.geometry.dispose === 'function') {
        node.geometry.dispose();
      }
      if (node.material) {
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          if (material && typeof material.dispose === 'function') material.dispose();
        }
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children) dispose3dNode(child);
      }
    }

    function clear3dGroup() {
      const r3 = state.recon3d;
      if (!r3.group) return;
      while (r3.group.children.length) {
        const child = r3.group.children[r3.group.children.length - 1];
        if (!child) break;
        r3.group.remove(child);
        dispose3dNode(child);
      }
      r3.group.position.set(0, 0, 0);
      r3.triangleCount = 0;
    }

    function buildCenterlineLineObject(THREE, points) {
      if (!Array.isArray(points) || points.length < 2) return null;
      const verts = [];
      for (const item of points) {
        const w = Array.isArray(item?.world) ? item.world : null;
        if (!w || w.length < 3) continue;
        verts.push(new THREE.Vector3(Number(w[0]), Number(w[1]), Number(w[2])));
      }
      if (verts.length < 2) return null;
      const geometry = new THREE.BufferGeometry().setFromPoints(verts);
      const material = new THREE.LineBasicMaterial({ color: 0x93c5fd, linewidth: 1 });
      return new THREE.Line(geometry, material);
    }

    function buildAnnulusPlaneObject(THREE, annulusPlane) {
      const ring = Array.isArray(annulusPlane?.ring_points_world)
        ? annulusPlane.ring_points_world
        : Array.isArray(annulusPlane?.corners_world)
          ? annulusPlane.corners_world
          : [];
      if (!ring.length) return null;
      const points = ring
        .map((p) => Array.isArray(p) && p.length >= 3 ? new THREE.Vector3(Number(p[0]), Number(p[1]), Number(p[2])) : null)
        .filter(Boolean);
      if (points.length < 3) return null;
      points.push(points[0].clone());
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.95 });
      return new THREE.LineLoop(geometry, material);
    }

    function render3dCanvas() {
      const r3 = state.recon3d;
      if (!r3.initialized || !r3.renderer || !r3.scene || !r3.camera) return;
      r3.renderer.render(r3.scene, r3.camera);
    }

    function fit3dCameraToGroup() {
      const r3 = state.recon3d;
      if (!r3.group || !r3.camera || !r3.controls || !r3.lib) return;
      const THREE = r3.lib.THREE;
      const box = new THREE.Box3().setFromObject(r3.group);
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z) * 0.6 || 40;
      r3.group.position.set(-center.x, -center.y, -center.z);
      r3.controls.target.set(0, 0, 0);
      r3.camera.position.set(radius * 0.9, -radius * 1.8, radius * 1.2);
      r3.camera.near = Math.max(0.1, radius / 250);
      r3.camera.far = Math.max(2000, radius * 20);
      r3.camera.updateProjectionMatrix();
      r3.controls.update();
    }

    async function loadStlMesh(url, color, opacity, label) {
      const r3 = state.recon3d;
      if (!r3.lib || !url || url === '#') return null;
      const THREE = r3.lib.THREE;
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) return null;
      const loader = new r3.lib.STLLoader();
      const geometry = loader.parse(await resp.arrayBuffer());
      geometry.computeVertexNormals();
      const material = new THREE.MeshPhongMaterial({
        color,
        transparent: opacity < 1,
        opacity,
        shininess: 45,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = label;
      return mesh;
    }

    function triangleCountOf(object3d) {
      let total = 0;
      object3d?.traverse?.((node) => {
        const pos = node?.geometry?.attributes?.position;
        if (pos?.count) total += Math.floor(pos.count / 3);
      });
      return total;
    }

    async function rebuild3dModel() {
      if (!state.segReady || !state.seg) {
        setRecon3dStatus('recon3dStatusNoSeg');
        return;
      }
      if (!(await init3dViewer())) {
        setRecon3dStatus('recon3dStatusLibFail');
        return;
      }
      setRecon3dStatus('recon3dStatusBuilding');
      clear3dGroup();
      const r3 = state.recon3d;
      const THREE = r3.lib.THREE;
      const specs = [
        { cls: 1, url: findArtifactLink(state.caseData, ['aortic_root_stl']), color: 0xef4444, opacity: 0.72, label: 'aortic_root' },
        { cls: 2, url: findArtifactLink(state.caseData, ['leaflets_stl']), color: 0xfacc15, opacity: 0.92, label: 'leaflets' },
        { cls: 3, url: findArtifactLink(state.caseData, ['ascending_aorta_stl']), color: 0x22d3ee, opacity: 0.65, label: 'ascending_aorta' }
      ];

      for (const sp of specs) {
        if (!r3.classVisible[sp.cls]) continue;
        const mesh = await loadStlMesh(sp.url, sp.color, sp.opacity, sp.label);
        if (mesh) r3.group.add(mesh);
      }

      const centerlineLine = buildCenterlineLineObject(THREE, state.centerlineData?.points);
      if (centerlineLine) r3.group.add(centerlineLine);

      const annulusLoop = buildAnnulusPlaneObject(THREE, state.annulusPlaneData || state.pipelineResult?.landmarks?.annulus_plane);
      if (annulusLoop) r3.group.add(annulusLoop);

      fit3dCameraToGroup();
      r3.triangleCount = triangleCountOf(r3.group);
      render3dCanvas();
      setRecon3dStatus('recon3dStatusReady', r3.triangleCount + ' tris');
    }

    function reset3dView() {
      const r3 = state.recon3d;
      if (!r3.initialized || !r3.controls) return;
      fit3dCameraToGroup();
      render3dCanvas();
    }

    function toggle3dClass(cls, btnId) {
      const r3 = state.recon3d;
      r3.classVisible[cls] = !r3.classVisible[cls];
      $(btnId).classList.toggle('active', r3.classVisible[cls]);
      rebuild3dModel().catch(() => {});
    }

    function fillPlanningTables() {
      if (!state.stats) return;
      const s = state.stats;
      setReadinessChip('pearsState', classifyPearsReadiness().level);
      setReadinessChip('vsrrState', classifyVsrrReadiness().level);
      setReadinessChip('taviState', classifyTaviReadiness().level);
      updateKeySliceMap();
      updateKeySliceButtons();

      const pearsRows = [
        [L('测量方法', 'Measurement method'), L('中心线正交切面（double-oblique）', 'Centerline-orthogonal cross-sections (double-oblique)')],
        [L('根部最大直径', 'Root max diameter'), fmt(s.rootMaxDiameterMm) + ' mm'],
        [L('升主动脉最大直径', 'Ascending max diameter'), fmt(s.ascMaxDiameterMm) + ' mm'],
        [L('VBR（正交）', 'VBR (orthogonal)'), fmt(s.vbrDiameterMm) + ' mm'],
        [L('STJ（正交）', 'STJ (orthogonal)'), fmt(s.stjDiameterMm) + ' mm'],
        [L('根部长/短轴', 'Root major/minor'), fmt(s.rootMaxMajorDiameterMm) + ' / ' + fmt(s.rootMaxMinorDiameterMm) + ' mm'],
        [L('升主动脉长/短轴', 'Ascending major/minor'), fmt(s.ascMaxMajorDiameterMm) + ' / ' + fmt(s.ascMaxMinorDiameterMm) + ' mm'],
        [L('支撑长度', 'Support length'), fmt(s.supportLengthMm) + ' mm'],
        [L('根部体积', 'Root volume'), fmt(s.rootVolumeMl) + ' mL'],
        [L('升主动脉体积', 'Ascending volume'), fmt(s.ascVolumeMl) + ' mL'],
        [L('冠脉开口地标', 'Coronary ostia landmarks'), L('待补充（需地标模型）', 'pending (needs landmark model)')]
      ];
      $('pearsMetrics').innerHTML = pearsRows.map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('');

      const vsrrRows = [
        [L('测量方法', 'Measurement method'), L('中心线正交切面（double-oblique）', 'Centerline-orthogonal cross-sections (double-oblique)')],
        [L('瓣环/VBR 直径', 'Annulus/VBR diameter'), fmt(s.vbrDiameterMm) + ' mm'],
        [L('LVOT 直径', 'LVOT diameter'), fmt(s.lvotDiameterMm) + ' mm'],
        [L('STJ 直径', 'STJ diameter'), fmt(s.stjDiameterMm) + ' mm'],
        [L('根部最大直径', 'Root max diameter'), fmt(s.rootMaxDiameterMm) + ' mm'],
        [L('根部长/短轴', 'Root major/minor'), fmt(s.rootMaxMajorDiameterMm) + ' / ' + fmt(s.rootMaxMinorDiameterMm) + ' mm'],
        [L('瓣叶带厚度', 'Leaflet band thickness'), fmt(s.leafletBandMm) + ' mm'],
        [L('瓣叶区域体积', 'Leaflet zone volume'), fmt(s.leafletVolumeMl) + ' mL'],
        [L('交界点角度', 'Commissural angles'), s.commissuralAnglesDeg.join(' / ') + ' deg'],
        [L('交界点高度', 'Commissural heights'), L('待补充（需地标模型）', 'pending (needs landmark model)')],
        [L('瓣环-瓣叶失配风险', 'Annulus-cusp mismatch risk'), (s.vbrDiameterMm && s.rootMaxDiameterMm && s.rootMaxDiameterMm > s.vbrDiameterMm * 1.35) ? L('升高', 'elevated') : L('低-中', 'low-to-moderate')]
      ];
      $('vsrrMetrics').innerHTML = vsrrRows.map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('');

      const taviRows = [
        [L('测量方法', 'Measurement method'), L('中心线正交切面（double-oblique）', 'Centerline-orthogonal cross-sections (double-oblique)')],
        [L('瓣环面积（VBR）', 'Annulus area (VBR)'), fmt(s.vbrAreaMm2) + ' mm2'],
        [L('瓣环周长（VBR）', 'Annulus perimeter (VBR)'), fmt(s.vbrPerimeterMm) + ' mm'],
        [L('瓣环等效直径', 'Annulus equivalent diameter'), fmt(s.vbrDiameterMm) + ' mm'],
        [L('LVOT 直径', 'LVOT diameter'), fmt(s.lvotDiameterMm) + ' mm'],
        [L('瓣环长/短轴', 'Annulus major/minor'), fmt(s.vbrMajorDiameterMm) + ' / ' + fmt(s.vbrMinorDiameterMm) + ' mm'],
        [L('瓣环偏心率', 'Annulus eccentricity'), fmt(s.vbrEccentricity, 3)],
        [L('窦部最大直径', 'Sinus of Valsalva max diameter'), fmt(s.rootMaxDiameterMm) + ' mm'],
        [L('STJ 直径', 'STJ diameter'), fmt(s.stjDiameterMm) + ' mm'],
        [L('升主动脉直径', 'Ascending aorta diameter'), fmt(s.ascMaxDiameterMm) + ' mm'],
        [L('根轴角（相对体轴）', 'Root axis angle (vs body z-axis)'), fmt(s.aorticRootAxisAngleDeg, 1) + ' deg'],
        [L('瓣环区钙化体积（HU>' + fmtInt(s.calcificationThresholdHU || 130) + '）', 'Annulus calc volume (HU>' + fmtInt(s.calcificationThresholdHU || 130) + ')'), fmt(s.annulusCalcVolumeMl, 3) + ' mL'],
        [L('根部/瓣叶钙化体积（HU>' + fmtInt(s.calcificationThresholdHU || 130) + '）', 'Root/leaflet calc volume (HU>' + fmtInt(s.calcificationThresholdHU || 130) + ')'), fmt(s.rootLeafCalcVolumeMl, 3) + ' mL'],
        [L('冠脉高度（左/右）', 'Coronary heights (L/R)'), fmt(s.taviCoronaryHeightLeftMm, 2) + ' / ' + fmt(s.taviCoronaryHeightRightMm, 2) + ' mm'],
        [L('VTC / VTSTJ', 'VTC / VTSTJ'), L('待补充（需虚拟瓣膜模型）', 'pending (needs virtual valve model)')],
        [L('外周入路最小管径', 'Access route minimal lumen diameter'), L('待补充（需全主动脉-髂股动脉分割）', 'pending (needs full aorto-iliofemoral segmentation)')],
        [L('TAVI 风险提示', 'TAVI risk flags'), formatTaviRiskFlags(s.taviRiskFlags)]
      ];
      $('taviMetrics').innerHTML = taviRows.map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('');
      renderBottomMeasurements();
    }

    function renderBottomMeasurements() {
      const tbody = $('bottomMeasurements');
      if (!tbody) return;
      if (!state.stats) {
        tbody.innerHTML = '';
        return;
      }
      const s = state.stats;
      const backend = state.pipelineResult?.measurements || {};
      const backendCalc = backend?.valve_calcium_burden || {};
      const rawStructured = state.pipelineResult?.measurements_structured_raw || {};
      const regStructured = state.pipelineResult?.measurements_structured_regularized || state.pipelineResult?.measurements_structured || {};
      const contract = state.pipelineResult?.measurement_contract || {};
      const hasBackend = (k) => Number.isFinite(Number(backend?.[k]));
      const safeGet = (obj, path) => {
        const parts = String(path || '').split('.');
        let cur = obj;
        for (const p of parts) {
          if (!cur || typeof cur !== 'object') return null;
          cur = cur[p];
        }
        return cur ?? null;
      };
      const sameNum = (a, b) => {
        const na = Number(a);
        const nb = Number(b);
        if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
        return Math.abs(na - nb) < 1e-4;
      };
      const contractSource = (group, rawPath, regPath, fallback) => {
        const meta = contract?.[group] || null;
        if (!meta) return fallback;
        const method = String(meta.method || fallback || 'backend');
        const rawVal = rawPath ? safeGet(rawStructured, rawPath) : null;
        const regVal = regPath ? safeGet(regStructured, regPath) : null;
        if (rawVal !== null && regVal !== null && !sameNum(rawVal, regVal)) {
          return method + ' (raw→regularized)';
        }
        return method;
      };
      const src = (k, group, rawPath, regPath) => hasBackend(k)
        ? 'backend(' + contractSource(group, rawPath, regPath, 'centerline-orthogonal') + ')'
        : 'ui(fallback)';
      const calcSrc = Number.isFinite(Number(backendCalc?.calc_volume_ml))
        ? 'backend(' + contractSource('calcium_burden', 'calcium_burden.calc_volume_ml', 'calcium_burden.calc_volume_ml', 'HU-threshold') + ')'
        : 'ui/fallback';

      const rows = [
        [L('瓣环直径', 'Annulus Diameter'), fmt(s.vbrDiameterMm), 'mm', src('annulus_diameter_mm', 'annulus', 'annulus.equivalent_diameter_mm', 'annulus.equivalent_diameter_mm')],
        [L('瓣环面积', 'Annulus Area'), fmt(s.vbrAreaMm2), 'mm2', src('annulus_area_mm2', 'annulus', 'annulus.area_mm2', 'annulus.area_mm2')],
        [L('瓣环周长', 'Annulus Perimeter'), fmt(s.vbrPerimeterMm), 'mm', src('annulus_perimeter_mm', 'annulus', 'annulus.perimeter_mm', 'annulus.perimeter_mm')],
        [L('窦部直径', 'Sinus of Valsalva Diameter'), fmt(s.rootMaxDiameterMm), 'mm', src('sinus_of_valsalva_diameter_mm', 'sinus_of_valsalva', 'sinus_of_valsalva.max_diameter_mm', 'sinus_of_valsalva.max_diameter_mm')],
        [L('STJ 直径', 'STJ Diameter'), fmt(s.stjDiameterMm), 'mm', src('stj_diameter_mm', 'stj', 'stj.diameter_mm', 'stj.diameter_mm')],
        [L('升主动脉直径', 'Ascending Aorta Diameter'), fmt(s.ascMaxDiameterMm), 'mm', src('ascending_aorta_diameter_mm', 'ascending_aorta', 'ascending_aorta.diameter_mm', 'ascending_aorta.diameter_mm')],
        [L('LVOT 直径', 'LVOT Diameter'), fmt(s.lvotDiameterMm), 'mm', src('lvot_diameter_mm', 'lvot', 'lvot.diameter_mm', 'lvot.diameter_mm')],
        [L('左冠开口高度', 'Coronary Height Left'), fmt(s.taviCoronaryHeightLeftMm), 'mm', src('coronary_height_left_mm', 'coronary_heights_mm', 'coronary_heights_mm.left', 'coronary_heights_mm.left')],
        [L('右冠开口高度', 'Coronary Height Right'), fmt(s.taviCoronaryHeightRightMm), 'mm', src('coronary_height_right_mm', 'coronary_heights_mm', 'coronary_heights_mm.right', 'coronary_heights_mm.right')],
        [L('瓣膜钙化负荷', 'Valve Calcium Burden'), fmt(s.rootLeafCalcVolumeMl, 3), 'mL', calcSrc]
      ];
      tbody.innerHTML = rows
        .map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td><td>' + r[3] + '</td></tr>')
        .join('');
    }

    function defaultStandards(kind) {
      if (kind === 'pears') {
        return [
          { title: L('根部-升主动脉连续外表面', 'Continuous root-to-ascending outer surface'), rule: L('Root与Ascending需连续分割，STJ可识别；直径在中心线正交切面测量', 'Root and ascending segmentation must be continuous with identifiable STJ; diameters measured on centerline-orthogonal planes') },
          { title: L('冠脉开口避让', 'Coronary ostia sparing'), rule: L('需标记左右冠脉开口用于PEARS开窗', 'Left and right coronary ostia should be localized for PEARS windowing') },
          { title: L('早期预防性干预窗口', 'Early preventive intervention window'), rule: L('遗传性主动脉根部扩张中尽量在夹层前完成预防性支持', 'For inherited root dilation, perform preventive support before dissection risk escalates') }
        ];
      }
      if (kind === 'tavi') {
        return [
          { title: L('双斜位瓣环测量', 'Double-oblique annulus sizing'), rule: L('瓣环面积/周长/直径必须在中心线正交切面测量', 'Annulus area/perimeter/diameter must be measured on centerline-orthogonal planes') },
          { title: L('冠脉阻塞风险评估', 'Coronary obstruction risk assessment'), rule: L('需提供冠脉开口高度、VTC/VTSTJ与窦部/STJ几何', 'Provide coronary heights, VTC/VTSTJ and sinus/STJ geometry') },
          { title: L('入路评估', 'Access route assessment'), rule: L('需评估主动脉-髂股路径最小管径、钙化和迂曲度', 'Assess aorto-iliofemoral minimal lumen diameter, calcification and tortuosity') }
        ];
      }
      return [
        { title: L('VBR与STJ几何匹配', 'VBR-STJ geometric matching'), rule: L('基于双斜位/中心线正交切面，用于VSRR移植物尺寸与重建几何决策', 'Use double-oblique centerline-orthogonal planes for VSRR graft sizing and root reconstruction geometry') },
        { title: L('Commissure三点定位', 'Three-point commissural localization'), rule: L('需给出交界点角度映射与高度层面', 'Provide commissural angular mapping and vertical level') },
        { title: L('Annulus-cusp mismatch风险', 'Annulus-cusp mismatch risk'), rule: L('重视coaptation reserve不足导致的返流/再干预风险', 'Assess regurgitation/reintervention risk from low coaptation reserve') }
      ];
    }

    function getStandards(kind) {
      const fromCase = state.caseData?.clinical_targets?.[kind]?.standards;
      return Array.isArray(fromCase) && fromCase.length ? fromCase : defaultStandards(kind);
    }

    function classifyPearsReadiness() {
      const s = state.stats;
      if (!s) return { level: 'not-ready', note: L('未完成自动分割，无法评估。', 'Segmentation not completed; cannot assess.') };
      const hasCore = Number(s.rootVolumeMl || 0) > 0 && Number(s.ascVolumeMl || 0) > 0;
      if (!hasCore) return { level: 'not-ready', note: L('未形成可用的 root/ascending 连续体。', 'No usable root/ascending continuous structure found.') };
      if (!s.supportLengthMm || s.supportLengthMm < 25) {
        return { level: 'partial-ready', note: L('支撑段长度偏短，建议复核 STJ 与远端边界。', 'Support segment is short; recheck STJ and distal boundary.') };
      }
      return { level: 'partial-ready', note: L('已具备 PEARS 基础几何；冠脉开口与 VBR 平面仍需地标模型补齐。', 'PEARS baseline geometry is available; coronary ostia and VBR plane still need landmark model.') };
    }

    function classifyVsrrReadiness() {
      const s = state.stats;
      if (!s) return { level: 'not-ready', note: L('未完成自动分割，无法评估。', 'Segmentation not completed; cannot assess.') };
      const mismatchHigh = s.vbrDiameterMm && s.rootMaxDiameterMm && s.rootMaxDiameterMm > s.vbrDiameterMm * 1.35;
      if (!s.vbrDiameterMm || !s.stjDiameterMm) return { level: 'not-ready', note: L('VBR/STJ 关键几何缺失。', 'Missing key VBR/STJ geometry.') };
      if (mismatchHigh) return { level: 'partial-ready', note: L('annulus-cusp mismatch 风险偏高，建议术前重点复核。', 'Annulus-cusp mismatch risk is elevated; review before surgery.') };
      return { level: 'partial-ready', note: L('已具备 VSRR 基础几何评估；Commissure 高度仍需专用地标模型。', 'VSRR baseline geometry is available; commissural heights still need landmark model.') };
    }

    function classifyTaviReadiness() {
      const s = state.stats;
      if (!s) return { level: 'not-ready', note: L('未完成自动分割，无法评估。', 'Segmentation not completed; cannot assess.') };
      const hasCore = Number.isFinite(s.vbrAreaMm2) && Number.isFinite(s.vbrPerimeterMm) && Number.isFinite(s.stjDiameterMm);
      if (!hasCore) return { level: 'not-ready', note: L('瓣环/根部关键几何不足。', 'Missing key annulus/root geometry.') };
      const hasCoronary =
        Number.isFinite(s.taviCoronaryHeightMm) ||
        Number.isFinite(s.taviCoronaryHeightLeftMm) ||
        Number.isFinite(s.taviCoronaryHeightRightMm) ||
        Number.isFinite(s.taviVtcMm) ||
        Number.isFinite(s.taviVtstjMm);
      const hasAccess = Number.isFinite(s.taviAccessMinLumenMm);
      if (hasCoronary && hasAccess) {
        return { level: 'ready', note: L('已具备瓣环、冠脉风险与入路三大评估模块。', 'Annulus, coronary-risk and access-route modules are available.') };
      }
      return { level: 'partial-ready', note: L('已具备瓣环/根部核心几何；冠脉风险与入路仍需地标与全路径分割补齐。', 'Core annulus/root geometry is available; coronary-risk and access-route still require landmarks and full-route segmentation.') };
    }

    function renderPlan(kind) {
      state.lastPlanKind = kind;
      if (!state.stats) {
        $('planPreview').textContent = t('planWaiting');
        return;
      }
      const s = state.stats;
      const standards = getStandards(kind);
      const verdict = kind === 'pears'
        ? classifyPearsReadiness()
        : (kind === 'tavi' ? classifyTaviReadiness() : classifyVsrrReadiness());
      const lines = [];
      lines.push((state.lang === 'en' ? 'Plan Type: ' : '方案类型: ') + kind.toUpperCase());
      lines.push((state.lang === 'en' ? 'Case: ' : '病例: ') + (state.caseData?.study_id || '-'));
      lines.push((state.lang === 'en' ? 'Readiness: ' : '就绪度: ') + verdict.level);
      lines.push((state.lang === 'en' ? 'Summary: ' : '摘要: ') + verdict.note);
      lines.push('');
      lines.push(L('关键测量', 'Key Measurements'));
      lines.push('- ' + L('测量方法', 'Measurement method') + ': ' + L('中心线正交切面（double-oblique）', 'Centerline-orthogonal cross-sections (double-oblique)'));
      if (kind === 'tavi') {
        lines.push('- ' + L('瓣环面积（VBR）', 'Annulus area (VBR)') + ': ' + fmt(s.vbrAreaMm2) + ' mm2');
        lines.push('- ' + L('瓣环周长（VBR）', 'Annulus perimeter (VBR)') + ': ' + fmt(s.vbrPerimeterMm) + ' mm');
        lines.push('- ' + L('瓣环等效直径', 'Annulus equivalent diameter') + ': ' + fmt(s.vbrDiameterMm) + ' mm');
        lines.push('- ' + L('LVOT 直径', 'LVOT diameter') + ': ' + fmt(s.lvotDiameterMm) + ' mm');
        lines.push('- ' + L('瓣环长/短轴', 'Annulus major/minor') + ': ' + fmt(s.vbrMajorDiameterMm) + ' / ' + fmt(s.vbrMinorDiameterMm) + ' mm');
        lines.push('- ' + L('窦部最大直径', 'Sinus of Valsalva max diameter') + ': ' + fmt(s.rootMaxDiameterMm) + ' mm');
        lines.push('- ' + L('STJ 直径', 'STJ diameter') + ': ' + fmt(s.stjDiameterMm) + ' mm');
        lines.push('- ' + L('根轴角（相对体轴）', 'Root axis angle (vs body z-axis)') + ': ' + fmt(s.aorticRootAxisAngleDeg, 1) + ' deg');
        lines.push('- ' + L('根部/瓣叶钙化体积（HU>' + fmtInt(s.calcificationThresholdHU || 130) + '）', 'Root/leaflet calc volume (HU>' + fmtInt(s.calcificationThresholdHU || 130) + ')') + ': ' + fmt(s.rootLeafCalcVolumeMl, 3) + ' mL');
        lines.push('- ' + L('冠脉高度（左/右）', 'Coronary heights (L/R)') + ': ' + fmt(s.taviCoronaryHeightLeftMm, 2) + ' / ' + fmt(s.taviCoronaryHeightRightMm, 2) + ' mm');
        lines.push('- ' + L('风险提示', 'Risk flags') + ': ' + formatTaviRiskFlags(s.taviRiskFlags));
      } else {
        lines.push('- ' + L('VBR 直径（正交）', 'VBR diameter (orthogonal)') + ': ' + fmt(s.vbrDiameterMm) + ' mm');
        lines.push('- ' + L('LVOT 直径', 'LVOT diameter') + ': ' + fmt(s.lvotDiameterMm) + ' mm');
        lines.push('- ' + L('STJ 直径（正交）', 'STJ diameter (orthogonal)') + ': ' + fmt(s.stjDiameterMm) + ' mm');
        lines.push('- ' + L('根部最大直径（正交）', 'Root max diameter (orthogonal)') + ': ' + fmt(s.rootMaxDiameterMm) + ' mm');
        lines.push('- ' + L('根部长/短轴', 'Root major/minor') + ': ' + fmt(s.rootMaxMajorDiameterMm) + ' / ' + fmt(s.rootMaxMinorDiameterMm) + ' mm');
        lines.push('- ' + L('升主动脉最大直径', 'Ascending max diameter') + ': ' + fmt(s.ascMaxDiameterMm) + ' mm');
        lines.push('- ' + L('支撑长度', 'Support length') + ': ' + fmt(s.supportLengthMm) + ' mm');
        lines.push('- ' + L('瓣叶带厚度', 'Leaflet band') + ': ' + fmt(s.leafletBandMm) + ' mm');
      }
      lines.push('');
      lines.push(L('循证标准', 'Evidence Standards'));
      standards.forEach((std, i) => {
        lines.push((i + 1) + '. ' + (std.title || std.id || 'standard'));
        lines.push('   ' + L('规则', 'rule') + ': ' + (std.rule || '-'));
      });
      lines.push('');
      lines.push(L('临床说明：本系统仅用于科研/术前规划辅助，最终决策由心脏团队作出。', 'Clinical Note: research/pre-op planning assistant only; final decision by heart team.'));
      $('planPreview').textContent = lines.join('\\n');
    }

    function pickMprCrosshair(z) {
      let cx = Math.floor((state.dims.x || 1) / 2);
      let cy = Math.floor((state.dims.y || 1) / 2);
      if (state.segReady && state.seg) {
        const b = getSliceClassBounds(1, z) || getSliceClassBounds(3, z) || getSliceClassBounds(2, z);
        if (b) {
          cx = clamp(Math.round(b.cx), 0, state.dims.x - 1);
          cy = clamp(Math.round(b.cy), 0, state.dims.y - 1);
        }
      } else if (state.annulusPlaneData?.origin_voxel) {
        const p = state.annulusPlaneData.origin_voxel;
        if (Array.isArray(p) && p.length >= 2) {
          cx = clamp(Math.round(Number(p[0]) || cx), 0, state.dims.x - 1);
          cy = clamp(Math.round(Number(p[1]) || cy), 0, state.dims.y - 1);
        }
      }
      return { x: cx, y: cy };
    }

    function renderMprViews(axialZ) {
      if (!state.vol || !ctxSag || !ctxCor || !canvasSag || !canvasCor) return;
      const nx = state.dims.x;
      const ny = state.dims.y;
      const nz = state.dims.z;
      if (!(nx > 1 && ny > 1 && nz > 1)) return;
      const cross = pickMprCrosshair(axialZ);
      const lo = state.wl - state.ww / 2;
      const hi = state.wl + state.ww / 2;
      const inv = hi === lo ? 1 : 255.0 / (hi - lo);
      const alpha = Math.floor(255 * state.overlayOpacity * 0.58);

      // Sagittal: Y (x-axis on canvas) vs Z (y-axis on canvas), at fixed X.
      offSag.width = ny;
      offSag.height = nz;
      const sagImg = offSagCtx.createImageData(ny, nz);
      const sPix = sagImg.data;
      for (let z = 0; z < nz; z += 1) {
        for (let y = 0; y < ny; y += 1) {
          const idx = indexOf(cross.x, y, z);
          let g = ((Number(state.vol[idx]) * state.slope + state.inter) - lo) * inv;
          g = clamp(g, 0, 255);
          const p = (z * ny + y) * 4;
          sPix[p] = g;
          sPix[p + 1] = g;
          sPix[p + 2] = g;
          sPix[p + 3] = 255;
          if (state.segReady && state.seg) {
            const cls = state.seg[idx];
            if (cls === 1) { sPix[p] = 239; sPix[p + 1] = 68; sPix[p + 2] = 68; sPix[p + 3] = alpha; }
            else if (cls === 2) { sPix[p] = 250; sPix[p + 1] = 204; sPix[p + 2] = 21; sPix[p + 3] = alpha; }
            else if (cls === 3) { sPix[p] = 34; sPix[p + 1] = 211; sPix[p + 2] = 238; sPix[p + 3] = alpha; }
          }
        }
      }
      offSagCtx.putImageData(sagImg, 0, 0);
      const rs = canvasSag.getBoundingClientRect();
      ctxSag.clearRect(0, 0, rs.width, rs.height);
      ctxSag.drawImage(offSag, 0, 0, ny, nz, 0, 0, rs.width, rs.height);
      ctxSag.strokeStyle = '#93c5fd';
      ctxSag.lineWidth = 1.2;
      const zy = (axialZ / Math.max(1, nz - 1)) * rs.height;
      const yy = (cross.y / Math.max(1, ny - 1)) * rs.width;
      ctxSag.beginPath();
      ctxSag.moveTo(0, zy);
      ctxSag.lineTo(rs.width, zy);
      ctxSag.moveTo(yy, 0);
      ctxSag.lineTo(yy, rs.height);
      ctxSag.stroke();

      // Coronal: X (x-axis on canvas) vs Z (y-axis on canvas), at fixed Y.
      offCor.width = nx;
      offCor.height = nz;
      const corImg = offCorCtx.createImageData(nx, nz);
      const cPix = corImg.data;
      for (let z = 0; z < nz; z += 1) {
        for (let x = 0; x < nx; x += 1) {
          const idx = indexOf(x, cross.y, z);
          let g = ((Number(state.vol[idx]) * state.slope + state.inter) - lo) * inv;
          g = clamp(g, 0, 255);
          const p = (z * nx + x) * 4;
          cPix[p] = g;
          cPix[p + 1] = g;
          cPix[p + 2] = g;
          cPix[p + 3] = 255;
          if (state.segReady && state.seg) {
            const cls = state.seg[idx];
            if (cls === 1) { cPix[p] = 239; cPix[p + 1] = 68; cPix[p + 2] = 68; cPix[p + 3] = alpha; }
            else if (cls === 2) { cPix[p] = 250; cPix[p + 1] = 204; cPix[p + 2] = 21; cPix[p + 3] = alpha; }
            else if (cls === 3) { cPix[p] = 34; cPix[p + 1] = 211; cPix[p + 2] = 238; cPix[p + 3] = alpha; }
          }
        }
      }
      offCorCtx.putImageData(corImg, 0, 0);
      const rc = canvasCor.getBoundingClientRect();
      ctxCor.clearRect(0, 0, rc.width, rc.height);
      ctxCor.drawImage(offCor, 0, 0, nx, nz, 0, 0, rc.width, rc.height);
      ctxCor.strokeStyle = '#93c5fd';
      ctxCor.lineWidth = 1.2;
      const zy2 = (axialZ / Math.max(1, nz - 1)) * rc.height;
      const xx2 = (cross.x / Math.max(1, nx - 1)) * rc.width;
      ctxCor.beginPath();
      ctxCor.moveTo(0, zy2);
      ctxCor.lineTo(rc.width, zy2);
      ctxCor.moveTo(xx2, 0);
      ctxCor.lineTo(xx2, rc.height);
      ctxCor.stroke();
    }

    function render() {
      if (!state.vol || !state.dims.z) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (ctxSag && canvasSag) ctxSag.clearRect(0, 0, canvasSag.width, canvasSag.height);
        if (ctxCor && canvasCor) ctxCor.clearRect(0, 0, canvasCor.width, canvasCor.height);
        return;
      }
      const { x: nx, y: ny } = state.dims;
      const z = clamp(state.slice, 0, state.dims.z - 1);
      const overlayScale = 2;

      off.width = nx;
      off.height = ny;
      ov.width = nx * overlayScale;
      ov.height = ny * overlayScale;

      const img = offCtx.createImageData(nx, ny);
      const pix = img.data;
      const lo = state.wl - state.ww / 2;
      const hi = state.wl + state.ww / 2;
      const inv = hi === lo ? 1 : 255.0 / (hi - lo);

      for (let y = 0; y < ny; y += 1) {
        for (let x = 0; x < nx; x += 1) {
          const idx = indexOf(x, y, z);
          let g = ((Number(state.vol[idx]) * state.slope + state.inter) - lo) * inv;
          g = clamp(g, 0, 255);
          const p = (y * nx + x) * 4;
          pix[p] = g;
          pix[p + 1] = g;
          pix[p + 2] = g;
          pix[p + 3] = 255;
        }
      }
      offCtx.putImageData(img, 0, 0);

      if (state.segReady && state.seg) {
        const oimg = ovCtx.createImageData(nx * overlayScale, ny * overlayScale);
        const op = oimg.data;
        const alpha = Math.floor(255 * state.overlayOpacity * 0.58);
        const pxStride = nx * overlayScale;
        for (let y = 0; y < ny; y += 1) {
          for (let x = 0; x < nx; x += 1) {
            const cls = state.seg[indexOf(x, y, z)];
            if (!cls) continue;
            let r = 0;
            let g = 0;
            let b = 0;
            if (cls === 1) { r = 239; g = 68; b = 68; }
            else if (cls === 2) { r = 250; g = 204; b = 21; }
            else if (cls === 3) { r = 34; g = 211; b = 238; }
            if (!r && !g && !b) continue;
            const ox = x * overlayScale;
            const oy = y * overlayScale;
            for (let yy = 0; yy < overlayScale; yy += 1) {
              const row = (oy + yy) * pxStride;
              for (let xx = 0; xx < overlayScale; xx += 1) {
                const p = (row + ox + xx) * 4;
                op[p] = r;
                op[p + 1] = g;
                op[p + 2] = b;
                op[p + 3] = alpha;
              }
            }
          }
        }
        ovCtx.putImageData(oimg, 0, 0);
      } else {
        ovCtx.clearRect(0, 0, nx * overlayScale, ny * overlayScale);
      }

      const rect = canvas.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const sx = state.zoom;
      const sy = state.zoom;
      const b = getViewerFocusBounds();
      const bw = Math.max(1, b.maxX - b.minX + 1);
      const bh = Math.max(1, b.maxY - b.minY + 1);
      const tx = cx - ((b.minX + bw / 2) * sx) + state.panX;
      const ty = cy - ((b.minY + bh / 2) * sy) + state.panY;

      ctx.save();
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.setTransform(sx, 0, 0, sy, tx, ty);
      ctx.drawImage(off, 0, 0);
      ctx.drawImage(ov, 0, 0, ov.width, ov.height, 0, 0, nx, ny);

      if (state.segReady && state.seg) {
        const lw = Math.max(0.7, 1.8 / Math.max(1, state.zoom));
        drawContourForClass(z, 1, '#f87171', lw);
        drawContourForClass(z, 2, '#fde047', lw);
        drawContourForClass(z, 3, '#67e8f9', lw);
        if (state.measureDisplay === 'ct') {
          drawCurrentSliceMeasurements(z);
        }
        drawCenterlineOverlay(z);
        drawAnnulusPlaneOverlay(z);
      }

      if (state.stats && Math.abs(z - state.stats.commissureZ) <= 1) {
        const c = findCentroidForClassOnSlice(1, z);
        if (c) {
          const r = Math.max(8, (state.stats.rootMaxDiameterMm || 20) / (2 * state.vox.dx));
          const ang = [0, 2.09439510239, 4.18879020479];
          ctx.fillStyle = '#f0f9ff';
          for (const a of ang) {
            const px = c.x + Math.cos(a) * r;
            const py = c.y + Math.sin(a) * r;
            ctx.beginPath();
            ctx.arc(px, py, 2.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      ctx.restore();
      renderMprViews(z);
      syncControlLabels();
    }

    function drawContourForClass(z, cls, color, lineWidth) {
      if (!state.seg || typeof Path2D === 'undefined') return;
      const path = getContourPath(z, cls);
      if (!path) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke(path);
    }

    function getContourPath(z, cls) {
      if (!state.seg || typeof Path2D === 'undefined') return null;
      const key = z + ':' + cls;
      const cached = state.contourCache.get(key);
      if (cached) return cached;
      const path = new Path2D();
      const nx = state.dims.x;
      const ny = state.dims.y;
      for (let y = 0; y < ny - 1; y += 1) {
        for (let x = 0; x < nx - 1; x += 1) {
          const a = state.seg[indexOf(x, y, z)] === cls ? 1 : 0;
          const b = state.seg[indexOf(x + 1, y, z)] === cls ? 1 : 0;
          const c = state.seg[indexOf(x + 1, y + 1, z)] === cls ? 1 : 0;
          const d = state.seg[indexOf(x, y + 1, z)] === cls ? 1 : 0;
          const code = a | (b << 1) | (c << 2) | (d << 3);
          addMarchingSegments(path, x, y, code);
        }
      }
      state.contourCache.set(key, path);
      return path;
    }

    function segLine(path, x1, y1, x2, y2) {
      path.moveTo(x1, y1);
      path.lineTo(x2, y2);
    }

    function addMarchingSegments(path, x, y, code) {
      const lX = x, lY = y + 0.5;
      const tX = x + 0.5, tY = y;
      const rX = x + 1, rY = y + 0.5;
      const bX = x + 0.5, bY = y + 1;
      switch (code) {
        case 0:
        case 15:
          break;
        case 1:
        case 14:
          segLine(path, lX, lY, tX, tY);
          break;
        case 2:
        case 13:
          segLine(path, tX, tY, rX, rY);
          break;
        case 3:
        case 12:
          segLine(path, lX, lY, rX, rY);
          break;
        case 4:
        case 11:
          segLine(path, rX, rY, bX, bY);
          break;
        case 5:
          segLine(path, lX, lY, tX, tY);
          segLine(path, rX, rY, bX, bY);
          break;
        case 6:
        case 9:
          segLine(path, tX, tY, bX, bY);
          break;
        case 7:
        case 8:
          segLine(path, lX, lY, bX, bY);
          break;
        case 10:
          segLine(path, tX, tY, rX, rY);
          segLine(path, bX, bY, lX, lY);
          break;
        default:
          break;
      }
    }

    function getSliceClassBounds(cls, z) {
      if (!state.seg) return null;
      const nx = state.dims.x;
      const ny = state.dims.y;
      let minX = nx, maxX = -1, minY = ny, maxY = -1;
      let sx = 0, sy = 0, n = 0;
      for (let y = 0; y < ny; y += 1) {
        for (let x = 0; x < nx; x += 1) {
          if (state.seg[indexOf(x, y, z)] !== cls) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          sx += x;
          sy += y;
          n += 1;
        }
      }
      if (n < 8) return null;
      return { minX, maxX, minY, maxY, cx: sx / n, cy: sy / n, n };
    }

    function getDiameterLineForSlice(cls, z) {
      const b = getSliceClassBounds(cls, z);
      if (!b) return null;
      const widthMm = (b.maxX - b.minX + 1) * state.vox.dx;
      const heightMm = (b.maxY - b.minY + 1) * state.vox.dy;
      if (widthMm >= heightMm) {
        return { x1: b.minX, y1: b.cy, x2: b.maxX, y2: b.cy, mm: widthMm };
      }
      return { x1: b.cx, y1: b.minY, x2: b.cx, y2: b.maxY, mm: heightMm };
    }

    function drawLineLabel(line, color, label) {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.9, 2.2 / Math.max(1, state.zoom));
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(line.x1, line.y1);
      ctx.lineTo(line.x2, line.y2);
      ctx.stroke();

      const mx = (line.x1 + line.x2) * 0.5;
      const my = (line.y1 + line.y2) * 0.5;
      const fontSize = Math.max(8, 12 / Math.max(1, state.zoom));
      ctx.font = '700 ' + fontSize + 'px ui-sans-serif, -apple-system, Segoe UI, Roboto';
      const textW = ctx.measureText(label).width;
      const pad = Math.max(2, 4 / Math.max(1, state.zoom));
      const boxW = textW + pad * 2;
      const boxH = fontSize + pad * 2;
      const bx = mx + Math.max(2, 6 / Math.max(1, state.zoom));
      const by = my - boxH - Math.max(2, 5 / Math.max(1, state.zoom));
      ctx.fillStyle = 'rgba(4, 10, 20, 0.78)';
      ctx.fillRect(bx, by, boxW, boxH);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.5, 1.0 / Math.max(1, state.zoom));
      ctx.strokeRect(bx, by, boxW, boxH);
      ctx.fillStyle = color;
      ctx.fillText(label, bx + pad, by + boxH - pad - 1);
    }

    function measurementSpecsForSlice(z) {
      const s = state.stats;
      if (!s) return [];
      const out = [];
      if (state.keySliceMap?.vbr === z) out.push({ cls: 1, key: 'measureVbrDiam', mm: s.vbrDiameterMm, color: '#fb7185', lineKey: 'vbr' });
      if (state.keySliceMap?.stj === z) out.push({ cls: 1, key: 'measureStjDiam', mm: s.stjDiameterMm, color: '#fb7185', lineKey: 'stj' });
      if (state.keySliceMap?.rootMax === z) out.push({ cls: 1, key: 'measureRootMaxDiam', mm: s.rootMaxDiameterMm, color: '#fb7185', lineKey: 'rootMax' });
      if (state.keySliceMap?.leaf === z) out.push({ cls: 2, key: 'measureLeafletDiam', mm: s.leafletMaxDiameterMm, color: '#fde047', lineKey: 'leaf' });
      if (state.keySliceMap?.ascMax === z) out.push({ cls: 3, key: 'measureAscMaxDiam', mm: s.ascMaxDiameterMm, color: '#67e8f9', lineKey: 'ascMax' });
      const uniq = [];
      const seen = new Set();
      for (const x of out) {
        const id = x.key + ':' + x.cls;
        if (seen.has(id)) continue;
        seen.add(id);
        uniq.push(x);
      }
      return uniq;
    }

    function drawCurrentSliceMeasurements(z) {
      const specs = measurementSpecsForSlice(z);
      for (const sp of specs) {
        let line = null;
        const sl = state.stats?.measureLines?.[sp.lineKey];
        if (sl) {
          line = { x1: sl.x1, y1: sl.y1, x2: sl.x2, y2: sl.y2, mm: sp.mm };
        }
        if (!line) {
          line = getDiameterLineForSlice(sp.cls, z);
        }
        if (!line) continue;
        const mm = Number.isFinite(sp.mm) ? sp.mm : line.mm;
        const label = t(sp.key) + ': ' + fmt(mm, 1) + ' mm';
        drawLineLabel(line, sp.color, label);
      }
    }

    function drawCenterlineOverlay(z) {
      const cl = state.centerlineData?.points;
      if (!Array.isArray(cl) || !cl.length) return;
      const ptsNear = [];
      for (const p of cl) {
        const v = p?.voxel;
        if (!Array.isArray(v) || v.length < 3) continue;
        const pz = Number(v[2]);
        if (!Number.isFinite(pz)) continue;
        if (Math.abs(pz - z) > 1.5) continue;
        const px = Number(v[0]);
        const py = Number(v[1]);
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        ptsNear.push({ x: px, y: py, z: pz });
      }
      if (!ptsNear.length) return;
      ptsNear.sort((a, b) => a.z - b.z);
      ctx.strokeStyle = 'rgba(147, 197, 253, 0.92)';
      ctx.lineWidth = Math.max(0.8, 2.0 / Math.max(1, state.zoom));
      ctx.beginPath();
      ctx.moveTo(ptsNear[0].x, ptsNear[0].y);
      for (let i = 1; i < ptsNear.length; i += 1) {
        ctx.lineTo(ptsNear[i].x, ptsNear[i].y);
      }
      ctx.stroke();
      for (const p of ptsNear) {
        ctx.beginPath();
        ctx.fillStyle = 'rgba(191, 219, 254, 0.95)';
        ctx.arc(p.x, p.y, Math.max(1.2, 2.2 / Math.max(1, state.zoom)), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function drawAnnulusPlaneOverlay(z) {
      const pl = state.annulusPlaneData || state.pipelineResult?.landmarks?.annulus_plane || null;
      if (!pl || typeof pl !== 'object') return;
      const ov = pl?.origin_voxel;
      if (!Array.isArray(ov) || ov.length < 3) return;
      const pz = Number(ov[2]);
      if (!Number.isFinite(pz)) return;
      if (Math.abs(pz - z) > 1.1) return;
      const px = Number(ov[0]);
      const py = Number(ov[1]);
      if (!Number.isFinite(px) || !Number.isFinite(py)) return;
      const r = Math.max(8, 16 / Math.max(1, state.zoom));
      ctx.strokeStyle = 'rgba(96, 165, 250, 0.95)';
      ctx.lineWidth = Math.max(0.9, 2.2 / Math.max(1, state.zoom));
      ctx.beginPath();
      ctx.moveTo(px - r, py);
      ctx.lineTo(px + r, py);
      ctx.moveTo(px, py - r);
      ctx.lineTo(px, py + r);
      ctx.stroke();
      const label = state.lang === 'zh' ? 'Annulus plane' : 'Annulus plane';
      ctx.font = '700 ' + Math.max(8, 11 / Math.max(1, state.zoom)) + 'px ui-sans-serif, -apple-system, Segoe UI, Roboto';
      const w = ctx.measureText(label).width + 8 / Math.max(1, state.zoom);
      const h = Math.max(10, 14 / Math.max(1, state.zoom));
      const bx = px + 6 / Math.max(1, state.zoom);
      const by = py - h - 6 / Math.max(1, state.zoom);
      ctx.fillStyle = 'rgba(4, 10, 20, 0.8)';
      ctx.fillRect(bx, by, w, h);
      ctx.strokeStyle = 'rgba(96, 165, 250, 0.95)';
      ctx.lineWidth = Math.max(0.4, 1.0 / Math.max(1, state.zoom));
      ctx.strokeRect(bx, by, w, h);
      ctx.fillStyle = 'rgba(191, 219, 254, 0.98)';
      ctx.fillText(label, bx + 4 / Math.max(1, state.zoom), by + h - 4 / Math.max(1, state.zoom));
    }

    function findCentroidForClassOnSlice(cls, z) {
      if (!state.seg) return null;
      const { x: nx, y: ny } = state.dims;
      let sx = 0, sy = 0, n = 0;
      for (let y = 0; y < ny; y += 1) {
        for (let x = 0; x < nx; x += 1) {
          if (state.seg[indexOf(x, y, z)] === cls) {
            sx += x; sy += y; n += 1;
          }
        }
      }
      if (!n) return null;
      return { x: sx / n, y: sy / n };
    }

    function hookEvents() {
      $('btnReloadCase').addEventListener('click', () => {
        init().catch((e) => alert(String(e)));
      });
      $('btnLoadLatest').addEventListener('click', () => {
        init().catch((e) => alert(String(e)));
      });
      $('btnRunCloud').addEventListener('click', () => {
        const file = $('ctFileInput')?.files?.[0] || null;
        runCloudPipeline(file).catch((e) => {
          $('cloudProgress').textContent = t('cloudFailed') + ': ' + String(e);
          $('resultPreview').textContent = String(e);
        });
      });
      $('btnAutoSeg').addEventListener('click', () => {
        const btn = $('btnAutoSeg');
        btn.disabled = true;
        loadValidatedSegmentation(state.caseData, { appendErrorToPreview: true })
          .catch((e) => {
            markNoValidatedSegmentation(String(e));
          })
          .finally(() => {
            btn.disabled = false;
          });
      });
      $('btnResetView').addEventListener('click', resetView);
      $('btnZoomIn').addEventListener('click', () => { state.zoom = clamp(state.zoom * 1.15, 0.2, 12); render(); });
      $('btnZoomOut').addEventListener('click', () => { state.zoom = clamp(state.zoom / 1.15, 0.2, 12); render(); });
      $('btnPrev').addEventListener('click', () => { state.slice = clamp(state.slice - 1, 0, state.dims.z - 1); $('sliceRange').value = String(state.slice); render(); });
      $('btnNext').addEventListener('click', () => { state.slice = clamp(state.slice + 1, 0, state.dims.z - 1); $('sliceRange').value = String(state.slice); render(); });

      $('btnShowPlan').addEventListener('click', () => renderPlan('pears'));
      $('btnMakePears').addEventListener('click', () => renderPlan('pears'));
      $('btnMakeVsrr').addEventListener('click', () => renderPlan('vsrr'));
      $('btnMakeTavi').addEventListener('click', () => renderPlan('tavi'));
      $('btnRebuild3d').addEventListener('click', () => { rebuild3dModel().catch(() => setRecon3dStatus('recon3dStatusLibFail')); });
      $('btnReset3d').addEventListener('click', reset3dView);
      $('btn3dRoot').addEventListener('click', () => toggle3dClass(1, 'btn3dRoot'));
      $('btn3dLeaf').addEventListener('click', () => toggle3dClass(2, 'btn3dLeaf'));
      $('btn3dAsc').addEventListener('click', () => toggle3dClass(3, 'btn3dAsc'));
      $('btnJumpVbr').addEventListener('click', () => jumpToKeySlice('vbr'));
      $('btnJumpStj').addEventListener('click', () => jumpToKeySlice('stj'));
      $('btnJumpLeaf').addEventListener('click', () => jumpToKeySlice('leaf'));
      $('btnJumpRootMax').addEventListener('click', () => jumpToKeySlice('rootMax'));
      $('btnJumpAscMax').addEventListener('click', () => jumpToKeySlice('ascMax'));
      $('btnJumpBest').addEventListener('click', () => jumpToKeySlice('best'));
      $('btnDispCt').addEventListener('click', () => setMeasureDisplay('ct'));
      $('btnDispPanel').addEventListener('click', () => setMeasureDisplay('panel'));
      $('btnLangModalZh').addEventListener('click', () => chooseLanguage('zh'));
      $('btnLangModalEn').addEventListener('click', () => chooseLanguage('en'));
      $('btnLangSwitch').addEventListener('click', () => chooseLanguage(state.lang === 'zh' ? 'en' : 'zh'));

      $('sliceRange').addEventListener('input', (e) => {
        state.slice = Number(e.target.value) || 0;
        render();
      });
      $('wwRange').addEventListener('input', (e) => { state.ww = Number(e.target.value) || 350; render(); });
      $('wlRange').addEventListener('input', (e) => { state.wl = Number(e.target.value) || 40; render(); });
      $('overlayOpacity').addEventListener('input', (e) => { state.overlayOpacity = Number(e.target.value) || 0; render(); });

      canvas.addEventListener('wheel', (e) => {
        if (!state.vol) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const factor = e.deltaY > 0 ? 0.93 : 1.07;
          state.zoom = clamp(state.zoom * factor, 0.2, 15);
          render();
          return;
        }
        const step = e.deltaY > 0 ? 1 : -1;
        state.slice = clamp(state.slice + step, 0, state.dims.z - 1);
        $('sliceRange').value = String(state.slice);
        render();
      }, { passive: false });

      canvas.addEventListener('mousedown', (e) => {
        state.dragging = true;
        state.dragStartX = e.clientX;
        state.dragStartY = e.clientY;
        canvas.classList.add('dragging');
      });
      window.addEventListener('mouseup', () => {
        state.dragging = false;
        canvas.classList.remove('dragging');
      });
      window.addEventListener('mousemove', (e) => {
        if (!state.dragging) return;
        const dx = e.clientX - state.dragStartX;
        const dy = e.clientY - state.dragStartY;
        state.dragStartX = e.clientX;
        state.dragStartY = e.clientY;
        state.panX += dx;
        state.panY += dy;
        render();
      });

      window.addEventListener('resize', () => {
        setCanvasSize();
        resize3dCanvas();
      });
    }

    async function init() {
      $('resultPreview').textContent = t('initText');
      $('badgeSeg').textContent = t('segRunning');
      const qp = new URLSearchParams(location.search);
      const qJob = (qp.get('job_id') || '').trim();
      const qStudy = (qp.get('study_id') || '').trim();
      if (qJob && qStudy) {
        await loadCaseByJob(qJob, qStudy);
      } else {
        await loadLatestCase();
      }
      setCanvasSize();
      render();
    }

    hookEvents();
    initLanguage();
    initMeasureDisplay();
    setRecon3dStatus('recon3dStatusIdle');
    window.addEventListener('error', (e) => {
      const msg = (e && e.message) ? e.message : 'runtime_error';
      $('resultPreview').textContent = 'RuntimeError: ' + msg;
      $('jobStatus').textContent = t('segFailed');
      $('badgeSeg').textContent = t('segFailed');
    });
    init().catch((e) => {
      $('resultPreview').textContent = String(e);
      $('jobStatus').textContent = t('segFailed');
      $('badgeSeg').textContent = t('segFailed');
    });
  </script>
</body>
</html>`;

function renderDemoHtml(buildVersion: string): string {
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
    body { background: #f0f4f8; color: #0f172a; margin: 0; font-family: "Inter", "IBM Plex Sans", "SF Pro Text", -apple-system, sans-serif; }
    #pre-load { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 16px; }
    .spin { width: 40px; height: 40px; border: 3px solid rgba(15, 23, 42, 0.10); border-top-color: #2563eb; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
  <div id="pre-load">
    <div class="spin"></div>
    <div style="font-size:14px;color:#475569">AorticAI — Loading workstation...</div>
  </div>
  <div id="app"></div>
  <script>window.__AORTIC_BUILD_VERSION__=${JSON.stringify(buildVersion)};</script>
  <script type="module" src="${jsSrc}"></script>
</body>
</html>`;
}

function renderLandingPage(buildVersion: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="AorticAI — AI-powered structural heart surgery planning platform for TAVI, VSRR, and PEARS procedures" />
  <meta name="aortic-build-version" content="${buildVersion}" />
  <title>AorticAI — Structural Heart Planning Platform</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --black: #000000;
      --white: #ffffff;
      --gray-50: #f9fafb;
      --gray-100: #f3f4f6;
      --gray-200: #e5e7eb;
      --gray-300: #d1d5db;
      --gray-400: #9ca3af;
      --gray-500: #6b7280;
      --gray-600: #4b5563;
      --gray-700: #374151;
      --gray-800: #1f2937;
      --gray-900: #111827;
      --brand-500: #3b82f6;
      --brand-600: #2563eb;
      --brand-700: #1d4ed8;
      --gradient-brand: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
      --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.06);
      --shadow-md: 0 4px 8px rgba(0, 0, 0, 0.08);
      --shadow-lg: 0 12px 24px rgba(0, 0, 0, 0.10);
      --shadow-xl: 0 20px 40px rgba(0, 0, 0, 0.12);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--white);
      color: var(--gray-900);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    .container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }

    /* Navigation */
    .nav {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 64px;
      background: rgba(255, 255, 255, 0.9);
      backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--gray-200);
      z-index: 100;
      display: flex;
      align-items: center;
    }
    .nav .container {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
    }
    .nav-brand {
      font-size: 20px;
      font-weight: 700;
      color: var(--gray-900);
      letter-spacing: -0.02em;
    }
    .nav-brand span { color: var(--gray-500); font-weight: 500; margin-left: 8px; }
    .nav-actions { display: flex; gap: 16px; align-items: center; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 40px;
      padding: 0 20px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      transition: all 150ms ease;
      border: none;
    }
    .btn-secondary {
      background: var(--gray-100);
      color: var(--gray-700);
    }
    .btn-secondary:hover { background: var(--gray-200); }
    .btn-primary {
      background: var(--gradient-brand);
      color: var(--white);
      box-shadow: var(--shadow-sm), 0 0 0 1px var(--brand-600);
    }
    .btn-primary:hover {
      box-shadow: var(--shadow-md), 0 0 0 1px var(--brand-700);
      transform: translateY(-1px);
    }

    /* Hero */
    .hero {
      padding-top: 140px;
      padding-bottom: 80px;
      text-align: center;
    }
    .hero-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      background: var(--gray-100);
      border-radius: 100px;
      font-size: 13px;
      font-weight: 600;
      color: var(--gray-600);
      margin-bottom: 24px;
    }
    .hero-badge .dot {
      width: 8px;
      height: 8px;
      background: var(--brand-600);
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .hero h1 {
      font-size: clamp(40px, 8vw, 72px);
      font-weight: 700;
      letter-spacing: -0.03em;
      line-height: 1.1;
      margin-bottom: 24px;
      background: linear-gradient(180deg, var(--gray-900) 0%, var(--gray-600) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .hero p {
      font-size: clamp(18px, 3vw, 22px);
      color: var(--gray-500);
      max-width: 640px;
      margin: 0 auto 40px;
      line-height: 1.7;
    }
    .hero-cta {
      display: flex;
      gap: 16px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .hero-cta .btn { min-width: 160px; }

    /* Features */
    .features { padding: 100px 0; background: var(--gray-50); }
    .section-header { text-align: center; margin-bottom: 64px; }
    .section-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--brand-600);
      text-transform: uppercase;
      letter-spacing: 0.12em;
      margin-bottom: 12px;
    }
    .section-title {
      font-size: clamp(28px, 5vw, 40px);
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--gray-900);
    }
    .feature-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 32px;
    }
    .feature-card {
      background: var(--white);
      border-radius: 16px;
      padding: 32px;
      box-shadow: var(--shadow-sm);
      transition: all 200ms ease;
    }
    .feature-card:hover {
      transform: translateY(-4px);
      box-shadow: var(--shadow-xl);
    }
    .feature-icon {
      width: 48px;
      height: 48px;
      background: var(--gradient-brand);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 20px;
      color: var(--white);
    }
    .feature-icon svg { width: 24px; height: 24px; }
    .feature-title {
      font-size: 18px;
      font-weight: 600;
      color: var(--gray-900);
      margin-bottom: 8px;
    }
    .feature-desc {
      font-size: 15px;
      color: var(--gray-500);
      line-height: 1.6;
    }

    /* Stats */
    .stats { padding: 100px 0; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 40px;
      text-align: center;
    }
    .stat-value {
      font-size: clamp(36px, 6vw, 56px);
      font-weight: 700;
      color: var(--brand-600);
      letter-spacing: -0.03em;
      margin-bottom: 8px;
    }
    .stat-label {
      font-size: 14px;
      color: var(--gray-500);
      font-weight: 500;
    }

    /* Procedures */
    .procedures { padding: 100px 0; background: var(--gray-900); color: var(--white); }
    .procedures .section-title { color: var(--white); }
    .procedure-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 32px;
      margin-top: 48px;
    }
    .procedure-card {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 32px;
      transition: all 200ms ease;
    }
    .procedure-card:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .procedure-name {
      font-size: 32px;
      font-weight: 700;
      margin-bottom: 12px;
      background: var(--gradient-brand);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .procedure-full {
      font-size: 15px;
      color: var(--gray-400);
      margin-bottom: 20px;
    }
    .procedure-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .procedure-list li {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      font-size: 14px;
      color: var(--gray-300);
    }
    .procedure-list li::before {
      content: '✓';
      color: var(--brand-500);
      font-weight: 700;
    }

    /* CTA */
    .cta {
      padding: 120px 0;
      text-align: center;
    }
    .cta h2 {
      font-size: clamp(32px, 6vw, 48px);
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 16px;
    }
    .cta p {
      font-size: 18px;
      color: var(--gray-500);
      margin-bottom: 32px;
    }

    /* Footer */
    .footer {
      padding: 40px 0;
      border-top: 1px solid var(--gray-200);
      text-align: center;
      font-size: 13px;
      color: var(--gray-500);
    }

    /* Responsive */
    @media (max-width: 768px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .procedure-grid { grid-template-columns: 1fr; }
      .nav-actions { gap: 8px; }
      .btn { padding: 0 16px; height: 36px; font-size: 13px; }
    }
  </style>
</head>
<body>
  <!-- Navigation -->
  <nav class="nav">
    <div class="container">
      <div class="nav-brand">AorticAI<span>Structural Heart</span></div>
      <div class="nav-actions">
        <a href="https://heartvalvepro.edu.kg/app" class="btn btn-secondary">Launch App</a>
        <a href="https://heartvalvepro.edu.kg/app" class="btn btn-primary">Request Demo</a>
      </div>
    </div>
  </nav>

  <!-- Hero -->
  <section class="hero">
    <div class="container">
      <div class="hero-badge">
        <span class="dot"></span>
        Now Live: PEARS External Support Planning
      </div>
      <h1>Surgical Precision,<br>Powered by AI</h1>
      <p>
        The first AI-native platform for structural heart surgery planning.
        From CTA to 3D model in minutes — not hours. Trusted by cardiac surgeons
        for TAVI, VSRR, and personalized PEARS procedures.
      </p>
      <div class="hero-cta">
        <a href="https://heartvalvepro.edu.kg/app" class="btn btn-primary">Start Planning Free</a>
        <a href="#features" class="btn btn-secondary">Learn More</a>
      </div>
    </div>
  </section>

  <!-- Features -->
  <section id="features" class="features">
    <div class="container">
      <div class="section-header">
        <div class="section-label">Capabilities</div>
        <h2 class="section-title">Everything you need for structural heart planning</h2>
      </div>
      <div class="feature-grid">
        <div class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>
          <div class="feature-title">Automated Segmentation</div>
          <div class="feature-desc">
            AI-powered aortic root segmentation with sub-millimeter accuracy.
            Annulus, sinuses, STJ, and coronary ostia detected automatically.
          </div>
        </div>
        <div class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 6v6l4 2"/>
            </svg>
          </div>
          <div class="feature-title">Real-time Measurements</div>
          <div class="feature-desc">
            Instant annulus diameter, sinus dimensions, and coronary height
            measurements. All values include uncertainty quantification.
          </div>
        </div>
        <div class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M3 9h18M9 21V9"/>
            </svg>
          </div>
          <div class="feature-title">Multi-Planar Reformation</div>
          <div class="feature-desc">
            Clinical-grade MPR with linked crosshairs, slab MIP, and
            adjustable window/level. Full DICOM toolset in the browser.
          </div>
        </div>
        <div class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
              <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
              <line x1="12" y1="22.08" x2="12" y2="12"/>
            </svg>
          </div>
          <div class="feature-title">3D Model Export</div>
          <div class="feature-desc">
            High-fidelity STL export ready for 3D printing.
            Root, leaflets, annulus ring, and ascending aorta included.
          </div>
        </div>
        <div class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
            </svg>
          </div>
          <div class="feature-title">Data Quality Gates</div>
          <div class="feature-desc">
            Automatic CTA quality assessment against SCCT 2019 and
            manufacturer guidelines. Never size on inadequate data.
          </div>
        </div>
        <div class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
            </svg>
          </div>
          <div class="feature-title">Procedure Planning</div>
          <div class="feature-desc">
            TAVI, VSRR, and PEARS-specific planning workflows with
            procedure-specific recommendations and alerts.
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Stats -->
  <section class="stats">
    <div class="container">
      <div class="stats-grid">
        <div>
          <div class="stat-value">&lt;3 min</div>
          <div class="stat-label">CTA to Model</div>
        </div>
        <div>
          <div class="stat-value">0.3mm</div>
          <div class="stat-label">Mean Accuracy</div>
        </div>
        <div>
          <div class="stat-value">100%</div>
          <div class="stat-label">Browser-Based</div>
        </div>
        <div>
          <div class="stat-value">SCCT</div>
          <div class="stat-label">Guideline Compliant</div>
        </div>
      </div>
    </div>
  </section>

  <!-- Procedures -->
  <section class="procedures">
    <div class="container">
      <div class="section-header">
        <div class="section-label">Procedures</div>
        <h2 class="section-title">Supported Surgical Applications</h2>
      </div>
      <div class="procedure-grid">
        <div class="procedure-card">
          <div class="procedure-name">TAVI</div>
          <div class="procedure-full">Transcatheter Aortic Valve Implantation</div>
          <ul class="procedure-list">
            <li>Annulus sizing (min/max/equivalent diameter)</li>
            <li>Sinus of Valsalva assessment</li>
            <li>Coronary ostia height mapping</li>
            <li>Access route evaluation (iliofemoral)</li>
            <li>Device selection support (Evolut, SAPIEN)</li>
          </ul>
        </div>
        <div class="procedure-card">
          <div class="procedure-name">VSRR</div>
          <div class="procedure-full">Valve-Sparing Root Replacement</div>
          <ul class="procedure-list">
            <li>Multi-phase cardiac analysis</li>
            <li>STJ and sinus geometry quantification</li>
            <li>Commissure symmetry assessment</li>
            <li>Reimplantation vs remodeling planning</li>
            <li>Grayscale and color Doppler integration</li>
          </ul>
        </div>
        <div class="procedure-card">
          <div class="procedure-name">PEARS</div>
          <div class="procedure-full">Personalized External Aortic Root Support</div>
          <ul class="procedure-list">
            <li>Patient-specific ExoVasc design</li>
            <li>0.75mm slice thickness validation</li>
            <li>Diastolic phase gating (60-80% R-R)</li>
            <li>External sleeve geometry optimization</li>
            <li>Manufacturing-ready STL output</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <!-- CTA -->
  <section class="cta">
    <div class="container">
      <h2>Ready to transform your workflow?</h2>
      <p>Join cardiac surgeons using AorticAI for precision planning.</p>
      <a href="https://heartvalvepro.edu.kg/app" class="btn btn-primary" style="min-width: 200px; height: 48px; font-size: 16px;">
        Launch AorticAI
      </a>
    </div>
  </section>

  <!-- Footer -->
  <footer class="footer">
    <div class="container">
      <p>&copy; 2026 AorticAI. For research use only. Not intended for clinical diagnosis.</p>
    </div>
  </footer>
</body>
</html>`;
}

function renderLegacyDemoHtml(buildVersion: string): string {
  return DEMO_HTML.replace(
    /<head>/,
    `<head>\n  <meta name="aortic-build-version" content="${buildVersion}" />`
  );
}

export const __testables = {
  deriveCaseResultPayloads,
  evaluateCaseDisplayReadiness,
  normalizeCaseResultPayloads,
  summarizePlanningSection,
};
