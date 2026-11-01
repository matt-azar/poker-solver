import { potTypeFromActions } from "../setup/derive";
import { blankGrid, parseRangeText, rangeText, type WeightGrid } from "../range";
import { normalizeRakeEnvironmentLabel } from "./match";
import type { RangeProfile } from "./types";

export type InterpolationMethod = "linear_stack_blend";

export interface StackInterpolationInput {
  /** Lower (or equal) stack reference. */
  low: RangeProfile;
  /** Higher (or equal) stack reference. */
  high: RangeProfile;
  /** Target starting stack in bb. */
  targetStackBb: number;
  method?: InterpolationMethod;
}

export interface StackInterpolationResult {
  oopRange: string;
  ipRange: string;
  method: InterpolationMethod;
  t: number;
  lowId: string;
  highId: string;
  lowRevision: string | number;
  highRevision: string | number;
  lowStackBb: number;
  highStackBb: number;
  targetStackBb: number;
  notes: string[];
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** Linear blend of two weight grids. `t=0` → left, `t=1` → right. */
export function blendWeightGrids(
  left: WeightGrid,
  right: WeightGrid,
  t: number,
): WeightGrid {
  const w = clamp01(t);
  const out = blankGrid();
  for (let row = 0; row < 13; row++) {
    for (let col = 0; col < 13; col++) {
      const blended = left[row][col] * (1 - w) + right[row][col] * w;
      out[row][col] = blended <= 1e-9 ? 0 : Math.min(1, blended);
    }
  }
  return out;
}

export function blendRangeTexts(left: string, right: string, t: number): string {
  return rangeText(blendWeightGrids(parseRangeText(left), parseRangeText(right), t));
}

/**
 * Interpolate paired OOP/IP ranges between two profiles by starting-stack.
 * Callers must ensure strategic keys mostly agree (pot type, seats, rake);
 * this function only blends weights and records provenance fields.
 */
export function interpolateProfilesByStack(
  input: StackInterpolationInput,
): StackInterpolationResult {
  const method = input.method ?? "linear_stack_blend";
  const a = input.low;
  const b = input.high;
  const target = input.targetStackBb;
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error("targetStackBb must be a positive finite number");
  }

  let low = a;
  let high = b;
  if (a.startingStackBb > b.startingStackBb) {
    low = b;
    high = a;
  }

  const notes: string[] = [];
  if (low.positions.oop !== high.positions.oop || low.positions.ip !== high.positions.ip) {
    notes.push("reference seats differ — blend may be strategically inconsistent");
  }
  if ((low.labels?.stakes ?? "") !== (high.labels?.stakes ?? "")) {
    notes.push("reference rake/stakes labels differ");
  }

  let t = 0;
  if (high.startingStackBb === low.startingStackBb) {
    t = 0;
    notes.push("reference stacks are equal — using the low profile weights");
  } else {
    t = (target - low.startingStackBb) / (high.startingStackBb - low.startingStackBb);
    if (t < 0 || t > 1) {
      notes.push(
        `target ${target}bb is outside [${low.startingStackBb}, ${high.startingStackBb}] — clamping blend factor`,
      );
    }
    t = clamp01(t);
  }

  return {
    oopRange: blendRangeTexts(low.ranges.oop, high.ranges.oop, t),
    ipRange: blendRangeTexts(low.ranges.ip, high.ranges.ip, t),
    method,
    t,
    lowId: low.id,
    highId: high.id,
    lowRevision: low.dataRevision,
    highRevision: high.dataRevision,
    lowStackBb: low.startingStackBb,
    highStackBb: high.startingStackBb,
    targetStackBb: target,
    notes,
  };
}

/**
 * Among profiles sharing pot-type/seats/(optional rake), pick the closest
 * stack below and above the target for interpolation.
 */
export function pickStackBracket(
  catalogue: readonly RangeProfile[],
  args: {
    targetStackBb: number;
    positions: { oop: string; ip: string };
    potType?: "SRP" | "3BP" | "4BP";
    stakesLabel?: string;
  },
): { low: RangeProfile; high: RangeProfile } | null {
  const oop = args.positions.oop.trim().toUpperCase();
  const ip = args.positions.ip.trim().toUpperCase();
  const candidates = catalogue.filter((p) => {
    if (p.legacyPreset) return false;
    if (p.positions.oop.toUpperCase() !== oop) return false;
    if (p.positions.ip.toUpperCase() !== ip) return false;
    if (args.potType) {
      const got = potTypeFromActions(p.preflopActions);
      if (got !== args.potType) return false;
    }
    if (args.stakesLabel) {
      const want = normalizeRakeEnvironmentLabel(args.stakesLabel);
      const got = normalizeRakeEnvironmentLabel(p.labels?.stakes);
      if (want !== got) return false;
    }
    return true;
  });

  if (candidates.length < 2) {
    return null;
  }

  const sorted = [...candidates].sort((a, b) => a.startingStackBb - b.startingStackBb);
  let low: RangeProfile | undefined;
  let high: RangeProfile | undefined;
  for (const profile of sorted) {
    if (profile.startingStackBb <= args.targetStackBb) {
      low = profile;
    }
    if (profile.startingStackBb >= args.targetStackBb && !high) {
      high = profile;
    }
  }
  if (!low || !high) {
    return null;
  }
  return { low, high };
}
