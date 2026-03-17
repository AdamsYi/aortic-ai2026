import type { DefaultCaseBundle } from "./contracts";

export interface DefaultCaseStore {
  getCaseManifest(): Promise<Record<string, unknown>>;
  getDefaultCaseArtifact(name: string): Promise<string>;
  getDefaultCaseMesh(name: string): Promise<string>;
  getDefaultCaseReport(name?: string): Promise<string>;
  getDefaultCaseVolume(name?: string): Promise<string>;
  getDefaultCaseQa(name: string): Promise<string>;
  getDigestMap(): Record<string, string>;
}

function requireText(map: Record<string, string>, key: string, kind: string): string {
  const value = map[key];
  if (typeof value !== "string" || !value.length) {
    throw new Error(`default_case_missing_${kind}:${key}`);
  }
  return value;
}

export function createCaseStoreFromBundle(bundle: DefaultCaseBundle): DefaultCaseStore {
  return {
    async getCaseManifest() {
      return JSON.parse(bundle.artifacts["case_manifest.json"] || JSON.stringify(bundle.manifest || {}));
    },
    async getDefaultCaseArtifact(name: string) {
      return requireText(bundle.artifacts, name, "artifact");
    },
    async getDefaultCaseMesh(name: string) {
      return requireText(bundle.meshes, name, "mesh");
    },
    async getDefaultCaseReport(name = "report.pdf") {
      return requireText(bundle.reports, name, "report");
    },
    async getDefaultCaseVolume(name = "ct_placeholder.nii.gz") {
      return requireText(bundle.imaging, name, "imaging");
    },
    async getDefaultCaseQa(name: string) {
      return requireText(bundle.qa, name, "qa");
    },
    getDigestMap() {
      return bundle.digests || {};
    },
  };
}
