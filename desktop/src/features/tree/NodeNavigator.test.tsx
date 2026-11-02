import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
const { NodeNavigator } = await import("./NodeNavigator");

const decisionNode: NodePayload = {
  node_id: "p0.t-1.r-1.a1",
  kind: "decision",
  player: 0,
  place: "flop",
  board: ["Ah", "Kd", "7c"],
  line: "Bet 50",
  actions: ["Check", "Bet 50"],
  children: ["n-check", "n-bet"],
};

describe("NodeNavigator diagnostics", () => {
  beforeEach(() => {
    useStudyStore.setState({
      currentNode: decisionNode,
      pathTrail: [
        {
          nodeId: "p0.t-1.r-1",
          label: "Root",
          rawLabel: "Root",
          kind: "root",
          street: "flop",
          actor: null,
        },
        {
          nodeId: "p0.t-1.r-1.a1",
          label: "b50",
          rawLabel: "Bet 50",
          kind: "action",
          street: "flop",
          actor: "OOP",
        },
      ],
      status: { root_node_id: "p0.t-1.r-1" } as never,
      layout: { ...useStudyStore.getState().layout, leftNav: true },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not list raw child node ids as a competing navigator", () => {
    render(<NodeNavigator />);
    expect(screen.getByLabelText("Node diagnostics")).toBeTruthy();
    expect(screen.queryByText("n-check")).toBeNull();
    expect(screen.queryByText("n-bet")).toBeNull();
    expect(screen.getByText(/Path navigation lives in the Path strip/i)).toBeTruthy();
    expect(screen.getByText("unavailable")).toBeTruthy();
  });

  it("exposes truncated node id only in diagnostics", () => {
    render(<NodeNavigator />);
    expect(screen.getByTitle(decisionNode.node_id)).toBeTruthy();
    expect(screen.getByText("Jump to Root")).toBeTruthy();
  });
});
