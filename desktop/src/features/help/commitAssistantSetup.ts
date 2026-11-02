import type { SetupDraftResult } from "../../domain/setup";

export type AssistantSetupApplyOutcome =
  | { ok: true }
  | { ok: false; reason: string; message: string };

export type AssistantSetupApplyFn = (
  result: SetupDraftResult,
  options?: { force?: boolean },
) => AssistantSetupApplyOutcome;

/**
 * Apply an assistant setup proposal into Build.
 *
 * Uses the proposal's original `requestRevision` and never force-applies.
 * On stale rejection (draft changed while the request ran), returns that
 * failure as-is — do not remint `requestRevision` or retry with `{ force: true }`,
 * which would overwrite the player's intervening edits.
 */
export function commitAssistantSetup(
  result: SetupDraftResult,
  applySetupDraft: AssistantSetupApplyFn,
): AssistantSetupApplyOutcome {
  return applySetupDraft(result);
}
