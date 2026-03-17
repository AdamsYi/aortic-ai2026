import test from "node:test";
import assert from "node:assert/strict";
import { resolvePipelineRun } from "../services/api/pipelineRun";

test("resolvePipelineRun returns stored run when present", () => {
  const run = resolvePipelineRun(
    {
      source_mode: "stored",
      inference_mode: "webhook",
      provider_target: "provider-a",
      provider_runtime: "linux-gpu",
      pipeline_version: "v1",
      build_version: "b1",
      inferred: false,
    },
    null,
    "ignored"
  );

  assert.equal(run.source_mode, "stored");
  assert.equal(run.inference_mode, "webhook");
  assert.equal(run.provider_runtime, "linux-gpu");
  assert.equal(run.build_version, "b1");
});

test("resolvePipelineRun returns inferred run when stored run missing", () => {
  const run = resolvePipelineRun(
    null,
    {
      source_mode: "inferred",
      inference_mode: "historical_inferred",
      provider_target: null,
      provider_runtime: "historical_bundle",
      pipeline_version: "legacy-v2",
      build_version: "legacy-b",
      inferred: true,
    },
    "default-build"
  );

  assert.equal(run.source_mode, "inferred");
  assert.equal(run.inferred, true);
  assert.equal(run.pipeline_version, "legacy-v2");
});

test("resolvePipelineRun falls back to bundle runtime when no legacy record exists", () => {
  const run = resolvePipelineRun(null, null, "bundle-build");
  assert.equal(run.source_mode, "stored");
  assert.equal(run.inference_mode, "default_case_bundle");
  assert.equal(run.provider_runtime, "default_case_bundle");
  assert.equal(run.build_version, "bundle-build");
});
