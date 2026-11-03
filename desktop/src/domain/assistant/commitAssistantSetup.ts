import {
  buildApplicationReceipt,
  type ApplicationReceipt,
} from "./applicationReceipt";
import type { SetupDraftResult } from "../setup";
import type { SetupUndoEntry } from "../setup";

export type AssistantSetupApplyOutcome =
  | { ok: true; receipt: ApplicationReceipt }
  | { ok: false; reason: string; message: string };

export type AssistantSetupApplyFn = (
  result: SetupDraftResult,
  options?: { force?: boolean },
) =>
  | { ok: true; undoEntry: SetupUndoEntry }
  | { ok: false; reason: string; message: string };

/**
 * Apply an assistant setup proposal into Build and return an application receipt.
 *
 * Uses the proposal's original `requestRevision` and never force-applies.
 * On stale rejection (draft changed while the request ran), returns that
 * failure as-is — do not remint `requestRevision` or retry with `{ force: true }`,
 * which would overwrite the player's intervening edits.
 *
 * Chat text must be rendered from the receipt (actual before/after), not the
 * model's intended action.
 */
export function commitAssistantSetup(
  result: SetupDraftResult,
  applySetupDraft: AssistantSetupApplyFn,
  options?: { force?: boolean },
): AssistantSetupApplyOutcome {
  const outcome = options?.force
    ? applySetupDraft(result, { force: true })
    : applySetupDraft(result);
  if (!outcome.ok) {
    return outcome;
  }
  return {
    ok: true,
    receipt: buildApplicationReceipt({
      undoEntry: outcome.undoEntry,
      result,
    }),
  };
}
