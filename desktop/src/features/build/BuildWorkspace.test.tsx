import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }),
});

vi.mock("../../domain/profiles", async () => {
  const actual = await vi.importActual<typeof import("../../domain/profiles")>(
    "../../domain/profiles",
  );
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
  };
  const catalogue = actual.createSeatActionCatalogue([], storage);
  return {
    ...actual,
    loadBundledSeatActions: () => [],
    getSeatActionCatalogue: () => catalogue,
    resetSeatActionCatalogueForTests: () => {
      memory.clear();
    },
  };
});

const { resetSeatActionCatalogueForTests } = await import("../../domain/profiles");
const { useStudyStore } = await import("../../state/studyStore");
const { BuildWorkspace } = await import("./BuildWorkspace");

describe("BuildWorkspace range tools", () => {
  beforeEach(() => {
    resetSeatActionCatalogueForTests();
    useStudyStore.setState({
      draft: {
        ...useStudyStore.getState().draft,
        oopRange: "AA,KK",
        ipRange: "QQ+",
        pot: 10,
        stack: 100,
        boardText: "Ah Kd 2c",
      },
      weights: {
        oop: useStudyStore.getState().weights.oop,
        ip: useStudyStore.getState().weights.ip,
      },
      paintWeight: 0.4,
      canUndoRange: false,
      canRedoRange: false,
      solveValidationErrors: [],
      phase: "idle",
      workspace: "build",
    });
    useStudyStore.getState().setRangeText("oop", "AA,KK");
    useStudyStore.getState().setRangeText("ip", "QQ+");
  });

  afterEach(() => {
    cleanup();
  });

  it("lets the user type a paint weight into a number field", async () => {
    const user = userEvent.setup();
    render(<BuildWorkspace />);
    const input = screen.getByLabelText("Paint weight value") as HTMLInputElement;
    expect(input.value).toBe("0.40");
    await user.clear(input);
    await user.type(input, "0.75");
    await user.tab();
    expect(useStudyStore.getState().paintWeight).toBeCloseTo(0.75, 5);
    expect(input.value).toBe("0.75");
  });

  it("swaps OOP and IP range text without flipping layout labels", async () => {
    const user = userEvent.setup();
    render(<BuildWorkspace />);
    expect(screen.getByRole("heading", { name: "OOP" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "IP" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Swap" }));
    expect(useStudyStore.getState().draft.oopRange).toBe("QQ+");
    expect(useStudyStore.getState().draft.ipRange).toBe("AA,KK");
    expect(screen.getByRole("heading", { name: "OOP" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "IP" })).toBeTruthy();
  });

  it("saves the current seat range into the catalogue and can edit it", async () => {
    const user = userEvent.setup();
    render(<BuildWorkspace />);
    await user.click(screen.getAllByRole("button", { name: "Catalogue" })[0]!);
    expect(screen.getByRole("heading", { name: "Saved ranges" })).toBeTruthy();
    await user.type(
      screen.getByLabelText("Name for saved OOP range"),
      "My BTN open",
    );
    await user.click(screen.getByRole("button", { name: "Save to catalogue" }));
    expect(screen.getByRole("button", { name: "My BTN open" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const nameInput = screen.getByLabelText("Saved range name");
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed open");
    const rangeInput = screen.getByLabelText("Saved range text");
    await user.clear(rangeInput);
    await user.type(rangeInput, "AKs,AA");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("button", { name: "Renamed open" })).toBeTruthy();

    useStudyStore.getState().setRangeText("oop", "22");
    await user.click(screen.getByRole("button", { name: "Renamed open" }));
    expect(useStudyStore.getState().draft.oopRange).toBe("AKs,AA");
  });
});
