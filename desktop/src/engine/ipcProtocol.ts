/**
 * Typed IPC protocol for `solver-engine` (protocol version 2).
 * Frames: little-endian u32 length + UTF-8 JSON envelope.
 * Logs stay on stderr — never mixed into this stream.
 */

export const SOLVER_ENGINE_PROTOCOL = 2 as const;
export const SOLVER_ENGINE_SIDECAR = "solver-engine";

export type IpcFrameKind = "request" | "reply" | "progress";

export interface IpcEnvelope {
  v: number;
  kind: IpcFrameKind;
  request_id: string;
  job_id?: string | null;
  op: string;
  ok?: boolean;
  error_code?: string | null;
  error_message?: string | null;
  body?: unknown;
}

export function encodeIpcFrame(envelope: IpcEnvelope): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(envelope));
  const out = new Uint8Array(4 + json.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, json.length, true);
  out.set(json, 4);
  return out;
}

/** Decode one length-prefixed frame from a buffer; returns null if incomplete. */
export function tryDecodeIpcFrame(
  buffer: Uint8Array,
): { envelope: IpcEnvelope; bytesConsumed: number } | null {
  if (buffer.length < 4) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const len = view.getUint32(0, true);
  if (buffer.length < 4 + len) return null;
  const json = new TextDecoder().decode(buffer.subarray(4, 4 + len));
  const envelope = JSON.parse(json) as IpcEnvelope;
  if (envelope.v !== SOLVER_ENGINE_PROTOCOL) {
    throw new Error(`unsupported solver-engine protocol ${envelope.v}`);
  }
  return { envelope, bytesConsumed: 4 + len };
}

export function makeRequest(
  requestId: string,
  op: string,
  body: unknown = null,
  jobId?: string | null,
): IpcEnvelope {
  return {
    v: SOLVER_ENGINE_PROTOCOL,
    kind: "request",
    request_id: requestId,
    job_id: jobId ?? null,
    op,
    body,
  };
}
