import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "./StatusBar";

vi.mock("../../commands/studyCommands", () => ({
  canExecuteSolve: () => ({ ok: false, reason: "n/a" }),
  canExecuteContinue: () => ({ ok: true }),
  canExecutePause: () => ({ ok: true }),
  canExecuteStop: () => ({ ok: false, reason: "n/a" }),
  executeSolve: vi.fn(),
  executeContinue: vi.fn(),
  executePause: vi.fn(),
  executeStop: vi.fn(),
  studyCommandContextFromStore: () => ({}),
}));

vi.mock("../../state/studyStore", () => ({
  useStudyStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      solve: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      continueSolve: vi.fn(),
      draft: {},
      lastCheckpointPath: "",
      solutionId: "sol",
      workspace: "study",
      currentNode: null,
      solveValidationErrors: [],
      status: null,
      phase: "solving",
    }),
}));

afterEach(() => {
  cleanup();
});

describe("StatusBar", () => {
  it("keeps compact metrics and expands diagnostics on demand", () => {
    render(
      <StatusBar
        message="Solving…"
        connection="connected"
        phase="solving"
        status={{
          iterations: 12,
          iterations_requested: 100,
          nash_gap: 0.02,
          pot: 100,
          runtime_seconds: 4,
          job_id: "job-9",
          engine_allocated: 8 * 1024 * 1024,
        }}
      />,
    );

    expect(screen.getByText(/Iter 12\/100/)).toBeTruthy();
    expect(screen.getByText(/^Acc /)).toBeTruthy();
    expect(screen.queryByText(/Job job-9/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText(/Job job-9/)).toBeTruthy();
    expect(screen.getByText(/^Mem /)).toBeTruthy();
    expect(screen.getByText(/^Rate /)).toBeTruthy();
  });

  it("surfaces a prominent Reconnect when disconnected", () => {
    const onReconnect = vi.fn();
    render(
      <StatusBar
        message="Engine unreachable"
        connection="disconnected"
        phase="idle"
        onReconnect={onReconnect}
      />,
    );
    const button = screen.getByRole("button", { name: "Reconnect" });
    expect(button.className).toMatch(/primary/);
    fireEvent.click(button);
    expect(onReconnect).toHaveBeenCalled();
  });
});
