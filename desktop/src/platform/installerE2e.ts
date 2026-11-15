/**
 * Packaged Windows installer E2E boot hooks (Preview Site track 2).
 *
 * Env (read via Tauri `installer_e2e_stage`):
 *   STUDY_INSTALLER_E2E=stage-a  — Stage A: prove WebView → Tauri → installed sidecar
 *   STUDY_INSTALLER_E2E=stage-b  — Stage B: river solve / browse / clear-then-reopen PSOL
 *
 * Stage B also requires STUDY_INSTALLER_E2E_STAGE_B=1.
 * Optional STUDY_INSTALLER_E2E_PSOL = absolute .psol path for the round-trip.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./index";

export type InstallerE2eResult = {
  ok: boolean;
  stage: "a" | "b";
  lastCompletedStep: string;
  detail: string;
};

/** Tiny river fixture matching benchmarks/study/configs/river_gate_smoke.txt. */
export const STAGE_B_RIVER_CONFIG = `street-config 1
board Ah Kh Qh Jh 2c
pot 100
stack 100
oop-range AsQs:1,2d2h:1
ip-range AsQs:1,2d2h:1
oop-river-bets 1
ip-river-bets 1
first-to-act 0
max-raises 0
allow-three-bet 1
all-in-threshold 0
pot-cap 0
rake-rate 0
rake-cap 0
memory-mib 256
threads 1
`;

const ROOT_NODE_ID = "p0.t-1.r-1";
const STAGE_B_ITERS = 10;
const STAGE_B_IDLE_MS = 45_000;

type IpcEnvelope = {
  ok?: boolean;
  error_code?: string | null;
  error_message?: string | null;
  body?: unknown;
};

