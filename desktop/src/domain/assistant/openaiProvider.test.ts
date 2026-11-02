import { describe, expect, it } from "vitest";
import { AssistantProviderError } from "./provider";
import { asFieldEdits, parseInterpretProposal } from "./openaiProvider";

describe("asFieldEdits A07 limits", () => {
  it("accepts valid numeric edits including solve rake", () => {
    const edits = asFieldEdits({
      pot: 55,
      iterations: 400,
      rakeRate: 0,
      rakeCap: 0,
    });
    expect(edits).toEqual({
      pot: 55,
      iterations: 400,
      rakeRate: 0,
      rakeCap: 0,
    });
  });

  it("rejects negative pot / zero threads / fractional iterations", () => {
    expect(() => asFieldEdits({ pot: -5 })).toThrow(AssistantProviderError);
    expect(() => asFieldEdits({ threads: 0 })).toThrow(/Threads/i);
    expect(() => asFieldEdits({ iterations: 10.5 })).toThrow(/whole number/i);
    expect(() => asFieldEdits({ memoryMib: -1 })).toThrow(/Memory/i);
  });
});

describe("parseInterpretProposal fieldEdits", () => {
  it("surfaces invalid fieldEdits as invalid_response", () => {
    expect(() =>
      parseInterpretProposal({
        kind: "update_study",
        intent: { mode: "edit" },
        fieldEdits: { pot: -10 },
      }),
    ).toThrow(AssistantProviderError);
  });
});
