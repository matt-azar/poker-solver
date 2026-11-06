import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fitAspectSize, SINGLE_MATRIX_WIDTH_OVER_HEIGHT } from "./RangeMatrix";

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

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);

const { useStudyStore } = await import("../../state/studyStore");
const { RangeMatrix } = await import("./RangeMatrix");

function stubStageBox(width: number, height: number) {
  const proto = HTMLElement.prototype;
  const widthDesc = Object.getOwnPropertyDescriptor(proto, "clientWidth");
  const heightDesc = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  Object.defineProperty(proto, "clientWidth", {
    configurable: true,
    get() {
      return (this as HTMLElement).classList?.contains("range-matrix-stage") ? width : 0;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).classList?.contains("range-matrix-stage") ? height : 0;
    },
  });
  return () => {
    if (widthDesc) {
      Object.defineProperty(proto, "clientWidth", widthDesc);
    } else {
      Reflect.deleteProperty(proto, "clientWidth");
    }
    if (heightDesc) {
      Object.defineProperty(proto, "clientHeight", heightDesc);
    } else {
      Reflect.deleteProperty(proto, "clientHeight");
    }
  };
}

describe("fitAspectSize", () => {
  it("keeps a square inside the shorter side", () => {
    expect(fitAspectSize(420, 380, 1)).toEqual({ width: 380, height: 380 });
  });

  it("fits a 1.5-wide rectangle into a taller box by shrinking height", () => {
    expect(fitAspectSize(300, 400, SINGLE_MATRIX_WIDTH_OVER_HEIGHT)).toEqual({
      width: 300,
      height: 200,
    });
  });

  it("fits a 1.5-wide rectangle into a wider box by using full height", () => {
    expect(fitAspectSize(900, 400, SINGLE_MATRIX_WIDTH_OVER_HEIGHT)).toEqual({
      width: 600,
      height: 400,
    });
  });
});

describe("RangeMatrix single-layout size", () => {
  afterEach(() => {
    cleanup();
  });

  it("draws the main grid 1.5× as wide as it is tall when the opponent grid is hidden", () => {
    useStudyStore.setState({
      layout: { ...useStudyStore.getState().layout, dualRange: false },
      currentNode: null,
    });
    const restore = stubStageBox(900, 400);
    try {
      render(<RangeMatrix />);
      const grid = screen.getByRole("grid", { name: /Hand range matrix/ });
      expect(grid.style.width).toBe("600px");
      expect(grid.style.height).toBe("400px");
    } finally {
      restore();
    }
  });

  it("keeps the main grid square while the opponent grid is shown", () => {
    useStudyStore.setState({
      layout: { ...useStudyStore.getState().layout, dualRange: true },
      currentNode: null,
    });
    const restore = stubStageBox(900, 400);
    try {
      render(<RangeMatrix />);
      const grid = screen.getByRole("grid", { name: /Hand range matrix/ });
      expect(grid.style.width).toBe("400px");
      expect(grid.style.height).toBe("400px");
    } finally {
      restore();
    }
  });
});
