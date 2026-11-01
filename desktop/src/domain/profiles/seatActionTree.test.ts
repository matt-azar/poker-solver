import { describe, expect, it } from "vitest";
import { buildSeatActionTree } from "./seatActionTree";
import type { SeatActionRange } from "./seatActionTypes";

function atom(partial: Pick<SeatActionRange, "id" | "displayName" | "heroPosition" | "action" | "vsAction"> &
  Partial<SeatActionRange>): SeatActionRange {
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
});
