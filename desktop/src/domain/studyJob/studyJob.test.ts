import { describe, expect, it } from "vitest";
import { formatSolveJobStreetConfig } from "../../engine/streetConfigText";
import { buildJob } from "../../state/studyDraft";
import { DEFAULT_SPOT } from "../types";
import {
  draftFromPortableJob,
  parseHandHistory,
  parsePortableJobJson,
  portableJobFromDraft,
  riverJobFromHandHistoryText,
  stringifyPortableJob,
  walkPreviewActions,
} from "./index";

const RIVER_HH = `hand-history 1
board Ah Kd 7c 4s 2h
pot 100
stack 200
oop-hole AcAd
ip-hole KsKc
action 0 Check
action 1 Bet 50
action 0 Call
terminal-pot 200
outcome showdown
p0-net 100
`;

describe("portable study job", () => {
  it("round-trips Build draft through the same street-config Solve uses", () => {
    const draft = {
      ...DEFAULT_SPOT,
      boardText: "Ah Kd 7c 4s 2h",
      oopRange: "AcAd:1",
      ipRange: "KsKc:1",
      pot: 100,
      stack: 200,
      oopRiver: "0.5",
      ipRiver: "0.5",
      iterations: 40,
      accuracy: "0.5",
      memoryMib: 256,
    };
    const job = portableJobFromDraft(draft, {
      provenance: { source: "test" },
      decision: { actions: ["Check", "Bet 50"] },
    });
    expect(job.schema).toBe("holdem-study-job/1");
    expect(job.run.iterations).toBe(40);
    expect(job.run.accuracy).toBeCloseTo(0.005, 12);
    const fromSolve = formatSolveJobStreetConfig(buildJob(draft));
    expect(job.street_config).toBe(
      fromSolve.endsWith("\n") ? fromSolve : `${fromSolve}\n`,
    );

    const loaded = draftFromPortableJob(job);
    expect(loaded.draft.boardText.split(/\s+/)).toEqual(["Ah", "Kd", "7c", "4s", "2h"]);
    expect(loaded.draft.pot).toBe(100);
    expect(loaded.draft.stack).toBe(200);
    expect(loaded.draft.iterations).toBe(40);
    expect(loaded.draft.accuracy).toBe("0.5");
  });

  it("rejects jobs without schema or iterations", () => {
    expect(() => parsePortableJobJson("{}")).toThrow(/holdem-study-job/);
    expect(() =>
      parsePortableJobJson(
        JSON.stringify({
          schema: "holdem-study-job/1",
          street_config: "street-config 1\nboard Ah Kd 7c\npot 1\nstack 1\noop-range AA\nip-range KK\n",
          run: { iterations: 0 },
          provenance: { source: "x" },
        }),
      ),
    ).toThrow(/iterations/);
  });
});

describe("hand-history → river job", () => {
  it("parses HH and emits a reviewable river job with decision line", () => {
    const record = parseHandHistory(RIVER_HH);
    expect(record.board).toHaveLength(5);
    expect(record.actions.map((a) => a.label)).toEqual(["Check", "Bet 50", "Call"]);

    const job = riverJobFromHandHistoryText(RIVER_HH, {
      iterations: 20,
      created_at: "2026-11-16T00:00:00.000Z",
    });
    expect(job.review?.street_boundary).toBe("river");
    expect(job.review?.positions).toEqual({ oop: "BB", ip: "BTN" });
    expect(job.review?.pot).toBe(100);
    expect(job.review?.effective_stack).toBe(200);
    expect(job.review?.action_line).toEqual(["Check", "Bet 50", "Call"]);
    expect(job.review?.range_sources?.oop).toContain("AcAd");
    expect(job.decision?.actions).toEqual(["Check", "Bet 50", "Call"]);
    expect(job.street_config).toContain("street-config 1");
    expect(job.street_config).toContain("board Ah Kd 7c 4s 2h");
    expect(job.review?.missing_sizes ?? []).toEqual([]);
    // No stakes/rake-label fixation in review/provenance.
    expect(JSON.stringify(job)).not.toMatch(/100NL|stakesLabel/i);

    const again = parsePortableJobJson(stringifyPortableJob(job));
    expect(again.street_config).toBe(job.street_config);
  });

  it("flags played sizes missing from an explicit narrow tree", () => {
    const job = riverJobFromHandHistoryText(RIVER_HH, {
      oopRiverBets: [1],
      ipRiverBets: [1],
      iterations: 10,
    });
    expect(job.review?.missing_sizes).toContain("Bet 50");
  });

  it("refuses non-river boards", () => {
    const turnOnly = RIVER_HH.replace(
      "board Ah Kd 7c 4s 2h",
      "board Ah Kd 7c 4s",
    );
    expect(() => riverJobFromHandHistoryText(turnOnly)).toThrow(/5-card/);
  });
});

describe("walkPreviewActions", () => {
  it("follows labels on a tiny river preview tree", () => {
    const nodes = [
      {
        index: 0,
        terminal: false,
        chance: false,
        player: 0,
        street: 2,
        path: "",
        chance_child: -1,
        actions: [
          { label: "Check", compact: "c", child_index: 1 },
          { label: "Bet 50", compact: "b50", child_index: 2 },
        ],
        children: [1, 2],
      },
      {
        index: 1,
        terminal: false,
        chance: false,
        player: 1,
        street: 2,
        path: "Check",
        chance_child: -1,
        actions: [
          { label: "Check", compact: "c", child_index: 3 },
          { label: "Bet 50", compact: "b50", child_index: 4 },
        ],
        children: [3, 4],
      },
      {
        index: 2,
        terminal: true,
        chance: false,
        player: -1,
        street: 2,
        path: "Bet 50",
        chance_child: -1,
        actions: [],
        children: [],
      },
      {
        index: 3,
        terminal: true,
        chance: false,
        player: -1,
        street: 2,
        path: "Check/Check",
        chance_child: -1,
        actions: [],
        children: [],
      },
      {
        index: 4,
        terminal: false,
        chance: false,
        player: 0,
        street: 2,
        path: "Check/Bet 50",
        chance_child: -1,
        actions: [
          { label: "Fold", compact: "f", child_index: 5 },
          { label: "Call", compact: "call", child_index: 6 },
        ],
        children: [5, 6],
      },
      {
        index: 5,
        terminal: true,
        chance: false,
        player: -1,
        street: 2,
        path: "Check/Bet 50/Fold",
        chance_child: -1,
        actions: [],
        children: [],
      },
      {
        index: 6,
        terminal: true,
        chance: false,
        player: -1,
        street: 2,
        path: "Check/Bet 50/Call",
        chance_child: -1,
        actions: [],
        children: [],
      },
    ];
    const hit = walkPreviewActions(nodes, ["Check", "Bet 50"]);
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.nodeIndex).toBe(4);
      expect(hit.legal).toEqual(["Fold", "Call"]);
    }
  });
});
