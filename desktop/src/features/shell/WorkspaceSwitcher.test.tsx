import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearStudyIpcFeatureOverridesForTests } from "../../engine/ipcCapabilities";
import { setHttpFallbackTransport, setIpcTransport } from "../../engine/transport";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

afterEach(() => {
  cleanup();
  clearStudyIpcFeatureOverridesForTests();
  setHttpFallbackTransport();
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

  it("soft-disables Compare when solver-engine IPC lacks compare", () => {
    setIpcTransport({
      protocol: 2,
      launchId: "test",
      sidecar: "solver-engine",
      workers: 1,
    });
    const onChange = vi.fn();
    render(<WorkspaceSwitcher workspace="study" onChange={onChange} />);
    const compareTab = screen.getByRole("tab", { name: "Compare" });
    expect(compareTab).toHaveProperty("disabled", true);
    expect(compareTab.getAttribute("title")).toMatch(/not available/i);
    compareTab.click();
    expect(onChange).not.toHaveBeenCalled();
  });
});
