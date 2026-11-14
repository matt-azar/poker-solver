import { describe, expect, it } from "vitest";
import {
  canOfferReopenLastCheckpoint,
  classifyEngineSessionFault,
  coldReconnectMessage,
  disconnectedRecoveryMessage,
  isEngineSessionDead,
  isRecoveryOrUnreachableMessage,
  isSoftRpcTimeoutDetail,
  isStickyBusyPhase,
  lastValidCheckpointPath,
  normalizeStatusForPhase,
  phaseAfterSessionFault,
  sessionDeadUiPatch,
  shouldMarkStatusPollDead,
  shouldTerminateHungSidecar,
  STATUS_POLL_DEAD_AFTER_FAILURES,
  statusIndicatesFailure,
  statusStickyError,
} from "./sessionRecovery";

describe("sessionRecovery", () => {
  it("classifies pipe / InvalidFrame faults as session-dead", () => {
    expect(isEngineSessionDead("solver-engine pipe closed")).toBe(true);
    expect(
      isEngineSessionDead("connection_loss: solver-engine pipe closed (launch zig-1)"),
    ).toBe(true);
    expect(isEngineSessionDead("Broken pipe")).toBe(true);
    expect(isEngineSessionDead("ipc read error: InvalidFrame")).toBe(true);
    expect(isEngineSessionDead("invalid_frame")).toBe(true);
    expect(isEngineSessionDead("malformed IPC framing: decode ipc json")).toBe(true);
    expect(isEngineSessionDead("No engine URL — Study requires the Tauri shell")).toBe(
      true,
    );
    expect(
      isEngineSessionDead("solver-engine IPC not connected — use Reconnect"),
    ).toBe(true);
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

  it("aliases Zig heap + value fields for Study footer metrics (ZR-171)", () => {
    const next = normalizeStatusForPhase({
      running: true,
      paused: false,
      cancelled: false,
      status_generation: 2,
      allocated_bytes: 4096,
      peak_allocated_bytes: 8192,
      nash_gap: 2,
      value: 1.5,
    });
    expect(next.engine_allocated).toBe(4096);
    expect(next.engine_heap_bytes).toBe(4096);
    expect(next.engine_peak).toBe(8192);
    expect(next.accuracy_chips).toBe(1);
    expect(next.player0_expected_utility).toBe(1.5);
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

  it("ZR-151: soft RPC timeout is not session-dead; hung threshold may terminate", () => {
    expect(isSoftRpcTimeoutDetail("status request timed out")).toBe(true);
    expect(isSoftRpcTimeoutDetail("values request timed out")).toBe(true);
    expect(isEngineSessionDead("values request timed out")).toBe(false);
    expect(
      shouldTerminateHungSidecar({
        consecutiveFailures: 1,
        detail: "values request timed out",
      }),
    ).toBe(false);
    expect(
      shouldTerminateHungSidecar({
        consecutiveFailures: STATUS_POLL_DEAD_AFTER_FAILURES,
        detail: "status request timed out",
      }),
    ).toBe(true);
    expect(
      shouldTerminateHungSidecar({
        consecutiveFailures: 1,
        detail: "Broken pipe",
      }),
    ).toBe(true);
  });

  it("soft status timeouts during build/train/EV do not hung-kill (Windows flop)", () => {
    for (const phase of [
      "building",
      "solving",
      "pause_requested",
      "stop_requested",
      "analysis_pending",
    ] as const) {
      expect(
        shouldMarkStatusPollDead({
          consecutiveFailures: STATUS_POLL_DEAD_AFTER_FAILURES,
          detail: "status request timed out. Shell: solver-engine IPC (protocol 2).",
          phase,
        }),
      ).toBe(false);
      expect(
        shouldTerminateHungSidecar({
          consecutiveFailures: STATUS_POLL_DEAD_AFTER_FAILURES,
          detail: "status request timed out",
          phase,
        }),
      ).toBe(false);
    }
    // Idle still hung-kills after threshold; hard pipe death always terminates.
    expect(
      shouldTerminateHungSidecar({
        consecutiveFailures: STATUS_POLL_DEAD_AFTER_FAILURES,
        detail: "status request timed out",
        phase: "idle",
      }),
    ).toBe(true);
    expect(
      shouldTerminateHungSidecar({
        consecutiveFailures: 1,
        detail: "Broken pipe",
        phase: "solving",
      }),
    ).toBe(true);
  });

  it("cold reconnect copy keeps checkpoint reopen honest and rejects silent restore (ZR-143/ZR-157)", () => {
    expect(lastValidCheckpointPath(" /tmp/last.psol ")).toBe("/tmp/last.psol");
    expect(lastValidCheckpointPath("")).toBe("");
    expect(lastValidCheckpointPath("/draft.psol", "/saved.psol")).toBe(
      "/saved.psol",
    );
    expect(lastValidCheckpointPath("/draft.psol", "")).toBe("/draft.psol");
    expect(canOfferReopenLastCheckpoint("/saved.psol")).toBe(true);
    expect(canOfferReopenLastCheckpoint("")).toBe(false);
    expect(canOfferReopenLastCheckpoint("   ")).toBe(false);
    const withPath = coldReconnectMessage({
      label: "solver-engine IPC (protocol 2)",
      solutionPath: "/tmp/last.psol",
    });
    expect(withPath).toMatch(/reconnected/i);
    expect(withPath).toMatch(/Unsaved train progress is gone/i);
    expect(withPath).toMatch(/Reopen last checkpoint/i);
    expect(withPath).toMatch(/\/tmp\/last\.psol/);
    const withoutPath = coldReconnectMessage({ label: "engine" });
    expect(withoutPath).toMatch(/Unsaved train progress is gone/i);
    expect(withoutPath).toMatch(/Save before a crash/i);
  });
});
