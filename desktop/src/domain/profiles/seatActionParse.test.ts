import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composeSpotFromSeatActions } from "./seatActionCompose";
import {
  parseSeatActionFilename,
  seatActionFromTextFile,
} from "./seatActionParse";
import { loadBundledSeatActions } from "./bundledSeatActions";

const here = dirname(fileURLToPath(import.meta.url));
const packDir = join(here, "packs/seat-action");

describe("parseSeatActionFilename", () => {
  it("maps open charts and BB vs CO call/3bet", () => {
    expect(parseSeatActionFilename("CO.txt")).toMatchObject({
      heroPosition: "CO",
      action: "open",
      vsAction: "none",
    });
    expect(parseSeatActionFilename("BU.txt").heroPosition).toBe("BTN");
    expect(parseSeatActionFilename("BBvCOcall.txt")).toMatchObject({
      heroPosition: "BB",
      villainPosition: "CO",
      action: "call",
      vsAction: "open",
    });
    expect(parseSeatActionFilename("BBvCO3bet.txt")).toMatchObject({
      action: "three_bet",
      vsAction: "open",
    });
    expect(parseSeatActionFilename("COvBB3bcall.txt")).toMatchObject({
      heroPosition: "CO",
      villainPosition: "BB",
      action: "call",
      vsAction: "three_bet",
    });
  });

  it("parses HU depth and size variants", () => {
    expect(parseSeatActionFilename("HU2.5.txt").action).toBe("open");
    expect(parseSeatActionFilename("HU3bcall200bb.txt").startingStackBb).toBe(
      200,
    );
  });
});

describe("bundled seat-action pack", () => {
  it("loads Drive Ranges.zip atoms and composes CO vs BB SRP", () => {
    const atoms = loadBundledSeatActions();
    expect(atoms.length).toBeGreaterThanOrEqual(50);
    const coOpen = atoms.find(
      (a) => a.heroPosition === "CO" && a.action === "open",
    );
    const bbCall = atoms.find(
      (a) =>
        a.heroPosition === "BB" &&
        a.action === "call" &&
        a.vsAction === "open" &&
        a.villainPosition === "CO",
    );
    expect(coOpen?.range.length).toBeGreaterThan(10);
    expect(bbCall?.range.length).toBeGreaterThan(10);
    expect(coOpen!.range).not.toEqual(bbCall!.range);

    const composed = composeSpotFromSeatActions(atoms, {
      potType: "SRP",
      oopPosition: "BB",
      ipPosition: "CO",
    });
    expect(composed.missing).toEqual([]);
    expect(composed.oopRange).toBe(bbCall!.range);
    expect(composed.ipRange).toBe(coOpen!.range);
  });

  it("round-trips a raw pack file through seatActionFromTextFile", () => {
    const text = readFileSync(join(packDir, "BBvCOcall.txt"), "utf8");
    const atom = seatActionFromTextFile(
      "BBvCOcall.txt",
      text,
      "packs/seat-action/BBvCOcall.txt",
    );
    expect(atom.id).toContain("bb");
    expect(atom.range.startsWith("JJ")).toBe(true);
  });
});
