import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DefaultCaseStore } from "./defaultCaseStore";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const defaultCaseRoot = path.join(repoRoot, "cases/default_clinical_case");

async function readText(relPath: string): Promise<string> {
  return readFile(path.join(defaultCaseRoot, relPath), "utf8");
}

async function readBase64(relPath: string): Promise<string> {
  const buffer = await readFile(path.join(defaultCaseRoot, relPath));
  return buffer.toString("base64");
}

export function createCaseStoreFromFs(root = defaultCaseRoot): DefaultCaseStore {
  const resolvePath = (...parts: string[]) => path.join(root, ...parts);
  return {
    async getCaseManifest() {
      return JSON.parse(await readFile(resolvePath("artifacts", "case_manifest.json"), "utf8"));
    },
    async getDefaultCaseArtifact(name: string) {
      return readFile(resolvePath("artifacts", name), "utf8");
    },
    async getDefaultCaseMesh(name: string) {
      return (await readFile(resolvePath("meshes", name))).toString("base64");
    },
    async getDefaultCaseReport(name = "report.pdf") {
      return (await readFile(resolvePath("reports", name))).toString("base64");
    },
    async getDefaultCaseVolume(name = "ct_showcase_root_roi.nii.gz") {
      return (await readFile(resolvePath("imaging_hidden", name))).toString("base64");
    },
    async getDefaultCaseQa(name: string) {
      return readFile(resolvePath("qa", name), "utf8");
    },
    getDigestMap() {
      return {};
    },
  };
}
