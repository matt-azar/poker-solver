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
});
