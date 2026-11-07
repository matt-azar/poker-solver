import "../../styles/actions.css";

export interface ActionBlockProps {
  /** Compact pot tag (`b50`) or passive label — never a bare percent. */
  primary: string;
  /** Optional chips with units (`50.0 chips`). */
  secondary?: string | null;
  /** Strategy frequency in [0, 1]. Bar fill uses this; click target size does not. */
  frequency: number | null;
  /** Preformatted frequency text (`31.9%`), kept separate from `primary`. */
  frequencyText?: string | null;
  color: string;
  /** Filter highlight state. */
  active?: boolean;
  disabled?: boolean;
  title?: string;
  /** Filter toggle. Navigation lives in toolbar `ActionNavBar`. */
  onClick?: () => void;
  className?: string;
  "aria-label"?: string;
}

function clampFreq(frequency: number | null | undefined): number {
  if (frequency == null || !Number.isFinite(frequency)) {
    return 0;
  }
  return Math.min(1, Math.max(0, frequency));
}

/**
 * Stable-geometry action filter block: primary size tag, separate frequency,
 * optional chips, and an in-block frequency bar that never resizes the click target.
 */
export function ActionBlock({
  primary,
  secondary = null,
  frequency,
  frequencyText = null,
  color,
  active = false,
  disabled = false,
  title,
  onClick,
  className,
  "aria-label": ariaLabel,
}: ActionBlockProps) {
  const fill = clampFreq(frequency);

  return (
    <div
      className={["action-block", "action-block--filter", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      data-variant="filter"
      data-active={active ? "true" : "false"}
      data-disabled={disabled ? "true" : "false"}
      style={{ ["--action-color" as string]: color }}
    >
      <button
        type="button"
        className="action-block__main"
        aria-pressed={active}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={onClick}
      >
        <span className="action-block__swatch" aria-hidden />
        <span className="action-block__body">
          <span className="action-block__size">
            <span className="action-block__primary">{primary}</span>
            {secondary ? (
              <span className="action-block__chips tabular">{secondary}</span>
            ) : null}
          </span>
          {frequencyText ? (
            <span className="action-block__freq tabular">{frequencyText}</span>
          ) : null}
        </span>
        <span
          className="action-block__bar"
          aria-hidden
          style={{ ["--action-freq" as string]: String(fill) }}
        />
      </button>
    </div>
  );
}
