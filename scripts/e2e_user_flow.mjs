import { chromium } from "playwright-core";

const BASE = process.env.E2E_BASE_URL || "https://aortic-ai-api.we085197.workers.dev/demo";
const URL = `${BASE}${BASE.includes("?") ? "&" : "?"}t=${Date.now()}`;
const E2E_LANG = (process.env.E2E_LANG || "en").toLowerCase();
const CHROME_PATH =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg, details = "") {
  const extra = details ? `\n${details}` : "";
  throw new Error(`E2E_FAIL: ${msg}${extra}`);
}

async function text(page, id) {
  return page.locator(`#${id}`).textContent();
}

async function waitNotDash(page, id, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = ((await text(page, id)) || "").trim();
    if (v && v !== "-" && v !== "loading..." && v !== "initializing...") return v;
    await sleep(500);
  }
  fail(`timeout waiting #${id} to become non-dash`);
}

async function waitBadgeSeg(page, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = (((await text(page, "badgeSeg")) || "").trim()).toLowerCase();
    if (v.startsWith("done")) return v;
    if (v === "failed") fail("badgeSeg is failed");
    await sleep(800);
  }
  fail("timeout waiting auto segmentation to finish");
}

async function waitRecon3dStatus(page, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = (((await text(page, "recon3dStatus")) || "").trim()).toLowerCase();
    if (!v) {
      await sleep(500);
      continue;
    }
    if (v.includes("failed") || v.includes("失败")) return v;
    if (v.includes("ready") || v.includes("完成")) return v;
    await sleep(500);
  }
  return (((await text(page, "recon3dStatus")) || "").trim());
}

async function waitCaseLoaded(page, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const study = ((await text(page, "studyId")) || "").trim();
    const status = ((await text(page, "jobStatus")) || "").trim().toLowerCase();
    const slice = ((await text(page, "badgeSlice")) || "").trim();
    if (study && study !== "-" && status && status !== "-" && slice && slice !== "-") return;
    await sleep(600);
  }
  fail("default case did not load");
}

async function verifyCanvasNotBlank(page) {
  const stats = await page.evaluate(() => {
    const canvas = document.getElementById("viewer");
    if (!canvas) return { ok: false, reason: "canvas_missing" };
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, reason: "ctx_missing" };
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return { ok: false, reason: "canvas_size_zero" };
    const sw = Math.min(w, 512);
    const sh = Math.min(h, 512);
    const sample = ctx.getImageData(0, 0, sw, sh).data;
    let nonBlack = 0;
    let minX = sw - 1;
    let minY = sh - 1;
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < sample.length; i += 4) {
      const r = sample[i];
      const g = sample[i + 1];
      const b = sample[i + 2];
      if (r || g || b) {
        nonBlack += 1;
        const p = i / 4;
        const x = p % sw;
        const y = Math.floor(p / sw);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (nonBlack <= 120) return { ok: false, reason: "canvas_blank", nonBlack, w, h };
    const bw = Math.max(1, maxX - minX + 1);
    const bh = Math.max(1, maxY - minY + 1);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const offX = Math.abs(cx - sw / 2) / sw;
    const offY = Math.abs(cy - sh / 2) / sh;
    const cover = (bw * bh) / (sw * sh);
    const centered = offX <= 0.22 && offY <= 0.22;
    const sized = cover >= 0.18;
    return {
      ok: centered && sized,
      nonBlack,
      w,
      h,
      sw,
      sh,
      bounds: { minX, minY, maxX, maxY, bw, bh },
      center_offset: { offX, offY },
      cover
    };
  });
  if (!stats.ok) fail("canvas appears blank", JSON.stringify(stats));
}

