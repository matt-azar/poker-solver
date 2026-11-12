import { describe, expect, it } from "vitest";
import {
  getActiveTransport,
  setHttpFallbackTransport,
  setIpcTransport,
} from "./transport";

describe("solver transport selection", () => {
  it("labels HTTP as a temporary fallback", () => {
    const http = setHttpFallbackTransport();
    expect(http.kind).toBe("http-fallback");
    expect(http.label.toLowerCase()).toContain("temporary");
    expect(http.label.toLowerCase()).toContain("ipc");
    expect(getActiveTransport().kind).toBe("http-fallback");
  });

  it("records solver-engine IPC as the preferred Zig transport", () => {
    const ipc = setIpcTransport({
      protocol: 2,
      launchId: "zig-test",
      sidecar: "solver-engine",
      workers: 4,
    });
    expect(ipc.kind).toBe("ipc");
    expect(ipc.label).toContain("protocol 2");
    expect(getActiveTransport().kind).toBe("ipc");
    setHttpFallbackTransport();
  });
});
