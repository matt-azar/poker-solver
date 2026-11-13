/**
 * Local crash / session-fault diagnostics (ZR-160).
 * Tauri-only; browser/dev returns a clear unavailable message.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./index";

export type EngineFaultReport = {
  reason: string;
  launchId?: string;
  lastOp?: string;
  exitReason?: string;
  consecutiveStatusFailures?: number;
  protocol?: number;
};

export async function openDiagnosticsFolder(): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error("Diagnostics folder requires the Holdem Study desktop app");
  }
  return (await invoke("open_diagnostics_folder")) as string;
}

/** Builds a zip and returns its absolute path (paste into chat/email). */
export async function copyDiagnosticsBundle(): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error("Diagnostics bundle requires the Holdem Study desktop app");
  }
  return (await invoke("copy_diagnostics_bundle")) as string;
}

export async function diagnosticsDirPath(): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error("Diagnostics path requires the Holdem Study desktop app");
  }
  return (await invoke("diagnostics_dir_path")) as string;
}

/** Best-effort last-fault.json update from session-dead / reconnect UI paths. */
export async function reportEngineFault(report: EngineFaultReport): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  try {
    await invoke("report_engine_fault", { report });
  } catch {
    // Must not block Reconnect / status paint.
  }
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("Clipboard unavailable");
}
