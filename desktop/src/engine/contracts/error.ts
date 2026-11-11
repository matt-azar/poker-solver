import { isJsonObject, requireString } from "./policy";

/** Unsuccessful explorer JSON bodies use a string `error` field. */
export function decodeErrorPayload(data: unknown): string | null {
  if (!isJsonObject(data) || !("error" in data)) {
    return null;
  }
  try {
    return requireString(data, "error");
  } catch {
    return null;
  }
}
