import { describe, expect, it } from "vitest";
import {
  classifyEngineSessionFault,
  disconnectedRecoveryMessage,
  isEngineSessionDead,
  isRecoveryOrUnreachableMessage,
  isStickyBusyPhase,
  normalizeStatusForPhase,
  phaseAfterSessionFault,
  sessionDeadUiPatch,
  shouldMarkStatusPollDead,
  STATUS_POLL_DEAD_AFTER_FAILURES,
  statusIndicatesFailure,
  statusStickyError,
} from "./sessionRecovery";

describe("sessionRecovery", () => {
  it("classifies pipe / InvalidFrame faults as session-dead", () => {
    expect(isEngineSessionDead("solver-engine pipe closed")).toBe(true);
    expect(isEngineSessionDead("Broken pipe")).toBe(true);
    expect(isEngineSessionDead("ipc read error: InvalidFrame")).toBe(true);
    expect(isEngineSessionDead("invalid_frame")).toBe(true);
    expect(isEngineSessionDead("strategy edit rejected: bad probs")).toBe(false);
    expect(classifyEngineSessionFault(new Error("Broken pipe")).sessionDead).toBe(
      true,
    );
  });

  it("clears sticky busy/cancel phases after a session fault", () => {
    expect(isStickyBusyPhase("stop_requested")).toBe(true);
    expect(isStickyBusyPhase("solving")).toBe(true);
    expect(phaseAfterSessionFault("stop_requested")).toBe("idle");
    expect(phaseAfterSessionFault("solving", { hadSolution: true })).toBe(
      "failed",
    );
    expect(phaseAfterSessionFault("complete", { hadSolution: true })).toBe(
      "complete",
    );
  });

  it("builds an honest disconnected patch for Reconnect", () => {
    const patch = sessionDeadUiPatch({
      detail: "pipe closed",
      phase: "stop_requested",
      solutionId: "s1",
    });
    expect(patch.connection).toBe("disconnected");
    expect(patch.phase).toBe("failed");
    expect(patch.message).toBe(disconnectedRecoveryMessage("pipe closed"));
    expect(patch.message).toMatch(/Reconnect/i);
  });

  it("normalizes host phase=failed into status.failed", () => {
    const next = normalizeStatusForPhase({
      running: false,
      paused: false,
      cancelled: false,
      status_generation: 1,
      phase: "failed",
    });
    expect(next.failed).toBe(true);
  });

  it("marks status-poll dead immediately for session-dead faults, else after threshold (ZR-148)", () => {
    expect(
      shouldMarkStatusPollDead({
        consecutiveFailures: 1,
        detail: "Broken pipe",
      }),
    ).toBe(true);
    expect(
      shouldMarkStatusPollDead({
        consecutiveFailures: 1,
        detail: "status request timed out",
      }),
    ).toBe(false);
    expect(
      shouldMarkStatusPollDead({
        consecutiveFailures: STATUS_POLL_DEAD_AFTER_FAILURES,
        detail: "status request timed out",
      }),
    ).toBe(true);
  });

  it("rejects negative consecutiveFailures / zero threshold (ZR-149)", () => {
    expect(() =>
      shouldMarkStatusPollDead({
        consecutiveFailures: -1,
        detail: "status request timed out",
      }),
    ).toThrow(/consecutiveFailures/);
    expect(() =>
      shouldMarkStatusPollDead({
        consecutiveFailures: 1,
        detail: "status request timed out",
        threshold: 0,
      }),
    ).toThrow(/threshold/);
  });

  it("reads sticky last_error and recovery unreachable copy", () => {
    expect(
      statusStickyError({
        running: false,
        last_error: "InvalidSession",
        error: "",
      }),
    ).toBe("InvalidSession");
    expect(
      statusIndicatesFailure({
        running: false,
        failed: true,
        phase: "published",
      }),
    ).toBe(true);
    expect(
      isRecoveryOrUnreachableMessage(
        "Engine unreachable: status request timed out. Use Reconnect — Study will re-ensure the local solver-engine.",
      ),
    ).toBe(true);
    expect(isRecoveryOrUnreachableMessage("Solving — 12/200 iterations")).toBe(
      false,
    );
  });
});
