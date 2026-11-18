/** Display helpers for compare workspace values. */

export function formatChipEv(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) {
    return "—";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(4)}`;
}

export function formatNashGap(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) {
    return "—";
  }
  return value.toFixed(4);
}

export function formatProb(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "—";
  }
  return `${(value * 100).toFixed(1)}%`;
}

export function formatDelta(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "—";
  }
  const pct = value * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}pp`;
}

/** Max |Δ| across action columns for a hand row (missing slots ignored). */
export function maxAbsDelta(delta: number[] | undefined): number {
  if (!delta || delta.length === 0) {
    return 0;
  }
  let max = 0;
  for (const value of delta) {
    if (!Number.isFinite(value)) {
      continue;
    }
    const abs = Math.abs(value);
    if (abs > max) {
      max = abs;
    }
  }
  return max;
}

export function shortId(id: string | null | undefined): string {
  if (!id) {
    return "—";
  }
  return id;
}
