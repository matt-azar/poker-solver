/**
 * Recorded solver-engine IPC replies for the browser Equity Calculator preview.
 *
 * Same React Equity workspace as desktop; calculator jobs are served from
 * {@link createEquityJobFixtureSession}. Study node equity is out of scope.
 */
import type { FixtureIpcHandler, IpcRequestEnvelope } from "../../engine/transport";
import { SolverIpcError } from "../../engine/transport";
import {
  createEquityJobFixtureSession,
  type EquityJobFixtureSession,
} from "./equityJobFixture";
import type { PreviewReviewerState } from "./nodeLockingFixture";

export const EQUITY_CALCULATOR_PREVIEW_ID = "equity-calculator";

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

function idleStatusBody() {
  return {
    running: false,
    paused: false,
    cancelled: false,
    failed: false,
    error: "",
    last_error: null,
    solution_id: null,
    baseline_solution_id: null,
    root_node_id: null,
    job_id: null,
    status_generation: 1,
    phase: "idle",
    iterations: 0,
    iterations_requested: 0,
    policy_revision: 0,
    has_training: false,
    can_continue: false,
    terminal_reason: null,
    player0_expected_utility: null,
    nash_gap: null,
    accuracy_chips: null,
    pot: 0,
    stack: 0,
    board: [],
    algorithm: "cfr+",
  };
}

export type EquityCalculatorFixtureController = {
  handler: FixtureIpcHandler;
  getReviewerState: () => PreviewReviewerState;
  setReviewerState: (next: PreviewReviewerState) => void;
  getLastEquityStart: () => unknown;
  equityJobs: EquityJobFixtureSession;
};

/** Mutable recorded-fixture session for one Equity Calculator preview load. */
export function createEquityCalculatorFixtureHandler(
  initialState: PreviewReviewerState = "default",
): EquityCalculatorFixtureController {
  let reviewerState = initialState;
  let requestSeq = 0;
  const equityJobs = createEquityJobFixtureSession();

  const handler: FixtureIpcHandler = async (op, body) => {
    requestSeq += 1;
    const requestId = `eqfix-${requestSeq}`;

    if (reviewerState === "dropped-connection") {
      throw new SolverIpcError({
        class: "connection_loss",
        message: "connection_loss: recorded fixture dropped engine connection",
        op,
        requestId,
        launchId: "fixture-preview",
      });
    }

    const equityReply = equityJobs.handle(op, body, requestId);
    if (equityReply) {
      return equityReply;
    }

    switch (op) {
      case "ready":
        return envelope(
          op,
          {
            protocol: 2,
            launch_id: "fixture-preview",
            sidecar: "recorded-fixture",
            workers: 0,
          },
          requestId,
        );
      case "status":
        return envelope(op, idleStatusBody(), requestId);
      // Calculator does not need a Study solution; refuse Study analysis ops
      // with a clear fixture message rather than empty bodies.
      case "node":
      case "values":
      case "equity":
      case "put_lock":
      case "resolve_locked":
      case "solve":
      case "begin_config":
        return {
          v: 2,
          kind: "reply",
          request_id: requestId,
          job_id: null,
          op,
          ok: false,
          error_code: "preview_unsupported",
          error_message:
            "This preview scenario covers Equity Calculator jobs only — use ?preview=node-locking for Study.",
          body: null,
        };
      default:
        return envelope(op, {}, requestId);
    }
  };

  return {
    handler,
    getReviewerState: () => reviewerState,
    setReviewerState: (next) => {
      reviewerState = next;
    },
    getLastEquityStart: () => equityJobs.getLastStartBody(),
    equityJobs,
  };
}
