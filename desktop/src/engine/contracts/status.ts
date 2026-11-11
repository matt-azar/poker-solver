import type { StatusPayload } from "../../domain/types";
import {
  isJsonObject,
  optionalStringOrNull,
  requireBoolean,
  requireNumber,
} from "./policy";

/**
 * Decode explorer status JSON (also the body of a successful `POST /api/open`).
 * Required flags + status_generation are validated; remaining fields pass
 * through for additive forward compatibility.
 */
export function decodeStatusPayload(data: unknown): StatusPayload {
  if (!isJsonObject(data)) {
    throw new Error("contract: status body must be a JSON object");
  }
  const running = requireBoolean(data, "running");
  const paused = requireBoolean(data, "paused");
  const cancelled = requireBoolean(data, "cancelled");
  const status_generation = requireNumber(data, "status_generation");
  // solution_id / job_id / root_node_id may be null on a cold server.
  if ("solution_id" in data) {
    optionalStringOrNull(data, "solution_id");
  }
  if ("job_id" in data) {
    optionalStringOrNull(data, "job_id");
  }
  if ("root_node_id" in data) {
    optionalStringOrNull(data, "root_node_id");
  }
  return {
    ...data,
    running,
    paused,
    cancelled,
    status_generation,
  };
}
