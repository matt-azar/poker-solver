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

export interface EquityHandRow {
  combo: string;
  equity: number;
  weight: number;
}

export type HandShape = "pair" | "suited" | "offsuit";

/** Classify a combo label (AhAd, AhKh, AhKd, AA, AKs, AKo) into a shape bucket. */
export function handShape(combo: string): HandShape {
  const text = combo.trim();
  if (/^[2-9TJQKA]{2}$/i.test(text)) {
    return "pair";
  }
  if (/^[2-9TJQKA]{2}s$/i.test(text)) {
    return "suited";
  }
  if (/^[2-9TJQKA]{2}o$/i.test(text)) {
    return "offsuit";
  }
  // Explicit suits: AhAd → pair, AhKh → suited, AhKd → offsuit.
  const match = text.match(/^([2-9TJQKA])([cdhs])([2-9TJQKA])([cdhs])$/i);
  if (!match) {
    return "offsuit";
  }
  const rank0 = match[1]!.toUpperCase();
  const suit0 = match[2]!.toLowerCase();
  const rank1 = match[3]!.toUpperCase();
  const suit1 = match[4]!.toLowerCase();
  if (rank0 === rank1) {
    return "pair";
  }
  return suit0 === suit1 ? "suited" : "offsuit";
}

/** Keep hands whose check-down equity falls in any selected [lo, hi) band (last includes 1). */
export function filterHandsByEquityBands(
  hands: EquityHandRow[] | null | undefined,
  bands: Array<{ lo: number; hi: number }> | null | undefined,
): EquityHandRow[] {
  if (!hands?.length) {
    return [];
  }
  if (!bands?.length) {
    return hands.slice();
  }
  return hands.filter((hand) => {
    const equity = Number(hand.equity);
    if (!Number.isFinite(equity)) {
      return false;
    }
    return bands.some((band) => {
      const lo = Number(band.lo);
      const hi = Number(band.hi);
      if (!(equity >= lo)) {
        return false;
      }
      // Last bucket conventionally includes 1.0.
      if (hi >= 1 && equity <= 1) {
        return equity < hi || equity === 1;
      }
      return equity < hi;
    });
  });
}

export interface ShapeCompositionRow {
  name: HandShape;
  mass: number;
  fraction: number;
}

export interface FilteredEquityView {
  hands: EquityHandRow[];
  totalWeight: number;
  averageEquity: number | null;
  shapes: ShapeCompositionRow[];
  topHands: EquityHandRow[];
}

/** Summarize filtered check-down equity hands: mass, average, shape mix, top weights. */
export function filteredEquityComposition(
  hands: EquityHandRow[],
  topN = 12,
): FilteredEquityView {
  const totalWeight = hands.reduce((sum, hand) => sum + Math.max(0, Number(hand.weight) || 0), 0);
  let equityMass = 0;
  const shapeMass: Record<HandShape, number> = { pair: 0, suited: 0, offsuit: 0 };
  for (const hand of hands) {
    const weight = Math.max(0, Number(hand.weight) || 0);
    const equity = Number(hand.equity);
    if (weight > 0 && Number.isFinite(equity)) {
      equityMass += weight * equity;
      shapeMass[handShape(hand.combo)] += weight;
    }
  }
  const shapes: ShapeCompositionRow[] = (["pair", "suited", "offsuit"] as HandShape[]).map(
    (name) => ({
      name,
      mass: shapeMass[name],
      fraction: totalWeight > 0 ? shapeMass[name] / totalWeight : 0,
    }),
  );
  const topHands = [...hands]
    .sort((left, right) => Number(right.weight) - Number(left.weight))
    .slice(0, topN);
  return {
    hands,
    totalWeight,
    averageEquity: totalWeight > 0 ? equityMass / totalWeight : null,
    shapes,
    topHands,
  };
}

export interface LibraryRangeEntry {
  id: string;
  name: string;
  folder?: string;
}

/** Group range presets by folder for nested library display. */
export function groupRangesByFolder(
  ranges: LibraryRangeEntry[],
): Array<{ folder: string; label: string; entries: LibraryRangeEntry[] }> {
  const map = new Map<string, LibraryRangeEntry[]>();
  for (const entry of ranges) {
    const folder = (
      entry.folder ??
      (entry.id.includes("/") ? entry.id.slice(0, entry.id.lastIndexOf("/")) : "")
    ).trim();
    const key = folder;
    const list = map.get(key) ?? [];
    list.push(entry);
    map.set(key, list);
  }
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([folder, entries]) => ({
      folder,
      label: folder || "Root",
      entries: [...entries].sort((a, b) => a.id.localeCompare(b.id)),
    }));
}