async function run() {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true
  });

  const context = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1600, height: 980 }
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    pageErrors.push(String(err));
  });

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  const langModal = page.locator("#langModal");
  if (await langModal.isVisible().catch(() => false)) {
    await page.locator(E2E_LANG === "zh" ? "#btnLangModalZh" : "#btnLangModalEn").click();
    await sleep(300);
  }

  await waitCaseLoaded(page);
  await waitBadgeSeg(page);
  await verifyCanvasNotBlank(page);
  const recon3dStatus = await waitRecon3dStatus(page);

  const stjBtn = page.locator("#btnJumpStj");
  if (await stjBtn.isEnabled().catch(() => false)) {
    await stjBtn.click();
    await sleep(400);
    await page.screenshot({ path: "runs/e2e_keyslice_preview.png", fullPage: true });
    const keyLabel = (((await text(page, "badgeKey")) || "").trim()).toLowerCase();
    if (!keyLabel || keyLabel === "-" || keyLabel === "none" || keyLabel === "无") {
      fail("key slice shortcut did not activate a key label");
    }
  }

  await page.locator("#btnDispPanel").click();
  await sleep(250);
  const panelActive = await page.locator("#btnDispPanel").evaluate((el) => el.classList.contains("active"));
  if (!panelActive) fail("measurement display mode switch to panel failed");
  await page.locator("#btnDispCt").click();
  await sleep(250);
  const ctActive = await page.locator("#btnDispCt").evaluate((el) => el.classList.contains("active"));
  if (!ctActive) fail("measurement display mode switch back to CT failed");

  const sliceBefore = ((await text(page, "badgeSlice")) || "").trim();
  await page.locator("#viewer").hover();
  await page.mouse.wheel(0, 120);
  await sleep(500);
  const sliceAfter = ((await text(page, "badgeSlice")) || "").trim();
  if (sliceAfter === sliceBefore) fail("slice did not change on mouse wheel");

  const zoomBefore = ((await text(page, "badgeZoom")) || "").trim();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -260);
  await page.keyboard.up("Control");
  await sleep(500);
  const zoomAfter = ((await text(page, "badgeZoom")) || "").trim();
  if (zoomAfter === zoomBefore) fail("zoom did not change on ctrl+wheel");

  await page.locator("#btnMakePears").click();
  await sleep(500);
  const pearsPlan = ((await text(page, "planPreview")) || "").trim();
  if (!pearsPlan.includes("Plan Type: PEARS") && !pearsPlan.includes("方案类型: PEARS")) {
    fail("PEARS plan not generated in page");
  }
  if (
    !pearsPlan.toLowerCase().includes("centerline-orthogonal") &&
    !pearsPlan.includes("中心线正交切面")
  ) {
    fail("PEARS plan missing centerline-orthogonal measurement method");
  }

  await page.locator("#btnMakeVsrr").click();
  await sleep(500);
  const vsrrPlan = ((await text(page, "planPreview")) || "").trim();
  if (!vsrrPlan.includes("Plan Type: VSRR") && !vsrrPlan.includes("方案类型: VSRR")) {
    fail("VSRR plan not generated in page");
  }

  await page.locator("#btnMakeTavi").click();
  await sleep(500);
  const taviPlan = ((await text(page, "planPreview")) || "").trim();
  if (!taviPlan.includes("Plan Type: TAVI") && !taviPlan.includes("方案类型: TAVI")) {
    fail("TAVI plan not generated in page");
  }
  if (
    !taviPlan.includes("Annulus area") &&
    !taviPlan.includes("瓣环面积")
  ) {
    fail("TAVI plan missing annulus sizing outputs");
  }

  const studyId = ((await text(page, "studyId")) || "").trim();
  const dataset = ((await text(page, "datasetName")) || "").trim();
  const phase = ((await text(page, "datasetPhase")) || "").trim();
  const resultPreview = ((await text(page, "resultPreview")) || "").trim();
  if (!resultPreview || resultPreview === "loading..." || resultPreview.includes("RuntimeError:")) {
    fail("result preview not loaded", resultPreview.slice(0, 180));
  }

  await page.screenshot({ path: "runs/e2e_latest.png", fullPage: true });

  const hasCriticalErrors = pageErrors.length > 0 || consoleErrors.length > 0;
  if (hasCriticalErrors) {
    fail(
      "runtime errors detected",
      `pageErrors=${JSON.stringify(pageErrors)}\nconsoleErrors=${JSON.stringify(consoleErrors)}`
    );
  }

  const report = {
    ok: true,
    checked_at: new Date().toISOString(),
    url: URL,
    study_id: studyId,
    dataset,
    phase,
    slice_before: sliceBefore,
    slice_after: sliceAfter,
    zoom_before: zoomBefore,
    zoom_after: zoomAfter,
    recon3d_status: recon3dStatus,
    screenshot: "runs/e2e_latest.png"
  };
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}

run().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
