import { parseRangeText, comboCount } from "../range";

/** Soft caps so model-emitted ranges stay reviewable and parseable. */
export const GENERATED_RANGE_MAX_CHARS = 8000;
export const GENERATED_RANGE_MIN_COMBOS = 0.5;

export interface GeneratedRangesPayload {
  oop: string;
  ip: string;
  /** Optional model note — stored in summary, not as equilibrium claim. */
  note?: string;
}

export type GeneratedRangesValidation =
  | { ok: true; oop: string; ip: string; note?: string; oopCombos: number; ipCombos: number }
  | { ok: false; error: string };

/**
 * Guard model- or interpolation-produced weighted range strings before apply.
 * Does not claim strategic quality — only syntactic / size safety.
 */
export function validateGeneratedRanges(
  raw: unknown,
): GeneratedRangesValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "generatedRanges must be an object with oop and ip strings" };
  }
  const src = raw as Record<string, unknown>;
  if (typeof src.oop !== "string" || typeof src.ip !== "string") {
    return { ok: false, error: "generatedRanges.oop and .ip must be strings" };
  }
  const oop = src.oop.trim();
  const ip = src.ip.trim();
  if (!oop || !ip) {
    return { ok: false, error: "generatedRanges.oop and .ip must be non-empty" };
  }
  if (oop.length > GENERATED_RANGE_MAX_CHARS || ip.length > GENERATED_RANGE_MAX_CHARS) {
    return {
      ok: false,
      error: `generated range text exceeds ${GENERATED_RANGE_MAX_CHARS} characters`,
    };
  }
  let oopGrid;
  let ipGrid;
  try {
    oopGrid = parseRangeText(oop);
    ipGrid = parseRangeText(ip);
  } catch (err) {
    return {
      ok: false,
      error: `generated ranges failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const oopCombos = comboCount(oopGrid, "");
  const ipCombos = comboCount(ipGrid, "");
  if (oopCombos < GENERATED_RANGE_MIN_COMBOS || ipCombos < GENERATED_RANGE_MIN_COMBOS) {
    return {
      ok: false,
      error: "generated ranges parse to an empty (or near-empty) weight grid",
    };
  }
  const note = typeof src.note === "string" ? src.note.trim() : undefined;
  return { ok: true, oop, ip, note: note || undefined, oopCombos, ipCombos };
}
