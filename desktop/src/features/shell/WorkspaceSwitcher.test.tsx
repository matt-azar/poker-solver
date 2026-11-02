import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

afterEach(() => {
  cleanup();
});

describe("WorkspaceSwitcher", () => {
  it("marks the active workspace with aria-selected", () => {
    render(<WorkspaceSwitcher workspace="build" onChange={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Build" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("tab", { name: "Study" }).getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("exposes a labeled workspace select for compact layouts", () => {
    render(<WorkspaceSwitcher workspace="study" onChange={vi.fn()} />);
    const select = screen.getByLabelText("Workspace", {
      selector: "select",
    }) as HTMLSelectElement;
    expect(select.value).toBe("study");
  });
});
