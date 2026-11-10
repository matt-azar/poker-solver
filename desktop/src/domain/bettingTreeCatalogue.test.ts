import { describe, expect, it } from "vitest";
import { bettingTreeFromDraft } from "./bettingTreeFile";
import {
  createBettingTreeCatalogue,
  savedBettingTreeId,
} from "./bettingTreeCatalogue";
import { DEFAULT_SPOT } from "./types";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("bettingTreeCatalogue", () => {
  it("saves, lists, opens, renames, and removes named trees", () => {
    const storage = memoryStorage();
    const catalogue = createBettingTreeCatalogue(storage);
    const document = bettingTreeFromDraft({
      ...DEFAULT_SPOT,
      oopFlop: "33, 75",
      ipFlop: "50",
      potCap: 2,
      treeEdits: ["force - c"],
    });

    const saved = catalogue.save("SRP medium", document);
    expect(saved.id).toBe(savedBettingTreeId("SRP medium"));
    expect(catalogue.list()).toHaveLength(1);
    expect(catalogue.get(saved.id)?.document.tree.oopFlop).toBe("33, 75");

    const renamed = catalogue.rename(saved.id, "SRP wide");
    expect(renamed?.id).toBe(savedBettingTreeId("SRP wide"));
    expect(catalogue.get(saved.id)).toBeUndefined();
    expect(catalogue.get(renamed!.id)?.displayName).toBe("SRP wide");

    // Same-name save overwrites.
    catalogue.save("SRP wide", {
      ...document,
      tree: { ...document.tree, oopFlop: "25" },
    });
    expect(catalogue.list()).toHaveLength(1);
    expect(catalogue.list()[0]!.document.tree.oopFlop).toBe("25");

    expect(catalogue.remove(renamed!.id)).toBe(true);
    expect(catalogue.list()).toHaveLength(0);
  });

  it("round-trips through storage", () => {
    const storage = memoryStorage();
    const first = createBettingTreeCatalogue(storage);
    first.save(
      "Turn probe",
      bettingTreeFromDraft({ ...DEFAULT_SPOT, oopTurn: "66" }),
    );
    const second = createBettingTreeCatalogue(storage);
    expect(second.list()).toHaveLength(1);
    expect(second.list()[0]!.document.tree.oopTurn).toBe("66");
  });

  it("rejects blank names", () => {
    const catalogue = createBettingTreeCatalogue(memoryStorage());
    expect(() =>
      catalogue.save("  ", bettingTreeFromDraft(DEFAULT_SPOT)),
    ).toThrow(/name/i);
  });
});
