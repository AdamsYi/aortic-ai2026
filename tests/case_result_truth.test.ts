import test from "node:test";
import assert from "node:assert/strict";
import { __testables } from "../src/index";

const {
  deriveCaseResultPayloads,
  evaluateCaseDisplayReadiness,
  normalizeCaseResultPayloads,
  summarizePlanningSection,
} = __testables;

test("display-ready case requires measurements, planning, and all required clinical artifacts", () => {
  const readiness = evaluateCaseDisplayReadiness({
    measurements: { annulus: { equivalent_diameter_mm: 25.4 } },
    planning: { tavi: { valve_size_suggestion: { value: 26 } } },
    artifactTypes: [
      "centerline_json",
      "aortic_root_model_json",
      "leaflet_model_json",
      "aortic_root_stl",
      "planning_report_pdf",
    ],
  });

  assert.equal(readiness.display_ready, true);
  assert.equal(readiness.completion_state, "display_ready");
  assert.deepEqual(readiness.missing_requirements, []);
});

test("latest-case eligibility stays false when measurements exist but planning and report outputs are missing", () => {
  const readiness = evaluateCaseDisplayReadiness({
    measurements: { annulus: { equivalent_diameter_mm: 25.4 } },
    planning: null,
    artifactTypes: [
      "centerline_json",
      "aortic_root_model_json",
    ],
  });

  assert.equal(readiness.display_ready, false);
  assert.equal(readiness.completion_state, "incomplete_case_result");
  assert.deepEqual(readiness.missing_requirements, [
    "planning_json",
    "leaflet_model_json",
    "aortic_root_stl",
    "planning_report_pdf",
  ]);
});

test("case-result normalization still derives planning from measurements payload when provider nests it there", () => {
  const normalized = normalizeCaseResultPayloads({
    measurements: {
      annulus: { equivalent_diameter_mm: 24.8 },
      planning: {
        tavi: {
          valve_size_suggestion: { value: 26 },
        },
      },
    },
  });

  assert.ok(normalized.measurements);
  assert.ok(normalized.planning);
  assert.equal((normalized.planning?.tavi as Record<string, unknown>)?.valve_size_suggestion ? true : false, true);
});

test("case-result derivation backfills planning from measurements artifact when persisted row is stale", () => {
  const derived = deriveCaseResultPayloads({
    existingMeasurements: {
      annulus: { equivalent_diameter_mm: 24.8 },
    },
    existingPlanning: null,
    resultJson: {
      measurements: {
        annulus: { equivalent_diameter_mm: 24.8 },
      },
    },
    measurementsArtifactJson: {
      planning_metrics: {
        tavi: {
          area_derived_valve_size: { nearest_nominal_size_mm: 26 },
        },
        vsrr: {},
        pears: {},
      },
    },
  });

  assert.ok(derived.measurements);
  assert.ok(derived.planning);
  assert.equal(
    ((derived.planning?.tavi as Record<string, unknown>)?.area_derived_valve_size as Record<string, unknown>)?.nearest_nominal_size_mm,
    26
  );
});

test("planning summary marks raw planning metrics as review_required instead of unavailable", () => {
  const status = summarizePlanningSection({
    annulus_area_mm2: 570.8,
    coronary_risk_flag: true,
    area_derived_valve_size: {
      nearest_nominal_size_mm: 26,
    },
  });

  assert.equal(status, "review_required");
});
