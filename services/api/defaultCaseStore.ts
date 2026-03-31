export interface DefaultCaseStore {
  getCaseManifest(): Promise<Record<string, unknown>>;
  getDefaultCaseArtifact(name: string): Promise<string>;
  getDefaultCaseMesh(name: string): Promise<string>;
  getDefaultCaseReport(name?: string): Promise<string>;
  getDefaultCaseVolume(name?: string): Promise<string>;
  getDefaultCaseQa(name: string): Promise<string>;
  getDigestMap(): Record<string, string>;
}

export interface AssetFetcherLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function requireText(map: Record<string, string>, key: string, kind: string): string {
  const value = map[key];
  if (typeof value !== "string" || !value.length) {
    throw new Error(`default_case_missing_${kind}:${key}`);
  }
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

async function fetchAssetText(fetcher: AssetFetcherLike, assetPath: string, kind: string): Promise<string> {
  const response = await fetcher.fetch(new URL(assetPath, "https://default-case.local"));
  if (!response.ok) {
    throw new Error(`default_case_missing_${kind}:${assetPath}:${response.status}`);
  }
  return response.text();
}

async function fetchAssetBase64(fetcher: AssetFetcherLike, assetPath: string, kind: string): Promise<string> {
  const response = await fetcher.fetch(new URL(assetPath, "https://default-case.local"));
  if (!response.ok) {
    throw new Error(`default_case_missing_${kind}:${assetPath}:${response.status}`);
  }
  return bytesToBase64(new Uint8Array(await response.arrayBuffer()));
}

export function createCaseStoreFromBundle(bundle: {
  manifest: Record<string, unknown>;
  artifacts: Record<string, string>;
  meshes: Record<string, string>;
  reports: Record<string, string>;
  qa: Record<string, string>;
  imaging: Record<string, string>;
  digests: Record<string, string>;
}): DefaultCaseStore {
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
    async getDefaultCaseVolume(name = "ct_showcase_root_roi.nii.gz") {
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

export function createCaseStoreFromAssetFetcher(
  fetcher: AssetFetcherLike,
  digests: Record<string, string> = {}
): DefaultCaseStore {
  return {
    async getCaseManifest() {
      return JSON.parse(await fetchAssetText(fetcher, "/default-case/artifacts/case_manifest.json", "manifest"));
    },
    async getDefaultCaseArtifact(name: string) {
      return fetchAssetText(fetcher, `/default-case/artifacts/${name}`, "artifact");
    },
    async getDefaultCaseMesh(name: string) {
      return fetchAssetBase64(fetcher, `/default-case/meshes/${name}`, "mesh");
    },
    async getDefaultCaseReport(name = "report.pdf") {
      return fetchAssetBase64(fetcher, `/default-case/reports/${name}`, "report");
    },
    async getDefaultCaseVolume(name = "ct_showcase_root_roi.nii.gz") {
      return fetchAssetBase64(fetcher, `/default-case/imaging_hidden/${name}`, "imaging");
    },
    async getDefaultCaseQa(name: string) {
      return fetchAssetText(fetcher, `/default-case/qa/${name}`, "qa");
    },
    getDigestMap() {
      return digests;
    },
  };
}
