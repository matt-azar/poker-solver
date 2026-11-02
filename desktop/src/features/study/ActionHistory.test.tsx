import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const { ActionHistory } = await import("./ActionHistory");

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

describe("ActionHistory path chrome", () => {
  beforeEach(() => {
    useStudyStore.setState({
      currentNode: rootNode,
      draft: { ...useStudyStore.getState().draft, pot: 100 },
      status: { root_node_id: "root", pot: 100 } as never,
      pathTrail: [
        {
          nodeId: "root",
          label: "Root",
          rawLabel: "Root",
          kind: "root",
          street: "flop",
          actor: null,
        },
      ],
      navHistory: [{ nodeId: "root", trail: [] }],
      navHistoryIndex: 0,
      canNavBack: false,
      canNavForward: false,
      goNavBack: vi.fn(async () => undefined),
      goNavForward: vi.fn(async () => undefined),
      jumpTrailIndex: vi.fn(async () => undefined),
      takeTrailAlternative: vi.fn(async () => undefined),
      followAction: vi.fn(async () => undefined),
      layout: { ...useStudyStore.getState().layout, historyHeight: 96 },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders street-grouped path chrome with compact next labels", () => {
    render(<ActionHistory />);
    expect(screen.getByLabelText("Betting path by street")).toBeTruthy();
    expect(screen.getByText("Flop")).toBeTruthy();
    expect(screen.getByText("Root")).toBeTruthy();
    expect(screen.getByText("Ah")).toBeTruthy();
    expect(screen.getByText("OOP to act")).toBeTruthy();
    // Next row keeps b50 compact (not Bet 50%).
    expect(screen.getByText("b50")).toBeTruthy();
    expect(screen.queryByText("Bet 50%")).toBeNull();
    expect(screen.getByLabelText("Back")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Forward")).toHaveProperty("disabled", true);
  });

  it("tags path board cards with four-color suit attributes", () => {
    // Ah / Kd / 7c — diamond must be data-suit=d (blue via --suit-diamond), not
    // lumped with hearts as a two-color "red" path style.
    render(<ActionHistory />);
    expect(screen.getByText("Ah").getAttribute("data-suit")).toBe("h");
    expect(screen.getByText("Kd").getAttribute("data-suit")).toBe("d");
    expect(screen.getByText("7c").getAttribute("data-suit")).toBe("c");
  });

  it("distinguishes fold terminals from showdown", () => {
    useStudyStore.setState({
      currentNode: {
        node_id: "t-fold",
        kind: "terminal",
        folded: 1,
        line: "Bet 50/Fold",
        board: ["Ah", "Kd", "7c"],
        place: "flop",
      },
      pathTrail: [
        {
          nodeId: "t-fold",
          label: "Fold",
          rawLabel: "Fold",
          kind: "terminal",
          street: "flop",
          actor: "IP",
        },
      ],
    });
    render(<ActionHistory />);
    expect(screen.getByText("IP folded")).toBeTruthy();
    expect(screen.getByText("Fold terminal")).toBeTruthy();
    expect(screen.queryByText("Showdown")).toBeNull();
  });

  it("invokes back navigation from the control", async () => {
    const goNavBack = vi.fn(async () => undefined);
    useStudyStore.setState({
      canNavBack: true,
      goNavBack,
    });
    const user = userEvent.setup();
    render(<ActionHistory />);
    await user.click(screen.getByLabelText("Back"));
    expect(goNavBack).toHaveBeenCalledTimes(1);
  });
});
