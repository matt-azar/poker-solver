/**
 * Recorded solver-engine IPC replies for the browser Node Locking preview.
 *
 * Captured shapes match host protocol 2 bodies used by EngineClient IPC
 * branches — not an HTTP :8765 fallthrough.
 *
 * Re-solve (`resolve_locked`) refuses to return the recorded success body until
 * the last `put_lock` matches the expected node id, scope, and frequencies.
 */
import type { FixtureIpcHandler, IpcRequestEnvelope } from "../../engine/transport";
import { SolverIpcError } from "../../engine/transport";

export type PreviewReviewerState = "default" | "pending-ev" | "dropped-connection";

export const NODE_LOCKING_PREVIEW_ID = "node-locking";
export const NODE_LOCKING_ROOT_ID = "p0.t-1.r-1";
export const NODE_LOCKING_NODE_A_ID = "p1.t-1.r-1";
export const NODE_LOCKING_NODE_B_ID = "p2.t-1.r-1";
export const NODE_LOCKING_SOLUTION_ID = "s1";

/** Scenario expectation: Full-node path after one Check-frequency slider to 0.80. */
export const EXPECTED_LOCK_SUBMISSION = {
  nodeId: NODE_LOCKING_ROOT_ID,
  scope: "node" as const,
  /** Aggregate Check frequency after the supported slider change. */
  checkFrequency: 0.8,
  /** Absolute tolerance on aggregate action frequencies. */
  frequencyEps: 0.02,
};

const ROOT_ACTIONS = ["Check", "Bet 50"] as const;
const ROOT_COMBOS = ["AhAd", "AhAs", "AhAc", "KhKd", "QhQd", "JhJd"] as const;

type LockBody = {
  node_id?: string;
  kind?: "full" | "selected";
  scope?: "node" | "line";
  hand_indices?: number[];
  probs?: number[];
  combo_probs?: number[][];
};

type RecordedLock = {
  node_id: string;
  kind: "full" | "selected";
  scope: "node" | "line";
  hand_indices: number[];
  probs: number[];
  combo_probs?: number[][];
};

type FixtureState = {
  reviewerState: PreviewReviewerState;
  statusGeneration: number;
  policyRevision: number;
  locks: RecordedLock[];
  lastPutLock: RecordedLock | null;
  resolveCount: number;
  requestSeq: number;
  /** node_id → pending resolvers for deferred values (stale-EV control). */
  deferredValues: Map<string, Array<() => void>>;
  valuesHold: Set<string>;
};

function envelope(op: string, body: unknown, requestId: string): IpcRequestEnvelope {
  return {
    v: 2,
    kind: "reply",
    request_id: requestId,
    job_id: null,
    op,
    ok: true,
    error_code: null,
    error_message: null,
    body,
  };
}

function failEnvelope(
  op: string,
  requestId: string,
  errorCode: string,
  errorMessage: string,
): IpcRequestEnvelope {
  return {
    v: 2,
    kind: "reply",
    request_id: requestId,
    job_id: null,
    op,
    ok: false,
    error_code: errorCode,
    error_message: errorMessage,
    body: null,
  };
}

function decisionNodeBody(
  nodeId: string,
  policyRevision: number,
  opts?: { mix?: number[]; nodeEv?: number },
) {
  const mix = opts?.mix ?? (policyRevision > 2 ? [0.35, 0.65] : [0.55, 0.45]);
  const children =
    nodeId === NODE_LOCKING_ROOT_ID
      ? [
          { action: "Check", label: "Check", node_id: NODE_LOCKING_NODE_A_ID },
          { action: "Bet 50", label: "Bet 50", node_id: NODE_LOCKING_NODE_B_ID },
        ]
      : [];
  return {
    node_id: nodeId,
    kind: "decision",
    player: nodeId === NODE_LOCKING_NODE_B_ID ? 1 : 0,
    to_act: nodeId === NODE_LOCKING_NODE_B_ID ? "IP" : "OOP",
    pot: 100,
    stack: 100,
    stacks: [100, 100],
    board: ["Kh", "9d", "2c", "7s", "3h"],
    actions: [...ROOT_ACTIONS],
    children,
    combos: [...ROOT_COMBOS],
    reach: ROOT_COMBOS.map(() => 1),
    marginal: ROOT_COMBOS.map(() => 1),
    strategy: ROOT_COMBOS.map(() => [...mix]),
    action_frequencies: [...mix],
    reach_defined: true,
    joint: 1,
    policy_revision: policyRevision,
    // Omit status_generation — Study drops nodes whose generation is behind
    // the last applied status poll (see navigateTo).
  };
}

