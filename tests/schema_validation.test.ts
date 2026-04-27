import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const repoRoot = process.cwd();
const schemaDir = path.join(repoRoot, "schemas");
const caseRoot = path.join(repoRoot, "cases/default_clinical_case");

async function loadJson(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function findCaseManifests(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await findCaseManifests(fullPath));
    } else if (entry.name === "case_manifest.json") {
      out.push(fullPath);
    }
  }
  return out;
}

test("default showcase artifacts satisfy schemas", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schemaFiles = [
    "common.json",
    "planning.json",
    "centerline.json",
    "leaflet_model.json",
    "measurements.json",
    "aortic_root_computational_model.json",
    "aortic_root_model.json",
    "case_manifest.json",
    "quality_gates.json",
    "failure_flags.json",
  ];

  for (const name of schemaFiles) {
    const schema = await loadJson(path.join(schemaDir, name));
    ajv.addSchema(schema);
    ajv.addSchema(schema, name);
  }

  const validations: Array<[string, string, string]> = [
    ["case_manifest.json", "case_manifest.json", "artifacts"],
    ["planning.json", "planning.json", "artifacts"],
    ["centerline.json", "centerline.json", "artifacts"],
    ["aortic_root_model.json", "aortic_root_model.json", "artifacts"],
    ["measurements.json", "measurements.json", "artifacts"],
    ["leaflet_model.json", "leaflet_model.json", "artifacts"],
    ["quality_gates.json", "quality_gates.json", "qa"],
    ["failure_flags.json", "failure_flags.json", "qa"],
  ];

  for (const [schemaName, fileName, folder] of validations) {
    const schema = await loadJson(path.join(schemaDir, schemaName));
    const validate = ajv.getSchema(schema.$id) || ajv.compile(schema);
    const payload = await loadJson(path.join(caseRoot, folder, fileName));
    const ok = validate(payload);
    assert.equal(ok, true, `${fileName} failed schema validation: ${ajv.errorsText(validate.errors)}`);
  }
});

test("all case manifests satisfy manifest schema", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const commonSchema = await loadJson(path.join(schemaDir, "common.json"));
  const manifestSchema = await loadJson(path.join(schemaDir, "case_manifest.json"));
  ajv.addSchema(commonSchema);
  ajv.addSchema(commonSchema, "common.json");
  ajv.addSchema(manifestSchema);
  ajv.addSchema(manifestSchema, "case_manifest.json");

  const validate = ajv.getSchema(manifestSchema.$id) || ajv.compile(manifestSchema);
  const manifests = await findCaseManifests(path.join(repoRoot, "cases"));
  assert.ok(manifests.length >= 1);

  for (const manifestPath of manifests) {
    const payload = await loadJson(manifestPath);
    const ok = validate(payload);
    assert.equal(ok, true, `${path.relative(repoRoot, manifestPath)} failed schema validation: ${ajv.errorsText(validate.errors)}`);
  }
});
