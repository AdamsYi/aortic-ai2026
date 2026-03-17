import { resolvePipelineRun } from "./pipelineRun";

export function buildLegacyPipelineRunPayload(
  storedRun: Record<string, unknown> | null,
  inferredRun: Record<string, unknown> | null,
  buildVersion: string,
) {
  return resolvePipelineRun(storedRun, inferredRun, buildVersion);
}
