import { describe, expect, it } from "vitest";
import { bettingTreeFromDraft } from "./bettingTreeFile";
import {
  BETTING_TREE_CATALOGUE_STORAGE_KEY,
  createBettingTreeCatalogue,
  savedBettingTreeId,
} from "./bettingTreeCatalogue";
import { DEFAULT_SPOT } from "./types";

function memoryStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("bettingTreeCatalogue", () => {
  it("saves with opaque ids, renames in place, and requires replace for collisions", () => {
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
    expect(saved.ok).toBe(true);
    if (!saved.ok) {
      return;
    }
    expect(saved.entry.id).not.toBe(savedBettingTreeId("SRP medium"));
    expect(saved.entry.id.startsWith("user-saved-tree-")).toBe(true);
    expect(catalogue.list()).toHaveLength(1);
    expect(catalogue.get(saved.entry.id)?.document.tree.oopFlop).toBe("33, 75");

    const renamed = catalogue.rename(saved.entry.id, "SRP wide");
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) {
      return;
    }
    expect(renamed.entry.id).toBe(saved.entry.id);
    expect(catalogue.get(saved.entry.id)?.displayName).toBe("SRP wide");

    const collision = catalogue.save("SRP wide", {
      ...document,
      tree: { ...document.tree, oopFlop: "25" },
    });
    expect(collision).toMatchObject({
      ok: false,
      reason: "name_collision",
      collidingId: saved.entry.id,
    });
    expect(catalogue.list()).toHaveLength(1);
    expect(catalogue.list()[0]!.document.tree.oopFlop).toBe("33, 75");

    const replaced = catalogue.save(
      "SRP wide",
      {
        ...document,
        tree: { ...document.tree, oopFlop: "25" },
      },
      { replaceId: saved.entry.id },
    );
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) {
      return;
    }
    expect(replaced.entry.id).toBe(saved.entry.id);
    expect(catalogue.list()).toHaveLength(1);
    expect(catalogue.list()[0]!.document.tree.oopFlop).toBe("25");

    expect(catalogue.remove(saved.entry.id)).toEqual({ ok: true });
    expect(catalogue.list()).toHaveLength(0);
  });

  it("migrates legacy slug ids and re-persists opaque ids", () => {
    const legacyId = savedBettingTreeId("Turn probe");
    const document = bettingTreeFromDraft({ ...DEFAULT_SPOT, oopTurn: "66" });
    const storage = memoryStorage({
      [BETTING_TREE_CATALOGUE_STORAGE_KEY]: JSON.stringify([
        {
          id: legacyId,
          displayName: "Turn probe",
          dataRevision: "abc",
          document,
        },
      ]),
    });
    const catalogue = createBettingTreeCatalogue(storage);
    const entry = catalogue.list()[0]!;
    expect(entry.id).not.toBe(legacyId);
    expect(entry.displayName).toBe("Turn probe");
    const persisted = JSON.parse(
      storage.map.get(BETTING_TREE_CATALOGUE_STORAGE_KEY)!,
    ) as Array<{ id: string }>;
    expect(persisted[0]!.id).toBe(entry.id);
  });

  it("keeps memory unchanged when storage write fails", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    const catalogue = createBettingTreeCatalogue(storage);
    const result = catalogue.save("Will fail", bettingTreeFromDraft(DEFAULT_SPOT));
    expect(result).toMatchObject({ ok: false, reason: "storage" });
    expect(catalogue.list()).toHaveLength(0);

    const okStorage = memoryStorage();
    const durable = createBettingTreeCatalogue(okStorage);
    const first = durable.save("Keep", bettingTreeFromDraft(DEFAULT_SPOT));
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const failing = {
      getItem: (key: string) => okStorage.getItem(key),
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    const live = createBettingTreeCatalogue(failing);
    const before = live.list().map((entry) => entry.id);
    const rename = live.rename(first.entry.id, "Nope");
    expect(rename).toMatchObject({ ok: false, reason: "storage" });
    expect(live.list().map((entry) => entry.id)).toEqual(before);
    expect(live.get(first.entry.id)?.displayName).toBe("Keep");
  });

  it("round-trips through storage", () => {
    const storage = memoryStorage();
    const first = createBettingTreeCatalogue(storage);
    const saved = first.save(
      "Turn probe",
      bettingTreeFromDraft({ ...DEFAULT_SPOT, oopTurn: "66" }),
    );
    expect(saved.ok).toBe(true);
    const second = createBettingTreeCatalogue(storage);
    expect(second.list()).toHaveLength(1);
    expect(second.list()[0]!.document.tree.oopTurn).toBe("66");
  });

  it("rejects blank names", () => {
    const catalogue = createBettingTreeCatalogue(memoryStorage());
    expect(catalogue.save("  ", bettingTreeFromDraft(DEFAULT_SPOT))).toMatchObject({
      ok: false,
      reason: "blank_name",
    });
  });
});
