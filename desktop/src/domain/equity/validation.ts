import { parseCard, parseCardList, parseExactRange } from "../range";
import type { EquityScenarioDraft } from "./types";

export type EquityValidation = {
  ok: boolean;
  errors: string[];
  activePlayers: Array<{ id: string; label: string; rangeText: string }>;
  board: string[];
  deadCards: string[];
};

function normalizeCardTokens(rawCards: string[]): string[] {
  // Draft may store either already-split cards or a single concatenated token.
  if (rawCards.length === 1 && rawCards[0] && rawCards[0].length > 2) {
    return parseCardList(rawCards[0]);
  }
  return rawCards.flatMap((raw) => {
    const single = parseCard(raw);
    if (single) {
      return [single];
    }
    return parseCardList(raw);
  });
}

export function validateEquityDraft(draft: EquityScenarioDraft): EquityValidation {
  const errors: string[] = [];
  const activePlayers = draft.players.filter((player) => player.enabled);
  if (activePlayers.length < 2) {
    errors.push("At least two active players are required.");
  }
  if (activePlayers.length > 6) {
    errors.push("At most six active players are supported.");
  }

  const board: string[] = [];
  const seen = new Set<string>();
  for (const card of normalizeCardTokens(draft.board)) {
    if (!parseCard(card)) {
      errors.push(`Invalid board card: ${card}`);
      continue;
    }
    if (seen.has(card)) {
      errors.push(`Duplicate card: ${card}`);
      continue;
    }
    seen.add(card);
    board.push(card);
  }
  if (!(board.length === 0 || board.length === 3 || board.length === 4 || board.length === 5)) {
    errors.push("Board must be empty (preflop) or a complete flop/turn/river (3–5 cards).");
  }

  const deadCards: string[] = [];
  for (const card of normalizeCardTokens(draft.deadCards)) {
    if (!parseCard(card)) {
      errors.push(`Invalid dead card: ${card}`);
      continue;
    }
    if (seen.has(card)) {
      errors.push(`Dead card conflicts with board or another dead card: ${card}`);
      continue;
    }
    seen.add(card);
    deadCards.push(card);
  }

  const configured: Array<{ id: string; label: string; rangeText: string }> = [];
  for (const player of activePlayers) {
    const text = player.rangeText.trim();
    if (!text) {
      errors.push(`${player.label || player.id}: range is empty (empty is not random).`);
      continue;
    }
    const parsed = parseExactRange(text);
    if (parsed.errors.length) {
      errors.push(
        `${player.label || player.id}: ${parsed.errors.map((error) => error.message).join("; ")}`,
      );
      continue;
    }
    if (parsed.range.size === 0) {
      errors.push(`${player.label || player.id}: range has no positive-weight combos.`);
      continue;
    }
    configured.push({
      id: player.id,
      label: player.label || player.id,
      rangeText: text,
    });
  }

  if (configured.length < 2 && errors.length === 0) {
    errors.push("At least two valid active ranges are required.");
  }

  return {
    ok: errors.length === 0 && configured.length >= 2,
    errors,
    activePlayers: configured,
    board,
    deadCards,
  };
}

export function formatEquityPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return `${(value * 100).toFixed(2)}%`;
}
