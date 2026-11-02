import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodePayload } from "../../domain/types";
import engineChanceRiverDeal from "../../domain/fixtures/engine-chance-river-deal.json";

const followAction = vi.fn(async () => undefined);

/** Engine-captured chance shape: cards[{card, child_id, weight}], empty children. */
const chanceNode = engineChanceRiverDeal as NodePayload;

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

  it("renders a suits×ranks grid from engine cards[] with faded blockers", () => {
    render(<CardPicker open street="river" onClose={() => undefined} />);
    expect(screen.getByRole("dialog", { name: /river card picker/i })).toBeTruthy();
    expect(screen.getByText("Change river")).toBeTruthy();
    expect(screen.queryByLabelText(/four-color suits/i)).toBeNull();
    expect(screen.getAllByText("♠").length).toBeGreaterThan(0);
    expect(screen.getAllByText("♥").length).toBeGreaterThan(0);
    const as = screen.getByRole("gridcell", { name: /^As$/ });
    expect((as as HTMLButtonElement).disabled).toBe(false);
    const ah = screen.getByRole("gridcell", { name: /Ah board blocker/i });
    expect((ah as HTMLButtonElement).disabled).toBe(true);
    const khUnavailable = screen.getByRole("gridcell", { name: /^Kh$/ });
    expect((khUnavailable as HTMLButtonElement).disabled).toBe(false);
    // A non-listed, non-blocker card stays in place faded.
    const qd = screen.getByRole("gridcell", { name: /Qd unavailable/i });
    expect((qd as HTMLButtonElement).disabled).toBe(true);
    // Engine fixture uses empty children — picker must not show the empty hint.
    expect(screen.queryByText(/No next cards at this node/i)).toBeNull();
  });

  it("selects a legal card with Enter via engine child_id and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CardPicker open street="river" onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: /river card picker/i });
    dialog.focus();
    await user.keyboard("{Enter}");
    expect(followAction).toHaveBeenCalledWith("n:root/c/As");
    expect(onClose).toHaveBeenCalled();
  });

  it("jumps focus with rank and suit keys", async () => {
    const user = userEvent.setup();
    render(<CardPicker open street="river" onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog", { name: /river card picker/i });
    dialog.focus();
    // From As: suit key h → Ah (blocked), then rank key 2 → 2h (legal in fixture)
    await user.keyboard("h");
    expect(
      screen.getByRole("gridcell", { name: /Ah board blocker/i }).getAttribute("data-focused"),
    ).toBe("true");
    await user.keyboard("2");
    expect(
      screen.getByRole("gridcell", { name: /^2h$/ }).getAttribute("data-focused"),
    ).toBe("true");
  });

  it("renders inline without a dialog chrome when embedded in the Cards row", () => {
    render(
      <CardPicker open variant="inline" street="river" onClose={() => undefined} />,
    );
    expect(screen.getByRole("region", { name: /river card picker/i })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Change river")).toBeTruthy();
  });
});
