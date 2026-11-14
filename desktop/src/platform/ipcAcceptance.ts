/**
 * Packaged Windows acceptance probe (PR1 async Rust IPC).
 *
 * When `STUDY_IPC_ACCEPTANCE=1` and `STUDY_SOLVER_ENGINE` points at the
 * controllable `ipc-test-sidecar`, the WebView drives concurrent Tauri invokes:
 * withhold one EV (`values`) reply while Status and Stop (`cancel`) still
 * complete. Proves WebView → Tauri → pipe ownership under a delayed reply.
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

/**
 * Run the concurrency probe through real `invoke` calls.
 * Caller must have already ensured the test sidecar session.
 */
export async function runIpcAcceptanceProbe(): Promise<IpcAcceptanceResult> {
  if (!isTauriRuntime()) {
    return { ok: false, detail: "not a Tauri runtime" };
  }

  // Kick values — test sidecar withholds the first reply while still reading.
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

  // Let the values frame leave the WebView and hit the pipe.
  await rAF();
  await new Promise((r) => setTimeout(r, 150));

  if (valuesSettled) {
    return {
      ok: false,
      detail: `values settled too early (before status/stop): ${valuesError ?? "ok"}`,
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

  if (valuesSettled) {
    return {
      ok: false,
      detail: `values settled during status/stop (expected still pending): ${valuesError ?? "ok"}`,
    };
  }

  // Launch-scoped kill should reap; pending values must settle.
  const info = (await invoke("solver_engine_info")) as { launchId?: string } | null;
  const launchId = info?.launchId ?? "";
  if (launchId) {
    await invoke("kill_solver_engine_cmd", { expectedLaunchId: launchId });
  }
  await Promise.race([
    valuesPromise,
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  if (!valuesSettled) {
    return { ok: false, detail: "values did not settle after kill/reap" };
  }

  return {
    ok: true,
    detail:
      "status+cancel completed while values withheld; UI rAF advanced; kill reaped pending values",
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

  const result = await runIpcAcceptanceProbe();
  console.info("[ipc-acceptance]", result.ok ? "PASS" : "FAIL", result.detail);
  try {
    await invoke("exit_with_code", { code: result.ok ? 0 : 1 });
  } catch {
    // process may already be exiting
  }
  return true;
}
