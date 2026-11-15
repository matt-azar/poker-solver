/**
 * Packaged Windows acceptance probe (PR1 async Rust IPC).
 *
 * When `STUDY_IPC_ACCEPTANCE=1` and `STUDY_SOLVER_ENGINE` points at the
 * controllable `ipc-test-sidecar`, the WebView drives concurrent Tauri invokes:
 * withhold one EV (`values`) reply while Status and Stop (`cancel`) still
 * complete. Proves WebView → Tauri → pipe ownership under a delayed reply.
 *
 * Also covers node-switch-while-EV-pending: a second `values` for another node
 * demuxes by `request_id` while the first remains withheld.
 *
 * Pipe-level / CI (no WebView): `scripts/desktop/ipc_race_replay.py --all`.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./index";

export type IpcAcceptanceResult = {
  ok: boolean;
  detail: string;
};

async function rAF(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 16);
    }
  });
}

type ValuesTracker = {
  settled: boolean;
  error: string | null;
  promise: Promise<unknown>;
};

function trackValues(body: Record<string, unknown>): ValuesTracker {
  const tracker: ValuesTracker = {
    settled: false,
    error: null,
    promise: Promise.resolve(),
  };
  tracker.promise = invoke("solver_engine_request", {
    op: "values",
    body,
    jobId: null,
  })
    .then(() => {
      tracker.settled = true;
    })
    .catch((err: unknown) => {
      tracker.settled = true;
      tracker.error = err instanceof Error ? err.message : String(err);
    });
  return tracker;
}

/**
 * Run the concurrency probe through real `invoke` calls.
 * Caller must have already ensured the test sidecar session.
 */
export async function runIpcAcceptanceProbe(): Promise<IpcAcceptanceResult> {
  if (!isTauriRuntime()) {
    return { ok: false, detail: "not a Tauri runtime" };
  }

  // Kick values — test sidecar withholds the first reply while still reading.
  const values = trackValues({ node_index: 0 });

  // Let the values frame leave the WebView and hit the pipe.
  await rAF();
  await new Promise((r) => setTimeout(r, 150));

  if (values.settled) {
    return {
      ok: false,
      detail: `values settled too early (before status/stop): ${values.error ?? "ok"}`,
    };
  }

  // Prove the window event loop still pumps while values is pending.
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
    return { ok: false, detail: "requestAnimationFrame did not advance (UI frozen?)" };
  }

  const status = (await invoke("solver_engine_request", {
    op: "status",
    body: null,
    jobId: null,
  })) as { body?: { held_values?: boolean } };
  if (!status?.body || status.body.held_values !== true) {
    return {
      ok: false,
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
      detail: `cancel/stop did not complete while values pending: ${JSON.stringify(cancel)}`,
    };
  }

  if (values.settled) {
    return {
      ok: false,
      detail: `values settled during status/stop (expected still pending): ${values.error ?? "ok"}`,
    };
  }

  // Launch-scoped kill should reap; pending values must settle.
  const info = (await invoke("solver_engine_info")) as { launchId?: string } | null;
  const launchId = info?.launchId ?? "";
  if (launchId) {
    await invoke("kill_solver_engine_cmd", { expectedLaunchId: launchId });
  }
  await Promise.race([
    values.promise,
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  if (!values.settled) {
    return { ok: false, detail: "values did not settle after kill/reap" };
  }

  return {
    ok: true,
    detail:
      "status+cancel completed while values withheld; UI rAF advanced; kill reaped pending values",
  };
}

/**
 * Node switch while EV pending: first values stays withheld; a second values
 * for another node demuxes by request_id and completes.
 * Caller must ensure a fresh test-sidecar session (first values still unused).
 */
export async function runNodeSwitchWhileEvPendingProbe(): Promise<IpcAcceptanceResult> {
  if (!isTauriRuntime()) {
    return { ok: false, detail: "not a Tauri runtime" };
  }

  const first = trackValues({ node_index: 0, node_id: "root" });
  await rAF();
  await new Promise((r) => setTimeout(r, 120));
  if (first.settled) {
    return {
      ok: false,
      detail: `first values settled too early: ${first.error ?? "ok"}`,
    };
  }

  const second = trackValues({ node_index: 1, node_id: "p0" });
  await Promise.race([
    second.promise,
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  if (!second.settled) {
    return {
      ok: false,
      detail: "second-node values did not complete while first was pending",
    };
  }
  if (second.error) {
    return {
      ok: false,
      detail: `second-node values failed: ${second.error}`,
    };
  }
  if (first.settled) {
    return {
      ok: false,
      detail: `first values settled during node switch (expected still pending): ${first.error ?? "ok"}`,
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
      detail: `status did not report held_values after node switch: ${JSON.stringify(status)}`,
    };
  }

  const info = (await invoke("solver_engine_info")) as { launchId?: string } | null;
  const launchId = info?.launchId ?? "";
  if (launchId) {
    await invoke("kill_solver_engine_cmd", { expectedLaunchId: launchId });
  }
  await Promise.race([
    first.promise,
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  if (!first.settled) {
    return { ok: false, detail: "first values did not settle after kill/reap" };
  }

  return {
    ok: true,
    detail:
      "node switch demuxed second values while first EV stayed pending; status held_values; kill reaped",
  };
}

/** Run hold-EV + node-switch probes (fresh session each). */
export async function runAllIpcAcceptanceProbes(): Promise<IpcAcceptanceResult> {
  const hold = await runIpcAcceptanceProbe();
  if (!hold.ok) {
    return hold;
  }
  // Kill above tore down the session — ensure again for the next case.
  try {
    await invoke("ensure_solver_engine");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `ensure after hold probe failed: ${detail}` };
  }
  const nodeSwitch = await runNodeSwitchWhileEvPendingProbe();
  if (!nodeSwitch.ok) {
    return nodeSwitch;
  }
  return {
    ok: true,
    detail: `${hold.detail}; then ${nodeSwitch.detail}`,
  };
}

/** Boot hook: when acceptance env is set, run probe and exit with code. */
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

  // Ensure uses STUDY_SOLVER_ENGINE → ipc-test-sidecar.
  try {
    await invoke("ensure_solver_engine");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[ipc-acceptance] ensure failed", detail);
    try {
      await invoke("exit_with_code", { code: 2 });
    } catch {
      // fall through
    }
    return true;
  }

  const result = await runAllIpcAcceptanceProbes();
  console.info("[ipc-acceptance]", result.ok ? "PASS" : "FAIL", result.detail);
  try {
    await invoke("exit_with_code", { code: result.ok ? 0 : 1 });
  } catch {
    // process may already be exiting
  }
  return true;
}
