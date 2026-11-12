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

  it("shows Compare runouts and does not keep a Runouts tab", () => {
    useStudyStore.setState({
      analysisTab: "equity",
      layout: { ...useStudyStore.getState().layout, lowerDock: false },
    });
    render(<LowerDock />);
    expect(screen.getByRole("tab", { name: "Compare runouts" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Runouts" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Runouts" })).toBeNull();
  });

  it("sends a stored Runouts tab to Equity", async () => {
    useStudyStore.setState({
      // Legacy persisted tab id — migrate off after dock removal.
      analysisTab: "runouts" as "equity",
      layout: { ...useStudyStore.getState().layout, lowerDock: false },
    });
    render(<LowerDock />);
    await waitFor(() => {
      expect(useStudyStore.getState().analysisTab).toBe("equity");
    });
    expect(screen.queryByRole("tab", { name: "Runouts" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Compare runouts" })).toBeTruthy();
  });
});
