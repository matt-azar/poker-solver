import { describe, expect, it } from "vitest";
import { blankGrid } from "../range";
import { DEFAULT_SPOT, type SpotDraft } from "../types";
import type { SetupDraftResult } from "../setup/types";
import type { SetupUndoEntry } from "../setup/setupTransaction";
import {
  buildApplicationReceipt,
  chatContentFromReceipt,
  renderReceiptChatText,
  renderReceiptReviewCard,
} from "./applicationReceipt";

function result(partial: Partial<SetupDraftResult> = {}): SetupDraftResult {
  return {
    ok: true,
    mode: "edit",
    draftPatch: { pot: 55 },
    provenance: {},
    conflicts: [],
    missing: [],
    summary: ["Updated pot"],
    canSolve: true,
    requestRevision: 0,
    ...partial,
  };
}

function undoEntry(partial: Partial<SetupUndoEntry> = {}): SetupUndoEntry {
  const before: Partial<SpotDraft> = { pot: 100 };
  const after: Partial<SpotDraft> = { pot: 55 };
  return {
    operationId: "setup-1-1",
    mode: "edit",
    changedKeys: ["pot"],
    beforeDraft: before,
    afterDraft: after,
    rangesChanged: false,
    beforeWeights: null,
    afterWeights: null,
    beforeMeta: null,
    afterMeta: {
      profile: null,
      rangeSnapshot: null,
      profileDataRevision: null,
      provenance: {},
      summary: [],
      conflicts: [],
      missing: [],
      canSolve: true,
    },
    baseRevision: 0,
    resultRevision: 1,
    fullBefore: {
      draft: { ...DEFAULT_SPOT, pot: 100 },
      weights: { oop: blankGrid(), ip: blankGrid() },
      meta: null,
      draftRevision: 0,
    },
    ...partial,
  };
}

describe("application receipts", () => {
  it("renders pot before/after chat text from the receipt", () => {
    const receipt = buildApplicationReceipt({
      undoEntry: undoEntry(),
      result: result(),
    });

    expect(receipt.operationId).toBe("setup-1-1");
    expect(receipt.committedRevision).toBe(1);
    expect(receipt.changedFields).toEqual([{ field: "pot", before: 100, after: 55 }]);
    expect(receipt.broadSetup).toBe(false);

    const text = renderReceiptChatText(receipt);
    expect(text).toBe("Pot: 100 → 55. Other fields unchanged. Build draft updated.");
    expect(chatContentFromReceipt(receipt)).toBe(text);
  });

  it("includes range sources and unresolved requirements", () => {
    const receipt = buildApplicationReceipt({
      undoEntry: undoEntry({
        mode: "create",
        changedKeys: ["oopRange", "ipRange", "boardText", "pot", "stack"],
        beforeDraft: {
          oopRange: "",
          ipRange: "",
          boardText: "As7d2cKh2s",
          pot: 5.5,
          stack: 97.5,
        },
        afterDraft: {
          oopRange: "AA,KK",
          ipRange: "QQ+",
          boardText: "",
          pot: 20.5,
          stack: 90,
        },
        rangesChanged: true,
      }),
      result: result({
        mode: "create",
        draftPatch: { oopRange: "AA,KK", ipRange: "QQ+", boardText: "", pot: 20.5, stack: 90 },
        provenance: {
          oopRange: "selected_profile",
          ipRange: "selected_profile",
          stakesLabel: "explicit_request",
        },
        missing: [{ field: "boardText", message: "Select a board", reason: "required" }],
        canSolve: false,
      }),
    });

    expect(receipt.broadSetup).toBe(true);
    expect(receipt.rangeSources.oopRange).toBe("selected_profile");
    expect(receipt.unresolved[0]?.field).toBe("boardText");

    const text = renderReceiptChatText(receipt);
    expect(text).toMatch(/OOP range:/);
    expect(text).toMatch(/New study created/);
    expect(text).toMatch(/Range sources:/);
    expect(text).toMatch(/Unresolved: boardText/);

    const card = renderReceiptReviewCard(receipt);
    expect(card).toMatch(/Review · create/);
    expect(card).toMatch(/Missing boardText/);
    expect(card).toMatch(/Not yet solvable/);
    expect(chatContentFromReceipt(receipt)).toContain(card);
  });
});
