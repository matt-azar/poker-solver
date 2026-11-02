import { potTypeFromActions } from "../setup/derive";
import {
  blankGrid,
  emptyExactRange,
  parseExactRange,
  serializeExactRange,
  type ExactRange,
  type WeightGrid,
} from "../range";
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

/**
 * Linear blend of exact combo weights. Identity-preserving: blending a range
 * with itself (any t) keeps the same suit-specific combo keys and weights.
 */
export function blendExactRanges(
  left: ExactRange,
  right: ExactRange,
  t: number,
): ExactRange {
  const w = clamp01(t);
  if (w <= 1e-12) {
    return new Map(left);
  }
  if (w >= 1 - 1e-12) {
    return new Map(right);
  }
  const out = emptyExactRange();
  const keys = new Set<string>([...left.keys(), ...right.keys()]);
  for (const combo of keys) {
    const blended = (left.get(combo) ?? 0) * (1 - w) + (right.get(combo) ?? 0) * w;
    if (blended > 1e-9) {
      out.set(combo, Math.min(1, blended));
    }
  }
  return out;
}

/**
 * Blend range texts via exact combo maps (not the aggregate 169-grid).
 * Rejects either side when any token fails full-token parse.
 */
export function blendRangeTexts(left: string, right: string, t: number): string {
  const leftParsed = parseExactRange(left);
  const rightParsed = parseExactRange(right);
  if (leftParsed.errors.length > 0 || rightParsed.errors.length > 0) {
    const sample =
      leftParsed.errors[0]?.token ?? rightParsed.errors[0]?.token ?? "unknown";
    throw new Error(`interpolation range token invalid: ${sample}`);
  }
  return serializeExactRange(
    blendExactRanges(leftParsed.range, rightParsed.range, t),
  );
}

/**
 * Require matching strategic keys before blending. Warnings alone are not enough
 * for a meaningful study — mismatched seats/rake/pot/format become conflicts.
 */
export function assertCompatibleInterpolationRefs(
  low: RangeProfile,
  high: RangeProfile,
): void {
  const problems: string[] = [];
  if (
    low.positions.oop.toUpperCase() !== high.positions.oop.toUpperCase() ||
    low.positions.ip.toUpperCase() !== high.positions.ip.toUpperCase()
  ) {
    problems.push(
      `seats differ (${low.positions.oop}/${low.positions.ip} vs ${high.positions.oop}/${high.positions.ip})`,
    );
  }
  const potLow = potTypeFromActions(low.preflopActions);
  const potHigh = potTypeFromActions(high.preflopActions);
  if (potLow && potHigh && potLow !== potHigh) {
    problems.push(`pot type differs (${potLow} vs ${potHigh})`);
  }
  const stakesLow = normalizeRakeEnvironmentLabel(low.labels?.stakes);
  const stakesHigh = normalizeRakeEnvironmentLabel(high.labels?.stakes);
  if (stakesLow !== stakesHigh) {
    problems.push(
      `range-source rake/stakes differs (${low.labels?.stakes ?? "none"} vs ${high.labels?.stakes ?? "none"})`,
    );
  }
  if (low.format !== high.format) {
    problems.push(`format differs (${low.format} vs ${high.format})`);
  }
  if (problems.length > 0) {
    throw new Error(
      `Incompatible interpolation references: ${problems.join("; ")}. Choose matching seats, pot type, and range-source rake.`,
    );
  }
}

/**
 * Interpolate paired OOP/IP ranges between two profiles by starting-stack.
 * Requires compatible strategic keys; rejects unsupported extrapolation.
 * Exact combo weights are preserved (identity blend of identical ranges).
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

  assertCompatibleInterpolationRefs(a, b);

  let low = a;
  let high = b;
  if (a.startingStackBb > b.startingStackBb) {
    low = b;
    high = a;
  }

  const notes: string[] = [];
  let t = 0;
  if (high.startingStackBb === low.startingStackBb) {
    t = 0;
    notes.push("reference stacks are equal — using the low profile weights");
  } else {
    t = (target - low.startingStackBb) / (high.startingStackBb - low.startingStackBb);
    if (t < -1e-9 || t > 1 + 1e-9) {
      throw new Error(
        `Unsupported extrapolation: target ${target}bb is outside bracket [${low.startingStackBb}, ${high.startingStackBb}]bb`,
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
