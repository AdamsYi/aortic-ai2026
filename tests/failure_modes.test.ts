import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CASE_BUNDLE } from "../src/generated/defaultCaseBundle";
import {
  buildDefaultCaseWorkstationPayload,
  createDefaultCaseStoreFromBundle,
} from "../services/api/defaultCaseHandlers";
import { WORKSTATION_BUILD_VERSION } from "../src/generated/workstationAssets";

test("showcase case includes explicit failed measurement placeholders", async () => {
  const store = createDefaultCaseStoreFromBundle(DEFAULT_CASE_BUNDLE);
  const workstation = await buildDefaultCaseWorkstationPayload(store, WORKSTATION_BUILD_VERSION);
  const measurements = (workstation.measurements as Record<string, any>).measurements;

  assert.equal(measurements.coronary_height_right_mm.value, null);
  assert.notEqual(measurements.coronary_height_right_mm.uncertainty.flag, "NONE");
  assert.equal(measurements.coronary_height_right_mm.uncertainty.clinician_review_required, true);
});

test("showcase case includes explicit failed planning placeholders", async () => {
  const store = createDefaultCaseStoreFromBundle(DEFAULT_CASE_BUNDLE);
  const workstation = await buildDefaultCaseWorkstationPayload(store, WORKSTATION_BUILD_VERSION);
  const planning = workstation.planning as Record<string, any>;

  assert.equal(planning.tavi.access_route_assessment.value, null);
  assert.notEqual(planning.tavi.access_route_assessment.uncertainty.flag, "NONE");
  assert.equal(planning.tavi.access_route_assessment.uncertainty.clinician_review_required, true);
  assert.equal(planning.vsrr.leaflet_geometry_status.value, null);
});

test("showcase case keeps CPR unavailable and leaflet geometry legacy", async () => {
  const store = createDefaultCaseStoreFromBundle(DEFAULT_CASE_BUNDLE);
  const workstation = await buildDefaultCaseWorkstationPayload(store, WORKSTATION_BUILD_VERSION);

  assert.equal(workstation.capabilities.cpr.available, false);
  assert.equal(workstation.capabilities.cpr.reason, "cpr_artifact_missing");
  assert.equal(workstation.capabilities.leaflet_geometry.legacy, true);
});

test("showcase case exposes explicit failure flags", async () => {
  const flags = JSON.parse(DEFAULT_CASE_BUNDLE.qa["failure_flags.json"]);
  assert.ok(Array.isArray(flags.items) && flags.items.length > 0);
  for (const item of flags.items) {
    assert.equal(item.uncertainty.clinician_review_required, true);
    assert.notEqual(item.uncertainty.flag, "NONE");
  }
});
