import { afterEach, describe, expect, it, vi } from "vitest";
import { SolverIpcError } from "../engine/transport";
import {
  analysisErrorMessage,
  analysisRequestIsCurrent,
  analysisRevision,
  beginAnalysisRequest,
  invalidateAllAnalysisRequests,
  isTransientAnalysisError,
  pollAnalysis,
  policyRevisionOf,
  resetAnalysisCacheForTests,
  resetStatusPollingForTests,
  startStatusPolling,
  stopStatusPolling,
  isStatusPollActive,
} from "./studySessionController";

describe("studySessionController", () => {
  afterEach(() => {
    stopStatusPolling();
    resetStatusPollingForTests();
    resetAnalysisCacheForTests();
  });

  it("start/stop status polling arms and clears the session flag", () => {
    const kick = vi.fn();
    startStatusPolling(kick);
    expect(isStatusPollActive()).toBe(true);
    expect(kick).toHaveBeenCalledTimes(1);
    startStatusPolling(kick);
    expect(kick).toHaveBeenCalledTimes(1);
    stopStatusPolling();
    expect(isStatusPollActive()).toBe(false);
  });

  it("abandons in-flight analysis when navigation invalidates the token", async () => {
    const { token } = beginAnalysisRequest("values", "s1", "n1", 1);
    let fetches = 0;
    const pending = pollAnalysis(
      "values",
      token,
      async () => {
        fetches += 1;
        return { pending: true };
      },
      () => {
        throw new Error("stale ready must not paint");
      },
      () => {
        throw new Error("stale error must not paint");
      },
    );
    await Promise.resolve();
    invalidateAllAnalysisRequests();
    expect(analysisRequestIsCurrent("values", token)).toBe(false);
    await pending;
    expect(fetches).toBeGreaterThanOrEqual(1);
  });

  it("revision bump starts a new analysis identity", () => {
    const first = beginAnalysisRequest("equity", "s1", "n1", 1);
    const second = beginAnalysisRequest("equity", "s1", "n1", 2);
    expect(analysisRequestIsCurrent("equity", first.token)).toBe(false);
    expect(analysisRequestIsCurrent("equity", second.token)).toBe(true);
    expect(second.identity.revision).toBe(2);
  });

  it("prefers host policy_revision for analysis cache identity", () => {
    expect(
      analysisRevision(
        { node_id: "root", policy_revision: 3, status_generation: 9 },
        { policy_revision: 7, status_generation: 9 },
      ),
    ).toBe(7);
    expect(policyRevisionOf({ policy_revision: 4 })).toBe(4);
  });

  it("retries superseded analysis then paints the ready body", async () => {
    const { token } = beginAnalysisRequest("values", "s1", "root", 1);
    let fetches = 0;
    const onReady = vi.fn();
    const onError = vi.fn();
    await pollAnalysis(
      "values",
      token,
      async () => {
        fetches += 1;
        if (fetches === 1) {
          throw new SolverIpcError({
            class: "engine_rejection",
            message: "analysis superseded by a newer node request",
            errorCode: "superseded",
            op: "values",
          });
        }
        return { pending: false, node_id: "root" };
      },
      onReady,
      onError,
    );
    expect(fetches).toBe(2);
    expect(onReady).toHaveBeenCalledWith({ pending: false, node_id: "root" });
    expect(onError).not.toHaveBeenCalled();
    expect(isTransientAnalysisError(
      new SolverIpcError({
        class: "engine_rejection",
        message: "nothing published",
        errorCode: "nothing_published",
        op: "values",
      }),
    )).toBe(true);
    expect(analysisErrorMessage(
      new SolverIpcError({
        class: "engine_rejection",
        message: "analysis superseded by a newer node request",
        errorCode: "superseded",
        op: "values",
      }),
    )).toContain("superseded");
  });
});
