import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CASE_BUNDLE } from "../src/generated/defaultCaseBundle";
import {
  buildDefaultCaseSummary,
  buildDefaultCaseWorkstationPayload,
  createDefaultCaseStoreFromBundle,
} from "../services/api/defaultCaseHandlers";
import { WORKSTATION_BUILD_VERSION } from "../src/generated/workstationAssets";

test("default case summary and workstation payload share the same manifest truth", async () => {
  const store = createDefaultCaseStoreFromBundle(DEFAULT_CASE_BUNDLE);
  const summary = await buildDefaultCaseSummary(store, WORKSTATION_BUILD_VERSION);
  const workstation = await buildDefaultCaseWorkstationPayload(store, WORKSTATION_BUILD_VERSION);

  assert.equal(summary.case_id, "default_clinical_case");
  assert.equal(workstation.case_id, summary.case_id);
  assert.deepEqual(workstation.case_role, summary.case_role);
  assert.deepEqual(workstation.capabilities, summary.capabilities);
  assert.deepEqual(workstation.planning_summary, summary.planning_summary);
  assert.deepEqual(workstation.uncertainty_summary, summary.uncertainty_summary);
  assert.equal(workstation.links.summary, "/api/cases/default_clinical_case/summary");
  assert.equal(workstation.links.workstation, "/workstation/cases/default_clinical_case");
});

test("default case workstation payload includes planning and downloads", async () => {
  const store = createDefaultCaseStoreFromBundle(DEFAULT_CASE_BUNDLE);
  const workstation = await buildDefaultCaseWorkstationPayload(store, WORKSTATION_BUILD_VERSION);
  assert.ok(workstation.planning);
  assert.ok(workstation.measurements);
  assert.ok(Array.isArray(workstation.downloads.json) && workstation.downloads.json.length > 0);
  assert.ok(Array.isArray(workstation.downloads.stl) && workstation.downloads.stl.length > 0);
  assert.equal(typeof workstation.downloads.pdf, "string");
});
