/**
 * Shared recorded Equity Calculator job replies for browser preview fixtures.
 *
 * Distinct from Study node `equity` (reach-weighted check-down at a tree node).
 * Calculator jobs are `start_equity_job` / `get_equity_job` / `cancel_equity_job`.
 *
 * The happy-path contract matches scripts/zig/equity-calculator-smoke.py:
 * exact river AsAd vs KcKd on 2c 3d 7h 9s Jc → 100% / 0%.
 */
import type { IpcRequestEnvelope } from "../../engine/transport";

/** Scenario expectation: Exact river AA vs KK (matches calculator smoke). */
export const EXPECTED_EQUITY_SUBMISSION = {
  method: "exact" as const,
  board: ["2c", "3d", "7h", "9s", "Jc"] as const,
  deadCards: [] as const,
  players: [
    { id: "p1", range: "AsAd" },
    { id: "p2", range: "KcKd" },
  ] as const,
};

export type EquityStartBody = {
  version?: number;
  client_revision?: string;
  method?: string;
  target_samples?: number;
  seed?: number;
  board?: unknown;
  dead_cards?: unknown;
  players?: unknown;
};

type JobRecord = {
  clientRevision: string;
  cancelled: boolean;
  /** First get returns running; subsequent gets return completed (unless cancelled). */
  polls: number;
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

function asStartBody(body: unknown): EquityStartBody {
  if (!body || typeof body !== "object") {
    return {};
  }
  return body as EquityStartBody;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (!value.every((entry) => typeof entry === "string")) {
    return null;
  }
  return value as string[];
}

function asPlayers(
  value: unknown,
): Array<{ id: string; range: string }> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: Array<{ id: string; range: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      return null;
    }
    const id = (entry as { id?: unknown }).id;
    const range = (entry as { range?: unknown }).range;
    if (typeof id !== "string" || typeof range !== "string") {
      return null;
    }
    out.push({ id, range: range.trim() });
  }
  return out;
}

/**
 * Assert the UI's start_equity_job body matches the scenario contract.
 * Throws with a useful message so Playwright cannot pass on wrong inputs.
 */
