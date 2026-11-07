import { describe, expect, it } from "vitest";
import { makeUserSavedRange, userSavedRangeId } from "./userSavedRange";

describe("userSavedRange", () => {
  it("slugs display names into stable ids", () => {
    expect(userSavedRangeId("BTN open 2.5x")).toBe("user-saved-btn-open-2-5x");
    expect(userSavedRangeId("  ")).toBe("user-saved-range");
  });

  it("builds a personal_adjustment atom with the given range text", () => {
    const atom = makeUserSavedRange("My open", "AA,KK");
    expect(atom.id).toBe("user-saved-my-open");
    expect(atom.displayName).toBe("My open");
    expect(atom.range).toBe("AA,KK");
    expect(atom.action).toBe("unknown");
    expect(atom.provenance.classification).toBe("personal_adjustment");
  });

  it("keeps an explicit id when updating an existing saved range", () => {
    const atom = makeUserSavedRange("Renamed", "QQ+", {
      id: "user-saved-old",
      dataRevision: "rev2",
    });
    expect(atom.id).toBe("user-saved-old");
    expect(atom.dataRevision).toBe("rev2");
  });
});
