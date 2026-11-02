import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SPOT } from "../domain/types";
import { parseRangeText, snapshotWeights } from "../domain/range";
import type { SetupDraftResult } from "../domain/setup";

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

vi.mock("../engine/client", () => ({
  EngineError: class EngineError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status = 400, body: unknown = null) {
      super(message);
      this.status = status;
      this.body = body;
    }
  },
  engineClient: {
    solve: vi.fn(),
    status: vi.fn(),
  },
}));

const { resetSetupHistoryForTests, useStudyStore } = await import("./studyStore");

function editPotResult(pot: number, revision: number): SetupDraftResult {
  return {
    ok: true,
    mode: "edit",
    draftPatch: { pot },
    pot,
    provenance: { pot: "explicit_request" },
    conflicts: [],
    missing: [],
    summary: [`Set pot to ${pot}`],
    canSolve: false,
    requestRevision: revision,
  };
}

function createWithoutBoardResult(revision: number): SetupDraftResult {
  return {
    ok: false,
    mode: "create",
    draftPatch: {
      boardText: "",
      oopRange: "QQ+",
      ipRange: "JJ+",
      pot: 5.5,
      stack: 97.5,
      solutionPath: "",
    },
    pot: 5.5,
    stack: 97.5,
    provenance: {
      pot: "derived",
      stack: "derived",
      oopRange: "selected_profile",
      ipRange: "selected_profile",
      boardText: "default",
      solutionPath: "default",
    },
    conflicts: [],
    missing: [
      {
        field: "board",
        message: "Select a flop, turn, or river board before solving",
        reason: "board_missing",
      },
    ],
    summary: ["Missing board"],
    canSolve: false,
    requestRevision: revision,
  };
}

describe("studyStore guarded setup undo (A05)", () => {
  beforeEach(() => {
    resetSetupHistoryForTests();
    useStudyStore.setState({
      draft: { ...DEFAULT_SPOT, pot: 100, stack: 200 },
      weights: snapshotWeights({
        oop: parseRangeText(DEFAULT_SPOT.oopRange),
        ip: parseRangeText(DEFAULT_SPOT.ipRange),
      }),
      draftRevision: 0,
      setupMeta: null,
      canUndoSetup: false,
      message: "",
    });
  });

  it("undo pot edit after manual stack change keeps stack 777", () => {
    const store = useStudyStore.getState();
    const applied = store.applySetupDraft(editPotResult(5.5, 0));
    expect(applied.ok).toBe(true);

    useStudyStore.getState().updateDraft({ stack: 777 });
    expect(useStudyStore.getState().draft.stack).toBe(777);
    expect(useStudyStore.getState().draft.pot).toBe(5.5);

    const undone = useStudyStore.getState().undoSetupTransaction();
    expect(undone.ok).toBe(true);
    if (!undone.ok) {
      return;
    }
    const after = useStudyStore.getState();
    expect(after.draft.pot).toBe(100);
    expect(after.draft.stack).toBe(777);
    expect(undone.conflictKeys).toEqual([]);
    expect(undone.restoredKeys).toContain("pot");
    expect(after.message).toMatch(/Reverted assistant setup/i);
  });

  it("undo with no intervening edits restores assistant fields", () => {
    const applied = useStudyStore.getState().applySetupDraft(editPotResult(5.5, 0));
    expect(applied.ok).toBe(true);

    const undone = useStudyStore.getState().undoSetupTransaction();
    expect(undone.ok).toBe(true);
    if (!undone.ok) {
      return;
    }
    expect(useStudyStore.getState().draft.pot).toBe(100);
    expect(useStudyStore.getState().draft.stack).toBe(200);
    expect(undone.conflictKeys).toEqual([]);
  });
});

describe("studyStore create vs edit apply (A06)", () => {
  beforeEach(() => {
    resetSetupHistoryForTests();
    useStudyStore.setState({
      draft: {
        ...DEFAULT_SPOT,
        boardText: "Ah Kd 7c 4s 2h",
        solutionPath: "/prior/out.bin",
        pot: 100,
        stack: 200,
        iterations: 999,
      },
      weights: snapshotWeights({
        oop: parseRangeText(DEFAULT_SPOT.oopRange),
        ip: parseRangeText(DEFAULT_SPOT.ipRange),
      }),
      draftRevision: 0,
      setupMeta: null,
      canUndoSetup: false,
      message: "",
    });
  });

  it("create without board does not leave previous boardText in the committed draft", () => {
    const applied = useStudyStore
      .getState()
      .applySetupDraft(createWithoutBoardResult(0), { force: true });
    expect(applied.ok).toBe(true);
    const draft = useStudyStore.getState().draft;
    expect(draft.boardText).toBe("");
    expect(draft.solutionPath).toBe("");
    expect(draft.oopRange).toBe("QQ+");
    expect(draft.ipRange).toBe("JJ+");
    expect(draft.iterations).toBe(DEFAULT_SPOT.iterations);
  });

  it("edit preserves unrelated fields", () => {
    const applied = useStudyStore.getState().applySetupDraft(editPotResult(5.5, 0));
    expect(applied.ok).toBe(true);
    const draft = useStudyStore.getState().draft;
    expect(draft.pot).toBe(5.5);
    expect(draft.boardText).toBe("Ah Kd 7c 4s 2h");
    expect(draft.solutionPath).toBe("/prior/out.bin");
    expect(draft.stack).toBe(200);
    expect(draft.iterations).toBe(999);
  });
});
