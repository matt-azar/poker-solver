/**
 * Packaged Windows installer E2E boot hooks (Preview Site track 2).
 *
 * Env (read via Tauri `installer_e2e_stage`):
 *   STUDY_INSTALLER_E2E=stage-a  — Stage A: prove WebView → Tauri → installed sidecar
 *   STUDY_INSTALLER_E2E=stage-b  — Stage B: river solve / browse / save-reopen (gated)
 *
 * Stage B also requires STUDY_INSTALLER_E2E_STAGE_B=1. Until Stage A is proven
 * green in CI, do not enable Stage B in the installer workflow.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./index";

export type InstallerE2eResult = {
  ok: boolean;
  stage: "a" | "b";
  lastCompletedStep: string;
  detail: string;
};

async function exitWithCode(code: number): Promise<void> {
  try {
    await invoke("exit_with_code", { code });
  } catch {
    // process may already be exiting
  }
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
 * Stage B scaffold — not enabled until Stage A is solid.
 * Clear-before-reopen + PSOL strategy restore belong here (PS-5).
 */
export async function runInstallerE2eStageB(): Promise<InstallerE2eResult> {
  return {
    ok: false,
    stage: "b",
    lastCompletedStep: "stage-b-gated",
    detail:
      "Stage B scaffold only: tiny river solve → browse node → clear active solution → reopen PSOL → assert strategy restored → close + sidecar exit. Enable with STUDY_INSTALLER_E2E=stage-b and STUDY_INSTALLER_E2E_STAGE_B=1 after Stage A is proven.",
  };
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
        "[installer-e2e] Stage B requested but STUDY_INSTALLER_E2E_STAGE_B!=1 (gated until Stage A is proven)",
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
