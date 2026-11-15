import { expect, test, type Page } from "@playwright/test";

async function waitForRootDecision(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const debug = window.__STUDY_PREVIEW_DEBUG__;
        return Boolean(debug && debug.nodeId === "p0.t-1.r-1");
      });
    })
    .toBe(true);
}

async function openNodeLocking(page: Page): Promise<void> {
  await waitForRootDecision(page);
  await expect(async () => {
    const tree = page.getByRole("button", { name: "Tree" });
    await tree.click();
    await expect(page.getByRole("menuitem", { name: "Node locking…" })).toBeEnabled();
  }).toPass({ timeout: 25_000 });
  await page.getByRole("menuitem", { name: "Node locking…" }).click();
  await expect(page.getByRole("dialog", { name: "Node locking" })).toBeVisible();
}

/**
 * Same scenario as the browser preview URL:
 * Study → Node Locking → one supported frequency slider change → re-solve.
 *
 * The recorded fixture refuses resolve_locked unless put_lock carried the
 * expected node id, scope, and Check frequency≈0.80.
 */
test.describe("browser preview: node locking", () => {
  test("Study → Node Locking → frequency slider → resolve locked", async ({
    page,
  }) => {
    await page.goto("/?preview=node-locking");

    await expect(page.getByRole("region", { name: "Browser preview" })).toBeVisible();
    await expect(page.getByText(/Commit /)).toBeVisible();

    await openNodeLocking(page);

    await page.getByRole("button", { name: "Full node" }).click();

    // One supported slider change: Check → 0.80 (number input drives the same path).
    const checkValue = page.getByRole("spinbutton", { name: "Check frequency value" });
    await checkValue.fill("0.8");
    await checkValue.blur();

    await page.getByRole("button", { name: "Lock all hands" }).click();
    await expect(page.getByText(/Full node lock applied|Locked .* combo/i)).toBeVisible({
      timeout: 10_000,
    });

    const lastLock = await page.evaluate(() => window.__STUDY_PREVIEW_FIXTURE__?.getLastPutLock());
    expect(lastLock?.node_id).toBe("p0.t-1.r-1");
    expect(lastLock?.scope).toBe("node");

    await page
      .getByRole("dialog", { name: "Node locking" })
      .getByRole("button", { name: "Resolve locked" })
      .click();

    // Fixture assert + recorded resolve must succeed for the expected frequencies.
    await expect(page.getByText(/Solve complete|Action EVs ready/i)).toBeVisible({
      timeout: 20_000,
    });
  });

  test("pending-ev reviewer state keeps values pending", async ({ page }) => {
    await page.goto("/?preview=node-locking&state=pending-ev");
    await expect(page.getByRole("region", { name: "Browser preview" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Pending EV", pressed: true }),
    ).toBeVisible();
    await waitForRootDecision(page);
    await expect
      .poll(async () => page.evaluate(() => window.__STUDY_PREVIEW_DEBUG__?.valuesPending === true))
      .toBe(true);
    // EV mode advertises the pending calculation (status poll may overwrite the footer).
    await expect(page.getByRole("button", { name: "EV", exact: true })).toHaveAttribute(
      "title",
      /Calculating action EVs/i,
    );
  });

  test("dropped-connection reviewer state surfaces reconnect UI", async ({ page }) => {
    await page.goto("/?preview=node-locking&state=dropped-connection");
    await expect(page.getByRole("region", { name: "Browser preview" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Dropped connection", pressed: true }),
    ).toBeVisible();
    await expect(page.getByText(/Engine unreachable|Reconnect/i).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("stale EV from node A does not replace node B under test-controlled timing", async ({
    page,
  }) => {
    await page.goto("/?preview=node-locking");
    await expect(page.getByRole("region", { name: "Browser preview" })).toBeVisible();

    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const debug = window.__STUDY_PREVIEW_DEBUG__;
          return Boolean(
            debug &&
              debug.nodeId === "p0.t-1.r-1" &&
              debug.nodeValuesId === "p0.t-1.r-1" &&
              !debug.valuesPending,
          );
        });
      })
      .toBe(true);

    await page.evaluate(() => {
      window.__STUDY_PREVIEW_FIXTURE__?.holdValues("p1.t-1.r-1");
    });

    // A → (back to root) → B, with A's values still held.
    await page.getByRole("button", { name: /^Open Check/i }).click();
    await expect
      .poll(async () => page.evaluate(() => window.__STUDY_PREVIEW_DEBUG__?.nodeId))
      .toBe("p1.t-1.r-1");

    await page.getByRole("button", { name: "Back" }).click();
    await expect
      .poll(async () => page.evaluate(() => window.__STUDY_PREVIEW_DEBUG__?.nodeId))
      .toBe("p0.t-1.r-1");

    // Display label is pot-tag "b50" (chips 50 into pot 100).
    await page.getByRole("button", { name: /^Open b50/i }).click();
    await expect
      .poll(async () => page.evaluate(() => window.__STUDY_PREVIEW_DEBUG__?.nodeId))
      .toBe("p2.t-1.r-1");

    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const debug = window.__STUDY_PREVIEW_DEBUG__;
          return Boolean(
            debug &&
              debug.nodeId === "p2.t-1.r-1" &&
              debug.nodeValuesId === "p2.t-1.r-1" &&
              !debug.valuesPending &&
              typeof debug.nodeEv === "number" &&
              debug.nodeEv > 30,
          );
        });
      })
      .toBe(true);

    const evBeforeRelease = await page.evaluate(
      () => window.__STUDY_PREVIEW_DEBUG__?.nodeEv ?? null,
    );

    await page.evaluate(() => {
      window.__STUDY_PREVIEW_FIXTURE__?.releaseValues("p1.t-1.r-1");
    });
    // Allow any late apply to race; B must stay.
    await page.waitForTimeout(400);

    const after = await page.evaluate(() => window.__STUDY_PREVIEW_DEBUG__);
    expect(after?.nodeId).toBe("p2.t-1.r-1");
    expect(after?.nodeValuesId).toBe("p2.t-1.r-1");
    expect(after?.nodeEv).toBe(evBeforeRelease);
    expect(after?.nodeEv).toBeGreaterThan(30);
  });
});
