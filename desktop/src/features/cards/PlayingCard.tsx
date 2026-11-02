import type { ButtonHTMLAttributes, ReactNode } from "react";
import { parseCardCode, suitSymbol } from "../../domain/cards";
import "../../styles/cards.css";

export type PlayingCardSize = "sm" | "md";
/** `stack` = rank over suit; `inline` = rank beside suit (picker proposal). */
export type PlayingCardLayout = "stack" | "inline";

export interface PlayingCardProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Card code like `Ah`, or null/undefined for an empty street slot. */
  card?: string | null;
  /** Empty-slot label when `card` is absent (e.g. "T" / "R"). */
  emptyLabel?: string;
  size?: PlayingCardSize;
  layout?: PlayingCardLayout;
  selected?: boolean;
  focused?: boolean;
  faded?: boolean;
  interactive?: boolean;
  /** Force suit for empty/placeholder styling. */
  suit?: string | null;
}

/**
 * Shared face for board tiles and next-card picker cells.
 * Suit color always accompanies a suit symbol (never color alone).
 */
export function PlayingCard({
  card,
  emptyLabel = "·",
  size = "sm",
  layout = "stack",
  selected = false,
  focused = false,
  faded = false,
  interactive = false,
  suit: suitProp = null,
  disabled,
  className,
  type = "button",
  ...rest
}: PlayingCardProps) {
  const parsed = card ? parseCardCode(card) : null;
  const suit = (parsed?.suit ?? suitProp ?? "").toLowerCase();
  const rank = parsed?.rank ?? null;
  const empty = !parsed;
  const symbol = suitSymbol(suit);
  const label = empty
    ? emptyLabel
    : `${rank}${symbol}`;

  const classes = ["playing-card", className].filter(Boolean).join(" ");

  const body: ReactNode = empty ? (
    <>
      <span className="playing-card__rank">{emptyLabel}</span>
      <span className="playing-card__suit" aria-hidden>
        {symbol || "·"}
      </span>
    </>
  ) : (
    <>
      <span className="playing-card__rank">{rank}</span>
      <span className="playing-card__suit" aria-hidden>
        {symbol}
      </span>
    </>
  );

  const dataAttrs = {
    "data-suit": suit || undefined,
    "data-size": size,
    "data-layout": layout,
    "data-empty": empty ? "true" : "false",
    "data-selected": selected ? "true" : "false",
    "data-focused": focused ? "true" : "false",
    "data-faded": faded ? "true" : "false",
  } as const;

  if (!interactive) {
    return (
      <span
        className={classes}
        {...dataAttrs}
        data-interactive="false"
        aria-label={label}
        {...(rest as object)}
      >
        {body}
      </span>
    );
  }

  return (
    <button
      type={type}
      className={classes}
      {...dataAttrs}
      data-interactive="true"
      disabled={disabled}
      aria-label={label}
      {...rest}
    >
      {body}
    </button>
  );
}