export function assertExpectedEquitySubmission(
  body: unknown,
  expected = EXPECTED_EQUITY_SUBMISSION,
): void {
  const start = asStartBody(body);
  const problems: string[] = [];

  if (start.method !== expected.method) {
    problems.push(
      `method got ${JSON.stringify(start.method)} want ${expected.method}`,
    );
  }

  const board = asStringArray(start.board);
  if (!board) {
    problems.push("board missing or not a string[]");
  } else if (
    board.length !== expected.board.length ||
    board.some((card, i) => card !== expected.board[i])
  ) {
    problems.push(
      `board got ${JSON.stringify(board)} want ${JSON.stringify([...expected.board])}`,
    );
  }

  const dead = asStringArray(start.dead_cards ?? []);
  if (!dead) {
    problems.push("dead_cards missing or not a string[]");
  } else if (dead.length !== expected.deadCards.length) {
    problems.push(
      `dead_cards got ${JSON.stringify(dead)} want ${JSON.stringify([...expected.deadCards])}`,
    );
  }

  const players = asPlayers(start.players);
  if (!players) {
    problems.push("players missing or malformed");
  } else if (players.length !== expected.players.length) {
    problems.push(
      `players length got ${players.length} want ${expected.players.length}`,
    );
  } else {
    for (let i = 0; i < expected.players.length; i++) {
      const want = expected.players[i]!;
      const got = players[i]!;
      if (got.id !== want.id) {
        problems.push(`players[${i}].id got ${JSON.stringify(got.id)} want ${want.id}`);
      }
      if (got.range !== want.range) {
        problems.push(
          `players[${i}].range got ${JSON.stringify(got.range)} want ${want.range}`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `preview fixture: start_equity_job refused — unexpected calculator submission: ${problems.join("; ")}`,
    );
  }
}

/** Completed result payload for the expected AA-vs-KK river scenario. */
export function recordedEquityResult() {
  return {
    model: "check-down",
    units: "fraction of the pot",
    method_version: "equity-calc-1",
    requested_method: "exact",
    actual_method: "exact",
    method_reason: "exact requested",
    joint_defined: true,
    exact_complete: true,
    stopped: false,
    legal_tuples: 1,
    completions_per_tuple: 1,
    exact_deals: 1,
    accepted_samples: 0,
    attempted_tuples: 0,
    seed: 1,
    elapsed_seconds: 0.01,
    board: [...EXPECTED_EQUITY_SUBMISSION.board],
    dead_cards: [...EXPECTED_EQUITY_SUBMISSION.deadCards],
    players: [
      { id: "p1", defined: true, equity: 1, win: 1, tie: 0, loss: 0 },
      { id: "p2", defined: true, equity: 0, win: 0, tie: 0, loss: 1 },
    ],
  };
}

export type EquityJobFixtureSession = {
  /** Handle calculator ops; returns null for unrelated ops. */
  handle: (
    op: string,
    body: unknown,
    requestId: string,
  ) => IpcRequestEnvelope | null;
  getLastStartBody: () => unknown;
  /** Inject a start body without going through the handler (unit tests). */
  recordStartForTests: (body: unknown) => void;
};

/** Mutable calculator-job session for one browser preview page load. */
export function createEquityJobFixtureSession(): EquityJobFixtureSession {
  let jobSeq = 0;
  const jobs = new Map<string, JobRecord>();
  let lastStartBody: unknown = null;

  const handle = (
    op: string,
    body: unknown,
    requestId: string,
  ): IpcRequestEnvelope | null => {
    switch (op) {
      case "start_equity_job": {
        lastStartBody = body;
        assertExpectedEquitySubmission(body);
        const start = asStartBody(body);
        jobSeq += 1;
        const jobId = `eq-fixture-${jobSeq}`;
        const clientRevision =
          typeof start.client_revision === "string" && start.client_revision.trim()
            ? start.client_revision.trim()
            : "fixture";
        jobs.set(jobId, { clientRevision, cancelled: false, polls: 0 });
        return envelope(op, { job_id: jobId, state: "queued" }, requestId);
      }
      case "get_equity_job": {
        const jobId =
          body &&
          typeof body === "object" &&
          typeof (body as { job_id?: unknown }).job_id === "string"
            ? (body as { job_id: string }).job_id.trim()
            : "";
        if (!jobId) {
          return failEnvelope(op, requestId, "invalid_request", "job_id required");
        }
        const job = jobs.get(jobId);
        if (!job) {
          return failEnvelope(
            op,
            requestId,
            "not_found",
            `Unknown equity job ${JSON.stringify(jobId)}`,
          );
        }
        if (job.cancelled) {
          return envelope(
            op,
            {
              job_id: jobId,
              state: "cancelled",
              client_revision: job.clientRevision,
              progress_done: 0,
              progress_total: 1,
              elapsed_seconds: 0,
            },
            requestId,
          );
        }
        job.polls += 1;
        if (job.polls < 2) {
          return envelope(
            op,
            {
              job_id: jobId,
              state: "running",
              client_revision: job.clientRevision,
              progress_done: 0,
              progress_total: 1,
              elapsed_seconds: 0,
            },
            requestId,
          );
        }
        return envelope(
          op,
          {
            job_id: jobId,
            state: "completed",
            client_revision: job.clientRevision,
            progress_done: 1,
            progress_total: 1,
            elapsed_seconds: 0.01,
            result: recordedEquityResult(),
          },
          requestId,
        );
      }
      case "cancel_equity_job": {
        const jobId =
          body &&
          typeof body === "object" &&
          typeof (body as { job_id?: unknown }).job_id === "string"
            ? (body as { job_id: string }).job_id.trim()
            : "";
        if (!jobId) {
          return failEnvelope(op, requestId, "invalid_request", "job_id required");
        }
        const job = jobs.get(jobId);
        if (!job) {
          return failEnvelope(
            op,
            requestId,
            "not_found",
            `Unknown equity job ${JSON.stringify(jobId)}`,
          );
        }
        job.cancelled = true;
        return envelope(
          op,
          {
            job_id: jobId,
            state: "cancelled",
            client_revision: job.clientRevision,
            progress_done: 0,
            progress_total: 1,
            elapsed_seconds: 0,
          },
          requestId,
        );
      }
      default:
        return null;
    }
  };

  return {
    handle,
    getLastStartBody: () => lastStartBody,
    recordStartForTests: (body) => {
      lastStartBody = body;
    },
  };
}
