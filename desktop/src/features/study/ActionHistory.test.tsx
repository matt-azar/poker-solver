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

const { useSettingsStore } = await import("../../state/settingsStore");
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
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        betSizeDisplay: "both",
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders street-grouped path chrome without a duplicate Next action row", () => {
    render(<ActionHistory />);
    expect(screen.getByLabelText("Betting path by street")).toBeTruthy();
    expect(screen.getByText("Flop")).toBeTruthy();
    expect(screen.getByText("Root")).toBeTruthy();
    expect(screen.getByText("Ah")).toBeTruthy();
    expect(screen.getByText("OOP to act")).toBeTruthy();
    expect(screen.queryByLabelText("Next actions")).toBeNull();
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
    expect(screen.getByText("IP folded").getAttribute("data-terminal")).toBe("fold");
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

  it("abbreviates the path and separates streets with a spaced dash", () => {
    useStudyStore.setState({
      currentNode: {
        ...rootNode,
        node_id: "n-river-check",
        board: ["Ah", "Kd", "7c", "2s", "3h"],
        place: "river",
        player: 1,
        line: "Check/Bet 10/Call/Check/Bet 35/Call/Check/Check",
      },
      pathTrail: [
        {
          nodeId: "root",
          label: "Root",
          rawLabel: "Root",
          kind: "root",
          street: "flop",
          actor: null,
        },
        {
          nodeId: "n-x",
          label: "Check",
          rawLabel: "Check",
          kind: "action",
          street: "flop",
          actor: "OOP",
        },
        {
          nodeId: "n-b",
          label: "Bet 10",
          rawLabel: "Bet 10",
          kind: "action",
          street: "flop",
          actor: "IP",
          sizePot: 50,
          toCall: 0,
        },
        {
          nodeId: "n-c",
          label: "Call",
          rawLabel: "Call",
          kind: "action",
          street: "flop",
          actor: "OOP",
        },
        {
          nodeId: "n-turn",
          label: "2s",
          rawLabel: "2s",
          kind: "card",
          street: "turn",
          actor: null,
          card: "2s",
        },
        {
          nodeId: "n-tx",
          label: "Check",
          rawLabel: "Check",
          kind: "action",
          street: "turn",
          actor: "OOP",
        },
        {
          nodeId: "n-tb",
          label: "Bet 35",
          rawLabel: "Bet 35",
          kind: "action",
          street: "turn",
          actor: "IP",
          sizePot: 70,
          toCall: 0,
        },
        {
          nodeId: "n-tc",
          label: "Call",
          rawLabel: "Call",
          kind: "action",
          street: "turn",
          actor: "OOP",
        },
        {
          nodeId: "n-rx",
          label: "Check",
          rawLabel: "Check",
          kind: "action",
          street: "river",
          actor: "OOP",
        },
        {
          nodeId: "n-river-check",
          label: "Check",
          rawLabel: "Check",
          kind: "action",
          street: "river",
          actor: "IP",
        },
      ],
    });
    render(<ActionHistory />);
    expect(
      screen.getByLabelText("Betting path by street").getAttribute("data-path"),
    ).toBe("x/b20/c - x/b50/c - x/x");
    const path = screen.getByLabelText("Betting path by street");
    expect(path.textContent).toContain(" - ");
    expect(path.textContent).toContain("/");
    expect(screen.getByText("b20")).toBeTruthy();
    expect(screen.getByText("b50")).toBeTruthy();
    expect(screen.getAllByText("x").length).toBeGreaterThan(0);
  });

  it("keeps pot-fraction path tags when bet size display is chips", () => {
    useStudyStore.setState({
      pathTrail: [
        {
          nodeId: "root",
          label: "Root",
          rawLabel: "Root",
          kind: "root",
          street: "flop",
          actor: null,
        },
        {
          nodeId: "n-bet",
          label: "b100",
          rawLabel: "Bet 100",
          kind: "action",
          street: "flop",
          actor: "OOP",
          sizePot: 100,
          toCall: 0,
        },
      ],
      currentNode: {
        ...rootNode,
        node_id: "n-bet",
        player: 1,
        pot: 200,
        to_call: 100,
        line: "Bet 100",
        actions: ["Fold", "Call", "Raise to 400"],
        children: ["n-f", "n-c", "n-r"],
        strategy: [[0.2, 0.3, 0.5]],
      },
    });

    const { rerender } = render(<ActionHistory />);
    expect(screen.getByText("b100")).toBeTruthy();

    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        betSizeDisplay: "chips",
      },
    });
    rerender(<ActionHistory />);
    expect(screen.getByText("b100")).toBeTruthy();
    expect(screen.queryByText("100.0 chips")).toBeNull();
  });
});
