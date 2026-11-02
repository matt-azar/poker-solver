import {
  comboCount,
  parseExactRange,
  weightsFromExact,
} from "../range";

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

function formatTokenErrors(
  side: "oop" | "ip",
  errors: { token: string; message: string }[],
): string {
  const sample = errors
    .slice(0, 3)
    .map((e) => `"${e.token}" (${e.message})`)
    .join("; ");
  return `generatedRanges.${side} has invalid token(s): ${sample}`;
}

/**
 * Guard model- or interpolation-produced weighted range strings before apply.
 * Full-token parse — garbage tokens like THISISGARBAGE are rejected even when
 * a neighbouring AA token would otherwise parse. Does not claim strategic quality.
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
  const oopParsed = parseExactRange(oop);
  if (oopParsed.errors.length > 0) {
    return { ok: false, error: formatTokenErrors("oop", oopParsed.errors) };
  }
  const ipParsed = parseExactRange(ip);
  if (ipParsed.errors.length > 0) {
    return { ok: false, error: formatTokenErrors("ip", ipParsed.errors) };
  }
  const oopCombos = comboCount(weightsFromExact(oopParsed.range), "");
  const ipCombos = comboCount(weightsFromExact(ipParsed.range), "");
  if (oopCombos < GENERATED_RANGE_MIN_COMBOS || ipCombos < GENERATED_RANGE_MIN_COMBOS) {
    return {
      ok: false,
      error: "generated ranges parse to an empty (or near-empty) weight grid",
    };
  }
  const note = typeof src.note === "string" ? src.note.trim() : undefined;
  return { ok: true, oop, ip, note: note || undefined, oopCombos, ipCombos };
}
