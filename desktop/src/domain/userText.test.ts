import { describe, expect, it } from "vitest";
import { parseAbsoluteNumberList } from "./range";
import { presentUserText } from "./userText";

describe("presentUserText", () => {
  it("sentence-cases an all-lowercase engine error and spells ICM", () => {
    expect(presentUserText("icm stacks need at least two seats")).toBe(
      "ICM stacks need at least two seats",
    );
  });

  it("leaves already-cased copy unchanged", () => {
    expect(presentUserText("ICM stacks need at least two seats")).toBe(
      "ICM stacks need at least two seats",
    );
    expect(presentUserText("Solve failed.")).toBe("Solve failed.");
  });
});

describe("parseAbsoluteNumberList", () => {
  it("omits blank tokens instead of treating them as zero", () => {
    expect(parseAbsoluteNumberList("")).toEqual([]);
    expect(parseAbsoluteNumberList("  ,  ")).toEqual([]);
    expect(parseAbsoluteNumberList("1000, 1000")).toEqual([1000, 1000]);
    expect(parseAbsoluteNumberList("1000, , 500")).toEqual([1000, 500]);
  });
});
