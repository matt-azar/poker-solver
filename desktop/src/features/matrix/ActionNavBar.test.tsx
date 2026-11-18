import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
const { ActionNavBar } = await import("./ActionNavBar");

const followAction = vi.fn(async () => undefined);

function seedNode(overrides?: Partial<NodePayload>) {
  const node: NodePayload = {
    node_id: "n1",
    kind: "decision",
    player: 0,
    pot: 100,
    actions: ["Check", "Bet 36", "Bet 62"],
    children: ["n-check", "n-b36", "n-b62"],
    combos: ["AsAh"],
    marginal: [1],
    reach_defined: true,
    strategy: [[0.2, 0.3, 0.5]],
    ...overrides,
  };
  useStudyStore.setState({
    currentNode: node,
    status: {
      pot: 100,
      root_node_id: "n1",
    } as never,
    draft: { ...useStudyStore.getState().draft, pot: 100 },
    followAction,
  });
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getState().settings,
      betSizeDisplay: "pot",
    },
  });
}

describe("ActionNavBar", () => {
  beforeEach(() => {
    followAction.mockClear();
    seedNode();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders compact action navigation chips with formatted labels", () => {
    render(<ActionNavBar />);
    const nav = screen.getByRole("group", { name: "Action navigation" });
    expect(nav).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Check" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open b36" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open b62" })).toBeTruthy();
  });

  it("calls followAction with the child node id when a chip is clicked", () => {
    render(<ActionNavBar />);
    fireEvent.click(screen.getByRole("button", { name: "Open b36" }));
    expect(followAction).toHaveBeenCalledWith("n-b36");
  });

  it("disables chips that have no child node", () => {
    seedNode({
      children: ["n-check", null as unknown as string, "n-b62"],
    });
    render(<ActionNavBar />);
    expect(
      (screen.getByRole("button", { name: "Open Check" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Open b36" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Open b62" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("renders nothing when the node has no actions", () => {
    seedNode({ actions: [], children: [] });
    const { container } = render(<ActionNavBar />);
    expect(container.firstChild).toBeNull();
  });
});
