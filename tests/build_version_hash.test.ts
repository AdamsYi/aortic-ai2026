import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKSTATION_APP_SHA256,
  WORKSTATION_ASSET_DIGEST,
  WORKSTATION_BUILD_VERSION,
  WORKSTATION_DICOM_WORKER_SHA256,
  WORKSTATION_STYLE_SHA256,
} from "../src/generated/workstationAssets";
import {
  DEFAULT_CASE_BUILD_VERSION,
  DEFAULT_CASE_DIGEST,
  DEFAULT_CASE_FILE_DIGESTS,
} from "../src/generated/defaultCaseBundle";

test("workstation and default-case bundle share the same build version", () => {
  assert.equal(DEFAULT_CASE_BUILD_VERSION, WORKSTATION_BUILD_VERSION);
});

test("versioned asset digests are populated", () => {
  assert.match(WORKSTATION_BUILD_VERSION, /^[a-z0-9-]+$/i);
  assert.match(WORKSTATION_ASSET_DIGEST, /^[a-f0-9]{64}$/);
  assert.match(WORKSTATION_APP_SHA256, /^[a-f0-9]{64}$/);
  assert.match(WORKSTATION_STYLE_SHA256, /^[a-f0-9]{64}$/);
  assert.match(WORKSTATION_DICOM_WORKER_SHA256, /^[a-f0-9]{64}$/);
  assert.match(DEFAULT_CASE_DIGEST, /^[a-f0-9]{64}$/);
  assert.equal(DEFAULT_CASE_FILE_DIGESTS.default_case_digest, DEFAULT_CASE_DIGEST);
});
