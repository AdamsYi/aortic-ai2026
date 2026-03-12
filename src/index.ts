interface Env {
  DB: D1Database;
  R2_RAW: R2Bucket;
  R2_MASK: R2Bucket;
  SEG_QUEUE: Queue;
  UPLOAD_URL_TTL_SECONDS: string;
  INFERENCE_MODE?: string;
  INFERENCE_WEBHOOK_URL?: string;
  INFERENCE_WEBHOOK_TIMEOUT_MS?: string;
  INFERENCE_MAX_INPUT_BYTES?: string;
  INFERENCE_CALLBACK_SECRET?: string;
  API_BASE_URL?: string;
  BUILD_VERSION?: string;
}

type JobStatus = "queued" | "running" | "succeeded" | "failed";

type InferenceMode = "mock" | "webhook";

interface SegQueuePayload {
  job_id: string;
  study_id: string;
  image_key: string;
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
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-callback-secret"
};

const FALLBACK_BUILD_VERSION = "20260312-1800";

function getBuildVersion(env?: Env): string {
  const raw = String(env?.BUILD_VERSION || "").trim();
  return raw || FALLBACK_BUILD_VERSION;
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

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: jsonHeaders
        });
      }

      if (request.method === "GET" && path === "/health") {
        return json({
          ok: true,
          service: "aortic-ai-api",
          mode: getInferenceMode(env),
          date: new Date().toISOString(),
          build_version: getBuildVersion(env)
        });
      }

      if (request.method === "GET" && path === "/version") {
        return json({
          ok: true,
          build_version: getBuildVersion(env)
        });
      }

      if (request.method === "GET" && path === "/favicon.ico") {
        return new Response(null, {
          status: 204,
          headers: jsonHeaders
        });
      }

      if (request.method === "GET" && path === `/assets/style.${getBuildVersion(env)}.css`) {
        return textResponse(getDemoStyleCss(), "text/css; charset=utf-8");
      }

      if (request.method === "GET" && path === `/assets/app.${getBuildVersion(env)}.js`) {
        return textResponse(getDemoAppJs(getBuildVersion(env)), "text/javascript; charset=utf-8");
      }

      if (request.method === "GET" && path === "/demo") {
        return html(renderDemoHtml(getBuildVersion(env)));
      }

      if (request.method === "GET" && path === "/demo/latest-case") {
        return getLatestDemoCase(env);
      }

      if (request.method === "POST" && path === "/upload-url") {
        const payload = await readJson(request);
        return createUploadUrl(payload, env);
      }

      if (request.method === "PUT" && path.startsWith("/upload/")) {
        const sessionId = path.split("/").pop();
        return consumeUploadSession(request, env, sessionId ?? "");
      }

      if (request.method === "POST" && path === "/jobs") {
        const payload = await readJson(request);
        return createJob(payload, env);
      }

      if (request.method === "GET" && path.startsWith("/studies/") && path.endsWith("/raw")) {
        const parts = path.split("/");
        return streamStudyRaw(parts[2] ?? "", env);
      }

      if (request.method === "GET" && path.startsWith("/studies/") && path.endsWith("/meta")) {
        const parts = path.split("/");
        return getStudyMeta(parts[2] ?? "", env);
      }

      if (request.method === "GET" && path.startsWith("/jobs/") && path.includes("/artifacts/")) {
        const parts = path.split("/");
        return streamJobArtifact(parts[2] ?? "", parts[4] ?? "", env);
      }

      if (request.method === "GET" && path.startsWith("/jobs/")) {
        const jobId = path.split("/").pop();
        return getJob(jobId ?? "", env);
      }

      if (request.method === "POST" && path === "/callbacks/inference") {
        const payload = (await readJson(request)) as InferenceCallbackPayload;
        return handleInferenceCallback(request, payload, env);
      }

      if (request.method === "POST" && path === "/providers/mock-inference") {
        const payload = await readJson(request);
        return handleMockInferenceProvider(payload);
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({ error: "internal_error", message: asError(error).message }, 500);
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

  if (!request.body) return json({ error: "missing_body" }, 400);

  const putResult = await env.R2_RAW.put(row.object_key, request.body, {
    httpMetadata: {
      contentType: request.headers.get("content-type") || "application/octet-stream"
    }
  });

  await env.DB.prepare(`UPDATE upload_sessions SET consumed = 1 WHERE id = ?1`).bind(sessionId).run();
  await env.DB.prepare(`UPDATE studies SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1`).bind(row.study_id).run();

  return json({
    ok: true,
    study_id: row.study_id,
    etag: putResult?.etag ?? null,
    version: putResult?.version ?? null
  });
}

