import { describe, expect, it } from "vitest";
import {
  isFiledPlacement,
  normalizePositionName,
  openPlacement,
  parseLineFolderLabel,
  seatSlotKey,
} from "./seatActionPlacement";

describe("seatActionPlacement", () => {
  it("builds open placement and slot keys", () => {
    const open = openPlacement("hj");
    expect(open).toEqual({
      heroPosition: "HJ",
      action: "open",
      vsAction: "none",
    });
    expect(seatSlotKey(open)).toBe("HJ|open|none|");
  });

  it("parses vs-line folder labels", () => {
    expect(parseLineFolderLabel("BB", "vs CO open", "call")).toEqual({
      heroPosition: "BB",
      villainPosition: "CO",
      action: "call",
      vsAction: "open",
    });
    expect(parseLineFolderLabel("BB", "vs CO 3bet", "four_bet")).toMatchObject({
      vsAction: "three_bet",
      action: "four_bet",
    });
    expect(parseLineFolderLabel("HJ", "Open")).toEqual(openPlacement("HJ"));
  });

  it("normalizes position names and filed placement", () => {
    expect(normalizePositionName(" bu ")).toBe("BTN");
    expect(normalizePositionName("USER")).toBeNull();
    expect(isFiledPlacement({ heroPosition: "HJ", action: "open" })).toBe(true);
    expect(isFiledPlacement({ heroPosition: "USER", action: "unknown" })).toBe(
      false,
    );
  });
});
