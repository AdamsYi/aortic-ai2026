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
      "valve_size_suggestion",
      "access_route_assessment",
      "coronary_obstruction_risk",
      "implant_depth",
      "optimal_projection_angle",
    ],
    vsrr: [
      "graft_sizing",
      "commissural_geometry_status",
      "leaflet_geometry_status",
    ],
    pears: [
      "external_root_geometry_status",
      "support_region_status",
    ],
  };

  for (const [section, keys] of Object.entries(requiredKeys) as Array<[keyof typeof requiredKeys, string[]]>) {
    assert.ok(planning[section], `${section} section is missing in planning.json`);
    for (const key of keys) {
      assert.ok(planning[section][key], `${section}.${key} is missing in planning.json`);
    }
  }

  assert.equal(
    planning.vsrr.key_geometry_ratio,
    undefined,
    "vsrr.key_geometry_ratio should currently be missing and rendered by UI-level fallback"
  );
});
