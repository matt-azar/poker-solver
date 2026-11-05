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

  it("renders six pair mini-squares with overlay meta", () => {
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
        anchor={{ left: 10, top: 10, width: 20, height: 20, viewport: true }}
      />,
    );

    expect(screen.getByRole("dialog", { name: "AA combo breakdown" })).toBeTruthy();
    expect(screen.getByText("AA")).toBeTruthy();
    const squares = document.querySelectorAll(".combo-hover-square");
    expect(squares).toHaveLength(6);
    expect(document.querySelectorAll('.combo-hover-square[data-present="true"]')).toHaveLength(
      3,
    );
  });
});
