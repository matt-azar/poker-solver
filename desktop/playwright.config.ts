import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PREVIEW_E2E_PORT || 5173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Browser preview scenario gate. Attaches a Playwright trace on failure.
 * Serves the Vite app with recorded fixture IPC (`?preview=node-locking`).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `${BASE_URL}/?preview=node-locking`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
