import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDefaultCaseWorkstationPayload,
} from "../services/api/defaultCaseHandlers";
import { createCaseStoreFromFs } from "../services/api/defaultCaseStore.node";
import { WORKSTATION_BUILD_VERSION } from "../src/generated/workstationAssets";

test("showcase case exposes unavailable coronary measurements honestly", async () => {
  const store = createCaseStoreFromFs();
  const workstation = await buildDefaultCaseWorkstationPayload(store, WORKSTATION_BUILD_VERSION);
  const measurements = workstation.measurements as Record<string, any>;

  assert.equal(measurements.coronary_height_left_mm.value, null);
  assert.equal(measurements.coronary_height_right_mm.value, null);
  assert.equal(measurements.coronary_height_left_mm.uncertainty.flag, "NOT_AVAILABLE");
  assert.equal(measurements.coronary_height_right_mm.uncertainty.flag, "NOT_AVAILABLE");
  assert.equal(measurements.coronary_height_left_mm.uncertainty.clinician_review_required, true);
  assert.equal(measurements.coronary_height_right_mm.uncertainty.clinician_review_required, true);
});

test("showcase case uses layered clinical gates instead of hard boolean failures", async () => {
  const store = createCaseStoreFromFs();
  const workstation = await buildDefaultCaseWorkstationPayload(store, WORKSTATION_BUILD_VERSION);

  assert.equal(workstation.quality_gates.sinus_annulus_relation.status, "normal");
  assert.equal(workstation.quality_gates.stj_sinus_relation.status, "normal");
  assert.equal(workstation.quality_gates.commissure_symmetry.status, "normal");
  assert.equal(workstation.quality_gates.coronary_height_assessment.status, "not_assessable");
  assert.equal(workstation.quality_gates.coronary_height_assessment.clinician_review_required, true);
});

test("showcase case includes complete tavi planning structure", async () => {
  const store = createCaseStoreFromFs();
  const workstation = await buildDefaultCaseWorkstationPayload(store, WORKSTATION_BUILD_VERSION);
  const planning = workstation.planning as Record<string, any>;

  assert.equal(planning.tavi.area_derived_valve_size.nearest_nominal_size_mm, 23);
  assert.equal(planning.tavi.area_derived_valve_size.method, "nearest_reference_nominal_size_non_vendor_specific");
  assert.equal(planning.tavi.coronary_height_left_mm, null);
  assert.equal(planning.tavi.coronary_height_right_mm, null);
  assert.equal(planning.vsrr.recommended_graft_size_mm, 24.6);
  assert.equal(planning.pears.root_external_reference_diameter_mm, 39.65986365529072);
});

test("showcase case keeps CPR unavailable while retaining real leaflet geometry", async () => {
  const store = createCaseStoreFromFs();
  const workstation = await buildDefaultCaseWorkstationPayload(store, WORKSTATION_BUILD_VERSION);

  assert.equal(workstation.capabilities.cpr.available, false);
  assert.equal(workstation.capabilities.cpr.reason, "cpr_artifact_missing");
  assert.equal(workstation.capabilities.leaflet_geometry.available, true);
  assert.equal(workstation.capabilities.leaflet_geometry.legacy, false);
});

test("showcase case exposes explicit failure flags", async () => {
  const store = createCaseStoreFromFs();
  const flags = JSON.parse(await store.getDefaultCaseQa("failure_flags.json"));
  assert.ok(Array.isArray(flags.items) && flags.items.length > 0);
  for (const item of flags.items) {
    assert.equal(item.uncertainty.clinician_review_required, true);
    assert.notEqual(item.uncertainty.flag, "NONE");
  }
});

test("coronary detection_failed requires clinician review", () => {
  const coronary = {
    left: {
      status: "detection_failed",
      confidence: 0.12,
      clinician_review_required: true,
    },
  };

  assert.equal(coronary.left.status, "detection_failed");
  assert.equal(coronary.left.clinician_review_required, true);
});

test("coronary uncertain requires clinician review", () => {
  const coronary = {
    right: {
      status: "uncertain",
      confidence: 0.42,
      clinician_review_required: true,
    },
  };

  assert.equal(coronary.right.status, "uncertain");
  assert.equal(coronary.right.clinician_review_required, true);
});

test("coronary detected with confidence >= 0.55 clears clinician review", () => {
  const coronary = {
    left: {
      status: "detected",
      confidence: 0.72,
      clinician_review_required: false,
    },
  };

  assert.equal(coronary.left.status, "detected");
  assert.ok(coronary.left.confidence >= 0.55);
  assert.equal(coronary.left.clinician_review_required, false);
});

test("auto-corrected sinus measurement carries anatomy constraint uncertainty flag", () => {
  const measurements = {
    measurements_regularized: {
      annulus: {
        equivalent_diameter_mm: 28,
      },
      sinus_of_valsalva: {
        max_diameter_mm: 28,
        constraint_corrected_from_mm: 26,
        uncertainty_flag: "ANATOMY_CONSTRAINT_VIOLATION",
        constraint_note: "sinus_raised_to_annulus_value",
      },
    },
  };

  assert.equal(
    measurements.measurements_regularized.sinus_of_valsalva.uncertainty_flag,
    "ANATOMY_CONSTRAINT_VIOLATION",
  );
  assert.equal(
    measurements.measurements_regularized.sinus_of_valsalva.constraint_note,
    "sinus_raised_to_annulus_value",
  );
});
