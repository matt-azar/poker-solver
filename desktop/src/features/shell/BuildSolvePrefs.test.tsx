import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

const { useStudyStore } = await import("../../state/studyStore");
const { BuildSolvePrefs } = await import("./BuildSolvePrefs");

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  useStudyStore.setState({
    draft: {
      ...useStudyStore.getState().draft,
      threads: 4,
      memoryMib: 2048,
      samples: 10,
      frozen: false,
    },
  });
});

describe("BuildSolvePrefs", () => {
  it("edits per-solve threads and memory on the Build chrome strip", () => {
    render(<BuildSolvePrefs />);
    const threads = screen.getByLabelText("Threads") as HTMLInputElement;
    const memory = screen.getByLabelText("Memory MiB") as HTMLInputElement;
    expect(threads.value).toBe("4");
    fireEvent.change(threads, { target: { value: "6" } });
    fireEvent.change(memory, { target: { value: "4096" } });
    expect(useStudyStore.getState().draft.threads).toBe(6);
    expect(useStudyStore.getState().draft.memoryMib).toBe(4096);
    expect(useStudyStore.getState().draft.frozen).toBe(true);
  });
});
