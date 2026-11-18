import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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

const { useStudyStore } = await import("../../state/studyStore");
const { LowerDock } = await import("./LowerDock");

describe("LowerDock tabs", () => {
  afterEach(() => {
    cleanup();
    useStudyStore.setState({
      analysisTab: "equity",
      layout: { ...useStudyStore.getState().layout, lowerDock: false },
    });
  });

  it("shows Compare runouts when the board has alternate deals", () => {
    useStudyStore.setState({
      analysisTab: "equity",
      currentNode: {
        node_id: "p0.t0.r-1",
        kind: "decision",
        board: ["Ah", "Kd", "7c", "2s"],
      },
      layout: { ...useStudyStore.getState().layout, lowerDock: false },
    });
    render(<LowerDock />);
    expect(screen.getByRole("tab", { name: "Compare runouts" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Range equity" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Runouts" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Runouts" })).toBeNull();
  });

  it("hides Compare runouts on flop-only boards without chance fan-out", () => {
    useStudyStore.setState({
      analysisTab: "equity",
      currentNode: {
        node_id: "p0.t-1.r-1",
        kind: "decision",
        board: ["Ah", "Kd", "7c"],
      },
      boardChangeChanceNode: null,
      lineCardReport: null,
      layout: { ...useStudyStore.getState().layout, lowerDock: false },
    });
    render(<LowerDock />);
    expect(screen.queryByRole("tab", { name: "Compare runouts" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Range equity" })).toBeTruthy();
  });

  it("sends a stored Runouts tab to Range equity", async () => {
    useStudyStore.setState({
      // Legacy persisted tab id — migrate off after dock removal.
      analysisTab: "runouts" as "equity",
      currentNode: {
        node_id: "p0.t0.r-1",
        kind: "decision",
        board: ["Ah", "Kd", "7c", "2s"],
      },
      layout: { ...useStudyStore.getState().layout, lowerDock: false },
    });
    render(<LowerDock />);
    await waitFor(() => {
      expect(useStudyStore.getState().analysisTab).toBe("equity");
    });
    expect(screen.queryByRole("tab", { name: "Runouts" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Range equity" })).toBeTruthy();
  });
});
