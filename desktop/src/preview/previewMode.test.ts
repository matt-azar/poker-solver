import { afterEach, describe, expect, it } from "vitest";
import {
  clearFixtureIpcHandlerForTests,
  hasFixtureIpcHandler,
  setNoEngineTransport,
} from "../engine/transport";
import {
  clearBrowserPreviewForTests,
  getPreviewCommitSha,
  installBrowserPreviewTransport,
  parsePreviewSearch,
  setPreviewReviewerState,
} from "./previewMode";

describe("previewMode", () => {
  afterEach(() => {
    clearBrowserPreviewForTests();
    clearFixtureIpcHandlerForTests();
    setNoEngineTransport();
    window.history.replaceState({}, "", "/");
  });

  it("parses scenario and reviewer states from the query string", () => {
    expect(parsePreviewSearch("?preview=node-locking")).toEqual({
      scenario: "node-locking",
      state: "default",
    });
    expect(parsePreviewSearch("?preview=node-locking&state=pending-ev")).toEqual({
      scenario: "node-locking",
      state: "pending-ev",
    });
    expect(
      parsePreviewSearch("?preview=node-locking&state=dropped-connection"),
    ).toEqual({
      scenario: "node-locking",
      state: "dropped-connection",
    });
    expect(parsePreviewSearch("?preview=equity-calculator")).toEqual({
      scenario: "equity-calculator",
      state: "default",
    });
    expect(parsePreviewSearch("")).toEqual({ scenario: null, state: "default" });
  });

  it("installs the fixture IPC handler for the node-locking scenario", () => {
    const config = installBrowserPreviewTransport("?preview=node-locking");
    expect(config?.scenario).toBe("node-locking");
    expect(config?.commitSha).toBe(getPreviewCommitSha());
    expect(hasFixtureIpcHandler()).toBe(true);
  });

  it("installs the fixture IPC handler for the equity-calculator scenario", () => {
    const config = installBrowserPreviewTransport("?preview=equity-calculator");
    expect(config?.scenario).toBe("equity-calculator");
    expect(config?.commitSha).toBe(getPreviewCommitSha());
    expect(hasFixtureIpcHandler()).toBe(true);
  });

  it("updates reviewer state without leaving the scenario", () => {
    installBrowserPreviewTransport("?preview=node-locking");
    setPreviewReviewerState("pending-ev");
    expect(window.location.search).toContain("state=pending-ev");
    setPreviewReviewerState("default");
    expect(window.location.search).not.toContain("state=");
  });
});
