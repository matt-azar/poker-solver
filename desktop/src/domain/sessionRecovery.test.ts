import { describe, expect, it } from "vitest";
import {
  canOfferReopenLastCheckpoint,
  classifyEngineFault,
  classifyEngineSessionFault,
  coldReconnectMessage,
  decideReadyProbeOnExistingChild,
  decideStatusPollRecovery,
  disconnectedRecoveryMessage,
  explicitRestartRecoveryMessage,
  isAdmissionSaturationDetail,
  isEngineSessionDead,
  isRecoveryOrUnreachableMessage,
  isSoftRpcTimeoutDetail,
  isStickyBusyPhase,
  lastValidCheckpointPath,
  normalizeStatusForPhase,
  phaseAfterSessionFault,
  sessionDeadUiPatch,
  shouldMarkStatusPollDead,
  shouldSoftRecoverTrainTimeout,
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

  describe("IPC audit §3 congestion / Complete / Ready policy", () => {
    const saturation =
      "admission saturated: 8/8 outstanding requests";
    const softTimeout = "status request timed out";

    it("row1: three soft status timeouts during Solving preserve the session", () => {
      const decision = decideStatusPollRecovery({
        consecutiveFailures: STATUS_POLL_DEAD_AFTER_FAILURES,
        detail: softTimeout,
        phase: "solving",
      });
      expect(decision.markDead).toBe(false);
      expect(decision.terminate).toBe(false);
      expect(decision.reason).toBe("soft_timeout_preserve");
      expect(
        shouldTerminateHungSidecar({
          consecutiveFailures: STATUS_POLL_DEAD_AFTER_FAILURES,
          detail: softTimeout,
          phase: "solving",
        }),
      ).toBe(false);
    });

    it("row2: three status admission-saturation errors during Solving do not terminate", () => {
      expect(isAdmissionSaturationDetail(saturation)).toBe(true);
      expect(isEngineSessionDead(saturation)).toBe(false);
      const decision = decideStatusPollRecovery({
        consecutiveFailures: STATUS_POLL_DEAD_AFTER_FAILURES,
        detail: saturation,
        phase: "solving",
      });
      expect(decision.markDead).toBe(false);
      expect(decision.terminate).toBe(false);
      expect(decision.reason).toBe("congestion_backoff");
      expect(decision.fault.congestion).toBe(true);
      expect(decision.fault.faultClass).toBe("queue_saturation");
      expect(
        shouldMarkStatusPollDead({
          consecutiveFailures: STATUS_POLL_DEAD_AFTER_FAILURES,
          detail: saturation,
          phase: "solving",
        }),
      ).toBe(false);
      expect(
        shouldTerminateHungSidecar({
          consecutiveFailures: STATUS_POLL_DEAD_AFTER_FAILURES,
          detail: saturation,
          phase: "solving",
        }),
      ).toBe(false);
    });

    it("row2: typed queue_saturation during Solving is congestion backoff in every phase", () => {
      for (const phase of ["solving", "complete", "idle"] as const) {
        const decision = decideStatusPollRecovery({
          consecutiveFailures: STATUS_POLL_DEAD_AFTER_FAILURES,
          detail: "wrapped",
          phase,
          error: {
            message: saturation,
            ipcClass: "queue_saturation",
            phase: "before_write",
            origin: "status",
            launchId: "launch-a",
          },
        });
        expect(decision.terminate).toBe(false);
        expect(decision.reason).toBe("congestion_backoff");
        expect(decision.fault.faultClass).toBe("queue_saturation");
        expect(decision.fault.phase).toBe("before_write");
        expect(decision.fault.origin).toBe("status");
        expect(decision.fault.launchId).toBe("launch-a");
      }
    });

    it("row3: three ordinary status timeouts in Complete do not kill (unsaved solution)", () => {
      const decision = decideStatusPollRecovery({
        consecutiveFailures: STATUS_POLL_DEAD_AFTER_FAILURES,
        detail: softTimeout,
        phase: "complete",
      });
      expect(decision.markDead).toBe(false);
      expect(decision.terminate).toBe(false);
      expect(decision.reason).toBe("soft_timeout_preserve");
      expect(
        shouldTerminateHungSidecar({
          consecutiveFailures: STATUS_POLL_DEAD_AFTER_FAILURES,
          detail: softTimeout,
          phase: "complete",
        }),
      ).toBe(false);
    });

    it("row4: Ready probe timeout / admission on existing child preserve + explicit restart", () => {
      const timedOut = decideReadyProbeOnExistingChild({
        message: "ensure ready probe failed: status request timed out",
        ipcClass: "timeout",
        phase: "before_write",
        launchId: "launch-b",
      });
      expect(timedOut.teardown).toBe(false);
      expect(timedOut.preserve).toBe(true);
      expect(timedOut.explicitRestart).toBe(true);
      expect(timedOut.observation).toBe("missed_observation");
      expect(timedOut.fault.faultClass).toBe("timeout");
      expect(timedOut.fault.phase).toBe("before_write");
      expect(timedOut.fault.launchId).toBe("launch-b");

      const congested = decideReadyProbeOnExistingChild({
        message: saturation,
        class: "queue_saturation",
        origin: "ensure",
      });
      expect(congested.teardown).toBe(false);
      expect(congested.preserve).toBe(true);
      expect(congested.explicitRestart).toBe(true);
      expect(congested.observation).toBe("congestion");
      expect(congested.fault.origin).toBe("ensure");
    });

    it("row4: Ready probe without typed class fails closed toward preserve + explicit restart", () => {
      const missingClass = decideReadyProbeOnExistingChild(
        "ensure ready probe failed: something odd",
      );
      expect(missingClass.teardown).toBe(false);
      expect(missingClass.preserve).toBe(true);
      expect(missingClass.explicitRestart).toBe(true);
      expect(missingClass.observation).toBe("unknown");
      expect(missingClass.reason).toMatch(/fail closed/i);

      // Timeout/admission text alone also must not tear down.
      const timeoutText = decideReadyProbeOnExistingChild(
        "ensure ready probe failed: timed out waiting for ready",
      );
      expect(timeoutText.teardown).toBe(false);
      expect(timeoutText.preserve).toBe(true);
      expect(timeoutText.observation).toBe("missed_observation");

      const admissionText = decideReadyProbeOnExistingChild(
        `ensure ready probe failed: ${saturation}`,
      );
      expect(admissionText.teardown).toBe(false);
      expect(admissionText.observation).toBe("congestion");
    });

    it("row4: Ready probe connection_loss / process exit may tear down", () => {
      const pipe = decideReadyProbeOnExistingChild({
        message: "connection_loss: solver-engine pipe closed",
        ipcClass: "connection_loss",
      });
      expect(pipe.teardown).toBe(true);
      expect(pipe.preserve).toBe(false);
      expect(pipe.observation).toBe("failed_connection");

      const exit = decideReadyProbeOnExistingChild({
        message: "sidecar_exit: solver-engine exiting",
        class: "connection_loss",
      });
      expect(exit.teardown).toBe(true);
      expect(exit.observation).toBe("process_exit");
    });

    it("preserves typed error class / phase / origin on EngineError-like inputs", () => {
      const fault = classifyEngineFault({
        message: "status request timed out",
        ipcClass: "timeout",
        phase: "after_write",
        origin: "status-poll",
        op: "status",
        requestId: "r-9",
        launchId: "launch-c",
        degraded: true,
        errorCode: "timeout",
      });
      expect(fault.faultClass).toBe("timeout");
      expect(fault.classFromTypedField).toBe(true);
      expect(fault.phase).toBe("after_write");
      expect(fault.origin).toBe("status-poll");
      expect(fault.op).toBe("status");
      expect(fault.requestId).toBe("r-9");
      expect(fault.launchId).toBe("launch-c");
      expect(fault.degraded).toBe(true);
      expect(fault.errorCode).toBe("timeout");
      expect(fault.softTimeout).toBe(true);
      expect(fault.sessionDead).toBe(false);
    });

    it("queued-bytes admission text is congestion, never hung-kill", () => {
      const detail =
        "admission saturated: queued bytes 1048576+4096 exceed 1048576";
      expect(
        shouldTerminateHungSidecar({
          consecutiveFailures: STATUS_POLL_DEAD_AFTER_FAILURES,
          detail,
          phase: "solving",
        }),
      ).toBe(false);
      expect(
        decideStatusPollRecovery({
          consecutiveFailures: STATUS_POLL_DEAD_AFTER_FAILURES,
          detail,
          phase: "idle",
        }).reason,
      ).toBe("congestion_backoff");
    });

    it("train timeout soft-recover requires live running/paused — not solution_id alone", () => {
      expect(
        shouldSoftRecoverTrainTimeout({
          running: false,
          paused: false,
          solution_id: "s-old",
        }),
      ).toBe(false);
      expect(
        shouldSoftRecoverTrainTimeout({
          running: true,
          paused: false,
          solution_id: null,
        }),
      ).toBe(true);
      expect(
        shouldSoftRecoverTrainTimeout({
          running: false,
          paused: true,
          solution_id: "s1",
        }),
      ).toBe(true);
    });

    it("explicit restart copy warns about unsaved work in a live child", () => {
      const message = explicitRestartRecoveryMessage(
        "ensure ready probe timed out",
      );
      expect(message).toMatch(/Restart Engine/i);
      expect(message).toMatch(/unsaved/i);
      expect(isRecoveryOrUnreachableMessage(message)).toBe(true);
    });
  });
});
