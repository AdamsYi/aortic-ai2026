import { test, expect } from "@playwright/test";

test("default showcase case renders full first-screen workstation", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.locator("h1")).toContainText("AorticAI");
  await expect(page.locator("#measurement-grid .metric-row").first()).toBeVisible();
  await expect(page.locator("#planning-grid .metric-row").first()).toBeVisible();
  await expect(page.locator("#qa-list")).toBeVisible();
  await expect(page.locator("#download-list .download-link").first()).toBeVisible();
  await expect(page.locator("#viewport-axial")).toBeVisible();
  await expect(page.locator("#viewport-sagittal")).toBeVisible();
  await expect(page.locator("#viewport-coronal")).toBeVisible();
  await expect(page.locator("#three-root")).toBeVisible();
});

test("default showcase case displays success and failure states together", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.locator("#planning-grid")).toContainText("TAVI");
  await expect(page.locator("#planning-grid")).toContainText("null");
  await expect(page.locator("#qa-list")).toContainText("placeholder");
  await expect(page.locator("#qa-list")).toContainText("cpr_artifact_missing");
});
