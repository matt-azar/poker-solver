/**
 * HTTP JSON compatibility policy for Study ↔ explorer.
 *
 * - Required fields: must be present with the declared JSON type; missing or
 *   wrong type fails decode (do not coerce).
 * - Additive fields: unknown keys are ignored by decoders and may remain on
 *   the payload for forward compatibility.
 * - Errors: unsuccessful HTTP bodies use `{ "error": string }`; other shapes
 *   fall back to statusText in EngineClient.
 * - Semantics not changed by this layer: omit vs [] vs explicit-empty size
 *   lists, chip vs pot-fraction units, root vs local EV, action order, null
 *   metrics when unset.
 */

export const EXPLORER_READY_PROTOCOL = 1 as const;

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireBoolean(obj: JsonObject, key: string): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") {
    throw new Error(`contract: ${key} must be boolean`);
  }
  return value;
}

export function requireNumber(obj: JsonObject, key: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`contract: ${key} must be a finite number`);
  }
  return value;
}

export function requireString(obj: JsonObject, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new Error(`contract: ${key} must be string`);
  }
  return value;
}

export function optionalStringOrNull(obj: JsonObject, key: string): string | null | undefined {
  if (!(key in obj)) {
    return undefined;
  }
  const value = obj[key];
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`contract: ${key} must be string or null`);
}
