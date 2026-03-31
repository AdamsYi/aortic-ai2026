import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDefaultCaseWorkstationPayload,
} from "../services/api/defaultCaseHandlers";
import { createCaseStoreFromFs } from "../services/api/defaultCaseStore.node";
import { WORKSTATION_BUILD_VERSION } from "../src/generated/workstationAssets";

test("showcase case includes clinically populated coronary measurements", async () => {
  const store = createCaseStoreFromFs();
  const workstation = await buildDefaultCaseWorkstationPayload(store, WORKSTATION_BUILD_VERSION);
  const measurements = (workstation.measurements as Record<string, any>).measurements;

  assert.equal(typeof measurements.coronary_height_left_mm.value, "number");
  assert.equal(typeof measurements.coronary_height_right_mm.value, "number");
  assert.ok(measurements.coronary_height_left_mm.value >= 12 && measurements.coronary_height_left_mm.value <= 16);
  assert.ok(measurements.coronary_height_right_mm.value >= 14 && measurements.coronary_height_right_mm.value <= 18);
  assert.notEqual(measurements.coronary_height_left_mm.uncertainty.flag, "PLACEHOLDER_ONLY");
  assert.notEqual(measurements.coronary_height_right_mm.uncertainty.flag, "NOT_AVAILABLE");
});

test("showcase case uses layered clinical gates instead of hard boolean failures", async () => {
  const store = createCaseStoreFromFs();
  const workstation = await buildDefaultCaseWorkstationPayload(store, WORKSTATION_BUILD_VERSION);

  assert.equal(workstation.quality_gates.sinus_annulus_relation.status, "normal");
  assert.equal(workstation.quality_gates.stj_sinus_relation.status, "normal");
  assert.equal(workstation.quality_gates.commissure_symmetry.status, "normal");
  assert.equal(workstation.quality_gates.coronary_height_assessment.status, "borderline");
  assert.equal(workstation.quality_gates.coronary_height_assessment.clinician_review_required, true);
});

test("showcase case includes complete tavi planning structure", async () => {
  const store = createCaseStoreFromFs();
  const workstation = await buildDefaultCaseWorkstationPayload(store, WORKSTATION_BUILD_VERSION);
  const planning = workstation.planning as Record<string, any>;

  assert.equal(planning.tavi.recommended_prosthesis.value.primary.brand, "Edwards SAPIEN 3");
  assert.equal(planning.tavi.access_route.value.recommended, "transfemoral");
  assert.equal(planning.tavi.coronary_occlusion_risk.value.lca.risk_level, "low");
  assert.equal(planning.tavi.implant_depth_recommendation.value.value_mm, 4);
  assert.equal(planning.tavi.sizing_method.value, "perimeter_based");
  assert.equal(planning.vsrr.recommended_graft_diameter_mm.value, 28);
  assert.equal(planning.pears.external_support_size.value, "medium");
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
