import { expect, test, type Page } from "@playwright/test";

/**
 * Browser preview Equity Calculator path:
 * Equity workspace → Exact AsAd vs KcKd on river → Calculate → 100% / 0%.
 *
 * The recorded fixture refuses start_equity_job unless method, board, and
 * player ranges match EXPECTED_EQUITY_SUBMISSION (same contract as the Zig smoke).
 */
async function openEquityWorkspace(page: Page): Promise<void> {
  // ≤1280px chrome hides workspace tabs (CSS) but leaves them in the DOM —
  // Study's analysis dock also has an "Equity" tab. Prefer the compact select
  // when visible; otherwise click the workspace tablist button.
  const compact = page.locator(".workspace-switcher__compact select");
  if (await compact.isVisible()) {
    await compact.selectOption("equity");
  } else {
    await page
      .locator('.workspace-switcher__tabs [role="tab"][aria-label="Equity"], .workspace-switcher__tabs [role="tab"]')
      .filter({ hasText: /^Equity$/ })
      .click();
  }
  // Calculator chrome — not Study's analysis "Equity" panel title.
  await expect(page.getByRole("button", { name: "Calculate" })).toBeVisible({
    timeout: 20_000,
  });
}

async function fillExpectedScenario(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Calculate" })).toBeVisible({
    timeout: 20_000,
  });

  await page.locator(".equity-method select").selectOption("exact");

  const board = page.getByLabel("Board");
  await board.fill("2c 3d 7h 9s Jc");
  await board.blur();

  await page.getByRole("textbox", { name: "Player 1 range" }).fill("AsAd");
  await page.getByRole("textbox", { name: "Player 2 range" }).fill("KcKd");
}

async function expectCompletedEquity(page: Page): Promise<void> {
  await expect(page.locator(".equity-status")).toContainText(/completed/i, {
    timeout: 15_000,
  });
  await expect(page.locator("td.equity-emphasis").nth(0)).toHaveText("100.00%");
  await expect(page.locator("td.equity-emphasis").nth(1)).toHaveText("0.00%");
}

test.describe("browser preview: equity calculator", () => {
  test("Equity → Exact AA vs KK river → Calculate paints 100% / 0%", async ({
    page,
  }) => {
    await page.goto("/?preview=equity-calculator");

    await expect(page.getByRole("region", { name: "Browser preview" })).toBeVisible();
    await expect(page.getByText(/Scenario: equity-calculator/)).toBeVisible();
    await expect(page.getByText(/Commit /)).toBeVisible();

    await fillExpectedScenario(page);

    const calculate = page.getByRole("button", { name: "Calculate" });
    await expect(calculate).toBeEnabled({ timeout: 10_000 });
    await calculate.click();

    await expectCompletedEquity(page);

    const lastStart = await page.evaluate(
      () => window.__STUDY_PREVIEW_FIXTURE__?.getLastEquityStart?.() ?? null,
    );
    expect(lastStart).toMatchObject({
      method: "exact",
      board: ["2c", "3d", "7h", "9s", "Jc"],
      players: [
        { id: "p1", range: "AsAd" },
        { id: "p2", range: "KcKd" },
      ],
    });
  });

  test("wrong ranges refuse Calculate via fixture assertion", async ({ page }) => {
    await page.goto("/?preview=equity-calculator");
    await expect(page.getByRole("button", { name: "Calculate" })).toBeVisible({
      timeout: 20_000,
    });

    await page.locator(".equity-method select").selectOption("exact");
    const board = page.getByLabel("Board");
    await board.fill("2c 3d 7h 9s Jc");
    await board.blur();
    // Deliberate regression inputs — fixture must refuse.
    await page.getByRole("textbox", { name: "Player 1 range" }).fill("AhAd");
    await page.getByRole("textbox", { name: "Player 2 range" }).fill("KhKd");

    await page.getByRole("button", { name: "Calculate" }).click();

    await expect(page.locator(".equity-error")).toContainText(
      /start_equity_job refused|unexpected calculator submission/i,
      { timeout: 10_000 },
    );
  });

  test("node-locking preview also serves calculator jobs from Equity workspace", async ({
    page,
  }) => {
    await page.goto("/?preview=node-locking");
    await expect(page.getByRole("region", { name: "Browser preview" })).toBeVisible();

    await openEquityWorkspace(page);
    await fillExpectedScenario(page);
    await page.getByRole("button", { name: "Calculate" }).click();
    await expectCompletedEquity(page);
  });
});
