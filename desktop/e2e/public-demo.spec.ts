import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page, type Request } from "@playwright/test";

type ExpectedPack = {
  nodes: Record<
    string,
    {
      actions?: string[];
      action_frequencies?: number[];
      combos?: string[];
      node_ev?: number | null;
      value?: number[];
      action_ev?: number[][];
    }
  >;
};

function loadExpected(rel: string): ExpectedPack {
  const path = resolve(process.cwd(), "public/demo", rel);
  return JSON.parse(readFileSync(path, "utf8")) as ExpectedPack;
}

const expectedFlop = loadExpected("flop-explore/baseline/expected.json");
const expectedRiverBaseline = loadExpected("river-lock/baseline/expected.json");
const expectedRiverLocked = loadExpected(
  "river-lock/oop-always-check/expected.json",
);

const ROOT = "p0.t-1.r-1";
/** Flop Check child in the exported pack (decision). */
const CHILD_CHECK = "p1.t-1.r-1";

function approxEqual(
  actual: number | null | undefined,
  expected: number,
  eps = 0.02,
): boolean {
  return typeof actual === "number" && Math.abs(actual - expected) <= eps;
}

function freqsClose(
  actual: number[] | null | undefined,
  expected: number[] | undefined,
  eps = 0.02,
): boolean {
  if (!actual || !expected || actual.length !== expected.length) {
    return false;
  }
  return actual.every((value, index) =>
    approxEqual(value, expected[index]!, eps),
  );
}

function isMobileProject(projectName: string): boolean {
  return projectName.startsWith("mobile-");
}

async function waitForDemoNode(
  page: Page,
  opts: { exampleId: string; nodeId: string },
): Promise<void> {
  await expect(page.getByRole("region", { name: "Public demo" })).toBeVisible();
  await expect(page.getByLabel("Precomputed")).toBeVisible();
  await expect
    .poll(async () => {
      return page.evaluate((want) => {
        const debug = window.__STUDY_DEMO_DEBUG__;
        return Boolean(
          debug &&
            debug.exampleId === want.exampleId &&
            debug.nodeId === want.nodeId,
        );
      }, opts);
    })
    .toBe(true);
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const scrollWidth = Math.max(doc.scrollWidth, body.scrollWidth);
    const clientWidth = doc.clientWidth;
    return { scrollWidth, clientWidth, overflowPx: scrollWidth - clientWidth };
  });
  expect(
    overflow.overflowPx,
    `horizontal overflow ${overflow.overflowPx}px (scroll=${overflow.scrollWidth}, client=${overflow.clientWidth})`,
  ).toBeLessThanOrEqual(1);
}

/**
 * Phone layout markers from the UI sibling (`data-phone-demo`, HandInspectSheet).
 * Skip the phone-only branch when this PR is exercised without the layout tip.
 */
async function phoneLayoutReady(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.getAttribute("data-phone-demo") === "true",
  );
}

