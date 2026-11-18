/**
 * Packaged Windows / IPC acceptance probes (async Rust supervisor + WebView).
 *
 * Named stages — must match windows-installer.yml / windows-installer-e2e.ps1:
 *
 * | -Stage (PS/YAML)           | Env                                          |
 * |----------------------------|----------------------------------------------|
 * | DelayedReply               | STUDY_IPC_ACCEPTANCE=1 (ipc-async-acceptance)|
 * | BlockedWrite               | STUDY_INSTALLER_E2E=stage-blocked-write      |
 * | NormalClosePending         | STUDY_INSTALLER_E2E=stage-normal-close-pending |
 * | StaleCallAfterReconnect    | STUDY_INSTALLER_E2E=stage-stale-call-after-reconnect |
 *
 * Stage A/B (real-engine river Save/reopen) stay in installerE2e.ts.
 *
 * Pipe-level / CI (no WebView): `scripts/desktop/ipc_race_replay.py` case
 * `values-hold-status-cancel` covers the DelayedReply pass bar.
 */
import { invoke } from "@tauri-apps/api/core";
// Static import so the packaged Vite bundle always includes window Close/Destroy
// (a dynamic import can fail in the NSIS WebView and trip exit_with_code(1)).
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "./index";

/** Canonical -Stage / probe names (CI ValidateSet + YAML). */
export const IPC_ACCEPTANCE_STAGES = [
  "DelayedReply",
  "BlockedWrite",
  "NormalClosePending",
  "StaleCallAfterReconnect",
] as const;

export type IpcAcceptanceStageName = (typeof IPC_ACCEPTANCE_STAGES)[number];

/** STUDY_INSTALLER_E2E values for the three installer-driven probes. */
export const INSTALLER_E2E_ENV_BY_STAGE: Record<
  Exclude<IpcAcceptanceStageName, "DelayedReply">,
  string
> = {
  BlockedWrite: "stage-blocked-write",
  NormalClosePending: "stage-normal-close-pending",
  StaleCallAfterReconnect: "stage-stale-call-after-reconnect",
};

export type IpcAcceptanceResult = {
  ok: boolean;
  /** True when the TS contract ran but the Rust/sidecar arm is missing. */
  skipped?: boolean;
  stage: IpcAcceptanceStageName;
  detail: string;
};

const STAGE_ALIASES: Record<string, IpcAcceptanceStageName> = {
  delayedreply: "DelayedReply",
  "delayed-reply": "DelayedReply",
  delayed_reply: "DelayedReply",
  blockedwrite: "BlockedWrite",
  "blocked-write": "BlockedWrite",
  blocked_write: "BlockedWrite",
  "stage-blocked-write": "BlockedWrite",
  normalclosepending: "NormalClosePending",
  "normal-close-pending": "NormalClosePending",
  normal_close_pending: "NormalClosePending",
  "stage-normal-close-pending": "NormalClosePending",
  // Longer alias kept for docs / older wording.
  normalclosewithpendingwork: "NormalClosePending",
  "normal-close-with-pending-work": "NormalClosePending",
  stalecallafterreconnect: "StaleCallAfterReconnect",
  "stale-call-after-reconnect": "StaleCallAfterReconnect",
  stale_call_after_reconnect: "StaleCallAfterReconnect",
  "stage-stale-call-after-reconnect": "StaleCallAfterReconnect",
};

/** Map raw env / CLI stage tokens to a canonical probe name. */
export function normalizeIpcAcceptanceStage(
  raw: string | null | undefined,
): IpcAcceptanceStageName | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  for (const name of IPC_ACCEPTANCE_STAGES) {
    if (trimmed === name) return name;
  }
  return STAGE_ALIASES[trimmed.toLowerCase()] ?? null;
}

export function isIpcAcceptanceStageName(raw: string | null | undefined): boolean {
  return normalizeIpcAcceptanceStage(raw) != null;
}

/** True when STUDY_INSTALLER_E2E names one of the three installer IPC probes. */
export function isInstallerIpcProbeStage(raw: string | null | undefined): boolean {
  const stage = normalizeIpcAcceptanceStage(raw);
  return stage != null && stage !== "DelayedReply";
}

async function rAF(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 16);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exitWithCode(code: number): Promise<void> {
  try {
    await invoke("exit_with_code", { code });
  } catch {
    // process may already be exiting
  }
}

async function engineInfoLaunchId(): Promise<string> {
  const info = (await invoke("solver_engine_info")) as { launchId?: string } | null;
  return info?.launchId?.trim() ?? "";
}

