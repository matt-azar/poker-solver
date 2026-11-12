import { afterEach, describe, expect, it } from "vitest";
import {
  clearStudyIpcFeatureOverridesForTests,
  setStudyIpcFeatureOverrideForTests,
  studyIpcFeatureAvailable,
  studyIpcUnavailableReason,
  studyUsesIpcFeatureGates,
} from "./ipcCapabilities";
import { setNoEngineTransport, setIpcTransport } from "./transport";

afterEach(() => {
  clearStudyIpcFeatureOverridesForTests();
  setNoEngineTransport();
});

describe("studyIpcFeatureAvailable", () => {
  it("leaves features available outside the packaged IPC shell", () => {
    setNoEngineTransport();
    expect(studyUsesIpcFeatureGates()).toBe(false);
    expect(studyIpcFeatureAvailable("compare")).toBe(true);
    expect(studyIpcFeatureAvailable("resolveLocked")).toBe(true);
    expect(studyIpcFeatureAvailable("strategyEdits")).toBe(true);
    expect(studyIpcFeatureAvailable("categories")).toBe(true);
  });

  it("enables wired IPC features and soft-disables the rest", () => {
    setIpcTransport({
      protocol: 2,
      launchId: "test",
      sidecar: "solver-engine",
      workers: 1,
    });
    expect(studyUsesIpcFeatureGates()).toBe(true);
    expect(studyIpcFeatureAvailable("resolveLocked")).toBe(true);
    expect(studyIpcFeatureAvailable("compare")).toBe(false);
    // ZR-101 wired host strategy-edits CRUD + client IPC branch.
    expect(studyIpcFeatureAvailable("strategyEdits")).toBe(true);
    // ZR-103 wired host `categories` + client IPC branch.
    expect(studyIpcFeatureAvailable("categories")).toBe(true);
  });

  it("honors test overrides as a thin sibling hook", () => {
    setIpcTransport({
      protocol: 2,
      launchId: "test",
      sidecar: "solver-engine",
      workers: 1,
    });
    setStudyIpcFeatureOverrideForTests("compare", true);
    expect(studyIpcFeatureAvailable("compare")).toBe(true);
    setStudyIpcFeatureOverrideForTests("compare", null);
    expect(studyIpcFeatureAvailable("compare")).toBe(false);
  });

  it("exposes honest unavailable copy", () => {
    expect(studyIpcUnavailableReason("compare")).toMatch(/dual-session baseline/i);
    expect(studyIpcUnavailableReason("resolveLocked")).toMatch(/not available/i);
    expect(studyIpcUnavailableReason("strategyEdits")).toMatch(/not available/i);
    expect(studyIpcUnavailableReason("categories")).toMatch(/not available/i);
  });
});
