import { describe, expect, it } from "vitest";
import {
  addCatalogueLine,
  addCataloguePosition,
  hideBundledAtom,
  parseCatalogueLayout,
  renameCatalogueBranch,
  unhideBundledAtom,
} from "./catalogueLayout";

describe("catalogueLayout", () => {
  it("parses empty and partial payloads", () => {
    expect(parseCatalogueLayout(null).extraPositions).toEqual([]);
    expect(parseCatalogueLayout('{"extraPositions":["HJ","hj"]}').extraPositions).toEqual([
      "HJ",
    ]);
  });

  it("renames branches and manages empty folders", () => {
    let layout = parseCatalogueLayout(null);
    layout = renameCatalogueBranch(layout, "HJ", "Hijack");
    expect(layout.renames.HJ).toBe("Hijack");
    layout = addCataloguePosition(layout, "EP");
    layout = addCatalogueLine(layout, "EP", "vs UTG open");
    expect(layout.extraPositions).toContain("EP");
    expect(layout.extraLines.EP).toEqual(["vs UTG open"]);
  });

  it("hides and unhides bundled overrides", () => {
    let layout = hideBundledAtom(parseCatalogueLayout(null), "hj-open");
    expect(layout.hiddenBundledIds).toEqual(["hj-open"]);
    layout = unhideBundledAtom(layout, "hj-open");
    expect(layout.hiddenBundledIds).toEqual([]);
  });
});
