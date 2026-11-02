import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRunoutsPayload } from "../../engine/runouts";
import { RunoutTable } from "./RunoutTable";

const followAction = vi.fn(async () => undefined);
const loadRunouts = vi.fn(async () => undefined);

vi.mock("../../state/studyStore", () => ({
  useStudyStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      runouts: (globalThis as { __runoutsFixture?: unknown }).__runoutsFixture ?? null,
      followAction,
      loadRunouts,
    }),
}));

afterEach(() => {
  cleanup();
  followAction.mockClear();
  loadRunouts.mockClear();
  delete (globalThis as { __runoutsFixture?: unknown }).__runoutsFixture;
});

describe("RunoutTable", () => {
  it("renders one row per engine card and navigates via child_id", () => {
    const model = normalizeRunoutsPayload({
      pending: false,
      units: "chips",
      utility_basis: "root_centered",
      cards: [
        {
          card: "As",
          child_id: "n:root/c/As",
          probability_defined: true,
          probability: 0.02,
          ev_defined: true,
          oop_ev: 1.5,
          ip_ev: -1.5,
        },
        {
          card: "Kh",
          child_id: "n:root/c/Kh",
          probability_defined: false,
          probability: null,
          ev_defined: false,
          oop_ev: null,
          ip_ev: null,
        },
      ],
    });
    (globalThis as { __runoutsFixture?: unknown }).__runoutsFixture = model;

    render(<RunoutTable />);

    expect(screen.getByTestId("runout-units").textContent).toContain("chips");
    expect(screen.getByTestId("runout-units").textContent).toContain("root_centered");

    const rows = document.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-child-id")).toBe("n:root/c/As");
    expect(rows[1]?.getAttribute("data-child-id")).toBe("n:root/c/Kh");

    // Undefined probability/EV show an em dash.
    expect(rows[1]?.textContent).toContain("—");

    fireEvent.click(rows[0]!);
    expect(followAction).toHaveBeenCalledWith("n:root/c/As");
  });

  it("shows empty hint when status is ready but raw legacy shape had no cards", () => {
    (globalThis as { __runoutsFixture?: unknown }).__runoutsFixture = normalizeRunoutsPayload({
      pending: false,
      runouts: [{ card: "As", weight: 1, node_id: "legacy" }],
    });
    render(<RunoutTable />);
    expect(screen.getByText(/Open a deal/i)).toBeTruthy();
    expect(document.querySelectorAll("tbody tr")).toHaveLength(0);
  });
});
