import { describe, expect, it, vi } from "vitest";
import {
  captureCompareRequestScope,
  captureStudyMutationScope,
  classifyStatusPollError,
  compareRequestIsCurrent,
  createTimeoutSignal,
  isAbortError,
  nextStatusPollDelay,
  statusPollFailureDetail,
  STATUS_POLL_BACKOFF_INITIAL_MS,
  STATUS_POLL_BACKOFF_MAX_MS,
  STATUS_POLL_INTERVAL_MS,
  studyMutationScopeIsCurrent,
  studyMutationScopesEqual,
} from "./requestScope";

describe("study mutation scope", () => {
  it("captures and matches solution/node/actions", () => {
    const scope = captureStudyMutationScope({
      solutionId: "s1",
      nodeId: "p0",
      revision: 3,
      actions: ["Check", "Bet 50"],
    });
    expect(scope).toEqual({
      solutionId: "s1",
      nodeId: "p0",
      revision: 3,
      actionsSignature: "Check\0Bet 50",
    });
    expect(
      studyMutationScopeIsCurrent(scope, {
        solutionId: "s1",
        nodeId: "p0",
        revision: 3,
        actions: ["Check", "Bet 50"],
      }),
    ).toBe(true);
    expect(
      studyMutationScopeIsCurrent(scope, {
        solutionId: "s1",
        nodeId: "p1",
        revision: 3,
        actions: ["Check", "Bet 50"],
      }),
    ).toBe(false);
    expect(
      studyMutationScopeIsCurrent(scope, {
        solutionId: "s2",
        nodeId: "p0",
        revision: 3,
        actions: ["Check", "Bet 50"],
      }),
    ).toBe(false);
  });

  it("fails closed when live identity is missing", () => {
    const scope = captureStudyMutationScope({
      solutionId: "s1",
      nodeId: "p0",
    });
    expect(
      studyMutationScopeIsCurrent(scope, {
        solutionId: null,
        nodeId: "p0",
      }),
    ).toBe(false);
    expect(studyMutationScopesEqual(scope, null)).toBe(false);
    expect(captureStudyMutationScope({ solutionId: "s1", nodeId: null })).toBeNull();
  });
});

describe("compare request scope", () => {
  it("rejects publication when live solution/node diverges", () => {
    const captured = captureCompareRequestScope({
      baselineId: "s0",
      scenarioId: "s1",
      nodeId: "p0",
    });
    expect(
      compareRequestIsCurrent(captured, {
        baselineId: "s0",
        scenarioId: "s1",
        nodeId: "p0",
      }),
    ).toBe(true);
    expect(
      compareRequestIsCurrent(captured, {
        baselineId: "s0",
        scenarioId: "s2",
        nodeId: "p0",
      }),
    ).toBe(false);
    expect(
      compareRequestIsCurrent(captured, {
        baselineId: "s0",
        scenarioId: "s1",
        nodeId: "p1",
      }),
    ).toBe(false);
  });
});

describe("status poll scheduling", () => {
  it("uses base interval on success and backoff on failure", () => {
    expect(
      nextStatusPollDelay({ outcome: "success", consecutiveFailures: 0 }),
    ).toBe(STATUS_POLL_INTERVAL_MS);
    expect(
      nextStatusPollDelay({ outcome: "shutdown_cancel", consecutiveFailures: 3 }),
    ).toBe(STATUS_POLL_INTERVAL_MS);
    expect(
      nextStatusPollDelay({ outcome: "failure", consecutiveFailures: 1 }),
    ).toBe(STATUS_POLL_BACKOFF_INITIAL_MS);
    expect(
      nextStatusPollDelay({ outcome: "failure", consecutiveFailures: 2 }),
    ).toBe(STATUS_POLL_BACKOFF_INITIAL_MS * 2);
    expect(
      nextStatusPollDelay({ outcome: "failure", consecutiveFailures: 20 }),
    ).toBe(STATUS_POLL_BACKOFF_MAX_MS);
  });

  it("distinguishes shutdown cancel from failure aborts", () => {
    const abort = new DOMException("Aborted", "AbortError");
    expect(isAbortError(abort)).toBe(true);
    expect(
      classifyStatusPollError(abort, { pollActive: false, timedOut: false }),
    ).toEqual({
      kind: "shutdown_cancel",
    });
    expect(
      classifyStatusPollError(abort, { pollActive: true, timedOut: false }),
    ).toEqual({ kind: "failure" });
    expect(
      classifyStatusPollError(abort, { pollActive: false, timedOut: true }),
    ).toEqual({ kind: "failure" });
    expect(
      classifyStatusPollError(new Error("boom"), { pollActive: true }),
    ).toEqual({
      kind: "failure",
    });
  });

  it("createTimeoutSignal aborts on timeout", async () => {
    vi.useFakeTimers();
    const { signal, dispose } = createTimeoutSignal(100);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(100);
    expect(signal.aborted).toBe(true);
    dispose();
    vi.useRealTimers();
  });

  it("statusPollFailureDetail hides raw AbortError wording", () => {
    const abort = new DOMException("signal is aborted without reason", "AbortError");
    expect(statusPollFailureDetail(abort, { timedOut: true })).toBe(
      "status request timed out",
    );
    expect(statusPollFailureDetail(abort)).toBe("status request was cancelled");
    expect(statusPollFailureDetail(new Error("connection refused"))).toBe(
      "connection refused",
    );
    expect(statusPollFailureDetail(null)).toBe("engine unreachable");
  });
});