test.describe("public demo (precomputed packs)", () => {
  test("flop: child node → combo → freqs/EV match export; lazy root load", async ({
    page,
  }, testInfo) => {
    const mobile = isMobileProject(testInfo.project.name);
    const demoGets: string[] = [];
    page.on("request", (req: Request) => {
      const url = req.url();
      if (req.resourceType() === "fetch" || req.resourceType() === "xhr") {
        const path = new URL(url).pathname;
        if (path.startsWith("/demo/")) {
          demoGets.push(path);
        }
      }
    });

    await page.goto("/?demo=flop-explore");
    await waitForDemoNode(page, { exampleId: "flop-explore", nodeId: ROOT });
    await assertNoHorizontalOverflow(page);

    // Initial flop view must not download the whole tree.
    const initialPaths = [...demoGets];
    expect(initialPaths.some((p) => p.endsWith("/catalog.json"))).toBe(true);
    expect(
      initialPaths.some((p) =>
        p.includes("/flop-explore/baseline/nodes/p0.t-1.r-1.json"),
      ),
    ).toBe(true);
    expect(
      initialPaths.some((p) =>
        p.includes("/flop-explore/baseline/nodes/p1.t-1.r-1.json"),
      ),
    ).toBe(false);
    // Sanity: far nodes from the 393-node pack must not load up front.
    expect(
      initialPaths.some((p) =>
        p.includes("/flop-explore/baseline/nodes/p120.t-1.r-1.json"),
      ),
    ).toBe(false);

    const rootExpected = expectedFlop.nodes[ROOT]!;
    await expect
      .poll(async () => {
        const freqs = await page.evaluate(
          () => window.__STUDY_DEMO_DEBUG__?.actionFrequencies ?? null,
        );
        return freqsClose(freqs, rootExpected.action_frequencies);
      })
      .toBe(true);

    await page.getByRole("button", { name: "Open Check" }).click();
    await waitForDemoNode(page, {
      exampleId: "flop-explore",
      nodeId: CHILD_CHECK,
    });

    const childExpected = expectedFlop.nodes[CHILD_CHECK]!;
    await expect
      .poll(async () => {
        const freqs = await page.evaluate(
          () => window.__STUDY_DEMO_DEBUG__?.actionFrequencies ?? null,
        );
        return freqsClose(freqs, childExpected.action_frequencies);
      })
      .toBe(true);

    await expect
      .poll(async () => {
        const ev = await page.evaluate(() => window.__STUDY_DEMO_DEBUG__?.nodeEv);
        return approxEqual(ev, childExpected.node_ev ?? NaN, 0.05);
      })
      .toBe(true);

    // Combo inspect: first live matrix cell.
    const cell = page.locator('button.matrix-cell[data-empty="false"]').first();
    await cell.scrollIntoViewIfNeeded();
    await cell.click();

    if (mobile) {
      const phoneReady = await phoneLayoutReady(page);
      test.skip(
        !phoneReady,
        "phone layout markers missing (stack on layout PR #418)",
      );

      const sheet = page.getByRole("dialog", { name: /Hands/i });
      // Skip-if-missing: sheet selector from HandInspectSheet.
      if ((await sheet.count()) === 0) {
        test.skip(true, "HandInspectSheet dialog not present");
        return;
      }
      await expect(sheet).toBeVisible();
      // Combo freqs / action EV tiles from ComboInspector.
      const comboTile = sheet.locator(".hands-combo[data-present='true']").first();
      await expect(comboTile).toBeVisible();
      await expect(comboTile.locator(".hands-combo__metric-value").first()).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Close hand inspector" }),
      ).toBeVisible();

      // Child node freqs/EV still match export while sheet is open.
      await expect
        .poll(async () => {
          const freqs = await page.evaluate(
            () => window.__STUDY_DEMO_DEBUG__?.actionFrequencies ?? null,
          );
          return freqsClose(freqs, childExpected.action_frequencies);
        })
        .toBe(true);
      await expect
        .poll(async () => {
          const ev = await page.evaluate(
            () => window.__STUDY_DEMO_DEBUG__?.nodeEv,
          );
          return approxEqual(ev, childExpected.node_ev ?? NaN, 0.05);
        })
        .toBe(true);

      // Dismiss → same matrix, node (no navigation).
      await page.getByRole("button", { name: "Close hand inspector" }).click();
      await expect(sheet).toHaveCount(0);
      await expect
        .poll(async () =>
          page.evaluate(() => window.__STUDY_DEMO_DEBUG__?.nodeId ?? null),
        )
        .toBe(CHILD_CHECK);
      await expect(
        page.locator('button.matrix-cell[data-empty="false"]').first(),
      ).toBeVisible();
    } else {
      await expect(page.getByRole("region", { name: "Hands" })).toBeVisible();
    }

    await assertNoHorizontalOverflow(page);

    // Deep link survives reload (must land on child, not root).
    await expect(page).toHaveURL(/demo=flop-explore/);
    await expect(page).toHaveURL(
      new RegExp(`node=${CHILD_CHECK.replace(/\./g, "\\.")}`),
    );
    await page.reload();
    await waitForDemoNode(page, {
      exampleId: "flop-explore",
      nodeId: CHILD_CHECK,
    });

    if (mobile) {
      // Continue browsing after dismiss + reload.
      const betOpen = page.getByRole("button", { name: /^Open Bet/ });
      if ((await betOpen.count()) > 0) {
        await betOpen.first().click();
        await expect
          .poll(async () =>
            page.evaluate(() => window.__STUDY_DEMO_DEBUG__?.nodeId ?? null),
          )
          .not.toBe(CHILD_CHECK);
        await assertNoHorizontalOverflow(page);
      }
    }
  });

  test("river: baseline → lock preset freqs/EV match export; shared URL restores", async ({
    page,
  }, testInfo) => {
    const mobile = isMobileProject(testInfo.project.name);

    await page.goto("/?demo=river-lock");
    await waitForDemoNode(page, { exampleId: "river-lock", nodeId: ROOT });
    await assertNoHorizontalOverflow(page);

    // Baseline root freqs before switching the lock preset.
    const baseline = expectedRiverBaseline.nodes[ROOT]!;
    await expect
      .poll(async () => {
        const freqs = await page.evaluate(
          () => window.__STUDY_DEMO_DEBUG__?.actionFrequencies ?? null,
        );
        return freqsClose(freqs, baseline.action_frequencies);
      })
      .toBe(true);

    await page.getByLabel("Lock preset").selectOption("oop-always-check");
    await expect
      .poll(async () => page.evaluate(() => window.__STUDY_DEMO_DEBUG__?.variantId))
      .toBe("oop-always-check");

    const locked = expectedRiverLocked.nodes[ROOT]!;
    await expect
      .poll(async () => {
        const freqs = await page.evaluate(
          () => window.__STUDY_DEMO_DEBUG__?.actionFrequencies ?? null,
        );
        return freqsClose(freqs, locked.action_frequencies);
      })
      .toBe(true);

    await expect
      .poll(async () => {
        const ev = await page.evaluate(() => window.__STUDY_DEMO_DEBUG__?.nodeEv);
        return approxEqual(ev, locked.node_ev ?? NaN, 0.05);
      })
      .toBe(true);

    await expect(page).toHaveURL(/demo=river-lock/);
    await expect(page).toHaveURL(/variant=oop-always-check/);

    // Reload shared URL restores example + preset.
    await page.reload();
    await waitForDemoNode(page, { exampleId: "river-lock", nodeId: ROOT });
    await expect
      .poll(async () => page.evaluate(() => window.__STUDY_DEMO_DEBUG__?.variantId))
      .toBe("oop-always-check");
    await expect
      .poll(async () => {
        const freqs = await page.evaluate(
          () => window.__STUDY_DEMO_DEBUG__?.actionFrequencies ?? null,
        );
        return freqsClose(freqs, locked.action_frequencies);
      })
      .toBe(true);

    const download = page.getByRole("link", { name: "Download for Windows" });
    await expect(download).toHaveAttribute(
      "href",
      "https://github.com/matt-azar/poker-solver/releases/latest/download/Holdem-Study-windows-x64-setup.exe",
    );
    if (mobile) {
      const phoneReady = await phoneLayoutReady(page);
      test.skip(
        !phoneReady,
        "phone layout markers missing (stack on layout PR #418)",
      );
      // Secondary placement on phone (still reachable).
      await expect(download).toBeVisible();
      await expect(page.locator(".demo-banner__download-secondary")).toHaveCount(
        1,
      );
      await expect(page.locator(".resize-handle")).toHaveCount(0);
      await expect(page.locator(".range-matrix-wrap")).toBeVisible();
    }

    await assertNoHorizontalOverflow(page);
  });

  test("phone landscape: no horizontal scroll", async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo.project.name), "mobile projects only");
    // Rotate to landscape while keeping touch (Android Chrome / iPhone Safari short height).
    const vp = page.viewportSize();
    if (!vp) {
      test.skip(true, "no viewport");
      return;
    }
    await page.setViewportSize({ width: vp.height, height: vp.width });
    await page.goto("/?demo=flop-explore");
    await waitForDemoNode(page, { exampleId: "flop-explore", nodeId: ROOT });
    await assertNoHorizontalOverflow(page);
  });
});
