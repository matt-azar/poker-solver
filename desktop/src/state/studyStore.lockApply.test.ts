import { beforeEach, describe, expect, it, vi } from "vitest";
import { comboProbsRowsForHands } from "../domain/locks";

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

const engineMocks = vi.hoisted(() => {
  let putLockImpl: (
    solutionId: string,
    body: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> = async () => ({ locks: [] });

  return {
    setPutLockImpl(impl: typeof putLockImpl) {
      putLockImpl = impl;
    },
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
      putLock: vi.fn(async (solutionId: string, body: Record<string, unknown>) =>
        putLockImpl(solutionId, body),
      ),
      listLocks: vi.fn(async () => ({ locks: [] })),
      deleteLock: vi.fn(async () => ({ locks: [] })),
      calculateEv: vi.fn(async () => ({})),
    },
  };
});

vi.mock("../engine/client", () => ({
  EngineError: engineMocks.EngineError,
  engineClient: engineMocks.engineClient,
}));

const { resetStatusPollingForTests, useStudyStore } = await import("./studyStore");

describe("studyStore lock apply (NL-5)", () => {
  beforeEach(() => {
    resetStatusPollingForTests();
    engineMocks.engineClient.putLock.mockClear();
    engineMocks.setPutLockImpl(async (_solutionId, body) => ({
      locks: [
        {
          node_id: body.node_id,
          kind: body.kind,
          scope: body.scope ?? "node",
          hand_indices: body.hand_indices ?? [],
          probs: body.probs,
          combo_probs: body.combo_probs,
        },
      ],
    }));
    useStudyStore.setState({
      solutionId: "s1",
      currentNode: {
        node_id: "p0.t-1.r7",
        solution_id: "s1",
        actions: ["Check", "Bet 50"],
        combos: ["AcAd", "KcKd"],
        kind: "decision",
        player: 0,
        strategy: [
          [1, 0],
          [0, 1],
        ],
      },
      locks: [],
      lockDraft: {
        kind: "selected",
        handIndices: [0],
        probs: [1, 0],
        comboProbsByHand: { 0: [1, 0] },
      },
      lockDraftBaseline: {
        kind: "selected",
        handIndices: [0],
        probs: [1, 0],
        comboProbsByHand: { 0: [1, 0] },
      },
      message: "",
    });
  });

  it("Lock all hands freezes both original mixes even with one combo selected", async () => {
    const ok = await useStudyStore.getState().lockAllHands("node");
    expect(ok).toBe(true);

    expect(engineMocks.engineClient.putLock).toHaveBeenCalledTimes(1);
    const [, body] = engineMocks.engineClient.putLock.mock.calls[0] as [
      string,
      {
        kind: string;
        scope?: string;
        hand_indices?: number[];
        combo_probs?: number[][];
        probs: number[];
      },
    ];
    expect(body.kind).toBe("selected");
    expect(body.scope).toBe("node");
    expect(body.hand_indices).toEqual([0, 1]);
    expect(body.combo_probs).toEqual([
      [1, 0],
      [0, 1],
    ]);

    const locks = useStudyStore.getState().locks;
    expect(locks).toHaveLength(1);
    expect(locks[0]?.hand_indices).toEqual([0, 1]);
    expect(locks[0]?.combo_probs).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("toggleLockHand keeps edited mixes keyed by combo identity", () => {
    useStudyStore.setState({
      lockDraft: {
        kind: "selected",
        handIndices: [0],
        probs: [0.8, 0.2],
        comboProbsByHand: { 0: [0.8, 0.2] },
      },
    });

    useStudyStore.getState().toggleLockHand(0); // deselect A
    useStudyStore.getState().toggleLockHand(1); // select B

    const draft = useStudyStore.getState().lockDraft;
    expect(draft.handIndices).toEqual([1]);
    expect(draft.comboProbsByHand?.[0]).toBeUndefined();
    expect(draft.comboProbsByHand?.[1]).toEqual([0, 1]);
    expect(comboProbsRowsForHands(draft.comboProbsByHand, draft.handIndices)).toEqual([
      [0, 1],
    ]);
  });
});
