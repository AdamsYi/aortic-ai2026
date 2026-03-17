import { defineConfig } from "@playwright/test";

const port = Number(process.env.PORT || 4173);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
  },
  webServer: {
    command: `node --import tsx tests/support/demoServer.ts`,
    port,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
