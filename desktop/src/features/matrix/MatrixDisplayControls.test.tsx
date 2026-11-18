import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const ensureNodeAnalysis = vi.fn(async () => undefined);

const { useStudyStore } = await import("../../state/studyStore");
const { MatrixDisplayControls } = await import("./MatrixDisplayControls");

describe("MatrixDisplayControls", () => {
  beforeEach(() => {
    loadEquity.mockClear();
    calculateEv.mockClear();
    ensureNodeAnalysis.mockClear();
    useMatrixDisplayStore.getState().resetPrefs();
    useStudyStore.setState({
      solutionId: "sol-1",
      matrixMode: "strategy",
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
      ensureNodeAnalysis,
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
  });

  it("auto-loads equity when equity overlay is selected", async () => {
    render(<MatrixDisplayControls />);
    fireEvent.change(screen.getByLabelText("Overlay"), {
      target: { value: "equity" },
    });
    await waitFor(() => {
      expect(loadEquity).toHaveBeenCalled();
    });
    expect(calculateEv).not.toHaveBeenCalled();
    expect(ensureNodeAnalysis).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Load Eq" })).toBeNull();
  });

  it("auto-loads EV when EV overlay is selected", async () => {
    render(<MatrixDisplayControls />);
    fireEvent.change(screen.getByLabelText("Overlay"), {
      target: { value: "ev" },
    });
    await waitFor(() => {
      expect(calculateEv).toHaveBeenCalled();
    });
    expect(loadEquity).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Load EV" })).toBeNull();
  });

  it("uses the selection owner when EV+Eq overlay needs both metrics", async () => {
    render(<MatrixDisplayControls />);
    fireEvent.change(screen.getByLabelText("Overlay"), {
      target: { value: "both" },
    });
    await waitFor(() => {
      expect(ensureNodeAnalysis).toHaveBeenCalled();
    });
    expect(loadEquity).not.toHaveBeenCalled();
    expect(calculateEv).not.toHaveBeenCalled();
  });

  it("does not auto-resubmit a permanent equity work-limit error", async () => {
    useStudyStore.setState({
      equity: {
        pending: false,
        error: "equity work limit exceeded",
        node_id: "n1",
        solution_id: "sol-1",
      },
    });
    useMatrixDisplayStore.getState().setCellOverlay("equity");
    render(<MatrixDisplayControls />);
    await waitFor(() => {
      expect(screen.getByLabelText("Overlay")).toBeTruthy();
    });
    expect(loadEquity).not.toHaveBeenCalled();
    expect(ensureNodeAnalysis).not.toHaveBeenCalled();
  });

  it("auto-loads EV when matrix mode is EV", async () => {
    useStudyStore.setState({ matrixMode: "ev" });
    render(<MatrixDisplayControls />);
    await waitFor(() => {
      expect(calculateEv).toHaveBeenCalled();
    });
    expect(loadEquity).not.toHaveBeenCalled();
  });

  it("does not reload when equity for the live node is already ready", async () => {
    useStudyStore.setState({
      equity: { pending: false, node_id: "n1", solution_id: "sol-1" },
    });
    useMatrixDisplayStore.getState().setCellOverlay("equity");
    render(<MatrixDisplayControls />);
    await waitFor(() => {
      expect(screen.getByLabelText("Overlay")).toBeTruthy();
    });
    expect(loadEquity).not.toHaveBeenCalled();
  });
});
