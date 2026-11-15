/**
 * Fixture IPC handler that proxies Study ops to the river-beta HTTPS service.
 * EngineClient still uses typed IPC branches via isIpcTransport().
 */
import type { FixtureIpcHandler, IpcRequestEnvelope } from "../engine/transport";
import { RiverBetaApi, type RiverBetaEnvelope } from "./api";

function toEnvelope(env: RiverBetaEnvelope, fallbackOp: string): IpcRequestEnvelope {
  return {
    v: typeof env.v === "number" ? env.v : 2,
    kind: typeof env.kind === "string" ? env.kind : "reply",
    request_id:
      typeof env.request_id === "string" ? env.request_id : "river-beta",
    job_id: env.job_id ?? null,
    op: typeof env.op === "string" ? env.op : fallbackOp,
    ok: env.ok !== false,
    error_code: env.error_code ?? null,
    error_message: env.error_message ?? null,
    body: env.body ?? null,
  };
}

export function createRiverBetaIpcHandler(api: RiverBetaApi): FixtureIpcHandler {
  return async (op, body, jobId) => {
    // ready is local — session already started the sidecar.
    if (op === "ready") {
      return {
        v: 2,
        kind: "reply",
        request_id: "river-beta-ready",
        job_id: null,
        op: "ready",
        ok: true,
        error_code: null,
        error_message: null,
        body: { launch_id: api.getSessionId(), street: "river" },
      };
    }
    const env = await api.ipc(op, body, jobId);
    return toEnvelope(env, op);
  };
}
