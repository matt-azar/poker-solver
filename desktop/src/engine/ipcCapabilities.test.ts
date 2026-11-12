import { afterEach, describe, expect, it } from "vitest";
import {
  clearStudyIpcFeatureOverridesForTests,
  setStudyIpcFeatureOverrideForTests,
  studyIpcFeatureAvailable,
  studyIpcUnavailableReason,
  studyUsesIpcFeatureGates,
} from "./ipcCapabilities";
import { setHttpFallbackTransport, setIpcTransport } from "./transport";

afterEach(() => {
  clearStudyIpcFeatureOverridesForTests();
  setHttpFallbackTransport();
});

describe("studyIpcFeatureAvailable", () => {
  it("leaves features available outside the packaged IPC shell", () => {
    setHttpFallbackTransport();
    expect(studyUsesIpcFeatureGates()).toBe(false);
    expect(studyIpcFeatureAvailable("compare")).toBe(true);
    expect(studyIpcFeatureAvailable("resolveLocked")).toBe(true);
    expect(studyIpcFeatureAvailable("strategyEdits")).toBe(true);
    expect(studyIpcFeatureAvailable("categories")).toBe(true);
  });

  it("soft-disables unwired features when solver-engine IPC is active", () => {
    setIpcTransport({
      protocol: 2,
      launchId: "test",
      sidecar: "solver-engine",
      workers: 1,
    });
    expect(studyUsesIpcFeatureGates()).toBe(true);
    expect(studyIpcFeatureAvailable("compare")).toBe(false);
    expect(studyIpcFeatureAvailable("resolveLocked")).toBe(false);
    expect(studyIpcFeatureAvailable("strategyEdits")).toBe(false);
    expect(studyIpcFeatureAvailable("categories")).toBe(false);
    expect(studyIpcFeatureAvailable("runouts")).toBe(false);
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
    expect(studyIpcUnavailableReason("compare")).toMatch(/not available/i);
    expect(studyIpcUnavailableReason("resolveLocked")).toMatch(/not available/i);
    expect(studyIpcUnavailableReason("strategyEdits")).toMatch(/not available/i);
    expect(studyIpcUnavailableReason("categories")).toMatch(/not available/i);
  });
});
