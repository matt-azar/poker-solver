import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearStudyIpcFeatureOverridesForTests,
  setStudyIpcFeatureOverrideForTests,
} from "../../engine/ipcCapabilities";
import { setNoEngineTransport, setIpcTransport } from "../../engine/transport";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

afterEach(() => {
  cleanup();
  clearStudyIpcFeatureOverridesForTests();
  setNoEngineTransport();
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

  it("keeps Compare enabled when solver-engine IPC has compare", () => {
    setIpcTransport({
      protocol: 2,
      launchId: "test",
      sidecar: "solver-engine",
      workers: 1,
    });
    const onChange = vi.fn();
    render(<WorkspaceSwitcher workspace="study" onChange={onChange} />);
    const compareTab = screen.getByRole("tab", { name: "Compare" });
    expect(compareTab).toHaveProperty("disabled", false);
    compareTab.click();
    expect(onChange).toHaveBeenCalledWith("compare");
  });

  it("soft-disables Compare when compare capability is overridden off", () => {
    setIpcTransport({
      protocol: 2,
      launchId: "test",
      sidecar: "solver-engine",
      workers: 1,
    });
    setStudyIpcFeatureOverrideForTests("compare", false);
    const onChange = vi.fn();
    render(<WorkspaceSwitcher workspace="study" onChange={onChange} />);
    const compareTab = screen.getByRole("tab", { name: "Compare" });
    expect(compareTab).toHaveProperty("disabled", true);
    expect(compareTab.getAttribute("title")).toMatch(/not available/i);
    compareTab.click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves between workspace tabs with arrow keys", () => {
    const onChange = vi.fn();
    render(<WorkspaceSwitcher workspace="study" onChange={onChange} />);
    const tablist = screen.getByRole("tablist", { name: "Workspace" });
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("build");
  });
});
