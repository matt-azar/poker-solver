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

test.describe("public demo (precomputed packs)", () => {
  test("flop: child node → combo → freqs/EV match export; lazy root load", async ({
    page,
  }) => {
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
    await page.locator('button.matrix-cell[data-empty="false"]').first().click();
    await expect(page.getByRole("region", { name: "Hands" })).toBeVisible();

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
  });

  test("river: baseline → lock preset freqs/EV match export", async ({
    page,
  }) => {
    await page.goto("/?demo=river-lock");
    await waitForDemoNode(page, { exampleId: "river-lock", nodeId: ROOT });

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

    await expect(
      page.getByRole("link", { name: "Download for Windows" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/matt-azar/poker-solver/releases/latest/download/Holdem-Study-windows-x64-setup.exe",
    );
  });
});
