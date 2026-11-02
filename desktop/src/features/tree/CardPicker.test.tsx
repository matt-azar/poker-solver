import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodePayload } from "../../domain/types";

const followAction = vi.fn(async () => undefined);

const chanceNode: NodePayload = {
  node_id: "deal-turn",
  kind: "chance",
  board: ["Ah", "Kd", "7c"],
  children: [
    { card: "As", node_id: "n-as", weight: 0.02 },
    { card: "2h", node_id: "n-2h", weight: 0.02 },
  ],
};

vi.mock("../../state/studyStore", () => ({
  useStudyStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      currentNode: chanceNode,
      followAction,
    }),
}));

const { CardPicker } = await import("./CardPicker");

describe("CardPicker", () => {
  beforeEach(() => {
    followAction.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a suits×ranks grid with suit symbols and faded unavailable cards", () => {
    render(<CardPicker open street="turn" onClose={() => undefined} />);
    expect(screen.getByRole("dialog", { name: /turn card picker/i })).toBeTruthy();
    expect(screen.getAllByText("♠").length).toBeGreaterThan(0);
    expect(screen.getAllByText("♥").length).toBeGreaterThan(0);
    const as = screen.getByRole("gridcell", { name: /^As$/ });
    expect((as as HTMLButtonElement).disabled).toBe(false);
    const ah = screen.getByRole("gridcell", { name: /Ah board blocker/i });
    expect((ah as HTMLButtonElement).disabled).toBe(true);
    const kh = screen.getByRole("gridcell", { name: /Kh unavailable/i });
    expect((kh as HTMLButtonElement).disabled).toBe(true);
  });

  it("selects a legal card with Enter and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CardPicker open street="turn" onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: /turn card picker/i });
    dialog.focus();
    await user.keyboard("{Enter}");
    expect(followAction).toHaveBeenCalledWith("n-as");
    expect(onClose).toHaveBeenCalled();
  });

  it("jumps focus with rank and suit keys", async () => {
    const user = userEvent.setup();
    render(<CardPicker open street="turn" onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog", { name: /turn card picker/i });
    dialog.focus();
    // From As: suit key h → Ah (blocked), then rank key 2 → 2h (legal)
    await user.keyboard("h");
    expect(
      screen.getByRole("gridcell", { name: /Ah board blocker/i }).getAttribute("data-focused"),
    ).toBe("true");
    await user.keyboard("2");
    expect(
      screen.getByRole("gridcell", { name: /^2h$/ }).getAttribute("data-focused"),
    ).toBe("true");
  });
});
