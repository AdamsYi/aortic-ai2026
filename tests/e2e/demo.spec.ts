import { test, expect } from "@playwright/test";

test("default demo route prefers the real default case when a display-ready real case exists", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.locator("h1")).toContainText("AorticAI");
  await expect(page.locator("#load-showcase")).toBeVisible();
  await expect(page.locator("#load-latest")).toBeVisible();
  await expect(page.locator("#run-annotation")).toBeVisible();
  await expect(page.locator("#focus-coronary")).toBeVisible();
  await expect(page.locator("[data-tool-mode='crosshair']")).toBeVisible();
  await expect(page.locator("[data-tool-mode='windowLevel']")).toBeVisible();
  await expect(page.locator("#window-preset")).toBeVisible();
  await expect(page.locator("#cine-toggle")).toBeVisible();
  await expect(page.locator("#undo-measurement")).toBeVisible();
  await expect(page.locator("#delete-measurement")).toBeVisible();
  await expect(page.locator("#clear-measurements")).toBeVisible();
  await expect(page.locator("#back-to-crosshair")).toBeVisible();
  await expect(page.locator("#measurement-grid .metric-row").first()).toBeVisible();
  await expect(page.locator("#planning-grid .metric-row").first()).toBeVisible();
  await expect(page.locator("#acceptance-summary")).toContainText("Review Required");
  await expect(page.locator("#acceptance-list")).toContainText("Viewing");
  await expect(page.locator("#qa-list")).toBeVisible();
  await expect(page.locator("#annotation-status")).toContainText(/existing auto annotation results|ready|queued|running|completed/i);
  await expect(page.locator("#download-list .download-link").first()).toBeVisible();
  await expect(page.locator("#viewport-axial")).toBeVisible();
  await expect(page.locator("#viewport-sagittal")).toBeVisible();
  await expect(page.locator("#viewport-coronal")).toBeVisible();
  await expect(page.locator("#three-root")).toBeVisible();
  await expect(page.locator("#case-meta")).toContainText(/Latest Real Case|Latest Case Auto Annotation/);
  await expect(page.locator("text=Debug")).toHaveCount(0);
  await expect(page.locator("text=Evidence")).toHaveCount(0);
});

test("reference case remains available as an explicit fallback route", async ({ page }) => {
  await page.goto("/demo?case=showcase");
  await expect(page.locator("#case-overview-summary")).toContainText("Gold Showcase CTA Case", { timeout: 15_000 });
  await expect(page.locator("#planning-grid")).toContainText("TAVI");
  await expect(page.locator("#planning-grid")).toContainText("Recommended Valve Size");
  await expect(page.locator("#planning-grid")).toContainText("Coronary Height");
  await expect(page.locator("#acceptance-summary")).toContainText("Review Required");
  await expect(page.locator("#qa-list")).toContainText("reference");
  await expect(page.locator("#qa-list")).toContainText("Cpr Artifact Missing");
  await expect(page.locator("#capability-grid")).toContainText("unavailable");
  await expect(page.locator("#case-overview-summary")).toContainText("Gold Showcase CTA Case");
});

test("same workstation can switch from showcase to latest case", async ({ page }) => {
  await page.goto("/demo?case=showcase");
  await page.locator("#load-latest").click();
  await expect(page.locator("#case-meta")).toContainText(/Latest Real Case|Latest Case Auto Annotation/);
  await expect(page.locator("#planning-grid .metric-row").first()).toBeVisible();
  await expect(page.locator("#acceptance-summary")).toContainText("Review Required");
  await expect(page.locator("#qa-list .qa-item").first()).toBeVisible();
  await expect(page.locator("#viewport-axial")).toBeVisible();
  await expect(page.locator("#download-list .download-link").first()).toBeVisible();
});

test("latest case stays stable through core viewing interactions", async ({ page }) => {
  await page.goto("/demo");
  await page.locator("#load-latest").click();
  await expect(page.locator("#case-meta")).toContainText(/Latest Real Case|Latest Case Auto Annotation/);
  await expect(page.locator("#acceptance-summary")).toContainText(/Review Required|Pass/);
  await expect(page.locator("#acceptance-list")).not.toContainText("Blocked");
  await expect(page.locator("#header-status")).not.toContainText("MPR unavailable");
  await expect(page.locator("#viewport-footer-axial")).not.toContainText("slice —");
  await expect(page.locator("#viewport-footer-sagittal")).not.toContainText("slice —");
  await expect(page.locator("#viewport-footer-coronal")).not.toContainText("slice —");
  await page.locator("[data-tool-mode='windowLevel']").click();
  await page.locator("#window-preset").selectOption("calcium");
  await page.locator("#viewport-axial").hover({ force: true });
  await page.locator("#viewport-axial").dispatchEvent("wheel", { deltaY: 240 });
  const annulusButton = page.locator("#focus-annulus");
  if (await annulusButton.isEnabled()) {
    await annulusButton.click();
  }
  const coronaryButton = page.locator("#focus-coronary");
  if (await coronaryButton.isEnabled()) {
    await coronaryButton.click();
  }
  await page.locator("#cine-toggle").click({ force: true });
  await expect(page.locator("#mpr-status")).toContainText("cine");
  await page.locator("#cine-toggle").click({ force: true });
  const auxMode = page.locator("#aux-mode");
  if (await auxMode.isVisible()) {
    await auxMode.selectOption("centerline");
  }
  await page.locator("[data-tool-mode='pan']").click();
  await expect(page.locator("#viewport-footer-axial")).not.toContainText("slice —");
  await expect(page.locator("#viewport-footer-sagittal")).not.toContainText("slice —");
  await expect(page.locator("#viewport-footer-coronal")).not.toContainText("slice —");
  await expect(page.locator("#viewport-footer-aux")).not.toContainText("slice —");
  await expect(page.locator("#download-list")).toContainText("Raw CT");
  await expect(page.locator("#acceptance-list")).toContainText("Clinical");
});

test("latest case can rerun annotation on demand and keep the same workstation shell", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.locator("#planning-grid .metric-row").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#case-meta")).toContainText(/Latest Real Case|Latest Case Auto Annotation/, { timeout: 20_000 });
  await expect(page.locator("#annotation-status")).toContainText(/existing auto annotation results|ready/i, { timeout: 20_000 });
  await page.locator("#run-annotation").click();
  await expect(page.locator("#annotation-status")).toContainText(/queued|running|completed/i, { timeout: 20_000 });
  await expect(page.locator("#case-meta")).toContainText("Latest Case Auto Annotation", { timeout: 10_000 });
  await expect(page.locator("#planning-grid .metric-row").first()).toBeVisible();
  await expect(page.locator("#download-list .download-link").first()).toBeVisible();
});