function valuesBody(nodeId: string, policyRevision: number) {
  // Distinct per-node EV so stale-EV tests can tell A from B on screen.
  const base =
    nodeId === NODE_LOCKING_NODE_B_ID ? 40 : nodeId === NODE_LOCKING_NODE_A_ID ? 20 : 10;
  return {
    node_id: nodeId,
    actions: [...ROOT_ACTIONS],
    combos: [...ROOT_COMBOS],
    utility_basis: "local",
    local_offset: 0,
    value: ROOT_COMBOS.map((_, i) => base + i),
    action_ev: ROOT_COMBOS.map((_, i) => [base - 2 + i, base + 2 + i]),
    ev_defined: ROOT_COMBOS.map(() => true),
    node_ev: base + 1.5,
    node_ev_defined: true,
    policy_revision: policyRevision,
  };
}

function equityBody(nodeId: string, policyRevision: number) {
  const base = nodeId === NODE_LOCKING_NODE_B_ID ? 0.7 : 0.4;
  return {
    node_id: nodeId,
    combos: [...ROOT_COMBOS],
    equity: ROOT_COMBOS.map((_, i) => base + i * 0.01),
    policy_revision: policyRevision,
  };
}

function statusBody(state: FixtureState) {
  return {
    running: false,
    paused: false,
    cancelled: false,
    failed: false,
    error: "",
    last_error: null,
    solution_id: NODE_LOCKING_SOLUTION_ID,
    baseline_solution_id: state.resolveCount > 0 ? "s0" : null,
    root_node_id: NODE_LOCKING_ROOT_ID,
    job_id: "j-fixture",
    status_generation: state.statusGeneration,
    phase: "published",
    iterations: 20 + state.resolveCount,
    iterations_requested: 20 + state.resolveCount,
    // Keep in sync with node payloads so navigateTo is not stale-dropped.
    policy_revision: state.policyRevision,
    has_training: true,
    can_continue: true,
    terminal_reason: "completed",
    player0_expected_utility: 12.5,
    nash_gap: 0.02,
    accuracy_chips: 0.01,
    pot: 100,
    stack: 100,
    board: ["Kh", "9d", "2c", "7s", "3h"],
    algorithm: "cfr+",
  };
}

function asLockBody(body: unknown): LockBody {
  if (!body || typeof body !== "object") {
    return {};
  }
  return body as LockBody;
}

function aggregateCheckFrequency(lock: RecordedLock): number | null {
  if (Array.isArray(lock.combo_probs) && lock.combo_probs.length > 0) {
    let weightSum = 0;
    let checkMass = 0;
    for (const row of lock.combo_probs) {
      if (!Array.isArray(row) || row.length < 1) {
        continue;
      }
      const rowSum = row.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
      if (!(rowSum > 0)) {
        continue;
      }
      weightSum += 1;
      checkMass += row[0]! / rowSum;
    }
    if (weightSum > 0) {
      return checkMass / weightSum;
    }
  }
  if (Array.isArray(lock.probs) && lock.probs.length >= 1) {
    const sum = lock.probs.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
    if (sum > 0) {
      return lock.probs[0]! / sum;
    }
  }
  return null;
}

/**
 * Assert the UI's last put_lock matches the scenario contract.
 * Throws with a useful message so Playwright cannot pass on wrong frequencies.
 */
export function assertExpectedLockSubmission(
  lock: RecordedLock | null,
  expected = EXPECTED_LOCK_SUBMISSION,
): void {
  if (!lock) {
    throw new Error(
      `preview fixture: resolve_locked refused — no put_lock received before re-solve ` +
        `(expected node_id=${expected.nodeId}, scope=${expected.scope}, ` +
        `Check frequency≈${expected.checkFrequency})`,
    );
  }
  const problems: string[] = [];
  if (lock.node_id !== expected.nodeId) {
    problems.push(`node_id got ${JSON.stringify(lock.node_id)} want ${expected.nodeId}`);
  }
  if (lock.scope !== expected.scope) {
    problems.push(`scope got ${JSON.stringify(lock.scope)} want ${expected.scope}`);
  }
  const checkFreq = aggregateCheckFrequency(lock);
  if (checkFreq == null) {
    problems.push("submitted frequencies missing (no probs / combo_probs)");
  } else if (Math.abs(checkFreq - expected.checkFrequency) > expected.frequencyEps) {
    problems.push(
      `Check frequency got ${checkFreq.toFixed(4)} want ${expected.checkFrequency}` +
        `±${expected.frequencyEps} (probs=${JSON.stringify(lock.probs)})`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `preview fixture: resolve_locked refused — unexpected lock submission: ${problems.join("; ")}`,
    );
  }
}

