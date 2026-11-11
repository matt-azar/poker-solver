import {
  EXPLORER_READY_PROTOCOL,
  isJsonObject,
  requireBoolean,
  requireNumber,
  requireString,
} from "./policy";

/** Versioned packaged-Study ownership handshake (`GET /api/ready`). */
export type ReadyPayload = {
  ok: boolean;
  protocol: number;
  port: number;
  max_pair_runouts: number;
  launch_id: string;
};

export function decodeReadyPayload(data: unknown): ReadyPayload {
  if (!isJsonObject(data)) {
    throw new Error("contract: /api/ready body must be a JSON object");
  }
  const ok = requireBoolean(data, "ok");
  const protocol = requireNumber(data, "protocol");
  if (protocol !== EXPLORER_READY_PROTOCOL) {
    throw new Error(
      `contract: /api/ready protocol ${protocol} incompatible (want ${EXPLORER_READY_PROTOCOL})`,
    );
  }
  return {
    ok,
    protocol,
    port: requireNumber(data, "port"),
    max_pair_runouts: requireNumber(data, "max_pair_runouts"),
    launch_id: requireString(data, "launch_id"),
  };
}
