import type { StatusPayload } from "../../domain/types";
import {
  isJsonObject,
  optionalFiniteNumber,
  optionalString,
  optionalStringOrNull,
  requireBoolean,
  requireNumber,
} from "./policy";

/**
 * Decode solver-engine status JSON (also the body of a successful open).
 * Required flags + status_generation are validated; Zig-era progress fields
 * (phase / iterations / iterations_requested) are type-checked when present
 * so Study UI progress stays honest (ZR-120 / ZR-125).
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
  // Host always emits these on solver-engine; keep additive for older fixtures.
  optionalString(data, "phase");
  optionalFiniteNumber(data, "iterations");
  optionalFiniteNumber(data, "iterations_requested");
  optionalFiniteNumber(data, "policy_revision");
  if ("has_training" in data) {
    requireBoolean(data, "has_training");
  }
  if ("can_continue" in data) {
    requireBoolean(data, "can_continue");
  }
  // Overlapping Session.canContinue invariant (ZR-149): Continue needs trainer.
  if ("can_continue" in data && "has_training" in data) {
    const can_continue = Boolean(data.can_continue);
    const has_training = Boolean(data.has_training);
    if (can_continue && !has_training) {
      throw new Error("contract: can_continue requires has_training");
    }
  }
  if ("failed" in data) {
    requireBoolean(data, "failed");
  }
  // ZR-130: sticky async-train fault code (null when clear).
  if ("last_error" in data) {
    optionalStringOrNull(data, "last_error");
  }
  // ZR-142 budget fields when present: peak covers live.
  const memory_budget_bytes = optionalFiniteNumber(data, "memory_budget_bytes");
  const allocated_bytes = optionalFiniteNumber(data, "allocated_bytes");
  const peak_allocated_bytes = optionalFiniteNumber(data, "peak_allocated_bytes");
  if (
    allocated_bytes != null &&
    peak_allocated_bytes != null &&
    peak_allocated_bytes < allocated_bytes
  ) {
    throw new Error("contract: peak_allocated_bytes must be >= allocated_bytes");
  }
  if (memory_budget_bytes != null && memory_budget_bytes < 0) {
    throw new Error("contract: memory_budget_bytes must be >= 0");
  }
  return {
    ...data,
    running,
    paused,
    cancelled,
    status_generation,
  };
}
