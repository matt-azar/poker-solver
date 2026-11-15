import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearFixtureIpcHandlerForTests,
  getActiveTransport,
  hasFixtureIpcHandler,
  setNoEngineTransport,
} from "../engine/transport";
import {
  clearBrowserRiverBetaForTests,
  getActiveRiverBetaConfig,
  installBrowserRiverBetaTransport,
  isBrowserRiverBetaMode,
  parseRiverBetaSearch,
  reconnectRiverBeta,
  refreshRiverBetaMetrics,
} from "./riverBetaMode";

type FetchInit = RequestInit | undefined;

function mockRiverBetaFetch(opts?: {
  failHealth?: boolean;
  sessionGoneAfter?: number;
}): void {
  let sessionId = "test-session-1";
  let sessionInfoCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: FetchInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();

      if (url.endsWith("/health") && method === "GET") {
        if (opts?.failHealth) {
          return new Response("down", { status: 502 });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            service: "river-beta",
            street: "river",
            active_sessions: 1,
            max_concurrent_sessions: 4,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.endsWith("/v1/bounds") && method === "GET") {
        return new Response(
          JSON.stringify({
            ok: true,
            street: "river",
            max_iterations: 200,
            max_time_limit_sec: 30,
            max_memory_mib: 256,
            max_weighted_combos_per_player: 24,
            max_session_idle_sec: 300,
            max_concurrent_sessions: 4,
            summary:
              "river-only · ≤200 iters · ≤30s · ≤256 MiB · ≤24 combos/player · 4 sessions · idle 300s",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.endsWith("/v1/sessions") && method === "POST") {
        sessionId = `test-session-${Math.random().toString(16).slice(2, 6)}`;
        return new Response(
          JSON.stringify({
            ok: true,
            session: {
              session_id: sessionId,
              idle_remaining_sec: 300,
              bounds: {
                max_iterations: 200,
                max_time_limit_sec: 30,
                max_memory_mib: 256,
                max_session_idle_sec: 300,
              },
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

      if (url.endsWith("/v1/sessions/me") && method === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
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
        sessionInfoCalls += 1;
        if (
          opts?.sessionGoneAfter != null &&
          sessionInfoCalls > opts.sessionGoneAfter
        ) {
          return new Response(
            JSON.stringify({
              ok: false,
              error_code: "no_session",
              error_message: "no river-beta session",
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            session: {
              session_id: sessionId,
              idle_remaining_sec: 280,
              bounds: {
                max_iterations: 200,
                max_time_limit_sec: 30,
                max_memory_mib: 256,
                max_session_idle_sec: 300,
              },
              metrics: {
                peak_rss_bytes: 12_000_000,
                solve_count: 1,
                cpu_total_sec: 0.05,
              },
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

  it("installBrowserRiverBetaTransport arms IPC fixture proxy and loads bounds", async () => {
    mockRiverBetaFetch();
    window.history.replaceState({}, "", "/?river-beta=1");
    const boot = await installBrowserRiverBetaTransport();
    expect(boot).not.toBeNull();
    expect(boot?.sessionId).toMatch(/^test-session-/);
    expect(boot?.autoSolved).toBe(true);
    expect(boot?.connectionState).toBe("connected");
    expect(boot?.bounds?.max_iterations).toBe(200);
    expect(boot?.bounds?.summary).toContain("river-only");
    expect(hasFixtureIpcHandler()).toBe(true);
    expect(getActiveTransport().kind).toBe("ipc");
    expect(
      getActiveTransport().kind === "ipc" && getActiveTransport().sidecar,
    ).toBe("river-beta-service");
  });

  it("marks session lost when service returns no_session", async () => {
    mockRiverBetaFetch({ sessionGoneAfter: 1 });
    window.history.replaceState({}, "", "/?river-beta=1");
    await installBrowserRiverBetaTransport();
    // First refresh after boot's sessionInfo may already count; force another.
    await refreshRiverBetaMetrics();
    await refreshRiverBetaMetrics();
    const cfg = getActiveRiverBetaConfig();
    expect(cfg?.connectionState).toBe("lost");
    expect(cfg?.lastError).toMatch(/no_session|expired|reaped/i);
  });

  it("reconnectRiverBeta creates a fresh connected session", async () => {
    mockRiverBetaFetch({ sessionGoneAfter: 1 });
    window.history.replaceState({}, "", "/?river-beta=1");
    await installBrowserRiverBetaTransport();
    await refreshRiverBetaMetrics();
    await refreshRiverBetaMetrics();
    expect(getActiveRiverBetaConfig()?.connectionState).toBe("lost");

    const next = await reconnectRiverBeta({ autoSolve: true });
    expect(next.connectionState).toBe("connected");
    expect(next.sessionId).toMatch(/^test-session-/);
    expect(next.autoSolved).toBe(true);
  });

  it("publishes unavailable config when health fails", async () => {
    mockRiverBetaFetch({ failHealth: true });
    window.history.replaceState({}, "", "/?river-beta=1");
    await expect(installBrowserRiverBetaTransport()).rejects.toThrow();
    const cfg = getActiveRiverBetaConfig();
    expect(cfg?.connectionState).toBe("unavailable");
    expect(cfg?.lastError).toMatch(/unreachable|unavailable|502/i);
  });
});
