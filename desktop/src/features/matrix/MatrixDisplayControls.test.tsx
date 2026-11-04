import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMatrixDisplayStore } from "../../domain/matrixDisplay";

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

const loadEquity = vi.fn(async () => undefined);
const calculateEv = vi.fn(async () => undefined);

const { useStudyStore } = await import("../../state/studyStore");
const { MatrixDisplayControls } = await import("./MatrixDisplayControls");

describe("MatrixDisplayControls", () => {
  beforeEach(() => {
    loadEquity.mockClear();
    calculateEv.mockClear();
    useMatrixDisplayStore.getState().resetPrefs();
    useStudyStore.setState({
      currentNode: {
        node_id: "n1",
        reach_defined: true,
        actions: ["Check"],
        combos: ["AhAd"],
        marginal: [1],
        strategy: [[1]],
      },
      equity: null,
      nodeValues: null,
      loadEquity,
      calculateEv,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("toggles weight fill and selects overlay", () => {
    render(<MatrixDisplayControls />);
    const fill = screen.getByRole("button", { name: "Weight fill" });
    expect(fill.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(fill);
    expect(useMatrixDisplayStore.getState().prefs.rangeWeightHeightFill).toBe(true);

    const select = screen.getByLabelText("Overlay");
    fireEvent.change(select, { target: { value: "equity" } });
    expect(useMatrixDisplayStore.getState().prefs.cellOverlay).toBe("equity");
    expect(screen.getByRole("button", { name: "Load Eq" })).toBeTruthy();
  });
});
