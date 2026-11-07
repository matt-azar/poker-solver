import { beforeEach, describe, expect, it } from "vitest";
import { createSeatActionCatalogue } from "./seatActionCatalogue";
import { makeUserSavedRange } from "./userSavedRange";
import { SEAT_ACTION_STORAGE_KEY } from "./seatActionTypes";

describe("SeatActionCatalogue user saves", () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  };

  beforeEach(() => {
    memory.clear();
  });

  it("imports, lists, updates, and removes user-saved ranges", () => {
    const catalogue = createSeatActionCatalogue([], storage);
    catalogue.importAtom(makeUserSavedRange("BTN open", "AA,KK"));
    expect(catalogue.isUserImport("user-saved-btn-open")).toBe(true);
    expect(catalogue.listUserImports()).toHaveLength(1);
    expect(catalogue.get("user-saved-btn-open")?.range).toBe("AA,KK");

    catalogue.importAtom(
      makeUserSavedRange("BTN open", "QQ+", {
        id: "user-saved-btn-open",
        dataRevision: "2",
      }),
    );
    expect(catalogue.get("user-saved-btn-open")?.range).toBe("QQ+");
    expect(catalogue.listUserImports()).toHaveLength(1);

    expect(catalogue.removeUserImport("user-saved-btn-open")).toBe(true);
    expect(catalogue.listUserImports()).toHaveLength(0);
    expect(memory.get(SEAT_ACTION_STORAGE_KEY)).toBe("[]");
  });

  it("persists user imports across catalogue instances", () => {
    createSeatActionCatalogue([], storage).importAtom(
      makeUserSavedRange("Saved", "AKs"),
    );
    const reloaded = createSeatActionCatalogue([], storage);
    expect(reloaded.get("user-saved-saved")?.range).toBe("AKs");
  });
});
