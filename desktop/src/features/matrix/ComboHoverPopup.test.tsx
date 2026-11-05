import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { groupHands } from "../../domain/browse";
import { equityByCombo, useMatrixDisplayStore } from "../../domain/matrixDisplay";
import type { NodePayload } from "../../domain/types";

const { ComboHoverPopup } = await import("./ComboHoverPopup");

const node: NodePayload = {
  node_id: "n1",
  player: 0,
  reach_defined: true,
  actions: ["Check", "Bet 50"],
  combos: ["AhAd", "AsAc", "AsAh"],
  reach: [1, 0.5, 0.25],
  marginal: [1, 0.5, 0.25],
  strategy: [
    [0.5, 0.5],
    [1, 0],
    [0.2, 0.8],
  ],
};

describe("ComboHoverPopup", () => {
  beforeEach(() => {
    useMatrixDisplayStore.getState().resetPrefs();
    useMatrixDisplayStore.getState().setCellOverlay("both");
  });

  afterEach(() => {
    cleanup();
  });

  it("renders six pair mini-squares with strategy paint by default", () => {
    const cell = groupHands(node).find((entry) => entry.text === "AA")!;
    const equityMap = equityByCombo([
      { combo: "AhAd", equity: 0.8 },
      { combo: "AsAc", equity: 0.6 },
    ]);
    render(
      <ComboHoverPopup
        cell={cell}
        node={node}
        nodeValues={{
          node_id: "n1",
          combos: node.combos,
          ev_defined: [true, true, true],
          value: [1, 2, 3],
          action_ev: [
            [0, 2],
            [2, 2],
            [1, 4],
          ],
        }}
        evDisplayBasis="local"
        equityMap={equityMap}
        pinned={false}
        matrixMode="strategy"
        actionColors={["#3f8f6b", "#c46a2b"]}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "AA combo breakdown" });
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("data-paint")).toBe("strategy");
    expect(screen.getByText("AA")).toBeTruthy();
    const squares = document.querySelectorAll(".combo-hover-square");
    expect(squares).toHaveLength(6);
    expect(document.querySelectorAll('.combo-hover-square[data-present="true"]')).toHaveLength(
      3,
    );
    expect(document.querySelectorAll(".combo-hover-square__segments").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".combo-hover-square__meta").length).toBeGreaterThan(0);
  });

  it("uses range paint when the main matrix is in Range mode", () => {
    useMatrixDisplayStore.getState().setCellOverlay("none");
    const cell = groupHands(node).find((entry) => entry.text === "AA")!;
    render(
      <ComboHoverPopup
        cell={cell}
        node={node}
        nodeValues={null}
        evDisplayBasis="local"
        equityMap={new Map()}
        pinned={false}
        matrixMode="range"
        actionColors={["#3f8f6b", "#c46a2b"]}
      />,
    );
    expect(
      screen.getByRole("dialog", { name: "AA combo breakdown" }).getAttribute("data-paint"),
    ).toBe("range");
    expect(document.querySelectorAll(".combo-hover-square__fill").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".combo-hover-square__segments")).toHaveLength(0);
  });

  it("renders 16 suited mini-squares (4 present) in a 4-column grid", () => {
    const suited = ["AcKc", "AdKd", "AhKh", "AsKs"];
    const aksNode: NodePayload = {
      node_id: "n-aks",
      player: 0,
      reach_defined: true,
      actions: ["Check"],
      combos: suited,
      reach: suited.map(() => 1),
      marginal: suited.map(() => 1),
      strategy: suited.map(() => [1]),
    };
    const cell = groupHands(aksNode).find((entry) => entry.text === "AKs")!;
    render(
      <ComboHoverPopup
        cell={cell}
        node={aksNode}
        nodeValues={null}
        evDisplayBasis="local"
        equityMap={new Map()}
        pinned={false}
        matrixMode="strategy"
        actionColors={["#3f8f6b"]}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "AKs combo breakdown" });
    expect(dialog.getAttribute("data-shape")).toBe("suited");
    const grid = dialog.querySelector(".combo-hover-popup__grid") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain("repeat(4");
    expect(document.querySelectorAll(".combo-hover-square")).toHaveLength(16);
    expect(document.querySelectorAll('.combo-hover-square[data-present="true"]')).toHaveLength(4);
  });

  it("renders 16 offsuit mini-squares (12 present) in a 4-column grid", () => {
    const offsuit = [
      "AcKd",
      "AcKh",
      "AcKs",
      "AdKc",
      "AdKh",
      "AdKs",
      "AhKc",
      "AhKd",
      "AhKs",
      "AsKc",
      "AsKd",
      "AsKh",
    ];
    const akoNode: NodePayload = {
      node_id: "n-ako",
      player: 0,
      reach_defined: true,
      actions: ["Check"],
      combos: offsuit,
      reach: offsuit.map(() => 1),
      marginal: offsuit.map(() => 1),
      strategy: offsuit.map(() => [1]),
    };
    const cell = groupHands(akoNode).find((entry) => entry.text === "AKo")!;
    render(
      <ComboHoverPopup
        cell={cell}
        node={akoNode}
        nodeValues={null}
        evDisplayBasis="local"
        equityMap={new Map()}
        pinned={false}
        matrixMode="strategy"
        actionColors={["#3f8f6b"]}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "AKo combo breakdown" });
    expect(dialog.getAttribute("data-shape")).toBe("offsuit");
    const grid = dialog.querySelector(".combo-hover-popup__grid") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain("repeat(4");
    expect(document.querySelectorAll(".combo-hover-square")).toHaveLength(16);
    expect(document.querySelectorAll('.combo-hover-square[data-present="true"]')).toHaveLength(
      12,
    );
  });
});