async function createJob(payload: any, env: Env): Promise<Response> {
  const studyId = stringOr(payload.study_id, "").trim();
  if (!studyId) return json({ error: "missing_study_id" }, 400);

  const study = await env.DB.prepare(`SELECT id, image_key FROM studies WHERE id = ?1`)
    .bind(studyId)
    .first<{ id: string; image_key: string }>();

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

  const queuePayload: SegQueuePayload = {
    job_id: jobId,
    study_id: studyId,
    image_key: study.image_key,
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

  return json({
    ...job,
    artifacts: (artifacts.results as Array<Record<string, unknown>>).map((row) => toPublicArtifactRecord(row)),
    metrics: metrics.results
  });
}

async function getLatestDemoCase(env: Env): Promise<Response> {
  const job = await env.DB.prepare(
    `SELECT
       j.id,
       j.study_id,
       j.status,
       j.model_tag,
       j.created_at,
       j.started_at,
       j.finished_at,
       EXISTS(
         SELECT 1 FROM artifacts a
         WHERE a.job_id = j.id AND a.artifact_type IN ('segmentation_mask_nifti', 'mask_output', 'mask_multiclass')
       ) AS has_seg,
       EXISTS(
         SELECT 1 FROM artifacts a
         WHERE a.job_id = j.id AND a.artifact_type = 'measurements_json'
       ) AS has_measurements,
       EXISTS(
         SELECT 1 FROM artifacts a
         WHERE a.job_id = j.id AND a.artifact_type = 'aortic_root_stl'
       ) AS has_stl
     FROM jobs j
     WHERE j.status = 'succeeded'
     ORDER BY
       CASE
         WHEN
           EXISTS(
             SELECT 1 FROM artifacts a
             WHERE a.job_id = j.id AND a.artifact_type IN ('segmentation_mask_nifti', 'mask_output', 'mask_multiclass')
           )
           AND EXISTS(
             SELECT 1 FROM artifacts a
             WHERE a.job_id = j.id AND a.artifact_type = 'measurements_json'
           )
         THEN 0
         ELSE 1
       END,
       CASE
         WHEN EXISTS(
           SELECT 1 FROM artifacts a
           WHERE a.job_id = j.id AND a.artifact_type IN ('segmentation_mask_nifti', 'mask_output', 'mask_multiclass')
         )
         THEN 0
         ELSE 1
       END,
       CASE
         WHEN j.study_id LIKE 'hqcta-cardio-%' THEN 0
         WHEN j.study_id LIKE 'openct-%' OR j.study_id LIKE 'colab-openct-%' THEN 1
         ELSE 2
       END,
       j.created_at DESC
     LIMIT 1`
  ).first<Record<string, unknown>>();

  if (!job) {
    return json({ error: "no_succeeded_case_yet" }, 404);
  }

  const jobId = String(job.id);
  const studyId = String(job.study_id);
  const jobStudy = await env.DB.prepare(`SELECT id, image_key, source_dataset, phase FROM studies WHERE id = ?1`)
    .bind(studyId)
    .first<{ id: string; image_key: string; source_dataset: string | null; phase: string | null }>();
  const preferredStudy = jobStudy;
  const rawStudyId = preferredStudy?.id || studyId;

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

  let imageBytes: number | null = null;
  if (preferredStudy?.image_key) {
    const head = await env.R2_RAW.head(preferredStudy.image_key);
    imageBytes = head?.size ?? null;
  }

  const resultArtifact = (artifacts.results as Array<Record<string, unknown>>).find(
    (a) => String(a.artifact_type || "") === "result_json"
  );
  const resultObjectKey = typeof resultArtifact?.object_key === "string" ? resultArtifact.object_key : null;
  let resultPayload: Record<string, unknown> | null = null;
  if (resultObjectKey) {
    const resultObj = await env.R2_MASK.get(resultObjectKey);
    if (resultObj) {
      const text = await resultObj.text();
      resultPayload = safeJsonObject(text);
    }
  }

  const queueWaitSeconds = secondsBetween(job.created_at, job.started_at);
  const processSeconds = secondsBetween(job.started_at, job.finished_at);
  const totalSeconds = secondsBetween(job.created_at, job.finished_at);
  const labelKeys = extractLabelKeys(resultPayload);
  const clinicalTargets = buildClinicalTargets(labelKeys);

  return json({
    ...job,
    artifacts: (artifacts.results as Array<Record<string, unknown>>).map((row) => toPublicArtifactRecord(row)),
    metrics: metrics.results,
    scalars: {
      image_bytes: imageBytes,
      queue_wait_seconds: queueWaitSeconds,
      process_seconds: processSeconds,
      total_seconds: totalSeconds
    },
    links: {
      raw_ct: `/studies/${rawStudyId}/raw`,
      mask_multiclass: `/jobs/${jobId}/artifacts/mask_output`,
      segmentation_mask_nifti: `/jobs/${jobId}/artifacts/segmentation_mask_nifti`,
      result_json: `/jobs/${jobId}/artifacts/result_json`,
      provider_receipt: `/jobs/${jobId}/artifacts/provider_receipt`,
      measurements_json: `/jobs/${jobId}/artifacts/measurements_json`,
      planning_report_pdf: `/jobs/${jobId}/artifacts/planning_report_pdf`,
      aortic_root_stl: `/jobs/${jobId}/artifacts/aortic_root_stl`,
      centerline_json: `/jobs/${jobId}/artifacts/centerline_json`,
      annulus_plane_json: `/jobs/${jobId}/artifacts/annulus_plane_json`,
      job_api: `/jobs/${jobId}`
    },
    study_meta: {
      raw_study_id: rawStudyId,
      source_dataset: preferredStudy?.source_dataset || null,
      phase: preferredStudy?.phase || null
    },
    label_keys: labelKeys,
    clinical_targets: clinicalTargets
  });
}

async function streamStudyRaw(studyId: string, env: Env): Promise<Response> {
  if (!studyId) return json({ error: "missing_study_id" }, 400);

  const study = await env.DB.prepare(`SELECT image_key FROM studies WHERE id = ?1`)
    .bind(studyId)
    .first<{ image_key: string }>();

  if (!study?.image_key) return json({ error: "study_not_found" }, 404);

  const obj = await env.R2_RAW.get(study.image_key);
  if (!obj?.body) return json({ error: "raw_object_not_found" }, 404);

  const filename = study.image_key.split("/").pop() || `${studyId}.bin`;
  const headers = new Headers(jsonHeaders);
  headers.set("content-type", obj.httpMetadata?.contentType || "application/octet-stream");
  headers.set("content-disposition", `attachment; filename="${filename}"`);
  headers.set("content-length", String(obj.size));

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
  return json(study);
}

async function streamJobArtifact(jobId: string, artifactType: string, env: Env): Promise<Response> {
  if (!jobId) return json({ error: "missing_job_id" }, 400);
  if (!artifactType) return json({ error: "missing_artifact_type" }, 400);

  const artifact = await env.DB.prepare(
    `SELECT object_key FROM artifacts WHERE job_id = ?1 AND artifact_type = ?2 ORDER BY created_at DESC LIMIT 1`
  )
    .bind(jobId, artifactType)
    .first<{ object_key: string }>();

  if (!artifact?.object_key) return json({ error: "artifact_not_found" }, 404);

  const obj = await env.R2_MASK.get(artifact.object_key);
  if (!obj?.body) return json({ error: "artifact_object_not_found" }, 404);

  const filename = artifact.object_key.split("/").pop() || `${jobId}-${artifactType}.bin`;
  const headers = new Headers(jsonHeaders);
  headers.set("content-type", obj.httpMetadata?.contentType || "application/octet-stream");
  headers.set("content-disposition", `attachment; filename="${filename}"`);
  headers.set("content-length", String(obj.size));

  return new Response(obj.body, { status: 200, headers });
}

async function handleInferenceCallback(
  request: Request,
  payload: InferenceCallbackPayload,
  env: Env
): Promise<Response> {
  const expectedSecret = (env.INFERENCE_CALLBACK_SECRET || "").trim();
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
  if (status !== "succeeded" && status !== "failed") {
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

  try {
    const src = await env.R2_RAW.get(payload.image_key);
    if (!src) throw new Error("source_image_not_found");

    const mode = getInferenceMode(env);
    if (mode === "webhook") {
      await dispatchToInferenceWebhook(env, payload, src);
      return;
    }

    await runMockInference(env, payload);
  } catch (error) {
    await markJobFailed(env, payload.job_id, asError(error).message);
  }
}

async function dispatchToInferenceWebhook(
  env: Env,
  payload: SegQueuePayload,
  src: R2ObjectBody
): Promise<void> {
  const webhookUrl = (env.INFERENCE_WEBHOOK_URL || "").trim();
  if (!webhookUrl) {
    throw new Error("inference_webhook_url_missing");
  }

  const maxInputBytes = parsePositiveInt(env.INFERENCE_MAX_INPUT_BYTES, 50 * 1024 * 1024);
  const timeoutMs = parsePositiveInt(env.INFERENCE_WEBHOOK_TIMEOUT_MS, 25000);

  const inputBuffer = await src.arrayBuffer();
  if (inputBuffer.byteLength > maxInputBytes) {
    throw new Error(`input_too_large:${inputBuffer.byteLength}`);
  }

  const callbackSecret = (env.INFERENCE_CALLBACK_SECRET || "").trim();
  const callbackUrl = buildCallbackUrl(env);

  const reqBody = {
    job_id: payload.job_id,
    study_id: payload.study_id,
    image_key: payload.image_key,
    requested_at: payload.requested_at,
    input_content_type: src.httpMetadata?.contentType || "application/octet-stream",
    input_base64: arrayBufferToBase64(inputBuffer),
    callback: {
      url: callbackUrl,
      header: callbackSecret ? "x-callback-secret" : null,
      secret: callbackSecret || null
    }
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

  if (hasResultJson) {
    const safeResultJson = sanitizePublicResultJson(payload.result_json as Record<string, unknown>) || {};
    await writeJsonArtifact(env, jobId, studyId, "result_json", "result.json", {
      ...safeResultJson,
      _source: source,
      _provider_job_id: payload.provider_job_id || null
    });
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

  await env.DB.prepare(`UPDATE jobs SET status = 'succeeded', finished_at = ?2, error_message = NULL WHERE id = ?1`)
    .bind(jobId, new Date().toISOString())
    .run();
}

async function markJobFailed(env: Env, jobId: string, message: string): Promise<void> {
  await env.DB.prepare(`UPDATE jobs SET status = 'failed', error_message = ?2, finished_at = ?3 WHERE id = ?1`)
    .bind(jobId, message, new Date().toISOString())
    .run();
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
      bodyBounds: null,
      recon3d: {
        lib: null,
        renderer: null,
        scene: null,
        camera: null,
        group: null,
        canvas: null,
        initialized: false,
        dragging: false,
        dragX: 0,
        dragY: 0,
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
        recon3dHint: '拖拽旋转，滚轮缩放，双击重置；使用当前真实分割重建。',
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
        recon3dHint: 'Drag to rotate, wheel to zoom, double-click to reset. Built from current validated segmentation.',
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
      applyLocale('zh', false);
      $('langModal').classList.remove('hidden');
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
      const centerlineUrl = findArtifactLink(data, ['centerline_json']);
      const annulusUrl = findArtifactLink(data, ['annulus_plane_json']);
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
      $('receiptLink').href = absLink(data.links?.provider_receipt);
      $('jobApiLink').href = absLink(data.links?.job_api);
      setReadinessChip('pearsState', data.clinical_targets?.pears?.readiness?.stage || 'partial-ready');
      setReadinessChip('vsrrState', data.clinical_targets?.vsrr?.readiness?.stage || 'partial-ready');
      setReadinessChip('taviState', data.clinical_targets?.tavi?.readiness?.stage || 'partial-ready');
      renderEvidenceLinks(data.clinical_targets?.evidence_refs);
      renderPipelineMetrics(data.metrics);
    }

    function findArtifactLink(data, preferredTypes) {
      const list = Array.isArray(data?.artifacts) ? data.artifacts : [];
      for (const type of preferredTypes) {
        const hit = list.find((a) => String(a?.artifact_type || '') === type);
        if (hit) return absLink('/jobs/' + encodeURIComponent(data.id) + '/artifacts/' + encodeURIComponent(type));
      }
      if (list.length > 0) return null;
      const fromLinks = preferredTypes
        .map((type) => data?.links?.[type])
        .find((x) => typeof x === 'string' && x.trim());
      return fromLinks ? absLink(fromLinks) : null;
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

      const links = {
        raw_ct: '/studies/' + studyId + '/raw',
        segmentation_mask_nifti: '/jobs/' + jobId + '/artifacts/segmentation_mask_nifti',
        result_json: '/jobs/' + jobId + '/artifacts/result_json',
        provider_receipt: '/jobs/' + jobId + '/artifacts/provider_receipt',
        measurements_json: '/jobs/' + jobId + '/artifacts/measurements_json',
        planning_report_pdf: '/jobs/' + jobId + '/artifacts/planning_report_pdf',
        aortic_root_stl: '/jobs/' + jobId + '/artifacts/aortic_root_stl',
        centerline_json: '/jobs/' + jobId + '/artifacts/centerline_json',
        annulus_plane_json: '/jobs/' + jobId + '/artifacts/annulus_plane_json',
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

    function resize3dCanvas() {
      const r3 = state.recon3d;
      if (!r3.initialized || !r3.canvas || !r3.ctx) return;
      const ratio = window.devicePixelRatio || 1;
      const rect = r3.canvas.getBoundingClientRect();
      const w = Math.max(2, Math.floor(rect.width * ratio));
      const h = Math.max(2, Math.floor(rect.height * ratio));
      r3.canvas.width = w;
      r3.canvas.height = h;
      r3.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      render3dCanvas();
    }

    function init3dViewer() {
      const r3 = state.recon3d;
      if (r3.initialized) return true;
      const canvas3d = $('viewer3d');
      if (!canvas3d) return false;
      const ctx3d = canvas3d.getContext('2d');
      if (!ctx3d) return false;
      r3.canvas = canvas3d;
      r3.ctx = ctx3d;
      r3.points = [];
      r3.rotX = -0.45;
      r3.rotY = 0.35;
      r3.scale = 1.0;
      r3.distance = 260;
      r3.initialized = true;

      canvas3d.addEventListener('mousedown', (e) => {
        r3.dragging = true;
        r3.dragX = e.clientX;
        r3.dragY = e.clientY;
        canvas3d.classList.add('dragging');
      });
      window.addEventListener('mouseup', () => {
        r3.dragging = false;
        canvas3d.classList.remove('dragging');
      });
      window.addEventListener('mousemove', (e) => {
        if (!r3.dragging) return;
        const dx = e.clientX - r3.dragX;
        const dy = e.clientY - r3.dragY;
        r3.dragX = e.clientX;
        r3.dragY = e.clientY;
        r3.rotY += dx * 0.008;
        r3.rotX += dy * 0.008;
        render3dCanvas();
      });
      canvas3d.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.93 : 1.07;
        r3.scale = clamp(r3.scale * factor, 0.35, 5.0);
        render3dCanvas();
      }, { passive: false });
      canvas3d.addEventListener('dblclick', () => reset3dView());

      resize3dCanvas();
      return true;
    }

    function clear3dGroup() {
      state.recon3d.points = [];
    }

    function getUnionBounds() {
      const nx = state.dims.x || 1;
      const ny = state.dims.y || 1;
      const nz = state.dims.z || 1;
      const fallback = { minX: 0, minY: 0, minZ: 0, maxX: nx - 1, maxY: ny - 1, maxZ: nz - 1 };
      const bounds = state.stats?.classBounds;
      if (!bounds) return fallback;
      let minX = nx, minY = ny, minZ = nz;
      let maxX = -1, maxY = -1, maxZ = -1;
      for (const cls of [1, 2, 3]) {
        const b = bounds[cls];
        if (!b) continue;
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
        if (b.minZ < minZ) minZ = b.minZ;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxY > maxY) maxY = b.maxY;
        if (b.maxZ > maxZ) maxZ = b.maxZ;
      }
      if (maxX < minX || maxY < minY || maxZ < minZ) return fallback;
      return { minX, minY, minZ, maxX, maxY, maxZ };
    }

    function rotatePoint(px, py, pz, rx, ry) {
      const cosY = Math.cos(ry);
      const sinY = Math.sin(ry);
      const x1 = px * cosY + pz * sinY;
      const z1 = -px * sinY + pz * cosY;
      const cosX = Math.cos(rx);
      const sinX = Math.sin(rx);
      const y2 = py * cosX - z1 * sinX;
      const z2 = py * sinX + z1 * cosX;
      return [x1, y2, z2];
    }

    function render3dCanvas() {
      const r3 = state.recon3d;
      if (!r3.initialized || !r3.canvas || !r3.ctx) return;
      const ctx = r3.ctx;
      const ratio = window.devicePixelRatio || 1;
      const rect = r3.canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);
      if (!Array.isArray(r3.points) || r3.points.length === 0) return;
      const cx = w / 2;
      const cy = h / 2;

      const transformed = [];
      for (const p of r3.points) {
        const [x, y, z] = rotatePoint(p.x, p.y, p.z, r3.rotX, r3.rotY);
        const depth = z + r3.distance;
        if (depth <= 6) continue;
        const proj = (90 * r3.scale) / depth;
        transformed.push({
          sx: cx + x * proj,
          sy: cy + y * proj,
          d: depth,
          c: p.c,
          r: Math.max(0.6, p.r * proj * 0.32)
        });
      }
      transformed.sort((a, b) => b.d - a.d);
      for (const p of transformed) {
        ctx.beginPath();
        ctx.fillStyle = p.c;
        ctx.globalAlpha = 0.78;
        ctx.arc(p.sx, p.sy, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function buildClassBoundaryPoints(cls) {
      if (!state.seg) return [];
      const seg = state.seg;
      const nx = state.dims.x;
      const ny = state.dims.y;
      const nz = state.dims.z;
      const xy = nx * ny;
      const b = state.stats?.classBounds?.[cls];
      if (!b) return [];
      const ub = getUnionBounds();
      const cx = (ub.minX + ub.maxX + 1) / 2;
      const cy = (ub.minY + ub.maxY + 1) / 2;
      const cz = (ub.minZ + ub.maxZ + 1) / 2;
      const dx = state.vox.dx || 1;
      const dy = state.vox.dy || 1;
      const dz = state.vox.dz || 1;
      const vox = state.stats?.byClass?.[cls]?.vox || 0;
      const stride = vox > 120000 ? 3 : (vox > 60000 ? 2 : 1);
      const maxPts = cls === 2 ? 24000 : 42000;
      const pts = [];

      const minX = Math.max(0, b.minX - 1);
      const minY = Math.max(0, b.minY - 1);
      const minZ = Math.max(0, b.minZ - 1);
      const maxX = Math.min(nx - 1, b.maxX + 1);
      const maxY = Math.min(ny - 1, b.maxY + 1);
      const maxZ = Math.min(nz - 1, b.maxZ + 1);

      for (let z = minZ; z <= maxZ; z += stride) {
        const zOff = z * xy;
        for (let y = minY; y <= maxY; y += stride) {
          const row = zOff + y * nx;
          for (let x = minX; x <= maxX; x += stride) {
            const i = row + x;
            if (seg[i] !== cls) continue;
            const exposed = (
              x === 0 || seg[i - 1] !== cls ||
              x === nx - 1 || seg[i + 1] !== cls ||
              y === 0 || seg[i - nx] !== cls ||
              y === ny - 1 || seg[i + nx] !== cls ||
              z === 0 || seg[i - xy] !== cls ||
              z === nz - 1 || seg[i + xy] !== cls
            );
            if (!exposed) continue;
            if (pts.length >= maxPts && ((x + y + z) % 2 === 1)) continue;
            pts.push({
              x: (x + 0.5 - cx) * dx,
              y: -(y + 0.5 - cy) * dy,
              z: (z + 0.5 - cz) * dz,
            });
          }
        }
      }
      return pts;
    }

    async function rebuild3dModel() {
      if (!state.segReady || !state.seg) {
        setRecon3dStatus('recon3dStatusNoSeg');
        return;
      }
      if (!init3dViewer()) {
        setRecon3dStatus('recon3dStatusLibFail');
        return;
      }
      setRecon3dStatus('recon3dStatusBuilding');
      clear3dGroup();
      const r3 = state.recon3d;
      const specs = [
        { cls: 1, color: '#ef4444', r: 1.05 },
        { cls: 2, color: '#facc15', r: 1.35 },
        { cls: 3, color: '#22d3ee', r: 1.00 },
      ];
      const all = [];
      for (const sp of specs) {
        if (!r3.classVisible[sp.cls]) continue;
        const pts = buildClassBoundaryPoints(sp.cls);
        for (const p of pts) {
          all.push({ ...p, c: sp.color, r: sp.r });
        }
      }
      r3.points = all;
      r3.triangleCount = all.length;
      render3dCanvas();
      setRecon3dStatus('recon3dStatusReady', all.length + ' pts');
    }

    function reset3dView() {
      const r3 = state.recon3d;
      if (!r3.initialized) return;
      r3.rotX = -0.45;
      r3.rotY = 0.35;
      r3.scale = 1.0;
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
      const hasBackend = (k) => Number.isFinite(Number(backend?.[k]));
      const src = (k) => hasBackend(k) ? 'backend(centerline-orthogonal)' : 'ui(fallback)';
      const calcSrc = Number.isFinite(Number(backendCalc?.calc_volume_ml))
        ? 'backend(HU>130)'
        : 'ui/fallback';

      const rows = [
        [L('瓣环直径', 'Annulus Diameter'), fmt(s.vbrDiameterMm), 'mm', src('annulus_diameter_mm')],
        [L('瓣环面积', 'Annulus Area'), fmt(s.vbrAreaMm2), 'mm2', src('annulus_area_mm2')],
        [L('瓣环周长', 'Annulus Perimeter'), fmt(s.vbrPerimeterMm), 'mm', src('annulus_perimeter_mm')],
        [L('窦部直径', 'Sinus of Valsalva Diameter'), fmt(s.rootMaxDiameterMm), 'mm', src('sinus_of_valsalva_diameter_mm')],
        [L('STJ 直径', 'STJ Diameter'), fmt(s.stjDiameterMm), 'mm', src('stj_diameter_mm')],
        [L('升主动脉直径', 'Ascending Aorta Diameter'), fmt(s.ascMaxDiameterMm), 'mm', src('ascending_aorta_diameter_mm')],
        [L('LVOT 直径', 'LVOT Diameter'), fmt(s.lvotDiameterMm), 'mm', src('lvot_diameter_mm')],
        [L('左冠开口高度', 'Coronary Height Left'), fmt(s.taviCoronaryHeightLeftMm), 'mm', src('coronary_height_left_mm')],
        [L('右冠开口高度', 'Coronary Height Right'), fmt(s.taviCoronaryHeightRightMm), 'mm', src('coronary_height_right_mm')],
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

function getDemoStyleCss(): string {
  const match = DEMO_HTML.match(/<style>([\s\S]*?)<\/style>/);
  return match?.[1]?.trim() || "";
}

function getDemoAppJs(buildVersion: string): string {
  const match = DEMO_HTML.match(/<script type="module">([\s\S]*?)<\/script>/);
  const body = match?.[1]?.trim() || "";
  const bootstrap = `
const AORTIC_BUILD_VERSION = ${JSON.stringify(buildVersion)};
async function ensureFreshBuild() {
  try {
    const resp = await fetch('/version', { cache: 'no-store' });
    if (!resp.ok) return;
    const info = await resp.json();
    const remote = String(info?.build_version || '');
    if (!remote || remote === AORTIC_BUILD_VERSION) return;
    const key = 'aortic-build-refresh';
    const last = sessionStorage.getItem(key) || '';
    if (last === remote) return;
    sessionStorage.setItem(key, remote);
    const next = new URL(window.location.href);
    next.searchParams.set('v', remote);
    window.location.replace(next.toString());
    await new Promise(() => {});
  } catch {}
}
await ensureFreshBuild();
`;
  return `${bootstrap}\n${body}\n`;
}

function renderDemoHtml(buildVersion: string): string {
  const cssHref = `/assets/style.${buildVersion}.css?v=${buildVersion}`;
  const jsSrc = `/assets/app.${buildVersion}.js?v=${buildVersion}`;
  return DEMO_HTML
    .replace(
      /<style>[\s\S]*?<\/style>/,
      `<meta name="aortic-build-version" content="${buildVersion}" />\n  <link rel="stylesheet" href="${cssHref}" />`
    )
    .replace(
      /<script type="module">[\s\S]*?<\/script>/,
      `<script>window.__AORTIC_BUILD_VERSION__=${JSON.stringify(buildVersion)};</script>\n  <script type="module" src="${jsSrc}"></script>`
    );
}
