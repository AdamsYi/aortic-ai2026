import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDefaultCaseList,
  buildDefaultCaseSummary,
  buildDefaultCaseWorkstationPayload,
  handleCaseArtifactById,
  handleCaseMeshById,
  handleDefaultCaseArtifact,
} from "../services/api/defaultCaseHandlers";
import { createCaseStoreFromFs } from "../services/api/defaultCaseStore.node";
import { WORKSTATION_BUILD_VERSION } from "../src/generated/workstationAssets";

test("default case summary and workstation payload share the same manifest truth", async () => {
  const store = createCaseStoreFromFs();
  const summary = await buildDefaultCaseSummary(store, WORKSTATION_BUILD_VERSION);
  const workstation = await buildDefaultCaseWorkstationPayload(store, WORKSTATION_BUILD_VERSION);

  assert.equal(summary.case_id, "default_clinical_case");
  assert.equal(summary.placeholder, false);
  assert.equal(summary.not_real_cta, false);
  assert.equal(workstation.case_id, summary.case_id);
  assert.deepEqual(workstation.case_role, summary.case_role);
  assert.deepEqual(workstation.capabilities, summary.capabilities);
  assert.deepEqual(workstation.planning_summary, summary.planning_summary);
  assert.deepEqual(workstation.quality_gates_summary, summary.quality_gates_summary);
  assert.deepEqual(workstation.quality_gates, await (async () => JSON.parse(await store.getDefaultCaseQa("quality_gates.json")))());
  assert.deepEqual(workstation.uncertainty_summary, summary.uncertainty_summary);
  assert.deepEqual(workstation.downloads, summary.downloads);
  assert.deepEqual(workstation.acceptance_review, summary.acceptance_review);
  assert.deepEqual(workstation.clinical_review, summary.clinical_review);
  assert.equal(workstation.links.summary, "/api/cases/default_clinical_case/summary");
  assert.equal(workstation.links.workstation, "/workstation/cases/default_clinical_case");
  assert.match(String(workstation.volume_source?.signed_url || ""), /ct_showcase_root_roi\.nii\.gz$/);
});

test("default case list is derived from manifest fields", async () => {
  const store = createCaseStoreFromFs();
  const listing = await buildDefaultCaseList(store, WORKSTATION_BUILD_VERSION);

  assert.equal(listing.total, 1);
  assert.equal(listing.cases[0]?.id, "default_clinical_case");
  assert.deepEqual(listing.cases[0]?.display_name, {
    "zh-CN": "金标准 CTA 展示病例",
    en: "Gold Showcase CTA Case",
  });
  assert.equal(listing.cases[0]?.scan_date, "2026-02-14");
  assert.equal(listing.cases[0]?.pipeline_version, "aortic_geometry_pipeline_v3");
  assert.equal(listing.cases[0]?.has_planning, true);
  assert.equal(listing.cases[0]?.has_measurements, true);
  assert.equal(listing.cases[0]?.has_meshes, true);
});

test("default case workstation payload includes planning and downloads", async () => {
  const store = createCaseStoreFromFs();
  const workstation = await buildDefaultCaseWorkstationPayload(store, WORKSTATION_BUILD_VERSION);
  assert.ok(workstation.planning);
  assert.ok(workstation.measurements);
  assert.ok(Array.isArray(workstation.downloads.json) && workstation.downloads.json.length > 0);
  assert.ok(Array.isArray(workstation.downloads.stl) && workstation.downloads.stl.length > 0);
  assert.equal(typeof workstation.downloads.raw, "object");
  assert.equal(typeof workstation.downloads.pdf, "object");
  assert.equal(workstation.pears_geometry, null);
  assert.ok(workstation.planning?.tavi);
  assert.equal(workstation.planning_summary?.tavi_status, "review_required");
  assert.equal(workstation.planning_summary?.vsrr_status, "available");
  assert.equal(workstation.planning_summary?.pears_status, "available");
  assert.equal(workstation.quality_gates?.coronary_height_assessment?.status, "not_assessable");
  assert.equal(workstation.quality_gates?.coronary_height_assessment?.clinician_review_required, true);
  assert.equal(workstation.acceptance_review?.overall_status, "needs_review");
  assert.equal(workstation.acceptance_review?.domains?.viewing?.status, "pass");
  assert.equal(workstation.clinical_review?.overall_status, "needs_review");
});

test("downloaded case manifest is normalized to the active build version", async () => {
  const store = createCaseStoreFromFs();
  const response = await handleDefaultCaseArtifact(store, WORKSTATION_BUILD_VERSION, "case_manifest.json");
  const payload = await response.json() as Record<string, unknown>;
  assert.equal(payload.build_version, WORKSTATION_BUILD_VERSION);
  assert.equal(payload.placeholder, false);
  assert.equal(payload.not_real_cta, false);
});

test("case artifact endpoint resolves manifest-backed json names", async () => {
  const store = createCaseStoreFromFs();
  const response = await handleCaseArtifactById(store, WORKSTATION_BUILD_VERSION, "default_clinical_case", "planning");
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type") || ""), /application\/json/);
  const payload = await response.json() as Record<string, unknown>;
  assert.ok(payload.tavi);
  assert.ok(payload.vsrr);
  assert.ok(payload.pears);
});

test("case mesh endpoint returns binary stl by filename", async () => {
  const store = createCaseStoreFromFs();
  const response = await handleCaseMeshById(store, "default_clinical_case", "aortic_root.stl");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "model/stl");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.length > 84);
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString("ascii"), "aorti");
});
