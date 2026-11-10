import { describe, expect, it } from "vitest";
import {
  actionSizePotBasis,
  advancePathTrail,
  canNavBack,
  canNavForward,
  abbreviateActionLine,
  abbreviatePathAction,
  compactActionLabel,
  displayPathStepLabel,
  formatAbbreviatedPath,
  studyLineLabel,
  edgeStepFromNode,
  formatChoiceFrequency,
  groupCrumbsByStreet,
  groupPathByStreet,
  isTerminalFold,
  lineCrumbs,
  nextChoicesFromNode,
  nodeEffectiveStack,
  nodePot,
  nodeStatusLabel,
  pathCrumbsFromTrail,
  pathEdgeSizePot,
  pushNavHistory,
  replaceTrailAlternative,
  rootPathStep,
  rootStreetFromPlace,
  splitActionLine,
  streetFromPlace,
  streetLabel,
} from "./actionHistory";
import type { NodePayload } from "./types";

describe("actionHistory helpers", () => {
  it("splits engine line paths into crumbs with compact labels", () => {
    expect(splitActionLine("open")).toEqual([]);
    expect(splitActionLine("Check/Bet 50/Call")).toEqual([
      "Check",
      "Bet 50",
      "Call",
    ]);
    expect(lineCrumbs("Check/Bet 50", "root-1", 100)).toEqual([
      { label: "Root", nodeId: "root-1", kind: "root" },
      { label: "Check", rawLabel: "Check", kind: "action" },
      { label: "b50", rawLabel: "Bet 50", kind: "action" },
    ]);
  });

  it("prefers node pot/stacks and adds to_call for raise % basis", () => {
    const node: NodePayload = {
      node_id: "n-bet",
      pot: 150,
      to_call: 50,
      stacks: [150, 200],
      stack: 150,
    };
    expect(nodePot(node, 100)).toBe(150);
    expect(actionSizePotBasis(node, 100)).toBe(200);
    expect(nodeEffectiveStack(node, 200)).toBe(150);
    expect(actionSizePotBasis({ node_id: "root", pot: 100, to_call: 0 }, 100)).toBe(
      100,
    );
  });

  it("keeps b50 compact and does not expand to Bet 50%", () => {
    expect(compactActionLabel("Bet 50", 100)).toBe("b50");
    expect(compactActionLabel("Bet 50", 100)).not.toMatch(/Bet 50%/i);
    expect(compactActionLabel("Check", 100)).toBe("Check");
    expect(compactActionLabel("As", 100)).toBe("As");
  });

  it("abbreviates a multi-street line as x / pot-fraction / c", () => {
    expect(abbreviatePathAction("Check", 50)).toBe("x");
    expect(abbreviatePathAction("Call", 50)).toBe("c");
    expect(abbreviatePathAction("Fold", 50)).toBe("f");
    expect(abbreviatePathAction("Bet 10", 50)).toBe("b20");
    expect(abbreviatePathAction("Bet 35", 70)).toBe("b50");
    expect(
      formatAbbreviatedPath([
        {
          steps: [
            { kind: "root", label: "Root", rawLabel: "Root" },
            { kind: "action", label: "Check", rawLabel: "Check" },
            {
              kind: "action",
              label: "Bet 10",
              rawLabel: "Bet 10",
              sizePot: 50,
              toCall: 0,
            },
            { kind: "action", label: "Call", rawLabel: "Call" },
          ],
        },
        {
          steps: [
            { kind: "card", label: "2s", rawLabel: "2s" },
            { kind: "action", label: "Check", rawLabel: "Check" },
            {
              kind: "action",
              label: "Bet 35",
              rawLabel: "Bet 35",
              sizePot: 70,
              toCall: 0,
            },
            { kind: "action", label: "Call", rawLabel: "Call" },
          ],
        },
        {
          steps: [
            { kind: "action", label: "Check", rawLabel: "Check" },
            { kind: "action", label: "Check", rawLabel: "Check" },
          ],
        },
      ]),
    ).toBe("x/b20/c - x/b50/c - x/x");
    expect(
      abbreviateActionLine(
        "Check/Bet 10/Call/Check/Bet 35/Call/Check/Check",
        50,
      ),
    ).toBe("x/b20/c/x/b50/c/x/x");
  });

  it("splits the study line on street boundaries from the trail", () => {
    expect(
      studyLineLabel({
        line: "Check/Bet 10/Call/Check/Bet 35/Call/Check/Check",
        currentNodeId: "n-river-check",
        rootPot: 50,
        trail: [
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
      }),
    ).toBe("x/b20/c - x/b50/c - x/x");
  });

  it("respects betSizeDisplay mode for path compact labels", () => {
    expect(compactActionLabel("Bet 75", 100, "pot")).toBe("b75");
    expect(compactActionLabel("Bet 75", 100, "chips")).toBe("75.0 chips");
    expect(compactActionLabel("Bet 75", 100, "both")).toBe("b75");
    expect(compactActionLabel("Raise to 400", 300, "pot", 100)).toBe("r100");
    expect(compactActionLabel("Bet 150 all-in", 100, "pot")).toBe("b150");
  });

  it("pairs actions with child ids and strategy frequencies", () => {
    const node: NodePayload = {
      node_id: "n1",
      kind: "decision",
      player: 0,
      actions: ["Check", "Bet 50"],
      children: ["n-check", "n-bet"],
      combos: ["AsAh", "KsKh"],
      marginal: [1, 1],
      reach_defined: true,
      strategy: [
        [0.25, 0.75],
        [0.25, 0.75],
      ],
    };
    const choices = nextChoicesFromNode(node);
    expect(choices).toHaveLength(2);
    expect(choices[0]).toMatchObject({
      label: "Check",
      nodeId: "n-check",
      kind: "action",
    });
    expect(choices[1]?.nodeId).toBe("n-bet");
    expect(choices[0]?.frequency).toBeCloseTo(0.25, 8);
    expect(choices[1]?.frequency).toBeCloseTo(0.75, 8);
    expect(formatChoiceFrequency(0.753)).toBe("75%");
  });

  it("reads chance cards from the cards field", () => {
    const node: NodePayload = {
      node_id: "c0",
      kind: "chance",
      cards: [
        { card: "As", child_id: "n1", weight: 0.02 },
        { card: "2h", child_id: "n2", weight: 0.02 },
      ],
    };
    const choices = nextChoicesFromNode(node);
    expect(choices.map((choice) => choice.label)).toEqual(["As", "2h"]);
    expect(choices[0]?.nodeId).toBe("n1");
  });

  it("labels fold terminals distinctly from showdown", () => {
    expect(
      nodeStatusLabel({
        node_id: "t-fold",
        kind: "terminal",
        folded: 0,
        line: "Bet 50/Fold",
      }),
    ).toBe("OOP folded");
    expect(
      nodeStatusLabel({
        node_id: "t-fold-ip",
        kind: "terminal",
        folded: 1,
        line: "Check/Bet 50/Fold",
      }),
    ).toBe("IP folded");
    expect(
      nodeStatusLabel({
        node_id: "t-sd",
        kind: "terminal",
        folded: null,
        line: "Check/Check",
      }),
    ).toBe("Showdown");
    expect(
      isTerminalFold({
        node_id: "t-fold-line",
        kind: "terminal",
        line: "Bet 50/Fold",
      }),
    ).toBe(true);
    expect(
      isTerminalFold({
        node_id: "t-sd",
        kind: "terminal",
        line: "Check/Call",
      }),
    ).toBe(false);
  });

  it("maps place strings to streets", () => {
    expect(streetFromPlace("flop", 3)).toBe("flop");
    expect(streetFromPlace("deal turn", 3)).toBe("turn");
    expect(streetFromPlace("turn As", 4)).toBe("turn");
    expect(streetFromPlace("turn As river Kd", 5)).toBe("river");
    expect(streetFromPlace("deal river", 4)).toBe("river");
  });

  it("builds trail edges with actor ownership and alternatives", () => {
    const from: NodePayload = {
      node_id: "root",
      kind: "decision",
      player: 0,
      place: "flop",
      board: ["Ah", "Kd", "7c"],
      pot: 100,
      actions: ["Check", "Bet 50"],
      children: ["n-check", "n-bet"],
    };
    const edge = edgeStepFromNode(from, "n-bet", 100);
    expect(edge).toMatchObject({
      nodeId: "n-bet",
      label: "b50",
      rawLabel: "Bet 50",
      actor: "OOP",
      street: "flop",
      kind: "action",
      sizePot: 100,
      toCall: 0,
    });
    expect(edge?.alternatives).toEqual([
      {
        label: "Check",
        rawLabel: "Check",
        nodeId: "n-check",
        kind: "action",
      },
    ]);
  });

  it("reformats stored path steps when betSizeDisplay changes", () => {
    const step = {
      label: "b50",
      rawLabel: "Bet 50",
      kind: "action" as const,
      sizePot: 100,
      toCall: 0,
    };
    expect(displayPathStepLabel(step, "pot")).toBe("b50");
    expect(displayPathStepLabel(step, "chips")).toBe("50.0 chips");
    expect(displayPathStepLabel(step, "both")).toBe("b50");
    expect(
      displayPathStepLabel(
        {
          label: "Raise to 400",
          rawLabel: "Raise to 400",
          kind: "action",
          sizePot: 300,
          toCall: 100,
        },
        "pot",
      ),
    ).toBe("r100");
  });

  it("tags path bets from source pot, not arrived pot (R10)", () => {
    // Chip-unit pots (R01 tenths PR may still show tenths until merged).
    const from: NodePayload = {
      node_id: "root",
      kind: "decision",
      player: 0,
      place: "flop",
      board: ["Ah", "Kd", "7c"],
      pot: 100,
      to_call: 0,
      actions: ["Check", "Bet 50", "Bet 100"],
      children: ["n-check", "n-bet", "n-bet100"],
    };
    const arrived: NodePayload = {
      node_id: "n-bet",
      kind: "decision",
      player: 1,
      place: "flop",
      board: ["Ah", "Kd", "7c"],
      pot: 150, // destination pot after Bet 50 — must not drive the tag
      to_call: 50,
      line: "Bet 50",
    };
    expect(pathEdgeSizePot(from, arrived.pot ?? 0)).toBe(100);
    // Even if the caller passes the arrived pot as fallback, source wins.
    const edge = edgeStepFromNode(from, "n-bet", Number(arrived.pot));
    expect(edge?.label).toBe("b50");
    expect(edge?.label).not.toMatch(/b33|Bet 50%/i);
    expect(edge?.alternatives?.map((alt) => alt.label)).toEqual([
      "Check",
      "b100",
    ]);

    const root = rootPathStep("root", from.board, "flop");
    const trail = advancePathTrail([root], from, arrived, Number(arrived.pot), "root");
    expect(trail[1]?.label).toBe("b50");
    expect(trail[1]?.label).not.toBe("b33");
  });

  it("labels turn-only and river-only roots without inventing Flop", () => {
    expect(rootStreetFromPlace("turn", 4)).toBe("turn");
    expect(rootStreetFromPlace("river", 5)).toBe("river");
    expect(rootStreetFromPlace("flop", 3)).toBe("flop");
    // Multi-street deep place still maps root chrome to Flop.
    expect(rootStreetFromPlace("turn As river Kd", 5)).toBe("flop");

    const turnRoot = rootPathStep("root", ["Ah", "Kd", "7c", "2s"], "turn");
    expect(turnRoot.street).toBe("turn");
    expect(streetLabel(turnRoot.street)).toBe("Turn");

    const riverRoot = rootPathStep(
      "root",
      ["Ah", "Kd", "7c", "2s", "9h"],
      "river",
    );
    expect(riverRoot.street).toBe("river");
    expect(streetLabel(riverRoot.street)).toBe("River");
    expect(streetLabel(riverRoot.street)).not.toBe("Flop");

    const crumbGroups = groupCrumbsByStreet(
      [{ label: "Root", nodeId: "root", kind: "root" }],
      ["Ah", "Kd", "7c", "2s", "9h"],
      "river",
    );
    expect(crumbGroups[0]?.street).toBe("river");
  });

  it("advances and truncates the client path trail", () => {
    const root = rootPathStep("root", ["Ah", "Kd", "7c"], "flop");
    const from: NodePayload = {
      node_id: "root",
      kind: "decision",
      player: 0,
      place: "flop",
      board: ["Ah", "Kd", "7c"],
      pot: 100,
      actions: ["Check", "Bet 50"],
      children: ["n-check", "n-bet"],
    };
    const arrived: NodePayload = {
      node_id: "n-bet",
      kind: "decision",
      player: 1,
      place: "flop",
      board: ["Ah", "Kd", "7c"],
      line: "Bet 50",
    };
    const trail = advancePathTrail([root], from, arrived, 100, "root");
    expect(trail.map((step) => step.nodeId)).toEqual(["root", "n-bet"]);
    expect(trail[1]?.label).toBe("b50");

    const back = advancePathTrail(trail, arrived, { ...from, node_id: "root" }, 100, "root");
    expect(back.map((step) => step.nodeId)).toEqual(["root"]);
  });

  it("groups path steps by street with board cards", () => {
    const steps = [
      rootPathStep("root", ["Ah", "Kd", "7c", "2s"], "flop"),
      {
        nodeId: "n1",
        label: "x",
        rawLabel: "Check",
        kind: "action" as const,
        street: "flop" as const,
        actor: "OOP",
      },
      {
        nodeId: "n2",
        label: "2s",
        rawLabel: "2s",
        kind: "card" as const,
        street: "turn" as const,
        actor: null,
        card: "2s",
      },
    ];
    const groups = groupPathByStreet(steps, ["Ah", "Kd", "7c", "2s"]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.street).toBe("flop");
    expect(groups[0]?.boardCards).toEqual(["Ah", "Kd", "7c"]);
    expect(groups[1]?.street).toBe("turn");
    expect(groups[1]?.boardCards).toEqual(["2s"]);
  });

  it("prefers trail crumbs with node ids over line-only crumbs", () => {
    const trail = [
      rootPathStep("root"),
      {
        nodeId: "n-check",
        label: "Check",
        rawLabel: "Check",
        kind: "action" as const,
        street: "flop" as const,
        actor: "OOP",
      },
    ];
    const crumbs = pathCrumbsFromTrail(
      trail,
      "Check/Bet 50",
      "root",
      "n-check",
      100,
    );
    expect(crumbs).toHaveLength(2);
    expect(crumbs[1]?.nodeId).toBe("n-check");
  });

  it("replaces a prior action alternative and drops descendants", () => {
    const trail = [
      rootPathStep("root"),
      {
        nodeId: "n-bet",
        label: "b50",
        rawLabel: "Bet 50",
        kind: "action" as const,
        street: "flop" as const,
        actor: "OOP",
        alternatives: [{ label: "Check", nodeId: "n-check", kind: "action" as const }],
      },
      {
        nodeId: "n-call",
        label: "Call",
        rawLabel: "Call",
        kind: "action" as const,
        street: "flop" as const,
        actor: "IP",
      },
    ];
    const next = replaceTrailAlternative(
      trail,
      1,
      { label: "Check", nodeId: "n-check", kind: "action" },
      100,
    );
    expect(next?.map((step) => step.nodeId)).toEqual(["root", "n-check"]);
    expect(next?.[1]?.label).toBe("Check");
  });

  it("pushes browser-style nav history with back/forward bounds", () => {
    const first = pushNavHistory([], -1, { nodeId: "a", trail: [] });
    expect(first.index).toBe(0);
    const second = pushNavHistory(first.entries, first.index, {
      nodeId: "b",
      trail: [],
    });
    expect(second.index).toBe(1);
    expect(canNavBack(second.index)).toBe(true);
    expect(canNavForward(second.entries, second.index)).toBe(false);
    const backIndex = second.index - 1;
    expect(canNavForward(second.entries, backIndex)).toBe(true);
  });
});