export type NodeLockingFixtureController = {
  handler: FixtureIpcHandler;
  getReviewerState: () => PreviewReviewerState;
  setReviewerState: (next: PreviewReviewerState) => void;
  getLastPutLock: () => RecordedLock | null;
  /** Hold `values` replies for a node until {@link releaseValues} (stale-EV). */
  holdValues: (nodeId: string) => void;
  releaseValues: (nodeId: string) => void;
  /** Inject a put_lock without going through the UI (wrong-frequency checks). */
  recordPutLockForTests: (lock: RecordedLock) => void;
};

/** Mutable recorded-fixture session for one browser preview page load. */
export function createNodeLockingFixtureHandler(
  initialState: PreviewReviewerState = "default",
): NodeLockingFixtureController {
  const state: FixtureState = {
    reviewerState: initialState,
    statusGeneration: 3,
    policyRevision: 2,
    locks: [],
    lastPutLock: null,
    resolveCount: 0,
    requestSeq: 0,
    deferredValues: new Map(),
    valuesHold: new Set(),
  };

  async function waitIfValuesHeld(nodeId: string): Promise<void> {
    if (!state.valuesHold.has(nodeId)) {
      return;
    }
    await new Promise<void>((resolve) => {
      const queue = state.deferredValues.get(nodeId) ?? [];
      queue.push(resolve);
      state.deferredValues.set(nodeId, queue);
    });
  }

  const handler: FixtureIpcHandler = async (op, body) => {
    state.requestSeq += 1;
    const requestId = `fix-${state.requestSeq}`;

    if (state.reviewerState === "dropped-connection") {
      throw new SolverIpcError({
        class: "connection_loss",
        message: "connection_loss: recorded fixture dropped engine connection",
        op,
        requestId,
        launchId: "fixture-preview",
      });
    }

    switch (op) {
      case "status":
        return envelope(op, statusBody(state), requestId);
      case "node": {
        const nodeId =
          body &&
          typeof body === "object" &&
          typeof (body as { node_id?: unknown }).node_id === "string"
            ? (body as { node_id: string }).node_id
            : NODE_LOCKING_ROOT_ID;
        const id = nodeId || NODE_LOCKING_ROOT_ID;
        return envelope(op, decisionNodeBody(id, state.policyRevision), requestId);
      }
      case "values": {
        if (state.reviewerState === "pending-ev") {
          return envelope(op, { pending: true, node_id: NODE_LOCKING_ROOT_ID }, requestId);
        }
        const nodeId =
          body &&
          typeof body === "object" &&
          typeof (body as { node_id?: unknown }).node_id === "string"
            ? (body as { node_id: string }).node_id
            : NODE_LOCKING_ROOT_ID;
        await waitIfValuesHeld(nodeId);
        return envelope(op, valuesBody(nodeId, state.policyRevision), requestId);
      }
      case "equity": {
        if (state.reviewerState === "pending-ev") {
          return envelope(op, { pending: true, node_id: NODE_LOCKING_ROOT_ID }, requestId);
        }
        const nodeId =
          body &&
          typeof body === "object" &&
          typeof (body as { node_id?: unknown }).node_id === "string"
            ? (body as { node_id: string }).node_id
            : NODE_LOCKING_ROOT_ID;
        return envelope(op, equityBody(nodeId, state.policyRevision), requestId);
      }
      case "list_locks":
        return envelope(op, { locks: state.locks }, requestId);
      case "put_lock": {
        const lock = asLockBody(body);
        const nodeId = typeof lock.node_id === "string" ? lock.node_id : NODE_LOCKING_ROOT_ID;
        const record: RecordedLock = {
          node_id: nodeId,
          kind: lock.kind === "full" ? "full" : "selected",
          scope: lock.scope === "line" ? "line" : "node",
          hand_indices: Array.isArray(lock.hand_indices) ? lock.hand_indices.slice() : [],
          probs: Array.isArray(lock.probs) ? lock.probs.slice() : [0.5, 0.5],
          ...(Array.isArray(lock.combo_probs) ? { combo_probs: lock.combo_probs } : {}),
        };
        state.lastPutLock = record;
        state.locks = [
          ...state.locks.filter(
            (entry) => !(entry.node_id === nodeId && entry.scope === record.scope),
          ),
          record,
        ];
        return envelope(op, { locks: state.locks }, requestId);
      }
      case "delete_lock": {
        const opts = (body && typeof body === "object" ? body : {}) as {
          node_id?: string;
          hand_index?: number;
        };
        if (!opts.node_id && opts.hand_index == null) {
          state.locks = [];
          state.lastPutLock = null;
        } else if (opts.node_id && opts.hand_index == null) {
          state.locks = state.locks.filter((entry) => entry.node_id !== opts.node_id);
        }
        return envelope(op, { locks: state.locks }, requestId);
      }
      case "resolve_locked": {
        // Binding pass criterion: verify outbound lock before recorded success.
        assertExpectedLockSubmission(state.lastPutLock);
        state.resolveCount += 1;
        state.policyRevision += 1;
        state.statusGeneration += 1;
        return envelope(
          op,
          {
            accepted: false,
            running: false,
            solution_id: 1,
            policy_revision: state.policyRevision,
            trained: 8,
            terminal_reason: "completed",
            threads: 1,
          },
          requestId,
        );
      }
      case "list_strategy_edits":
        return envelope(op, { edits: [], persisted: false }, requestId);
      case "categories":
        return envelope(
          op,
          {
            node_id: NODE_LOCKING_ROOT_ID,
            categories: [],
            policy_revision: state.policyRevision,
          },
          requestId,
        );
      case "get_config":
        return envelope(
          op,
          {
            config_text: "# recorded fixture\nstreet-config 1\n",
            board: ["Kh", "9d", "2c", "7s", "3h"],
          },
          requestId,
        );
      case "begin_config":
      case "solve":
      case "pause":
      case "cancel":
        return envelope(op, { ok: true }, requestId);
      case "tree_preview":
        // Small recorded public tree so Build → Preview tree can be exercised
        // in the browser fixture (collapsed-by-default navigation).
        return envelope(
          op,
          {
            nodes: [
              {
                index: 0,
                terminal: false,
                chance: false,
                player: 0,
                street: 0,
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
                terminal: true,
                chance: false,
                player: -1,
                street: 0,
                path: "Check",
                chance_child: -1,
                actions: [],
                children: [],
              },
              {
                index: 2,
                terminal: false,
                chance: false,
                player: 1,
                street: 0,
                path: "Bet 50",
                chance_child: -1,
                actions: [
                  { label: "Fold", compact: "f", child_index: 3 },
                  { label: "Call", compact: "call", child_index: 4 },
                  { label: "Raise to 150", compact: "r150", child_index: 5 },
                ],
                children: [3, 4, 5],
              },
            ],
            tree_edits: [],
            plan: {
              estimated_peak_bytes: 2_097_152,
              memory_budget_bytes: 67_108_864,
              deals: 48,
              infosets: 10,
              decision_nodes: 20,
              terminals: 30,
              public_decisions: 4,
              threads: 1,
              fits_budget: true,
              dry_run: true,
            },
          },
          requestId,
        );
      case "plan_memory":
        return envelope(
          op,
          {
            estimated_peak_bytes: 2_097_152,
            memory_budget_bytes: 67_108_864,
            deals: 48,
            infosets: 10,
            decision_nodes: 20,
            terminals: 30,
            public_decisions: 4,
            threads: 1,
            fits_budget: true,
            dry_run: true,
          },
          requestId,
        );
      case "start_equity_job":
      case "get_equity_job":
      case "cancel_equity_job":
        return failEnvelope(
          op,
          requestId,
          "preview_unsupported",
          "Equity Calculator jobs are not part of this preview fixture.",
        );
      default:
        return envelope(op, {}, requestId);
    }
  };

  return {
    handler,
    getReviewerState: () => state.reviewerState,
    setReviewerState: (next) => {
      state.reviewerState = next;
    },
    getLastPutLock: () => state.lastPutLock,
    holdValues: (nodeId) => {
      state.valuesHold.add(nodeId);
    },
    releaseValues: (nodeId) => {
      state.valuesHold.delete(nodeId);
      const waiting = state.deferredValues.get(nodeId) ?? [];
      state.deferredValues.delete(nodeId);
      for (const resolve of waiting) {
        resolve();
      }
    },
    recordPutLockForTests: (lock) => {
      state.lastPutLock = lock;
      state.locks = [lock];
    },
  };
}
