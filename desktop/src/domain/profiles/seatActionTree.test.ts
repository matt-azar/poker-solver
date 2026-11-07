import { describe, expect, it } from "vitest";
import {
  buildSeatActionTree,
  mergeAtomsForCatalogueTree,
} from "./seatActionTree";
import type { SeatActionRange } from "./seatActionTypes";

function atom(
  partial: Pick<
    SeatActionRange,
    "id" | "displayName" | "heroPosition" | "action" | "vsAction"
  > &
    Partial<SeatActionRange>,
): SeatActionRange {
  return {
    schemaVersion: 1,
    range: "AA",
    dataRevision: "1",
    provenance: { source: "test", classification: "synthetic_fixture" },
    villainPosition: undefined,
    ...partial,
  };
}

describe("buildSeatActionTree", () => {
  it("nests positions then preflop lines", () => {
    const tree = buildSeatActionTree([
      atom({
        id: "bb-call",
        displayName: "BB call vs CO open",
        heroPosition: "BB",
        villainPosition: "CO",
        action: "call",
        vsAction: "open",
      }),
      atom({
        id: "bb-3b",
        displayName: "BB 3bet vs CO open",
        heroPosition: "BB",
        villainPosition: "CO",
        action: "three_bet",
        vsAction: "open",
      }),
      atom({
        id: "co-open",
        displayName: "CO open",
        heroPosition: "CO",
        action: "open",
        vsAction: "none",
      }),
    ]);

    expect(tree.map((node) => node.label)).toEqual(["CO", "BB"]);
    const co = tree[0]!;
    expect(co.kind).toBe("branch");
    if (co.kind !== "branch") return;
    expect(co.children).toHaveLength(1);
    expect(co.children[0]).toMatchObject({ kind: "leaf", label: "Open" });

    const bb = tree[1]!;
    expect(bb.kind).toBe("branch");
    if (bb.kind !== "branch") return;
    expect(bb.children.map((child) => child.label)).toEqual(["vs CO open"]);
    const vsOpen = bb.children[0]!;
    expect(vsOpen.kind).toBe("branch");
    if (vsOpen.kind !== "branch") return;
    expect(vsOpen.children.map((child) => child.label)).toEqual([
      "BB call vs CO open",
      "BB 3bet vs CO open",
    ]);
  });

  it("keeps empty custom positions and applies renames", () => {
    const tree = buildSeatActionTree([], {
      extraPositions: ["EP"],
      renames: { EP: "Early", "EP-open": "RFI" },
    });
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      kind: "branch",
      id: "EP",
      label: "Early",
    });
    if (tree[0]?.kind !== "branch") return;
    expect(tree[0].children[0]).toMatchObject({
      kind: "branch",
      id: "EP-open",
      label: "RFI",
      children: [],
    });
  });
});

describe("mergeAtomsForCatalogueTree", () => {
  it("lets a filed user save override the bundled slot", () => {
    const bundled = atom({
      id: "hj",
      displayName: "HJ open",
      heroPosition: "HJ",
      action: "open",
      vsAction: "none",
      range: "AA,KK",
    });
    const user = atom({
      id: "user-saved-hj",
      displayName: "My HJ open",
      heroPosition: "HJ",
      action: "open",
      vsAction: "none",
      range: "QQ+",
    });
    const merged = mergeAtomsForCatalogueTree([bundled, user], {
      isUserImport: (id) => id.startsWith("user-"),
    });
    expect(merged.atoms.map((entry) => entry.id)).toEqual(["user-saved-hj"]);
    expect(merged.overriddenUserIds.has("user-saved-hj")).toBe(true);
  });

  it("drops hidden bundled ids and skips unfiled USER saves", () => {
    const bundled = atom({
      id: "co",
      displayName: "CO open",
      heroPosition: "CO",
      action: "open",
      vsAction: "none",
    });
    const unfiled = atom({
      id: "user-saved-misc",
      displayName: "Misc",
      heroPosition: "USER",
      action: "unknown",
      vsAction: "none",
    });
    const merged = mergeAtomsForCatalogueTree([bundled, unfiled], {
      isUserImport: (id) => id.startsWith("user-"),
      hiddenBundledIds: ["co"],
    });
    expect(merged.atoms).toEqual([]);
  });
});
