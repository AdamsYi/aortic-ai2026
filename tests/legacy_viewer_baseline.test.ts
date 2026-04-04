import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const planningPath = path.resolve(
  process.cwd(),
  "cases/default_clinical_case/artifacts/planning.json"
);

test("planning artifact keeps required planning sections and supports per-field UI fallback", () => {
  const planning = JSON.parse(fs.readFileSync(planningPath, "utf8")) as Record<string, any>;
  const requiredKeys: Record<"tavi" | "vsrr" | "pears", string[]> = {
    tavi: [
      "area_derived_valve_size",
      "coronary_risk_flag",
      "stj_diameter_mm",
    ],
    vsrr: [
      "recommended_graft_size_mm",
      "annulus_stj_mismatch_mm",
      "coaptation_height_mm",
    ],
    pears: [
      "root_external_reference_diameter_mm",
      "support_segment_length_mm",
    ],
  };

  for (const [section, keys] of Object.entries(requiredKeys) as Array<[keyof typeof requiredKeys, string[]]>) {
    assert.ok(planning[section], `${section} section is missing in planning.json`);
    for (const key of keys) {
      assert.ok(planning[section][key], `${section}.${key} is missing in planning.json`);
    }
  }

  assert.equal(
    planning.tavi.access_route_assessment,
    undefined,
    "tavi.access_route_assessment should currently be missing and rendered by UI-level fallback"
  );
});