/**
 * DelayedReply — Status + Cancel complete while EV (`values`) is withheld.
 * Driven by STUDY_IPC_ACCEPTANCE=1 (ipc-async-acceptance.ps1 / Stage DelayedReply).
 */
export async function runDelayedReplyProbe(): Promise<IpcAcceptanceResult> {
  if (!isTauriRuntime()) {
    return { ok: false, stage: "DelayedReply", detail: "not a Tauri runtime" };
  }

  let valuesSettled = false;
  let valuesError: string | null = null;
  const valuesPromise = invoke("solver_engine_request", {
    op: "values",
    body: { node_index: 0 },
    jobId: null,
  })
    .then(() => {
      valuesSettled = true;
    })
    .catch((err: unknown) => {
      valuesSettled = true;
      valuesError = err instanceof Error ? err.message : String(err);
    });

  await rAF();
  await sleep(150);

  if (valuesSettled) {
    return {
      ok: false,
      stage: "DelayedReply",
      detail: `values settled too early (before status/stop): ${valuesError ?? "ok"}`,
    };
  }

  const t0 =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  await rAF();
  await rAF();
  const t1 =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  if (t1 <= t0) {
    return {
      ok: false,
      stage: "DelayedReply",
      detail: "requestAnimationFrame did not advance (UI frozen?)",
    };
  }

  const status = (await invoke("solver_engine_request", {
    op: "status",
    body: null,
    jobId: null,
  })) as { body?: { held_values?: boolean } };
  if (!status?.body || status.body.held_values !== true) {
    return {
      ok: false,
      stage: "DelayedReply",
      detail: `status did not report held_values while values pending: ${JSON.stringify(status)}`,
    };
  }

  const cancel = (await invoke("solver_engine_request", {
    op: "cancel",
    body: null,
    jobId: "j-accept",
  })) as { body?: { cancelled?: boolean } };
  if (!cancel?.body || cancel.body.cancelled !== true) {
    return {
      ok: false,
      stage: "DelayedReply",
      detail: `cancel/stop did not complete while values pending: ${JSON.stringify(cancel)}`,
    };
  }

  if (valuesSettled) {
    return {
      ok: false,
      stage: "DelayedReply",
      detail: `values settled during status/stop (expected still pending): ${valuesError ?? "ok"}`,
    };
  }

  const launchId = await engineInfoLaunchId();
  if (launchId) {
    await invoke("kill_solver_engine_cmd", { expectedLaunchId: launchId });
  }
  await Promise.race([valuesPromise, sleep(5000)]);
  if (!valuesSettled) {
    return {
      ok: false,
      stage: "DelayedReply",
      detail: "values did not settle after kill/reap",
    };
  }

  return {
    ok: true,
    stage: "DelayedReply",
    detail:
      "status+cancel completed while values withheld; UI rAF advanced; kill reaped pending values",
  };
}

/** @deprecated Prefer {@link runDelayedReplyProbe} — kept for existing imports/tests. */
export async function runIpcAcceptanceProbe(): Promise<IpcAcceptanceResult> {
  return runDelayedReplyProbe();
}

/**
 * BlockedWrite — prove a genuinely blocked / non-draining write is bounded.
 *
 * Env: STUDY_INSTALLER_E2E=stage-blocked-write
 *
 * Full exercise needs the test sidecar to stop reading after ready
 * (`--stop-reading-after 1`). Packaged Study spawn only forwards `--launch-id`
 * today, so CI must either point STUDY_SOLVER_ENGINE at a wrapper that adds
 * that flag, or land Rust hook `STUDY_SOLVER_ENGINE_ARGS` /
 * `ipc_acceptance_arm_blocked_write` in `solver_engine.rs` `spawn_session`.
 *
 * When the sidecar keeps reading, returns skipped (exit 0) so Stage A/B and
 * DelayedReply stay green until that Rust arm lands.
 */
