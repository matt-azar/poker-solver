/** Stable colors keyed by canonical action identity, not array position. */

const FOLD = "#5B7FA8";
const CHECK_CALL = "#3F8F6B";
const BET_RAISE = ["#C9843F", "#C45C3A", "#B33A32", "#8E1F28", "#6B1420"];
const ALL_IN = "#5A0F18";

export interface ActionColorMap {
  byIndex: string[];
  byLabel: Record<string, string>;
  legend: Array<{ label: string; color: string }>;
}

function normalizeLabel(label: string): string {
  return label.trim();
}

function isAllIn(label: string): boolean {
  const lower = label.toLowerCase();
  return lower.includes("all-in") || lower.includes("allin") || /\ball\s*in\b/.test(lower);
}

function isFold(label: string): boolean {
  return label.toLowerCase().startsWith("fold");
}

/** Parse a rough size key so "Bet 50" and "Bet 50%" share an identity bucket. */
export function actionIdentity(label: string): string {
  const normalized = normalizeLabel(label);
  if (isAllIn(normalized)) {
    return "all-in";
  }
  if (isFold(normalized)) {
    return "fold";
  }
  const lower = normalized.toLowerCase();
  if (lower.startsWith("check")) {
    return "check";
  }
  if (lower.startsWith("call")) {
    return "call";
  }
  const match = normalized.match(/^(Bet|Raise)\s+(.+)$/i);
  if (match) {
    return `${match[1].toLowerCase()}:${match[2].replace(/\s+/g, "").toLowerCase()}`;
  }
  return lower;
}

function colorForIdentity(id: string, betRank: number): string {
  if (id === "all-in") {
    return ALL_IN;
  }
  if (id === "fold") {
    return FOLD;
  }
  if (id === "check" || id === "call") {
    return CHECK_CALL;
  }
  return BET_RAISE[Math.min(Math.max(betRank, 0), BET_RAISE.length - 1)];
}

export function mapActionColors(actions: string[]): ActionColorMap {
  const normalized = actions.map(normalizeLabel);
  const identities = normalized.map(actionIdentity);

  // Assign aggressive size colors by size magnitude (stable across array order).
  const aggressiveIds = [
    ...new Set(
      identities.filter(
        (id) => id !== "fold" && id !== "check" && id !== "call" && id !== "all-in",
      ),
    ),
  ].sort((left, right) => {
    const num = (id: string) => {
      const match = id.match(/:([\d.]+)/);
      return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
    };
    const delta = num(left) - num(right);
    return delta !== 0 ? delta : left.localeCompare(right);
  });
  const betRank = new Map(aggressiveIds.map((id, index) => [id, index]));

  const byLabel: Record<string, string> = {};
  const byIndex: string[] = [];
  const legend: Array<{ label: string; color: string }> = [];
  const seen = new Set<string>();

  normalized.forEach((label, index) => {
    const id = identities[index];
    const color = colorForIdentity(id, betRank.get(id) ?? 0);
    byLabel[label] = color;
    byIndex.push(color);
    if (!seen.has(id)) {
      seen.add(id);
      legend.push({ label, color });
    }
  });

  return { byIndex, byLabel, legend };
}

export function accessibleActionColors(actions: string[]): ActionColorMap {
  const alt = ["#1F6FEB", "#0F7B6C", "#B08900", "#C44B2B", "#8B3A9B", "#2B1A1A"];
  const mapped = mapActionColors(actions);
  const remapped: ActionColorMap = { byIndex: [], byLabel: {}, legend: [] };
  mapped.legend.forEach((entry, index) => {
    const color = isAllIn(entry.label) ? "#111111" : alt[index % alt.length];
    remapped.legend.push({ label: entry.label, color });
    remapped.byLabel[entry.label] = color;
  });
  remapped.byIndex = actions.map((label) => remapped.byLabel[normalizeLabel(label)]);
  return remapped;
}
