import type { PipelineRun } from "./contracts";

function parseRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

export function resolvePipelineRun(
  storedRun: Record<string, unknown> | null,
  inferredRun: Record<string, unknown> | null,
  buildVersion: string,
): PipelineRun {
  const stored = parseRecord(storedRun);
  if (Object.keys(stored).length) {
    return {
      source_mode: "stored",
      inference_mode: String(stored.inference_mode || stored.mode || "stored"),
      inferred: false,
      provider_target: typeof stored.provider_target === "string" ? stored.provider_target : null,
      provider_runtime: typeof stored.provider_runtime === "string" ? stored.provider_runtime : null,
      pipeline_version: typeof stored.pipeline_version === "string" ? stored.pipeline_version : null,
      build_version: typeof stored.build_version === "string" ? stored.build_version : buildVersion,
      provider_job_id: typeof stored.provider_job_id === "string" ? stored.provider_job_id : null,
      status: typeof stored.status === "string" ? stored.status : null,
    };
  }
  const inferred = parseRecord(inferredRun);
  if (Object.keys(inferred).length) {
    return {
      source_mode: inferred.source_mode === "legacy" ? "legacy" : "inferred",
      inference_mode: typeof inferred.inference_mode === "string" ? inferred.inference_mode : "historical_inferred",
      inferred: true,
      provider_target: typeof inferred.provider_target === "string" ? inferred.provider_target : null,
      provider_runtime: typeof inferred.provider_runtime === "string" ? inferred.provider_runtime : null,
      pipeline_version: typeof inferred.pipeline_version === "string" ? inferred.pipeline_version : null,
      build_version: typeof inferred.build_version === "string" ? inferred.build_version : buildVersion,
      provider_job_id: typeof inferred.provider_job_id === "string" ? inferred.provider_job_id : null,
      status: typeof inferred.status === "string" ? inferred.status : "historical_inferred",
    };
  }
  return {
    source_mode: "stored",
    inference_mode: "default_case_bundle",
    inferred: false,
    provider_target: null,
    provider_runtime: "default_case_bundle",
    pipeline_version: "showcase-case-v1",
    build_version: buildVersion,
    provider_job_id: null,
    status: "succeeded",
  };
}
