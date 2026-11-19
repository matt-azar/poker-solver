import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const { clampDockHeight } = await import("../../state/layoutStore");
const { RangeMatrix, fitAspectSize, SINGLE_MATRIX_WIDTH_OVER_HEIGHT } = await import(
  "./RangeMatrix"
);

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

  it("fills the stage when ratio is 0 (single-matrix Cursor-minimal)", () => {
    expect(fitAspectSize(900, 400, 0)).toEqual({ width: 900, height: 400 });
  });

  it("fills full height in a taller box when width is the constraint", () => {
    expect(fitAspectSize(300, 400, SINGLE_MATRIX_WIDTH_OVER_HEIGHT)).toEqual({
      width: 300,
      height: 400,
    });
  });

  it("fills full height in a wider box and keeps the 1.5 aspect", () => {
    expect(fitAspectSize(900, 400, SINGLE_MATRIX_WIDTH_OVER_HEIGHT)).toEqual({
      width: 600,
      height: 400,
    });
  });

  it("fills a square stage completely rather than shrinking height for 1.5", () => {
    expect(fitAspectSize(400, 400, SINGLE_MATRIX_WIDTH_OVER_HEIGHT)).toEqual({
      width: 400,
      height: 400,
    });
  });
});

describe("RangeMatrix single-layout size", () => {
  afterEach(() => {
    cleanup();
    useStudyStore.getState().setLayout({ dualRange: false, matrixWidth: null });
  });

  it("fills the stage width and height when the opponent grid is hidden", () => {
    useStudyStore.getState().setLayout({ dualRange: false });
    useStudyStore.setState({ currentNode: null });
    const restore = stubStageBox(900, 400);
    try {
      render(<RangeMatrix />);
      const wrap = document.querySelector(".range-matrix-wrap") as HTMLElement;
      expect(wrap.getAttribute("data-fill-stage")).toBe("true");
      expect(wrap.style.width).toBe("100%");
      const grid = screen.getByRole("grid", { name: /Hand range matrix/ });
      expect(grid.style.width).toBe("100%");
      expect(grid.style.height).toBe("100%");
      expect(
        screen.queryByRole("separator", { name: "Resize range matrix" }),
      ).toBeNull();
    } finally {
      restore();
    }
  });

  it("still fills a tall narrow stage instead of leaving a side gutter", () => {
    useStudyStore.getState().setLayout({ dualRange: false });
    useStudyStore.setState({ currentNode: null });
    const restore = stubStageBox(320, 480);
    try {
      render(<RangeMatrix />);
      const grid = screen.getByRole("grid", { name: /Hand range matrix/ });
      expect(grid.style.width).toBe("100%");
      expect(grid.style.height).toBe("100%");
    } finally {
      restore();
    }
  });

  it("keeps the main grid square while the opponent grid is shown", () => {
    // setLayout keeps layoutStore + studyStore in sync (setState alone does not).
    useStudyStore.getState().setLayout({ dualRange: true, matrixWidth: null });
    useStudyStore.setState({ currentNode: null });
    const restore = stubStageBox(900, 400);
    try {
      render(<RangeMatrix />);
      const wrap = document.querySelector(".range-matrix-wrap") as HTMLElement;
      expect(wrap.getAttribute("data-fill-stage")).toBe("false");
      const grid = screen.getByRole("grid", { name: /Hand range matrix/ });
      expect(grid.style.width).toBe("400px");
      expect(grid.style.height).toBe("400px");
    } finally {
      restore();
    }
  });

  it("drops the A–2 axis labels and still shows ranks inside cells", () => {
    useStudyStore.getState().setLayout({ dualRange: false, matrixWidth: null });
    useStudyStore.setState({ currentNode: null });
    render(<RangeMatrix />);
    expect(document.querySelectorAll(".range-matrix .matrix-axis")).toHaveLength(0);
    expect(document.querySelector(".matrix-corner")).toBeNull();
    expect(screen.getByText("AA")).toBeTruthy();
    expect(screen.getByText("AKs")).toBeTruthy();
    expect(
      screen.queryByRole("separator", { name: "Resize range matrix" }),
    ).toBeNull();
  });

  it("resizes a dual-range matrix when the handle is dragged", () => {
    useStudyStore.getState().setLayout({ dualRange: true, matrixWidth: null });
    useStudyStore.setState({ currentNode: null });
    render(<RangeMatrix />);
    const handle = screen.getByRole("separator", { name: "Resize range matrix" });
    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 420 });
    fireEvent.pointerUp(window);
    expect(useStudyStore.getState().layout.matrixWidth).toBe(420);
    const wrap = document.querySelector(".range-matrix-wrap") as HTMLElement;
    expect(wrap.style.width).toBe("420px");
    const grid = screen.getByRole("grid", { name: /Hand range matrix/ });
    expect(grid.style.width).toBe("100%");
    expect(grid.style.height).toBe("100%");
  });

  it("stops the dual-range column split at the top of the open analysis dock", () => {
    useStudyStore.getState().setLayout({
      dualRange: true,
      lowerDock: true,
      lowerDockHeight: 240,
    });
    render(<RangeMatrix />);
    const handle = screen.getByRole("separator", { name: "Resize range matrix" });
    expect(handle.style.bottom).toBe(`${clampDockHeight(240)}px`);
  });

  it("hides the single-matrix width handle when the dock is closed", () => {
    useStudyStore.getState().setLayout({
      dualRange: false,
      lowerDock: false,
      lowerDockHeight: 240,
    });
    render(<RangeMatrix />);
    expect(
      screen.queryByRole("separator", { name: "Resize range matrix" }),
    ).toBeNull();
  });
});
