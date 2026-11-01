import { describe, expect, it } from "vitest";
import { rankNearestNeighbors } from "./nearest";
import type { RangeProfile } from "./types";

function profile(partial: {
  id: string;
  stack: number;
  classification?: RangeProfile["provenance"]["classification"];
  ip?: string;
}): RangeProfile {
  return {
    schemaVersion: 1,
    id: partial.id,
    dataRevision: "1",
    displayName: partial.id,
    format: "cash_6max",
    playerCount: 6,
    positions: { oop: "BB", ip: partial.ip ?? "CO" },
    preflopActions: [
      { position: "CO", kind: "open", sizeBb: 2.5 },
      { position: "BB", kind: "call", sizeBb: 1.5 },
    ],
    startingStackBb: partial.stack,
    blinds: { sb: 0.5, bb: 1 },
    rake: { rate: 0, cap: 0, collection: "none", known: true },
    labels: { stakes: "cEV" },
    ranges: { oop: "AA", ip: "KK" },
    provenance: {
      source: "test",
      classification: partial.classification ?? "population_estimate",
    },
  };
}

describe("rankNearestNeighbors", () => {
  it("ranks closer stacks ahead and demotes synthetic fixtures slightly", () => {
    const catalogue = [
      profile({ id: "syn-100", stack: 100, classification: "synthetic_fixture" }),
      profile({ id: "real-150", stack: 150 }),
      profile({ id: "real-200", stack: 200 }),
      profile({ id: "other-ip", stack: 170, ip: "BTN" }),
    ];
    const ranked = rankNearestNeighbors(
      {
        potType: "SRP",
        positions: { oop: "BB", ip: "CO" },
        stackBb: 170,
        stakesLabel: "cEV",
      },
      catalogue,
    );
    expect(ranked[0]?.profile.id).toBe("real-150");
    expect(ranked.map((r) => r.profile.id)).toContain("real-200");
    expect(ranked.find((r) => r.profile.id === "other-ip")!.distance).toBeGreaterThan(
      ranked.find((r) => r.profile.id === "real-150")!.distance,
    );
  });
});
