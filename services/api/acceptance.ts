import type { AcceptanceDomain, AcceptanceReview, CapabilityState } from "./contracts";

function pickObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasStructuredPlanning(planning: unknown): boolean {
  const root = pickObject(planning);
  if (!root) return false;
  return ["tavi", "vsrr", "pears"].some((sectionKey) => {
    const section = pickObject(root[sectionKey]);
    return Boolean(section && Object.keys(section).length);
  });
}

function capabilityAvailable(value: unknown): boolean {
  const state = pickObject(value);
  return Boolean(state?.available);
}

function capabilityReason(value: unknown): string | null {
  const state = pickObject(value);
  return typeof state?.reason === "string" && state.reason.trim() ? state.reason : null;
}

function isHistoricalInferred(pipelineRun: unknown): boolean {
  const run = pickObject(pipelineRun);
  return Boolean(run?.inferred) || String(run?.source_mode || "").toLowerCase() === "legacy";
}

function qualityGateNeedsReview(gates: unknown): boolean {
  const record = pickObject(gates);
  if (!record) return false;
  return Object.values(record).some((entry) => {
    const gate = pickObject(entry);
    const status = String(gate?.status || "").toLowerCase();
    return status === "borderline" || status === "review_required" || status === "not_assessable" || status === "failed";
  });
}

function coronaryAssessmentIncomplete(coronarySummary: unknown): boolean {
  const record = pickObject(coronarySummary);
  const left = pickObject(record?.left);
  const right = pickObject(record?.right);
  return String(left?.status || "").toLowerCase() === "not_found"
    || String(right?.status || "").toLowerCase() === "not_found";
}

function downloadsAvailable(downloads: unknown): boolean {
  const record = pickObject(downloads);
  if (!record) return false;
  const raw = record.raw;
  const pdf = record.pdf;
  const json = Array.isArray(record.json) ? record.json : [];
  return Boolean(raw && pdf && json.length);
}

function blockedDomain(summary: string, blockers: string[], reviewFlags: string[]): AcceptanceDomain {
  return { status: "blocked", summary, blockers, review_flags: reviewFlags };
}

function reviewDomain(summary: string, blockers: string[], reviewFlags: string[]): AcceptanceDomain {
  return { status: "needs_review", summary, blockers, review_flags: reviewFlags };
}

function passDomain(summary: string): AcceptanceDomain {
  return { status: "pass", summary, blockers: [], review_flags: [] };
}

export function buildAcceptanceReview(input: {
  case_role?: unknown;
  pipeline_run?: unknown;
  viewer_bootstrap?: unknown;
  capabilities?: unknown;
  downloads?: unknown;
  planning?: unknown;
  quality_gates?: unknown;
  quality_gates_summary?: unknown;
  coronary_ostia_summary?: unknown;
  leaflet_geometry_summary?: unknown;
}): AcceptanceReview {
  const runtime = pickObject(pickObject(input.viewer_bootstrap)?.runtime_requirements);
  const capabilities = pickObject(input.capabilities) || {};
  const warnings = Array.isArray(pickObject(input.viewer_bootstrap)?.bootstrap_warnings)
    ? (pickObject(input.viewer_bootstrap)?.bootstrap_warnings as unknown[])
    : [];

  const viewingBlockers: string[] = [];
  const viewingFlags: string[] = [];
  if (runtime?.supports_mpr !== true) {
    viewingBlockers.push("mpr_not_exposed");
    viewingFlags.push("mpr_not_exposed");
  }
  if (!downloadsAvailable(input.downloads)) {
    viewingBlockers.push("downloads_incomplete");
    viewingFlags.push("downloads_incomplete");
  }
  if (warnings.includes("mpr_runtime_unavailable")) {
    viewingBlockers.push("mpr_runtime_unavailable");
    viewingFlags.push("mpr_runtime_unavailable");
  }
  const viewing = viewingBlockers.length
    ? blockedDomain(
        "The viewing surface is not yet acceptable because core CT runtime or download evidence is incomplete.",
        viewingBlockers,
        viewingFlags
      )
    : passDomain("The viewing surface is exposed through the unified workstation and is ready for clinician-style interaction testing.");

  const clinicalBlockers: string[] = [];
  const clinicalFlags: string[] = [];
  if (isHistoricalInferred(input.pipeline_run)) {
    clinicalBlockers.push("historical_inferred_provenance");
    clinicalFlags.push("historical_inferred_provenance");
  }
  if (!capabilityAvailable(capabilities.cpr)) {
    clinicalBlockers.push(capabilityReason(capabilities.cpr) || "cpr_missing");
    clinicalFlags.push("cpr_missing");
  }
  if (coronaryAssessmentIncomplete(input.coronary_ostia_summary)) {
    clinicalBlockers.push("coronary_height_incomplete");
    clinicalFlags.push("coronary_height_incomplete");
  }
  if (qualityGateNeedsReview(input.quality_gates_summary || input.quality_gates)) {
    clinicalFlags.push("quality_gates_need_review");
  }
  const leafletSummary = pickObject(input.leaflet_geometry_summary);
  if (leafletSummary?.legacy === true) {
    clinicalFlags.push("leaflet_geometry_legacy");
  }
  const clinical = clinicalBlockers.length || clinicalFlags.length
    ? reviewDomain(
        "Clinical interpretation remains usable but limited; direct review is still required for constrained or inferred findings.",
        clinicalBlockers,
        clinicalFlags
      )
    : passDomain("Clinical interpretation surface is internally consistent and does not expose obvious blockers.");

  const planningBlockers: string[] = [];
  const planningFlags: string[] = [];
  if (!hasStructuredPlanning(input.planning)) {
    planningBlockers.push("planning_missing");
    planningFlags.push("planning_missing");
  }
  const pearsCapability = pickObject(capabilities.pears_geometry);
  if (pearsCapability?.inferred === true) {
    planningFlags.push("pears_geometry_inferred");
  }
  const planning = planningBlockers.length
    ? blockedDomain(
        "Planning cannot be accepted because structured planning sections are missing.",
        planningBlockers,
        planningFlags
      )
    : planningFlags.length
      ? reviewDomain(
          "Planning sections are present, but some surfaces still depend on inferred or limited-confidence geometry.",
          [],
          planningFlags
        )
      : passDomain("Planning sections are present and exposed through the unified workstation contract.");

  const domainStatuses = [viewing.status, clinical.status, planning.status];
  const overall_status: AcceptanceReview["overall_status"] = domainStatuses.includes("blocked")
    ? "blocked"
    : domainStatuses.includes("needs_review")
      ? "needs_review"
      : "pass";

  const summary = overall_status === "pass"
    ? "The current workstation surface is acceptable for product demonstration."
    : overall_status === "blocked"
      ? "The current workstation surface is still blocked by runtime or planning completeness issues."
      : "The current workstation surface is usable for review but still requires explicit human review.";

  return {
    overall_status,
    summary,
    human_review_required: overall_status !== "pass",
    domains: {
      viewing,
      clinical,
      planning,
    },
    next_actions: overall_status === "pass"
      ? ["Maintain the current unified workstation contract and keep regression checks green."]
      : [
          "Complete the remaining workstation stability review under real headed-browser interaction.",
          "Preserve explicit unavailable and review-required states instead of promoting weak findings.",
          "Do not advance the next clinical automation step until this acceptance surface is stable.",
        ],
  };
}
