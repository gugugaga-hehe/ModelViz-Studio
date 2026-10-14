import { defineConfig, devices } from "@playwright/test";

const port = 5199;

/** Seam B: browser smoke tests against a real server serving the built web app. */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm --filter @modelviz/server start",
    url: `http://127.0.0.1:${port}`,
    env: { MODELVIZ_PORT: String(port) },
    reuseExistingServer: false,
  },
});
