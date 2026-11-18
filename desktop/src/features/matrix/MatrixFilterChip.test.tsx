import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
const { MatrixFilterChip } = await import("./MatrixFilterChip");

function seedNode() {
  const node: NodePayload = {
    node_id: "n1",
    kind: "decision",
    player: 0,
    pot: 100,
    actions: ["Check", "Bet 33", "Bet 75"],
    children: ["n-check", "n-b33", "n-b75"],
    combos: ["AsAh"],
    marginal: [1],
    reach_defined: true,
    strategy: [[0.2, 0.3, 0.5]],
  };
  useStudyStore.setState({
    currentNode: node,
    status: { pot: 100, root_node_id: "n1" } as never,
    draft: { ...useStudyStore.getState().draft, pot: 100 },
    actionFilter: 1,
  });
}

describe("MatrixFilterChip", () => {
  beforeEach(() => {
    seedNode();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the active filter with dim cutoff and clears in one click", () => {
    render(<MatrixFilterChip />);
    expect(screen.getByRole("status").textContent).toMatch(/Filter b33/);
    expect(screen.getByRole("status").textContent).toMatch(/freq ≥ 2%/);
    fireEvent.click(screen.getByRole("button", { name: "Clear action filter" }));
    expect(useStudyStore.getState().actionFilter).toBeNull();
  });

  it("renders nothing when no filter is active", () => {
    useStudyStore.setState({ actionFilter: null });
    const { container } = render(<MatrixFilterChip />);
    expect(container.firstChild).toBeNull();
  });
});
