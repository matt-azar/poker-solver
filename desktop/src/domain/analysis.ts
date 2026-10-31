/** Normalize equity histogram bucket weights to fractions of total mass. */
export function normalizeBucketWeights(
  buckets: Array<{ lo: number; hi: number; weight: number }> | null | undefined,
): Array<{ lo: number; hi: number; weight: number; fraction: number }> {
  if (!buckets?.length) {
    return [];
  }
  const total = buckets.reduce((sum, bucket) => sum + Math.max(0, Number(bucket.weight) || 0), 0);
  return buckets.map((bucket) => {
    const weight = Math.max(0, Number(bucket.weight) || 0);
    return {
      lo: Number(bucket.lo),
      hi: Number(bucket.hi),
      weight,
      fraction: total > 0 ? weight / total : 0,
    };
  });
}

export interface CategorySeatView {
  defined: boolean;
  totalMass: number | null;
  rows: Array<{ name: string; fraction: number; mass: number | null }>;
}

/** Map explorer categories payload (parallel arrays or legacy record) to rows. */
export function categorySeatView(
  names: string[] | null | undefined,
  seat:
    | {
        defined?: boolean;
        total_mass?: number | null;
        fractions?: number[] | Record<string, number> | null;
        mass?: number[] | null;
      }
    | null
    | undefined,
): CategorySeatView {
  if (!seat) {
    return { defined: false, totalMass: null, rows: [] };
  }
  const defined = seat.defined !== false;
  const totalMass =
    seat.total_mass == null || Number.isNaN(Number(seat.total_mass))
      ? null
      : Number(seat.total_mass);

  const fractionList = seat.fractions;
  if (Array.isArray(fractionList)) {
    const masses = Array.isArray(seat.mass) ? seat.mass : null;
    const list = names?.length ? names : fractionList.map((_, index) => `cat ${index}`);
    return {
      defined,
      totalMass,
      rows: list.map((name, index) => ({
        name,
        fraction: Number(fractionList[index] ?? 0) || 0,
        mass: masses ? Number(masses[index] ?? 0) || 0 : null,
      })),
    };
  }

  if (seat.fractions && typeof seat.fractions === "object") {
    return {
      defined,
      totalMass,
      rows: Object.entries(seat.fractions).map(([name, fraction]) => ({
        name,
        fraction: Number(fraction) || 0,
        mass: null,
      })),
    };
  }

  return { defined, totalMass, rows: [] };
}
