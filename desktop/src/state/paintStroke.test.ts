import { beforeEach, describe, expect, it } from "vitest";
import { blankGrid } from "../domain/range";
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

const { useStudyStore } = await import("./studyStore");

describe("range paint strokes", () => {
  beforeEach(() => {
    useStudyStore.getState().endPaintStroke();
    useStudyStore.setState({
      weights: { oop: blankGrid(), ip: blankGrid() },
      draft: { ...DEFAULT_SPOT, oopRange: "", ipRange: "" },
      paintWeight: 1,
    });
  });

  it("paints multiple cells in one undoable stroke", () => {
    const store = useStudyStore.getState();
    store.setPaintWeight(0.5);
    store.beginPaintStroke("oop", 0, 0);
    store.continuePaintStroke("oop", 0, 1);
    store.continuePaintStroke("oop", 0, 2);
    store.endPaintStroke();

    const painted = useStudyStore.getState();
    expect(painted.weights.oop[0][0]).toBe(0.5);
    expect(painted.weights.oop[0][1]).toBe(0.5);
    expect(painted.weights.oop[0][2]).toBe(0.5);
    expect(painted.canUndoRange).toBe(true);

    painted.undoRange();
    const undone = useStudyStore.getState();
    expect(undone.weights.oop[0][0]).toBe(0);
    expect(undone.weights.oop[0][1]).toBe(0);
    expect(undone.weights.oop[0][2]).toBe(0);
  });

  it("keeps the first-cell toggle weight for the whole stroke", () => {
    useStudyStore.setState({
      weights: {
        oop: blankGrid().map((row, r) => row.map((_, c) => (r === 1 && c === 1 ? 1 : 0))),
        ip: blankGrid(),
      },
      paintWeight: 1,
    });

    const store = useStudyStore.getState();
    store.beginPaintStroke("oop", 1, 1);
    store.continuePaintStroke("oop", 1, 2);
    store.continuePaintStroke("oop", 1, 3);
    store.endPaintStroke();

    const painted = useStudyStore.getState();
    expect(painted.weights.oop[1][1]).toBe(0);
    expect(painted.weights.oop[1][2]).toBe(0);
    expect(painted.weights.oop[1][3]).toBe(0);
  });

  it("ignores continue strokes for the other player", () => {
    const store = useStudyStore.getState();
    store.beginPaintStroke("oop", 2, 2);
    store.continuePaintStroke("ip", 2, 3);
    store.endPaintStroke();

    const painted = useStudyStore.getState();
    expect(painted.weights.oop[2][2]).toBe(1);
    expect(painted.weights.ip[2][3]).toBe(0);
  });
});
