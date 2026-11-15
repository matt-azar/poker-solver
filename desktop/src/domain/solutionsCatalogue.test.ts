import { describe, expect, it } from "vitest";
import {
  buildSolutionsTree,
  createSolutionsCatalogue,
  joinSolutionsPath,
  normalizeFolderPath,
  relativeSolutionKey,
  SOLUTIONS_CATALOGUE_STORAGE_KEY,
} from "./solutionsCatalogue";

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

describe("solutionsCatalogue helpers", () => {
  it("normalizes folder paths and builds relative keys", () => {
    expect(normalizeFolderPath(" SRP / 100bb \\ ")).toBe("SRP/100bb");
    expect(relativeSolutionKey("SRP/100bb", "Flop probe.psol")).toBe(
      "SRP/100bb/Flop probe.psol",
    );
    expect(relativeSolutionKey("", "spot")).toBe("spot.psol");
    expect(joinSolutionsPath("/data/solutions", "SRP/a.psol")).toBe(
      "/data/solutions/SRP/a.psol",
    );
  });
});

describe("createSolutionsCatalogue", () => {
  it("saves into folders, renames, moves, and rejects collisions per folder", () => {
    const storage = memoryStorage();
    const catalogue = createSolutionsCatalogue(storage);

    expect(catalogue.addFolder("SRP")).toEqual({ ok: true, folder: "SRP" });
    expect(catalogue.addFolder("SRP/100bb")).toEqual({
      ok: true,
      folder: "SRP/100bb",
    });

    const saved = catalogue.save("Flop probe", "/tmp/solutions/SRP/100bb/Flop probe.psol", {
      folder: "SRP/100bb",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) {
      return;
    }
    expect(saved.entry.id.startsWith("user-saved-solution-")).toBe(true);
    expect(catalogue.list()).toHaveLength(1);
    expect(catalogue.listFolders()).toEqual(["SRP", "SRP/100bb"]);

    const collision = catalogue.save(
      "Flop probe",
      "/tmp/solutions/SRP/100bb/other.psol",
      { folder: "SRP/100bb" },
    );
    expect(collision).toMatchObject({
      ok: false,
      reason: "name_collision",
      collidingId: saved.entry.id,
    });

    const otherFolder = catalogue.save(
      "Flop probe",
      "/tmp/solutions/Unfiled/Flop probe.psol",
      { folder: "" },
    );
    expect(otherFolder.ok).toBe(true);

    const renamed = catalogue.rename(saved.entry.id, "Flop wide");
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) {
      return;
    }
    expect(catalogue.get(saved.entry.id)?.displayName).toBe("Flop wide");

    const moved = catalogue.move(saved.entry.id, "SRP");
    expect(moved.ok).toBe(true);
    if (!moved.ok) {
      return;
    }
    expect(moved.entry.folder).toBe("SRP");

    expect(catalogue.remove(saved.entry.id)).toEqual({ ok: true });
    expect(catalogue.list()).toHaveLength(1);
  });

  it("keeps empty folders and blocks removing non-empty ones", () => {
    const catalogue = createSolutionsCatalogue(memoryStorage());
    expect(catalogue.addFolder("Labs")).toMatchObject({ ok: true });
    expect(catalogue.listFolders()).toEqual(["Labs"]);
    expect(catalogue.removeFolder("Labs")).toEqual({
      ok: true,
      folder: "Labs",
    });

    catalogue.addFolder("Keep");
    catalogue.save("A", "/tmp/a.psol", { folder: "Keep" });
    expect(catalogue.removeFolder("Keep")).toMatchObject({
      ok: false,
      reason: "not_empty",
    });
  });

  it("renames folders and rewrites nested entry paths", () => {
    const catalogue = createSolutionsCatalogue(memoryStorage());
    catalogue.addFolder("Old/Child");
    const saved = catalogue.save("Spot", "/tmp/old.psol", { folder: "Old/Child" });
    expect(saved.ok).toBe(true);
    if (!saved.ok) {
      return;
    }
    const renamed = catalogue.renameFolder("Old", "New");
    expect(renamed).toEqual({ ok: true, folder: "New" });
    expect(catalogue.get(saved.entry.id)?.folder).toBe("New/Child");
    expect(catalogue.listFolders()).toEqual(["New", "New/Child"]);
  });

  it("persists and reloads from storage", () => {
    const storage = memoryStorage();
    const first = createSolutionsCatalogue(storage);
    first.addFolder("Cash");
    first.save("100NL", "/data/Cash/100NL.psol", { folder: "Cash" });

    const raw = storage.getItem(SOLUTIONS_CATALOGUE_STORAGE_KEY);
    expect(raw).toBeTruthy();

    const second = createSolutionsCatalogue(storage);
    expect(second.listFolders()).toEqual(["Cash"]);
    expect(second.list()[0]?.displayName).toBe("100NL");
    expect(second.findByPath("/data/Cash/100NL.psol")?.folder).toBe("Cash");
  });
});

describe("buildSolutionsTree", () => {
  it("nests folders and exposes Unfiled", () => {
    const tree = buildSolutionsTree(
      ["SRP", "SRP/100bb"],
      [
        {
          id: "1",
          displayName: "Probe",
          folder: "SRP/100bb",
          path: "/tmp/a.psol",
          dataRevision: "1",
        },
        {
          id: "2",
          displayName: "Loose",
          folder: "",
          path: "/tmp/b.psol",
          dataRevision: "1",
        },
      ],
    );
    expect(tree.map((node) => (node.kind === "folder" ? node.name : ""))).toEqual([
      "SRP",
      "Unfiled",
    ]);
    const srp = tree[0]!;
    expect(srp.kind).toBe("folder");
    if (srp.kind !== "folder") {
      return;
    }
    expect(srp.children).toHaveLength(1);
    expect(srp.children[0]?.kind).toBe("folder");
    const unfiled = tree[1]!;
    expect(unfiled.kind).toBe("folder");
    if (unfiled.kind !== "folder") {
      return;
    }
    expect(unfiled.children[0]?.kind).toBe("file");
  });
});
