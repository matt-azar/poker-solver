import { describe, expect, it } from "vitest";
import { DEFAULT_SPOT } from "./types";
import {
  BETTING_TREE_FORMAT,
  BETTING_TREE_VERSION,
  bettingTreeFileName,
  bettingTreeFromDraft,
  parseBettingTree,
  serializeBettingTree,
} from "./bettingTreeFile";

describe("bettingTreeFile", () => {
  it("round-trips sizes, caps, and tree edits without board or ranges", () => {
    const draft = {
      ...DEFAULT_SPOT,
      boardText: "Ah Kd 7c",
      oopRange: "AA",
      ipRange: "KK",
      pot: 150,
      stack: 300,
      oopFlop: "33, 75",
      ipFlop: "50",
      oopFlopRaises: "e",
      ipTurn: "66",
      oopRiverDonk: "25",
      potCap: 2,
      mergeThresholdPct: 8,
      noThreeBet: true,
      maxRaises: 2,
      treeEdits: ["force - c", "add-size - 0.33"],
    };
    const document = bettingTreeFromDraft(draft, { name: "SRP medium" });
    expect(document.format).toBe(BETTING_TREE_FORMAT);
    expect(document.version).toBe(BETTING_TREE_VERSION);
    expect(document.name).toBe("SRP medium");
    expect(document.tree.oopFlop).toBe("33, 75");
    expect(document.tree.treeEdits).toEqual(["force - c", "add-size - 0.33"]);
    expect(document.tree).not.toHaveProperty("boardText");
    expect(document.tree).not.toHaveProperty("oopRange");

    const text = serializeBettingTree(document);
    const parsed = parseBettingTree(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.patch.oopFlop).toBe("33, 75");
    expect(parsed.patch.ipFlop).toBe("50");
    expect(parsed.patch.oopFlopRaises).toBe("e");
    expect(parsed.patch.ipTurn).toBe("66");
    expect(parsed.patch.oopRiverDonk).toBe("25");
    expect(parsed.patch.potCap).toBe(2);
    expect(parsed.patch.mergeThresholdPct).toBe(8);
    expect(parsed.patch.noThreeBet).toBe(true);
    expect(parsed.patch.maxRaises).toBe(2);
    expect(parsed.patch.treeEdits).toEqual(["force - c", "add-size - 0.33"]);
    expect(parsed.document.name).toBe("SRP medium");
  });

  it("rejects unknown formats and empty trees", () => {
    expect(parseBettingTree("{").ok).toBe(false);
    expect(
      parseBettingTree(
        JSON.stringify({ format: "other", version: 1, tree: { oopFlop: "50" } }),
      ).ok,
    ).toBe(false);
    expect(
      parseBettingTree(
        JSON.stringify({
          format: BETTING_TREE_FORMAT,
          version: BETTING_TREE_VERSION,
          tree: {},
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseBettingTree(
        JSON.stringify({
          format: BETTING_TREE_FORMAT,
          version: BETTING_TREE_VERSION,
          tree: { treeEdits: "force - c" },
        }),
      ).ok,
    ).toBe(false);
  });

  it("builds a safe download file name", () => {
    expect(bettingTreeFileName("SRP Medium")).toBe("srp-medium.json");
    expect(bettingTreeFileName("  ")).toBe("betting-tree.json");
  });
});
