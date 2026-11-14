/**
 * Versioned betting-tree documents for Build Save / Open.
 * Covers size lists, caps, and tree-edit lines — not board, ranges, or stop criteria.
 */
import type { SpotDraft } from "./types";

export const BETTING_TREE_FORMAT = "holdem-study-betting-tree" as const;
export const BETTING_TREE_VERSION = 1 as const;

const STRING_KEYS = [
  "oopBets",
  "ipBets",
  "oopRaises",
  "ipRaises",
  "oopFlop",
  "ipFlop",
  "oopTurn",
  "ipTurn",
  "oopRiver",
  "ipRiver",
  "oopFlopRaises",
  "ipFlopRaises",
  "oopTurnRaises",
  "ipTurnRaises",
  "oopRiverRaises",
  "ipRiverRaises",
  "oopDonk",
  "oopFlopDonk",
  "oopTurnDonk",
  "oopRiverDonk",
] as const;

const BOOLEAN_KEYS = [
  "donkFlop",
  "donkTurn",
  "donkRiver",
  "noThreeBet",
] as const;

const NUMBER_KEYS = [
  "mergeThresholdPct",
  "potCap",
  "allInThreshold",
  "maxRaises",
] as const;

export type BettingTreeStringKey = (typeof STRING_KEYS)[number];
export type BettingTreeBooleanKey = (typeof BOOLEAN_KEYS)[number];
export type BettingTreeNumberKey = (typeof NUMBER_KEYS)[number];

/** Full betting-tree snapshot written on Save. */
export type BettingTreeSnapshot = Pick<
  SpotDraft,
  | BettingTreeStringKey
  | BettingTreeBooleanKey
  | BettingTreeNumberKey
  | "treeEdits"
>;

/** Partial patch applied on Open (missing keys leave the live draft alone). */
export type BettingTreeDraftPatch = Partial<BettingTreeSnapshot>;

export interface BettingTreeDocument {
  format: typeof BETTING_TREE_FORMAT;
  version: typeof BETTING_TREE_VERSION;
  name?: string;
  tree: BettingTreeDraftPatch;
}

export type BettingTreeParseResult =
  | { ok: true; document: BettingTreeDocument; patch: BettingTreeDraftPatch }
  | { ok: false; error: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return isFiniteNumber(value) ? value : undefined;
}

function readTreeEdits(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((line) => String(line)).filter((line) => line.trim().length > 0);
}

/** Snapshot betting-tree fields from the live Build draft. */
export function bettingTreeFromDraft(
  draft: SpotDraft,
  options: { name?: string } = {},
): BettingTreeDocument {
  const tree: BettingTreeSnapshot = {
    oopBets: draft.oopBets,
    ipBets: draft.ipBets,
    oopRaises: draft.oopRaises,
    ipRaises: draft.ipRaises,
    oopFlop: draft.oopFlop,
    ipFlop: draft.ipFlop,
    oopTurn: draft.oopTurn,
    ipTurn: draft.ipTurn,
    oopRiver: draft.oopRiver,
    ipRiver: draft.ipRiver,
    oopFlopRaises: draft.oopFlopRaises,
    ipFlopRaises: draft.ipFlopRaises,
    oopTurnRaises: draft.oopTurnRaises,
    ipTurnRaises: draft.ipTurnRaises,
    oopRiverRaises: draft.oopRiverRaises,
    ipRiverRaises: draft.ipRiverRaises,
    oopDonk: draft.oopDonk,
    oopFlopDonk: draft.oopFlopDonk,
    oopTurnDonk: draft.oopTurnDonk,
    oopRiverDonk: draft.oopRiverDonk,
    donkFlop: draft.donkFlop,
    donkTurn: draft.donkTurn,
    donkRiver: draft.donkRiver,
    mergeThresholdPct: draft.mergeThresholdPct,
    potCap: draft.potCap,
    noThreeBet: draft.noThreeBet,
    allInThreshold: draft.allInThreshold,
    maxRaises: draft.maxRaises,
    treeEdits: [...draft.treeEdits],
  };
  const document: BettingTreeDocument = {
    format: BETTING_TREE_FORMAT,
    version: BETTING_TREE_VERSION,
    tree,
  };
  const name = options.name?.trim();
  if (name) {
    document.name = name;
  }
  return document;
}

/** Pretty-print a betting-tree document for download. */
export function serializeBettingTree(document: BettingTreeDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Parse a saved betting-tree JSON document into a draft patch.
 * Unknown keys are ignored; missing fields are left unset so callers can merge.
 */
export function parseBettingTree(text: string): BettingTreeParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "Betting tree file is not valid JSON." };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Betting tree file must be a JSON object." };
  }
  const root = raw as Record<string, unknown>;
  if (root.format !== BETTING_TREE_FORMAT) {
    return {
      ok: false,
      error: `Unsupported betting tree format (expected ${BETTING_TREE_FORMAT}).`,
    };
  }
  if (root.version !== BETTING_TREE_VERSION) {
    return {
      ok: false,
      error: `Unsupported betting tree version (expected ${BETTING_TREE_VERSION}).`,
    };
  }
  if (!root.tree || typeof root.tree !== "object" || Array.isArray(root.tree)) {
    return { ok: false, error: "Betting tree file is missing a tree object." };
  }

  const source = root.tree as Record<string, unknown>;
  const patch: BettingTreeDraftPatch = {};
  for (const key of STRING_KEYS) {
    const value = readString(source, key);
    if (value !== undefined) {
      patch[key] = value;
    }
  }
  for (const key of BOOLEAN_KEYS) {
    const value = readBoolean(source, key);
    if (value !== undefined) {
      patch[key] = value;
    }
  }
  for (const key of NUMBER_KEYS) {
    const value = readNumber(source, key);
    if (value !== undefined) {
      patch[key] = value;
    }
  }
  if ("treeEdits" in source) {
    const edits = readTreeEdits(source.treeEdits);
    if (edits === undefined) {
      return { ok: false, error: "treeEdits must be an array of strings." };
    }
    patch.treeEdits = edits;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "Betting tree file has no recognizable tree fields." };
  }

  const name =
    typeof root.name === "string" && root.name.trim() ? root.name.trim() : undefined;
  const document: BettingTreeDocument = {
    format: BETTING_TREE_FORMAT,
    version: BETTING_TREE_VERSION,
    tree: patch,
  };
  if (name) {
    document.name = name;
  }
  return { ok: true, document, patch };
}

/** Default download stem for Save. */
export function bettingTreeFileName(name?: string): string {
  const stem = (name?.trim() || "betting-tree")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "betting-tree";
  return `${stem}.json`;
}
