import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    removeItem: (key: string) => {
      memory.delete(key);
    },
  };
  const bundled = [
    {
      schemaVersion: 1,
      id: "hj",
      dataRevision: "1",
      displayName: "HJ open",
      heroPosition: "HJ",
      action: "open" as const,
      vsAction: "none" as const,
      range: "AA,KK",
      provenance: {
        source: "test",
        classification: "synthetic_fixture" as const,
      },
    },
  ];
  let catalogue = actual.createSeatActionCatalogue(bundled, storage);
  return {
    ...actual,
    loadBundledSeatActions: () => bundled,
    getSeatActionCatalogue: () => catalogue,
    resetSeatActionCatalogueForTests: () => {
      memory.clear();
      catalogue = actual.createSeatActionCatalogue(bundled, storage);
    },
    __testMemory: memory,
  };
});

const profiles = await import("../../domain/profiles");
const { SeatActionCatalogueTree } = await import("./SeatActionCatalogueTree");

describe("SeatActionCatalogueTree folder edits", () => {
  beforeEach(() => {
    localStorage.clear();
    profiles.resetSeatActionCatalogueForTests();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("adds a position folder and saves the current range into it", async () => {
    const user = userEvent.setup();
    render(
      <SeatActionCatalogueTree
        onPick={vi.fn()}
        saveSource={{ label: "OOP", rangeText: "QQ+,JJ" }}
      />,
    );

    await user.type(screen.getByLabelText("New position folder name"), "EP");
    await user.click(screen.getByRole("button", { name: "Add position" }));
    expect(screen.getByText("EP")).toBeTruthy();

    // EP empty Open folder's Save here is the last one after HJ's Save here.
    const saveHereButtons = screen.getAllByRole("button", { name: "Save here" });
    await user.click(saveHereButtons[saveHereButtons.length - 1]!);
    await user.type(
      screen.getByLabelText("Name for range saved into folder"),
      "EP open",
    );
    await user.click(screen.getByRole("button", { name: "Save into folder" }));

    expect(screen.getByRole("button", { name: /EP open/i })).toBeTruthy();
  });

  it("renames a position folder via the layout overlay", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "Hijack"),
    );
    render(
      <SeatActionCatalogueTree
        onPick={vi.fn()}
        saveSource={{ label: "OOP", rangeText: "AA" }}
      />,
    );
    await user.click(screen.getAllByRole("button", { name: "Rename" })[0]!);
    expect(screen.getByText("Hijack")).toBeTruthy();
  });

  it("replaces the hijack open chart with the current Build range", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "My HJ open"),
    );
    render(
      <SeatActionCatalogueTree
        onPick={vi.fn()}
        saveSource={{ label: "OOP", rangeText: "ATs+" }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Replace" }));
    expect(screen.getByRole("button", { name: /My HJ open/i })).toBeTruthy();
    expect(screen.getByText("custom")).toBeTruthy();
  });
});