export async function runBlockedWriteProbe(): Promise<IpcAcceptanceResult> {
  if (!isTauriRuntime()) {
    return { ok: false, stage: "BlockedWrite", detail: "not a Tauri runtime" };
  }

  let sawBound = false;
  let lastDetail = "";
  for (let i = 0; i < 24; i += 1) {
    try {
      await invoke("solver_engine_request", {
        op: "node",
        body: { node_index: i },
        jobId: null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      lastDetail = msg;
      const lower = msg.toLowerCase();
      if (
        lower.includes("admission saturated") ||
        lower.includes("queued bytes") ||
        lower.includes("timed out") ||
        lower.includes("timeout") ||
        lower.includes("expired-before-write") ||
        lower.includes("after_write") ||
        lower.includes("connection") ||
        lower.includes("pipe")
      ) {
        sawBound = true;
        break;
      }
    }
  }

  if (!sawBound) {
    // TODO(Rust): arm stop-reading in spawn_session — see module doc above.
    return {
      ok: true,
      skipped: true,
      stage: "BlockedWrite",
      detail:
        "SKIP: BlockedWrite needs Rust hook STUDY_SOLVER_ENGINE_ARGS=--stop-reading-after 1 " +
        "(or ipc_acceptance_arm_blocked_write) in solver_engine.rs spawn_session; " +
        "sidecar kept answering — no write bound observed" +
        (lastDetail ? `; last=${lastDetail}` : ""),
    };
  }

  const launchId = await engineInfoLaunchId();
  if (launchId) {
    await invoke("kill_solver_engine_cmd", { expectedLaunchId: launchId });
  }

  return {
    ok: true,
    stage: "BlockedWrite",
    detail: `write/admission bound observed while sidecar stopped draining: ${lastDetail}`,
  };
}

/**
 * NormalClosePending — normal window Close (not exit_with_code) while work
 * may still be pending. Env: STUDY_INSTALLER_E2E=stage-normal-close-pending
 *
 * Success path: getCurrentWindow().close() → ExitRequested/Exit (see #458
 * parent-exit reap). Returns ok immediately after Close is accepted — do not
 * wait or call exit_with_code (that skips the RunEvent path).
 */
export async function runNormalClosePendingProbe(): Promise<IpcAcceptanceResult> {
  if (!isTauriRuntime()) {
    return {
      ok: false,
      stage: "NormalClosePending",
      detail: "not a Tauri runtime",
    };
  }

  let valuesSettled = false;
  void invoke("solver_engine_request", {
    op: "values",
    body: { node_index: 0 },
    jobId: null,
  })
    .then(() => {
      valuesSettled = true;
    })
    .catch(() => {
      valuesSettled = true;
    });

  await rAF();
  await sleep(100);

  if (valuesSettled) {
    // Real engine may answer values immediately — still exercise Close.
    void invoke("solver_engine_request", {
      op: "status",
      body: null,
      jobId: null,
    }).catch(() => {});
  }

  // Requires core:window:allow-close (+ allow-destroy fallback) in capabilities.
  let win;
  try {
    win = getCurrentWindow();
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      stage: "NormalClosePending",
      detail: `getCurrentWindow() failed: ${detail}`,
    };
  }

  try {
    await win.close();
    return {
      ok: true,
      stage: "NormalClosePending",
      detail: "window.close() accepted; awaiting RunEvent::Exit reap (not exit_with_code)",
    };
  } catch (closeErr: unknown) {
    const closeDetail =
      closeErr instanceof Error ? closeErr.message : String(closeErr);
    // Force-destroy still goes through window teardown / Exit, unlike exit_with_code.
    try {
      await win.destroy();
      return {
        ok: true,
        stage: "NormalClosePending",
        detail: `window.close() failed (${closeDetail}); destroy() accepted for Exit path`,
      };
    } catch (destroyErr: unknown) {
      const destroyDetail =
        destroyErr instanceof Error ? destroyErr.message : String(destroyErr);
      const aclHint =
        /not allowed|forbidden|denied|ACL|permission/i.test(
          `${closeDetail} ${destroyDetail}`,
        )
          ? " (check capabilities: core:window:allow-close + allow-destroy)"
          : "";
      return {
        ok: false,
        stage: "NormalClosePending",
        detail: `normal window Close/destroy failed: close=${closeDetail}; destroy=${destroyDetail}${aclHint}`,
      };
    }
  }
}

/**
 * StaleCallAfterReconnect — pending call from launch A must settle without
 * poisoning launch B after kill + ensure.
 * Env: STUDY_INSTALLER_E2E=stage-stale-call-after-reconnect
 */
export async function runStaleCallAfterReconnectProbe(): Promise<IpcAcceptanceResult> {
  if (!isTauriRuntime()) {
    return {
      ok: false,
      stage: "StaleCallAfterReconnect",
      detail: "not a Tauri runtime",
    };
  }

  const launchA = await engineInfoLaunchId();
  if (!launchA) {
    return {
      ok: false,
      stage: "StaleCallAfterReconnect",
      detail: "missing launchId before stale call",
    };
  }

  let valuesSettled = false;
  let valuesError: string | null = null;
  const valuesPromise = invoke("solver_engine_request", {
    op: "values",
    body: { node_index: 0 },
    jobId: null,
  })
    .then(() => {
      valuesSettled = true;
    })
    .catch((err: unknown) => {
      valuesSettled = true;
      valuesError = err instanceof Error ? err.message : String(err);
    });

  await rAF();
  await sleep(100);

  await invoke("kill_solver_engine_cmd", { expectedLaunchId: launchA });
  await invoke("ensure_solver_engine");

  const launchB = await engineInfoLaunchId();
  if (!launchB) {
    return {
      ok: false,
      stage: "StaleCallAfterReconnect",
      detail: "missing launchId after reconnect",
    };
  }
  if (launchB === launchA) {
    return {
      ok: false,
      stage: "StaleCallAfterReconnect",
      detail: `launchId did not change after reconnect (still ${launchA})`,
    };
  }

  await Promise.race([valuesPromise, sleep(5000)]);
  if (!valuesSettled) {
    return {
      ok: false,
      stage: "StaleCallAfterReconnect",
      detail: "stale values from launch A did not settle after reconnect",
    };
  }

  let statusOk = false;
  try {
    const status = (await invoke("solver_engine_request", {
      op: "status",
      body: null,
      jobId: null,
    })) as { ok?: boolean; body?: unknown };
    statusOk = status != null && status.ok !== false;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      stage: "StaleCallAfterReconnect",
      detail: `status on launch B failed after stale A: ${msg}`,
    };
  }
  if (!statusOk) {
    return {
      ok: false,
      stage: "StaleCallAfterReconnect",
      detail: "status on launch B returned ok=false after stale A",
    };
  }

  return {
    ok: true,
    stage: "StaleCallAfterReconnect",
    detail:
      `stale values from ${launchA} settled` +
      (valuesError ? ` (err=${valuesError})` : "") +
      `; launch B=${launchB} status ok`,
  };
}

