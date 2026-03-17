import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DEFAULT_CASE_BUNDLE } from "../src/generated/defaultCaseBundle";
import {
  buildDefaultCaseSummary,
  buildDefaultCaseWorkstationPayload,
  createDefaultCaseStoreFromBundle,
} from "../services/api/defaultCaseHandlers";
import { WORKSTATION_BUILD_VERSION } from "../src/generated/workstationAssets";

test("default showcase bundle can build summary and workstation payload under 15s", async () => {
  const store = createDefaultCaseStoreFromBundle(DEFAULT_CASE_BUNDLE);
  const started = performance.now();
  const summary = await buildDefaultCaseSummary(store, WORKSTATION_BUILD_VERSION);
  const workstation = await buildDefaultCaseWorkstationPayload(store, WORKSTATION_BUILD_VERSION);
  const elapsedMs = performance.now() - started;

  assert.equal(summary.case_id, "default_clinical_case");
  assert.equal(workstation.case_id, "default_clinical_case");
  assert.ok(elapsedMs < 15_000, `default showcase chain exceeded 15s smoke budget: ${elapsedMs.toFixed(1)}ms`);
});
