import { beforeEach, describe, expect, it } from "vitest";
import { useValueBluffsHighlightStore } from "./valueBluffsHighlightStore";

describe("valueBluffsHighlightStore", () => {
  beforeEach(() => {
    useValueBluffsHighlightStore.getState().setHighlightCells(null);
  });

  it("starts inactive", () => {
    expect(useValueBluffsHighlightStore.getState().highlightCells).toBeNull();
  });

  it("publishes and clears matrix cell labels", () => {
    const cells = new Set(["AKo", "76s"]);
    useValueBluffsHighlightStore.getState().setHighlightCells(cells);
    expect(useValueBluffsHighlightStore.getState().highlightCells).toBe(cells);
    useValueBluffsHighlightStore.getState().setHighlightCells(null);
    expect(useValueBluffsHighlightStore.getState().highlightCells).toBeNull();
  });
});