async function exitWithCode(code: number): Promise<void> {
  try {
    await invoke("exit_with_code", { code });
  } catch {
    // process may already be exiting
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

async function engineRequest(
  op: string,
  body: unknown = null,
  jobId: string | null = null,
): Promise<IpcEnvelope> {
  return (await invoke("solver_engine_request", {
    op,
    body,
    jobId,
  })) as IpcEnvelope;
}

function requireOk(env: IpcEnvelope, step: string): Record<string, unknown> {
  if (env?.ok === false) {
    throw new Error(
      `${step}: host ok=false code=${env.error_code ?? "?"} msg=${env.error_message ?? ""}`,
    );
  }
  return asRecord(env?.body) ?? {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilIdle(label: string, timeoutMs = STAGE_B_IDLE_MS): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  let n = 0;
  while (Date.now() < deadline) {
    const env = await engineRequest("status", null, null);
    last = requireOk(env, `status-${label}-${n}`);
    if (last.running === false) {
      return last;
    }
    n += 1;
    await sleep(20);
  }
  throw new Error(`${label}: timed out waiting for idle; last=${JSON.stringify(last)}`);
}

/** Reach-weighted action frequencies — same idea as study-contract-smoke. */
export function weightedActionFreqs(node: Record<string, unknown>): number[] {
  const strategy = node.strategy;
  const reach = Array.isArray(node.reach) ? (node.reach as unknown[]) : [];
  const nActions = Number(node.n_actions ?? 0);
  if (!Array.isArray(strategy) || nActions <= 0) {
    throw new Error("decision node missing strategy / n_actions");
  }
  if (reach.length !== strategy.length) {
    throw new Error("reach/strategy hand count mismatch");
  }
  const totals = new Array<number>(nActions).fill(0);
  let mass = 0;
  for (let i = 0; i < strategy.length; i += 1) {
    const rw = Number(reach[i] ?? 0);
    if (!(rw > 0)) continue;
    const row = strategy[i];
    if (!Array.isArray(row) || row.length !== nActions) {
      throw new Error("bad strategy row");
    }
    mass += rw;
    for (let a = 0; a < nActions; a += 1) {
      totals[a] += rw * Number(row[a] ?? 0);
    }
  }
  if (!(mass > 0)) {
    throw new Error("zero reach mass for weighted strategy");
  }
  return totals.map((t) => t / mass);
}

export function strategyFingerprint(node: Record<string, unknown>): string {
  const freqs = weightedActionFreqs(node).map((f) => f.toFixed(6));
  const children = Array.isArray(node.children) ? (node.children as unknown[]).map(String) : [];
  return JSON.stringify({
    node_id: String(node.node_id ?? ROOT_NODE_ID),
    kind: String(node.kind ?? ""),
    n_actions: Number(node.n_actions ?? 0),
    freqs,
    children,
  });
}

/**
 * Stage A: drive the real WebView just enough to prove control.
 * Uses the packaged/installed solver-engine (no STUDY_SOLVER_ENGINE override).
 */
export async function runInstallerE2eStageA(): Promise<InstallerE2eResult> {
  let lastCompletedStep = "stage-a-start";
  try {
    lastCompletedStep = "ensure_solver_engine";
    await invoke("ensure_solver_engine");

    lastCompletedStep = "status";
    const status = (await invoke("solver_engine_request", {
      op: "status",
      body: null,
      jobId: null,
    })) as { ok?: boolean; body?: unknown };

    // Host may wrap as { ok, body } or return the body envelope; either proves IPC.
    if (status == null) {
      return {
        ok: false,
        stage: "a",
        lastCompletedStep,
        detail: "status returned null",
      };
    }

    lastCompletedStep = "solver_engine_info";
    const info = (await invoke("solver_engine_info")) as {
      launchId?: string;
    } | null;
    if (!info?.launchId) {
      return {
        ok: false,
        stage: "a",
        lastCompletedStep,
        detail: `missing launchId after ensure/status: ${JSON.stringify(info)}`,
      };
    }

    lastCompletedStep = "webview-control-proven";
    return {
      ok: true,
      stage: "a",
      lastCompletedStep,
      detail: `WebView drove ensure+status; launchId=${info.launchId}`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      stage: "a",
      lastCompletedStep,
      detail,
    };
  }
}

/**
 * Stage B: tiny river solve → browse → save → clear active solution →
 * reopen PSOL → assert strategy restored (proves clear-before-reopen).
 */
export async function runInstallerE2eStageB(): Promise<InstallerE2eResult> {
  let lastCompletedStep = "stage-b-start";
  try {
    lastCompletedStep = "ensure_solver_engine";
    await invoke("ensure_solver_engine");

    lastCompletedStep = "begin_config";
    const beginEnv = await engineRequest(
      "begin_config",
      { config_text: STAGE_B_RIVER_CONFIG },
      "j-e2e-b-begin",
    );
    const beginBody = requireOk(beginEnv, "begin_config");
    if (!beginBody.solution_id) {
      throw new Error(`begin_config missing solution_id: ${JSON.stringify(beginBody)}`);
    }

    lastCompletedStep = "solve-admit";
    const solveEnv = await engineRequest(
      "solve",
      { iterations: STAGE_B_ITERS },
      "j-e2e-b-solve",
    );
    const solveBody = requireOk(solveEnv, "solve");
    if (solveBody.accepted !== true && solveBody.running !== true) {
      throw new Error(`solve not admitted: ${JSON.stringify(solveBody)}`);
    }

    lastCompletedStep = "solve-idle";
    const afterSolve = await waitUntilIdle("solve");
    if (afterSolve.has_training !== true) {
      throw new Error(`post-solve has_training: ${JSON.stringify(afterSolve)}`);
    }
    if (Number(afterSolve.iterations ?? -1) !== STAGE_B_ITERS) {
      throw new Error(`post-solve iterations: ${JSON.stringify(afterSolve)}`);
    }

    lastCompletedStep = "browse-root";
    const rootEnv = await engineRequest("node", { node_id: ROOT_NODE_ID });
    const root = requireOk(rootEnv, "node-root");
    if (root.kind !== "decision") {
      throw new Error(`root kind: ${JSON.stringify(root)}`);
    }
    const fingerprintBefore = strategyFingerprint(root);
    const children = Array.isArray(root.children) ? (root.children as unknown[]) : [];
    if (children.length < 1) {
      throw new Error(`root missing children: ${JSON.stringify(root)}`);
    }

    lastCompletedStep = "browse-child";
    const childId = String(children[0]);
    const childEnv = await engineRequest("node", { node_id: childId });
    const child = requireOk(childEnv, "node-child");
    if (String(child.node_id ?? "") !== childId) {
      throw new Error(`child node_id mismatch: ${JSON.stringify(child)}`);
    }

    lastCompletedStep = "save-psol";
    let psolPath = "";
    try {
      psolPath = String((await invoke("installer_e2e_psol_path")) ?? "").trim();
    } catch {
      psolPath = "";
    }
    if (!psolPath) {
      throw new Error("installer_e2e_psol_path returned empty");
    }
    const saveEnv = await engineRequest("save", { path: psolPath });
    const saveBody = requireOk(saveEnv, "save");
    if (saveBody.saved !== true) {
      throw new Error(`save failed: ${JSON.stringify(saveBody)}`);
    }

    // Clear active solution: tear down the live sidecar session, then re-ensure.
    // Proves reopen restores strategy from the PSOL file, not leftover memory.
    lastCompletedStep = "clear-active-solution";
    const beforeKill = (await invoke("solver_engine_info")) as { launchId?: string } | null;
    const killId = beforeKill?.launchId?.trim() ?? "";
    if (!killId) {
      throw new Error("missing launchId before clear");
    }
    await invoke("kill_solver_engine_cmd", { expectedLaunchId: killId });
    await invoke("ensure_solver_engine");

    lastCompletedStep = "verify-cleared";
    const coldEnv = await engineRequest("status");
    const cold = requireOk(coldEnv, "status-cleared");
    const coldSolution = cold.solution_id;
    if (coldSolution != null && coldSolution !== "" && coldSolution !== false) {
      throw new Error(`solution still active after clear: ${JSON.stringify(cold)}`);
    }
    const clearedNode = await engineRequest("node", { node_id: ROOT_NODE_ID });
    if (clearedNode.ok !== false) {
      throw new Error(`node should fail after clear: ${JSON.stringify(clearedNode)}`);
    }
    if (String(clearedNode.error_code ?? "") !== "nothing_published") {
      throw new Error(
        `expected nothing_published after clear, got ${clearedNode.error_code}: ${JSON.stringify(clearedNode)}`,
      );
    }

    lastCompletedStep = "reopen-psol";
    const openEnv = await engineRequest("open", { path: psolPath });
    const openBody = requireOk(openEnv, "open");
    if (openBody.has_training !== true) {
      throw new Error(`open has_training: ${JSON.stringify(openBody)}`);
    }
    if (!openBody.solution_id) {
      throw new Error(`open missing solution_id: ${JSON.stringify(openBody)}`);
    }

    lastCompletedStep = "verify-strategy-restored";
    const restoredEnv = await engineRequest("node", { node_id: ROOT_NODE_ID });
    const restored = requireOk(restoredEnv, "node-restored");
    const fingerprintAfter = strategyFingerprint(restored);
    if (fingerprintAfter !== fingerprintBefore) {
      throw new Error(
        `strategy mismatch after clear+reopen before=${fingerprintBefore} after=${fingerprintAfter}`,
      );
    }

    lastCompletedStep = "stage-b-pass";
    return {
      ok: true,
      stage: "b",
      lastCompletedStep,
      detail: `river solve/browse/clear/reopen ok; child=${childId}; psol=${psolPath}; fingerprint=${fingerprintBefore}`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      stage: "b",
      lastCompletedStep,
      detail,
    };
  }
}

/** Boot hook: when STUDY_INSTALLER_E2E is set, run the stage probe and exit. */
export async function maybeRunInstallerE2eAndExit(): Promise<boolean> {
  if (!isTauriRuntime()) {
    return false;
  }
  let stage: string | null = null;
  try {
    stage = (await invoke("installer_e2e_stage")) as string | null;
  } catch {
    return false;
  }
  if (!stage) {
    return false;
  }

  const normalized = String(stage).trim().toLowerCase();
  if (normalized === "stage-a" || normalized === "a") {
    const result = await runInstallerE2eStageA();
    console.info(
      "[installer-e2e]",
      result.ok ? "PASS" : "FAIL",
      "stage=A",
      "lastCompletedStep=",
      result.lastCompletedStep,
      result.detail,
    );
    await exitWithCode(result.ok ? 0 : 1);
    return true;
  }

  if (normalized === "stage-b" || normalized === "b") {
    let stageBEnabled = false;
    try {
      stageBEnabled = Boolean(await invoke("installer_e2e_stage_b_enabled"));
    } catch {
      stageBEnabled = false;
    }
    if (!stageBEnabled) {
      console.error(
        "[installer-e2e] Stage B requested but STUDY_INSTALLER_E2E_STAGE_B!=1",
      );
      await exitWithCode(3);
      return true;
    }
    const result = await runInstallerE2eStageB();
    console.info(
      "[installer-e2e]",
      result.ok ? "PASS" : "FAIL",
      "stage=B",
      "lastCompletedStep=",
      result.lastCompletedStep,
      result.detail,
    );
    await exitWithCode(result.ok ? 0 : 1);
    return true;
  }

  console.error(`[installer-e2e] unknown stage: ${stage}`);
  await exitWithCode(4);
  return true;
}
