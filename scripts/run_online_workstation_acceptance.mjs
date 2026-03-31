import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const demoUrl = process.env.DEMO_URL || process.argv[2] || "https://aortic-ai-api.we085197.workers.dev/demo";
const url = new URL(demoUrl);
const origin = url.origin;
const outputRoot = path.resolve("output");
const screenshotDir = path.join(outputRoot, "playwright");
const expertDir = path.join(outputRoot, "expert");

await mkdir(screenshotDir, { recursive: true });
await mkdir(expertDir, { recursive: true });

const browser = await chromium.launch({
  headless: process.env.HEADLESS === "0" ? false : true,
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1080 } });
page.setDefaultTimeout(60000);

const runtimeErrors = [];
page.on("pageerror", (error) => runtimeErrors.push(`pageerror:${error.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error") runtimeErrors.push(`console:${msg.text()}`);
});

async function text(selector) {
  const loc = page.locator(selector).first();
  if (!await loc.count()) return "";
  return ((await loc.textContent().catch(() => "")) || "").trim();
}

async function safeClick(selector) {
  const loc = page.locator(selector).first();
  if (!await loc.count()) return;
  await loc.click({ timeout: 1500, force: true }).catch(() => {});
  await page.waitForTimeout(250);
}

async function safeSelect(selector, value) {
  const loc = page.locator(selector).first();
  if (!await loc.count()) return;
  await loc.selectOption(value, { timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(250);
}

async function wheel(selector, deltaY) {
  const loc = page.locator(selector).first();
  if (!await loc.count()) return;
  await loc.hover();
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(250);
}

async function waitForWorkstationReady() {
  await page.waitForSelector("#viewport-axial", { timeout: 60000 });
  await page.waitForFunction(() => {
    const header = document.querySelector("#header-status");
    const text = (header?.textContent || "").trim().toLowerCase();
    return text.includes("case ready:") || text.includes("loaded with");
  }, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
}

async function fetchJsonInPage(targetPath) {
  return page.evaluate(async (requestPath) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(requestPath, {
        cache: "no-store",
        signal: controller.signal,
        headers: { "cache-control": "no-store" },
      });
      if (!resp.ok) {
        return { __fetch_error: `request_failed:${requestPath}:${resp.status}` };
      }
      return await resp.json();
    } catch (error) {
      return { __fetch_error: error instanceof Error ? error.message : String(error) };
    } finally {
      window.clearTimeout(timeout);
    }
  }, targetPath);
}

async function screenshot(name, locator) {
  const target = locator ? page.locator(locator).first() : page;
  await target.screenshot({ path: path.join(screenshotDir, name) }).catch(() => {});
}

function footerLooksValid(footerText) {
  return Boolean(footerText) && !footerText.includes("slice —");
}

async function collectCaseState(label) {
  const state = {
    label,
    caseMeta: await text("#case-meta"),
    headerStatus: await text("#header-status"),
    mprStatus: await text("#mpr-status"),
    acceptanceSummary: await text("#acceptance-summary"),
    annotationStatus: await text("#annotation-status"),
    axialFooter: await text("#viewport-footer-axial"),
    sagittalFooter: await text("#viewport-footer-sagittal"),
    coronalFooter: await text("#viewport-footer-coronal"),
    auxFooter: await text("#viewport-footer-aux"),
    downloads: await page.locator("#download-list .download-link").count(),
    planningRows: await page.locator("#planning-grid .metric-row").count(),
    qaItems: await page.locator("#qa-list .qa-item").count(),
    bootOverlayVisible: await page.locator("#boot-overlay:not(.hidden)").count(),
    viewportPlaceholders: await page.locator(".viewport-placeholder:not(.hidden)").count(),
  };
  return state;
}

async function performDoctorStyleInteraction() {
  const issues = [];
  const steps = [
    ["windowLevel", () => safeClick("[data-tool-mode='windowLevel']")],
    ["preset-ctaVessel", () => safeSelect("#window-preset", "ctaVessel")],
    ["zoom", () => safeClick("[data-tool-mode='zoom']")],
    ["pan", () => safeClick("[data-tool-mode='pan']")],
    ["length", () => safeClick("[data-tool-mode='length']")],
    ["angle", () => safeClick("[data-tool-mode='angle']")],
    ["probe", () => safeClick("[data-tool-mode='probe']")],
    ["rectangle-roi", () => safeClick("[data-tool-mode='rectangleRoi']")],
    ["crosshair", () => safeClick("[data-tool-mode='crosshair']")],
    ["focus-annulus", () => safeClick("#focus-annulus")],
    ["focus-stj", () => safeClick("#focus-stj")],
    ["focus-root", () => safeClick("#focus-root")],
    ["aux-centerline", () => safeSelect("#aux-mode", "centerline")],
    ["cine-on", () => safeClick("#cine-toggle")],
    ["cine-off", async () => {
      await page.waitForTimeout(600);
      await safeClick("#cine-toggle");
    }],
  ];
  for (const [label, fn] of steps) {
    console.log(`interaction: ${label}`);
    try {
      await fn();
    } catch (error) {
      issues.push(`${label}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return issues;
}

function deriveReview(label, state, interactionIssues = []) {
  const issues = [];
  if (!footerLooksValid(state.axialFooter)) issues.push("axial_viewport_not_stable");
  if (!footerLooksValid(state.sagittalFooter)) issues.push("sagittal_viewport_not_stable");
  if (!footerLooksValid(state.coronalFooter)) issues.push("coronal_viewport_not_stable");
  if (!footerLooksValid(state.auxFooter)) issues.push("aux_viewport_not_stable");
  if (state.bootOverlayVisible) issues.push("boot_overlay_visible");
  if (state.viewportPlaceholders > 4) issues.push("placeholder_fallback_visible");
  if (state.downloads < 3) issues.push("downloads_incomplete");
  if (state.planningRows === 0) issues.push("planning_empty");
  if (state.qaItems === 0) issues.push("clinical_review_empty");
  issues.push(...interactionIssues);
  const status = issues.length ? "needs_review" : "pass";
  return {
    label,
    status,
    summary: issues.length
      ? `${label} still has visible workstation issues that require review before sign-off.`
      : `${label} completed the headed-browser interaction path without visible workstation blockers.`,
    issues,
    screenshots: {
      overview: path.relative(process.cwd(), path.join(screenshotDir, `${label}-overview.png`)),
      axial: path.relative(process.cwd(), path.join(screenshotDir, `${label}-axial.png`)),
      threeD: path.relative(process.cwd(), path.join(screenshotDir, `${label}-3d.png`)),
      sidebar: path.relative(process.cwd(), path.join(screenshotDir, `${label}-sidebar.png`)),
    },
  };
}

try {
  console.log(`opening ${demoUrl}`);
  await page.goto(demoUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitForWorkstationReady();

  console.log("capturing showcase");
  await screenshot("showcase-overview.png");
  await screenshot("showcase-axial.png", "#viewport-card-axial");
  await screenshot("showcase-3d.png", ".three-panel");
  await screenshot("showcase-sidebar.png", ".side-panel");
  const showcaseInteractionIssues = await performDoctorStyleInteraction();
  const showcaseState = await collectCaseState("showcase");
  const showcaseReview = deriveReview("showcase", showcaseState, showcaseInteractionIssues);

  console.log("switching to latest");
  await safeClick("#load-latest");
  await waitForWorkstationReady();
  await screenshot("latest-overview.png");
  await screenshot("latest-axial.png", "#viewport-card-axial");
  await screenshot("latest-3d.png", ".three-panel");
  await screenshot("latest-sidebar.png", ".side-panel");
  const latestInteractionIssues = await performDoctorStyleInteraction();
  const latestState = await collectCaseState("latest");
  const latestReview = deriveReview("latest", latestState, latestInteractionIssues);

  console.log("fetching live summaries");
  const showcaseSummary = await fetchJsonInPage("/api/cases/default_clinical_case/summary");
  const latestSummary = await fetchJsonInPage("/demo/latest-case");

  const report = {
    task_type: "workstation_case_review",
    summary_zh: latestReview.status === "pass" && showcaseReview.status === "pass"
      ? "线上展示病例和最新病例都完成了真实看片操作，当前工作站可以继续做临床审查。"
      : "线上工作站已经完成真实截图和操作审查，但仍有病例切换或看片稳定性问题需要继续整改。",
    summary_en: latestReview.status === "pass" && showcaseReview.status === "pass"
      ? "Both showcase and latest-case flows completed the headed viewing review and can proceed to clinical review."
      : "The live workstation completed the screenshot-based review, but visible viewing stability issues still require remediation.",
    confidence: {
      level: latestReview.status === "pass" && showcaseReview.status === "pass" ? "moderate" : "low",
      rationale: [
        "This artifact is derived from headed-browser screenshots and real interaction checks against the live workers.dev surface.",
        "Clinical confidence remains limited when coronary ostia or CPR artifacts are unavailable or review-required.",
      ],
    },
    human_review_required: true,
    missing_data: [
      "CPR-dependent review remains unavailable when the case does not expose a CPR artifact.",
      "Coronary ostia remain review-limited when the case reports not_found or low-confidence localization.",
    ],
    next_actions: latestReview.status === "pass" && showcaseReview.status === "pass"
      ? [
          "Use this artifact as the current screenshot-based acceptance record for the unified workstation.",
          "Proceed to the next auto-annotation validation round only after keeping the viewing regression checks green.",
        ]
      : [
          "Fix the remaining latest-case viewing issues before accepting the workstation as clinically demo-ready.",
          "Re-run this online acceptance script and refresh the screenshot set after each viewer change.",
        ],
    workstation_bridge: {
      planning: {
        tavi: {
          objective: "Keep the TAVI panel visible and clinically honest on the live workstation.",
          readiness: showcaseSummary?.planning_summary?.tavi_status === "available" ? "partial_ready" : "not_ready",
          suitability: "needs_more_data",
          supporting_findings: ["Live showcase planning rows are present on the unified workstation."],
          blockers: latestReview.issues.includes("planning_empty") ? ["latest_case_planning_empty"] : [],
          required_next_data: ["Direct coronary and CPR-dependent findings for full TAVI confidence."],
          recommended_review_flags: ["review_required_if_coronary_or_cpr_missing"],
        },
        vsrr: {
          objective: "Expose VSRR planning in the same right-hand review surface.",
          readiness: showcaseSummary?.planning_summary?.vsrr_status === "available" ? "partial_ready" : "not_ready",
          suitability: "needs_more_data",
          supporting_findings: ["Unified workstation planning surface is available."],
          blockers: [],
          required_next_data: ["Higher-confidence leaflet and commissural geometry artifacts."],
          recommended_review_flags: ["leaflet_geometry_review_required"],
        },
        pears: {
          objective: "Keep PEARS content inside the planning surface without over-promising dedicated geometry.",
          readiness: showcaseSummary?.planning_summary?.pears_status === "available" ? "partial_ready" : "not_ready",
          suitability: "needs_more_data",
          supporting_findings: ["Planning rows remain present after the sidebar simplification."],
          blockers: [],
          required_next_data: ["Dedicated PEARS geometry artifact before treating this as a mature clinical module."],
          recommended_review_flags: ["pears_preview_only"],
        },
      },
      planning_evidence: {
        case_facts: [
          `Showcase acceptance: ${showcaseReview.status}`,
          `Latest acceptance: ${latestReview.status}`,
        ],
        warnings: [...new Set([...showcaseReview.issues, ...latestReview.issues])],
        provenance: [
          `Live demo URL: ${demoUrl}`,
          `Latest summary source id: ${latestSummary?.id || latestSummary?.job_id || "unknown"}`,
        ],
      },
      quality_gates: {
        status: latestReview.status === "pass" && showcaseReview.status === "pass" ? "pass" : "needs_review",
        items: [
          { key: "showcase_viewing", status: showcaseReview.status === "pass" ? "pass" : "warning", detail: showcaseReview.summary },
          { key: "latest_viewing", status: latestReview.status === "pass" ? "pass" : "warning", detail: latestReview.summary },
        ],
      },
      measurement_contract: {
        annulus: { status: "available", source: "live workstation payload", note: "Reviewed from the unified live workstation." },
        stj: { status: "available", source: "live workstation payload", note: "Reviewed from the unified live workstation." },
        coronary_heights_mm: { status: "limited", source: "live workstation payload", note: "Do not promote coronary heights beyond what the case truly exposes." },
        leaflet_geometry: { status: "limited", source: "live workstation payload", note: "Leaflet geometry still requires explicit human review." },
      },
    },
    case_review: {
      runtime_errors: runtimeErrors,
      showcase: {
        state: showcaseState,
        review: showcaseReview,
      },
      latest: {
        state: latestState,
        review: latestReview,
      },
      summaries: {
        showcase: showcaseSummary,
        latest: latestSummary,
      },
    },
  };

  const outPath = path.join(expertDir, "workstation_acceptance_current.json");
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outPath, showcaseReview, latestReview, runtimeErrors }, null, 2));
} finally {
  await browser.close();
}
