import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodePayload } from "../../domain/types";
import { blankGrid } from "../../domain/range";

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

class ResizeObserverMock {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: target.getBoundingClientRect(),
        } as ResizeObserverEntry,
      ],
      this,
    );
  }
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);

const { useStudyStore } = await import("../../state/studyStore");
const { OpponentRangePanel } = await import("./OpponentRangePanel");

function seedOpponentNode(overrides: Partial<NodePayload> = {}): NodePayload {
  return {
    node_id: "p0",
    kind: "decision",
    player: 0,
    reach_defined: true,
    actions: ["Check"],
    combos: ["AhAd", "AsAc", "AsAh"],
    reach: [1, 1, 1],
    marginal: [1 / 3, 1 / 3, 1 / 3],
    strategy: [[1], [1], [1]],
    opponent_player: 1,
    opponent_combos: ["KhKd", "KsKc", "KsKh"],
    opponent_reach: [1, 1, 1],
    opponent_marginal: [1 / 3, 1 / 3, 1 / 3],
    ...overrides,
  };
}

describe("OpponentRangePanel", () => {
  beforeEach(() => {
    useStudyStore.setState({
      currentNode: seedOpponentNode(),
      // Deliberately wrong Build weights — panel must ignore these.
      weights: {
        oop: blankGrid(),
        ip: blankGrid().map((row, r) =>
          row.map((_, c) => (r === 1 && c === 1 ? 0.33 : 0)),
        ),
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows clear IP seat title from opponent_player", () => {
    render(<OpponentRangePanel />);
    expect(screen.getByRole("heading", { name: "IP range" })).toBeTruthy();
    expect(
      screen.getByRole("grid", { name: /IP solution range/ }),
    ).toBeTruthy();
  });

  it("shows OOP when opponent_player is 0", () => {
    useStudyStore.setState({
      currentNode: seedOpponentNode({ player: 1, opponent_player: 0 }),
    });
    render(<OpponentRangePanel />);
    expect(screen.getByRole("heading", { name: "OOP range" })).toBeTruthy();
  });

  it("renders KK inclusion 100 from opponent_reach, not KK33 from marginal", () => {
    render(<OpponentRangePanel />);
    const cells = screen.getAllByRole("gridcell");
    const kk = cells.find((el) => {
      const hand = el.querySelector(".matrix-cell__hand");
      return hand?.textContent === "KK";
    });
    expect(kk).toBeTruthy();
    const hand = within(kk!).getByText("KK");
    const pct = within(kk!).getByText("100");
    expect(hand.className).toContain("matrix-cell__hand");
    expect(pct.className).toContain("matrix-cell__sub");
    // Hand class and % stay in separate nodes (no concatenated KK33 text).
    expect(kk!.textContent).toBe("KK100");
    expect(kk!.getAttribute("data-measure")).toBe("inclusion-weight");
    expect(kk!.getAttribute("title")).toContain("inclusion weight 100%");
    expect(kk!.getAttribute("title")).not.toContain("33");
  });

  it("ignores Build draft weights for fill provenance", () => {
    render(<OpponentRangePanel />);
    const kk = screen.getAllByRole("gridcell").find((el) => {
      const hand = el.querySelector(".matrix-cell__hand");
      return hand?.textContent === "KK";
    });
    expect(kk?.querySelector(".matrix-cell__sub")?.textContent).toBe("100");
    // Build IP KK was 0.33; solution opponent_reach still wins.
    expect(useStudyStore.getState().weights.ip[1][1]).toBe(0.33);
  });

  it("sizes the grid to min(width,height) of the wrap", () => {
    const proto = HTMLElement.prototype;
    const widthDesc = Object.getOwnPropertyDescriptor(proto, "clientWidth");
    const heightDesc = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(proto, "clientWidth", {
      configurable: true,
      get() {
        return (this as HTMLElement).classList?.contains("range-matrix-wrap")
          ? 420
          : 0;
      },
    });
    Object.defineProperty(proto, "clientHeight", {
      configurable: true,
      get() {
        return (this as HTMLElement).classList?.contains("range-matrix-wrap")
          ? 380
          : 0;
      },
    });
    try {
      render(<OpponentRangePanel />);
      const grid = screen.getByRole("grid", { name: /IP solution range/ });
      expect(grid.style.width).toBe("380px");
      expect(grid.style.height).toBe("380px");
    } finally {
      if (widthDesc) {
        Object.defineProperty(proto, "clientWidth", widthDesc);
      } else {
        Reflect.deleteProperty(proto, "clientWidth");
      }
      if (heightDesc) {
        Object.defineProperty(proto, "clientHeight", heightDesc);
      } else {
        Reflect.deleteProperty(proto, "clientHeight");
      }
    }
  });

  it("shows empty hint when opponent reach is absent", () => {
    useStudyStore.setState({
      currentNode: {
        node_id: "root",
        kind: "chance",
        player: null,
        opponent_player: null,
      },
    });
    render(<OpponentRangePanel />);
    expect(
      screen.getByText("Opponent reach appears on decision nodes."),
    ).toBeTruthy();
  });
});
