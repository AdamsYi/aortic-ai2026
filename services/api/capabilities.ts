import { pickObject, readBoolean } from "./files";
import type { CapabilityState } from "./contracts";

export interface CapabilityResolutionInput {
  manifest: Record<string, unknown>;
  model: Record<string, unknown>;
  leafletModel: Record<string, unknown>;
  planning: Record<string, unknown>;
}

function fromManifest(manifest: Record<string, unknown>, key: string): CapabilityState {
  const value = pickObject(pickObject(manifest.capabilities)?.[key]);
  return {
    available: readBoolean(value?.available),
    inferred: readBoolean(value?.inferred),
    legacy: readBoolean(value?.legacy),
    source: typeof value?.source === "string" ? value.source : null,
    reason: typeof value?.reason === "string" ? value.reason : null,
  };
}

export function resolveCapabilityState(input: CapabilityResolutionInput): Record<string, CapabilityState> {
  const { manifest, model, leafletModel, planning } = input;
  const cpr = fromManifest(manifest, "cpr");
  const coronary = fromManifest(manifest, "coronary_ostia");
  const leaflet = fromManifest(manifest, "leaflet_geometry");
  const pears = fromManifest(manifest, "pears_geometry");

  const coronaryOstia = pickObject(model.coronary_ostia);
  const leafletArray = Array.isArray(leafletModel.leaflets) ? leafletModel.leaflets : [];
  const pearsPlanning = pickObject(pickObject(planning.pears)?.external_root_geometry_status);

  return {
    cpr: {
      ...cpr,
      available: Boolean(cpr.available && false),
      reason: cpr.available ? cpr.reason : (cpr.reason || "cpr_artifact_missing"),
    },
    coronary_ostia: {
      ...coronary,
      available: Boolean(coronary.available && coronaryOstia),
    },
    leaflet_geometry: {
      ...leaflet,
      available: Boolean(!leaflet.legacy && leafletArray.some((item) => pickObject(item)?.effective_height_mm)),
      reason: leaflet.legacy ? (leaflet.reason || "leaflet_geometry_legacy_only") : leaflet.reason,
    },
    pears_geometry: {
      ...pears,
      available: Boolean(pearsPlanning && pickObject(pearsPlanning.value)),
      reason: pears.reason || "pears_geometry_not_generated",
    },
  };
}
