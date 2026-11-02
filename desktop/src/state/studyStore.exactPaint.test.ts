import { beforeEach, describe, expect, it } from "vitest";
import { blankGrid, parseExactRange } from "../domain/range";
import { DEFAULT_SPOT } from "../domain/types";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }),
});

const { resetRangeEditHistoryForTests, useStudyStore } = await import("./studyStore");

function resetSeats() {
  resetRangeEditHistoryForTests();
  useStudyStore.setState({
    weights: { oop: blankGrid(), ip: blankGrid() },
    draft: { ...DEFAULT_SPOT, oopRange: "", ipRange: "" },
    paintWeight: 1,
    canUndoRange: false,
    canRedoRange: false,
  });
}

describe("exact paint / undo preserves suit-specific ranges (R02)", () => {
  beforeEach(() => {
    resetSeats();
  });

  it("AsAd:0.5,KK + paint QQ keeps AsAd:0.5; undo restores exact original (oop)", () => {
    const store = useStudyStore.getState();
    store.setRangeText("oop", "AsAd:0.5,KK");

    expect(useStudyStore.getState().draft.oopRange).toBe("AsAd:0.5,KK");
    expect(useStudyStore.getState().weights.oop[0][0]).toBeCloseTo(0.5 / 6, 12);

    store.setPaintWeight(1);
    store.paintCell("oop", 2, 2); // QQ

    const painted = useStudyStore.getState();
    expect(painted.draft.oopRange).toContain("AsAd:0.5");
    expect(painted.draft.oopRange).toMatch(/\bKK\b/);
    expect(painted.draft.oopRange).toMatch(/\bQQ\b/);
    expect(painted.draft.oopRange).not.toMatch(/\bAA\b/);
    expect(painted.weights.oop[2][2]).toBe(1);
    expect(painted.weights.oop[0][0]).toBeCloseTo(0.5 / 6, 12);

    const exact = parseExactRange(painted.draft.oopRange).range;
    expect(exact.get("AsAd")).toBeCloseTo(0.5, 12);

    painted.undoRange();
    const undone = useStudyStore.getState();
    expect(undone.draft.oopRange).toBe("AsAd:0.5,KK");
    expect(parseExactRange(undone.draft.oopRange).range.get("AsAd")).toBeCloseTo(0.5, 12);
    expect(undone.weights.oop[2][2]).toBe(0);
    expect(undone.weights.oop[0][0]).toBeCloseTo(0.5 / 6, 12);
  });

  it("preserves exact tokens for IP seat paint + undo", () => {
    const store = useStudyStore.getState();
    store.setRangeText("ip", "AsAd:0.5,KK");
    store.paintCell("ip", 2, 2);

    const painted = useStudyStore.getState();
    expect(painted.draft.ipRange).toContain("AsAd:0.5");
    expect(painted.draft.ipRange).toMatch(/\bQQ\b/);
    expect(painted.draft.oopRange).toBe("");

    painted.undoRange();
    expect(useStudyStore.getState().draft.ipRange).toBe("AsAd:0.5,KK");
  });

  it("multi-cell stroke preserves unrelated exact combos and undoes as one entry", () => {
    const store = useStudyStore.getState();
    store.setRangeText("oop", "AsAd:0.5,KK");
    store.setPaintWeight(0.5);
    store.beginPaintStroke("oop", 2, 2); // QQ
    store.continuePaintStroke("oop", 3, 3); // JJ
    store.continuePaintStroke("oop", 4, 4); // TT
    store.endPaintStroke();

    const painted = useStudyStore.getState();
    expect(painted.draft.oopRange).toContain("AsAd:0.5");
    expect(painted.draft.oopRange).toMatch(/\bKK\b/);
    expect(painted.draft.oopRange).toContain("QQ:0.5");
    expect(painted.draft.oopRange).toContain("JJ:0.5");
    expect(painted.draft.oopRange).toContain("TT:0.5");
    expect(painted.weights.oop[2][2]).toBeCloseTo(0.5, 12);
    expect(painted.weights.oop[3][3]).toBeCloseTo(0.5, 12);
    expect(painted.weights.oop[4][4]).toBeCloseTo(0.5, 12);

    painted.undoRange();
    const undone = useStudyStore.getState();
    expect(undone.draft.oopRange).toBe("AsAd:0.5,KK");
    expect(undone.weights.oop[2][2]).toBe(0);
    expect(undone.weights.oop[3][3]).toBe(0);
    expect(undone.weights.oop[4][4]).toBe(0);
  });

  it("clear then undo restores exact range text", () => {
    const store = useStudyStore.getState();
    store.setRangeText("oop", "AsAd:0.5,KK");
    store.clearRange("oop");
    expect(useStudyStore.getState().draft.oopRange).toBe("");
    useStudyStore.getState().undoRange();
    expect(useStudyStore.getState().draft.oopRange).toBe("AsAd:0.5,KK");
  });

  it("redo restores painted exact text after undo", () => {
    const store = useStudyStore.getState();
    store.setRangeText("oop", "AsAd:0.5,KK");
    store.paintCell("oop", 2, 2);
    const paintedText = useStudyStore.getState().draft.oopRange;
    useStudyStore.getState().undoRange();
    useStudyStore.getState().redoRange();
    expect(useStudyStore.getState().draft.oopRange).toBe(paintedText);
    expect(useStudyStore.getState().draft.oopRange).toContain("AsAd:0.5");
  });
});
