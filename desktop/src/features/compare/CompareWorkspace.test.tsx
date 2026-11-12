import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStudyIpcFeatureOverridesForTests } from "../../engine/ipcCapabilities";
import { setHttpFallbackTransport, setIpcTransport } from "../../engine/transport";
import type { ComparePayload } from "../../domain/locks";
import type { NodePayload } from "../../domain/types";

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
const { CompareWorkspace } = await import("./CompareWorkspace");

const rootNode: NodePayload = {
  node_id: "root",
  kind: "decision",
  player: 0,
  place: "flop",
  board: ["Ah", "Kd", "7c"],
  pot: 100,
  line: "open",
  actions: ["Check", "Bet 50"],
  children: ["n-check", "n-bet"],
  combos: ["AsAh"],
  marginal: [1],
  reach_defined: true,
  strategy: [[0.4, 0.6]],
};

const validNote: ComparePayload = {
  baseline_id: "base-1",
  scenario_id: "sol-1",
  node_id: "root",
  baseline_value: 0,
  scenario_value: 0,
  value_delta: 0,
  baseline_nash_gap: 0,
  scenario_nash_gap: 0,
  actions: ["Check", "Bet 50"],
  hands: [
    {
      combo: "AsAh",
      locked: false,
      delta: [0.1, -0.1],
      baseline: [0.5, 0.5],
      scenario: [0.4, 0.6],
    },
  ],
};

describe("CompareWorkspace busy state (R12)", () => {
  beforeEach(() => {
    useStudyStore.setState({
      compareNote: null,
      baselineSolutionId: "base-1",
      solutionId: "sol-1",
      currentNode: rootNode,
      message: "",
      loadCompare: vi.fn(async () => {
        useStudyStore.setState({ compareNote: validNote });
      }),
      setWorkspace: vi.fn(),
      navigateTo: vi.fn(async () => undefined),
    });
  });

  afterEach(() => {
    cleanup();
    clearStudyIpcFeatureOverridesForTests();
    setHttpFallbackTransport();
  });

  it("shows an honest unavailable empty when compare lacks IPC", () => {
    setIpcTransport({
      protocol: 2,
      launchId: "test",
      sidecar: "solver-engine",
      workers: 1,
    });
    render(<CompareWorkspace />);
    expect(screen.getByText("Unavailable over IPC")).toBeTruthy();
    expect(screen.getByText(/not available over solver-engine IPC/i)).toBeTruthy();
    expect(useStudyStore.getState().loadCompare).not.toHaveBeenCalled();
  });

  it("re-enables Refresh after a successful auto-load leaves a valid note", async () => {
    render(<CompareWorkspace />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh compare" })).toBeTruthy();
    });

    const refresh = screen.getByRole("button", { name: "Refresh compare" });
    expect(refresh).toHaveProperty("disabled", false);
    expect(screen.queryByRole("button", { name: "Loading…" })).toBeNull();
    expect(useStudyStore.getState().loadCompare).toHaveBeenCalled();
  });

  it("clears Loading after manual Refresh succeeds", async () => {
    useStudyStore.setState({
      compareNote: validNote,
      loadCompare: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        useStudyStore.setState({ compareNote: validNote });
      }),
    });

    render(<CompareWorkspace />);
    const user = userEvent.setup();
    const refresh = screen.getByRole("button", { name: "Refresh compare" });
    await user.click(refresh);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh compare" })).toHaveProperty(
        "disabled",
        false,
      );
    });
  });
});
