import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodePayload } from "../../domain/types";
import engineChanceRiverDeal from "../../domain/fixtures/engine-chance-river-deal.json";

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
const { ContextStrip } = await import("./ContextStrip");

const riverDeal = engineChanceRiverDeal as NodePayload;

describe("ContextStrip board card selector", () => {
  beforeEach(() => {
    useStudyStore.setState({
      currentNode: riverDeal,
      draft: { ...useStudyStore.getState().draft, boardText: "", pot: 100, stack: 200 },
      status: { pot: 100, stack: 200, board: riverDeal.board } as never,
      phase: "complete",
      solutionId: "s1",
      boardChangeChanceNode: null,
      boardChangeStreet: null,
      pathTrail: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("opens the river selector on arrival and keeps the empty slot blank", async () => {
    const user = userEvent.setup();
    render(<ContextStrip />);

    expect(
      await screen.findByRole("dialog", { name: /river card picker/i }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Select a river card" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "R" })).toBeNull();
    expect(screen.queryByRole("button", { name: "T" })).toBeNull();
    expect(screen.getByRole("button", { name: "Select a river card" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /create build spot/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Solve" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(screen.getByText("x/x")).toBeTruthy();
    expect(screen.queryByText("Check/Check")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("opens again when a later deal node is reached", async () => {
    render(<ContextStrip />);
    expect(
      await screen.findByRole("heading", { name: "Select a river card" }),
    ).toBeTruthy();

    useStudyStore.setState({
      currentNode: {
        node_id: "n-flop",
        kind: "decision",
        board: ["Ah", "Kd", "7c"],
        player: 0,
        pot: 50,
      },
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    useStudyStore.setState({
      currentNode: {
        ...riverDeal,
        node_id: "n:turn-deal",
        board: ["Ah", "Kd", "7c"],
      },
    });
    expect(
      await screen.findByRole("heading", { name: "Select a turn card" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "T" })).toBeNull();
  });

  it("shows the line column as pot-fraction abbreviations split by street", () => {
    useStudyStore.setState({
      currentNode: {
        node_id: "n-river-check",
        kind: "decision",
        board: ["Ah", "Kd", "7c", "2s", "3h"],
        place: "river",
        player: 1,
        pot: 140,
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
    render(<ContextStrip />);
    expect(screen.getByText("x/b20/c - x/b50/c - x/x")).toBeTruthy();
    expect(
      screen.queryByText("Check/Bet 10/Call/Check/Bet 35/Call/Check/Check"),
    ).toBeNull();
  });
});
