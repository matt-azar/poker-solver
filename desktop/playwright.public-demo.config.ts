import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PUBLIC_DEMO_E2E_PORT || 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Public precomputed demo gate — serves the static `dist-public-demo` build
 * (separate from private `preview:scenario` / `?preview=`).
 *
 * Projects:
 *   - chromium (desktop) — existing gate
 *   - mobile-chrome-360 / mobile-chrome-390 — touch Chromium (Android Chrome–like)
 *   - mobile-webkit-360 / mobile-webkit-390 — touch WebKit (iPhone Safari–like)
 *
 * Portrait (360×740, 390×844/664) is the primary phone layout under
 * `data-phone-demo` (max-width 540px). Landscape coverage asserts no horizontal
 * scroll after rotating those viewports (short height + coarse pointer also
 * matches the phone MQ). Real device chrome (iOS Safari / Android Chrome) may
 * still differ slightly from Playwright's WebKit/Chromium shells.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/public-demo.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report-public-demo" }],
  ],
  timeout: 90_000,
  expect: { timeout: 20_000 },
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
    {
      name: "mobile-chrome-360",
      use: {
        ...devices["Pixel 5"],
        defaultBrowserType: "chromium",
        viewport: { width: 360, height: 740 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: "mobile-chrome-390",
      use: {
        ...devices["Pixel 5"],
        defaultBrowserType: "chromium",
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: "mobile-webkit-360",
      use: {
        ...devices["iPhone 13"],
        defaultBrowserType: "webkit",
        viewport: { width: 360, height: 740 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: "mobile-webkit-390",
      use: {
        ...devices["iPhone 13"],
        defaultBrowserType: "webkit",
        viewport: { width: 390, height: 664 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: `npm run preview:public-demo -- --port ${PORT}`,
    url: `${BASE_URL}/?demo=flop-explore`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
