import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearFixtureIpcHandlerForTests,
  getActiveTransport,
  hasFixtureIpcHandler,
  setNoEngineTransport,
} from "../engine/transport";
import {
  clearBrowserRiverBetaForTests,
  installBrowserRiverBetaTransport,
  isBrowserRiverBetaMode,
  parseRiverBetaSearch,
} from "./riverBetaMode";

function mockRiverBetaFetch(): void {
  let sessionId = "test-session-1";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url.endsWith("/v1/sessions") && method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            session: {
              session_id: sessionId,
              metrics: {
                cpu_user_sec: 0.01,
                cpu_system_sec: 0,
                cpu_total_sec: 0.01,
                peak_rss_bytes: 12_000_000,
                solve_count: 0,
              },
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "X-River-Beta-Session": sessionId,
            },
          },
        );
      }
      if (url.endsWith("/v1/sessions/me/solve") && method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            begin: { ok: true },
            solve: { ok: true, body: { accepted: true, running: true } },
            active_job_id: "job-1",
            metrics: { peak_rss_bytes: 12_000_000, solve_count: 1, cpu_total_sec: 0.05 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/v1/sessions/me/ipc") && method === "POST") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.op === "status") {
          return new Response(
            JSON.stringify({
              ok: true,
              envelope: {
                v: 2,
                kind: "reply",
                request_id: "1",
                op: "status",
                ok: true,
                body: {
                  running: false,
                  root_node_id: "p0.t-1.r-1",
                  solution_id: 1,
                },
              },
              metrics: { peak_rss_bytes: 12_000_000, solve_count: 1 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            envelope: {
              v: 2,
              kind: "reply",
              request_id: "2",
              op: body.op,
              ok: true,
              body: {},
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/v1/sessions/me") && method === "GET") {
        return new Response(
          JSON.stringify({
            ok: true,
            session: {
              session_id: sessionId,
              metrics: { peak_rss_bytes: 12_000_000, solve_count: 1, cpu_total_sec: 0.05 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(`unexpected ${method} ${url}`, { status: 404 });
    }),
  );
}

describe("river beta mode", () => {
  afterEach(() => {
    clearBrowserRiverBetaForTests();
    clearFixtureIpcHandlerForTests();
    setNoEngineTransport();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });

  it("parseRiverBetaSearch recognizes ?river-beta=1", () => {
    expect(parseRiverBetaSearch("?river-beta=1")).toBe(true);
    expect(parseRiverBetaSearch("?river-beta=true")).toBe(true);
    expect(parseRiverBetaSearch("?demo=flop-explore")).toBe(false);
    expect(parseRiverBetaSearch("?preview=node-locking")).toBe(false);
  });

  it("isBrowserRiverBetaMode is separate from demo/preview", () => {
    expect(isBrowserRiverBetaMode("?river-beta=1")).toBe(true);
    expect(isBrowserRiverBetaMode("?demo=flop-explore")).toBe(false);
    expect(isBrowserRiverBetaMode("?preview=node-locking")).toBe(false);
  });

  it("installBrowserRiverBetaTransport arms IPC fixture proxy", async () => {
    mockRiverBetaFetch();
    window.history.replaceState({}, "", "/?river-beta=1");
    const boot = await installBrowserRiverBetaTransport();
    expect(boot).not.toBeNull();
    expect(boot?.sessionId).toBe("test-session-1");
    expect(boot?.autoSolved).toBe(true);
    expect(hasFixtureIpcHandler()).toBe(true);
    expect(getActiveTransport().kind).toBe("ipc");
    expect(
      getActiveTransport().kind === "ipc" && getActiveTransport().sidecar,
    ).toBe("river-beta-service");
  });
});
