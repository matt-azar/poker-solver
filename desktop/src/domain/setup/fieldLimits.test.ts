import { describe, expect, it } from "vitest";
import {
  validateLimitedField,
  validateProposedFieldBag,
} from "./fieldLimits";

describe("validateProposedFieldBag", () => {
  it("accepts positive pot/stack and integer iterations/threads", () => {
    expect(
      validateProposedFieldBag({
        pot: 55,
        stack: 100,
        iterations: 400,
        threads: 4,
        memoryMib: 512,
        rakeRate: 0,
        rakeCap: 0,
      }),
    ).toEqual([]);
  });

  it("flags negative pot/stack/memory, zero threads, fractional iterations", () => {
    const conflicts = validateProposedFieldBag({
      pot: -1,
      stack: -2,
      memoryMib: -8,
      threads: 0,
      iterations: 3.14,
    });
    expect(conflicts.map((c) => c.field).sort()).toEqual([
      "iterations",
      "memoryMib",
      "pot",
      "stack",
      "threads",
    ]);
  });

  it("validateLimitedField distinguishes incomplete-friendly zeros from invalid threads", () => {
    expect(validateLimitedField("threads", 0)?.message).toMatch(/at least 1/i);
    expect(validateLimitedField("pot", 0)?.message).toMatch(/greater than 0/i);
  });
});