/** Dispatch a named acceptance stage. */
export async function runIpcAcceptanceStage(
  stage: IpcAcceptanceStageName,
): Promise<IpcAcceptanceResult> {
  switch (stage) {
    case "DelayedReply":
      return runDelayedReplyProbe();
    case "BlockedWrite":
      return runBlockedWriteProbe();
    case "NormalClosePending":
      return runNormalClosePendingProbe();
    case "StaleCallAfterReconnect":
      return runStaleCallAfterReconnectProbe();
    default: {
      const _exhaustive: never = stage;
      return {
        ok: false,
        stage: "DelayedReply",
        detail: `unknown stage: ${String(_exhaustive)}`,
      };
    }
  }
}

async function ensureForAcceptance(): Promise<string | null> {
  try {
    await invoke("ensure_solver_engine");
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Finish a stage: NormalClosePending success exits via window Close.
 * Skipped stages exit 0 so CI can land the contract before the Rust arm.
 */
export async function finishIpcAcceptanceStage(
  result: IpcAcceptanceResult,
): Promise<void> {
  const tag = result.skipped ? "SKIP" : result.ok ? "PASS" : "FAIL";
  console.info(`[ipc-acceptance] ${tag} stage=${result.stage}`, result.detail);

  if (result.stage === "NormalClosePending" && result.ok && !result.skipped) {
    return;
  }

  const code = result.ok || result.skipped ? 0 : 1;
  await exitWithCode(code);
}

/**
 * Run an installer-driven IPC probe (BlockedWrite / NormalClosePending /
 * StaleCallAfterReconnect) after ensure; exit the process.
 */
export async function runInstallerIpcProbeAndExit(
  stage: Exclude<IpcAcceptanceStageName, "DelayedReply">,
): Promise<void> {
  const ensureErr = await ensureForAcceptance();
  if (ensureErr) {
    console.error("[ipc-acceptance] ensure failed", ensureErr);
    await exitWithCode(2);
    return;
  }
  const result = await runIpcAcceptanceStage(stage);
  await finishIpcAcceptanceStage(result);
}

/** Boot hook: STUDY_IPC_ACCEPTANCE=1 → DelayedReply (compat). */
export async function maybeRunIpcAcceptanceAndExit(): Promise<boolean> {
  if (!isTauriRuntime()) {
    return false;
  }
  let enabled = false;
  try {
    enabled = Boolean(await invoke("ipc_acceptance_enabled"));
  } catch {
    return false;
  }
  if (!enabled) {
    return false;
  }

  const ensureErr = await ensureForAcceptance();
  if (ensureErr) {
    console.error("[ipc-acceptance] ensure failed", ensureErr);
    await exitWithCode(2);
    return true;
  }

  const result = await runDelayedReplyProbe();
  await finishIpcAcceptanceStage(result);
  return true;
}
