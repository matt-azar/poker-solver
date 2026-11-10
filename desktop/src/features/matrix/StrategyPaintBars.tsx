/**
 * Shared flex strategy bars (passive → left, width ∝ frequency).
 *
 * Matrix cells, Hands tiles, Node Locking cells, and the Actions mix strip
 * all render through this component so bar styling cannot diverge.
 */
import type { CSSProperties } from "react";
import type { StrategyPaintSegment } from "../../domain/strategyPaint";

export type StrategyPaintBarsProps = {
  segments: readonly StrategyPaintSegment[];
  /** Container class (defaults to shared `.strategy-paint`). */
  className?: string;
  /** Per-segment class (defaults to shared `.strategy-paint__seg`). */
  segClassName?: string;
  /** Optional aria / role for non-decorative bars (e.g. Actions mix). */
  role?: string;
  "aria-label"?: string;
  "aria-hidden"?: boolean | "true" | "false";
};

/** Horizontal frequency bars: flexGrow = segment.weight, background = color. */
export function StrategyPaintBars({
  segments,
  className = "strategy-paint",
  segClassName = "strategy-paint__seg",
  role,
  "aria-label": ariaLabel,
  "aria-hidden": ariaHidden,
}: StrategyPaintBarsProps) {
  if (segments.length === 0) {
    return null;
  }
  return (
    <div
      className={className}
      role={role}
      aria-label={ariaLabel}
      aria-hidden={ariaHidden}
    >
      {segments.map((seg) => {
        const style: CSSProperties = {
          flexGrow: seg.weight,
          flexBasis: 0,
          background: seg.color,
        };
        const title =
          seg.label.length > 0
            ? `${seg.label} · ${(seg.weight * 100).toFixed(0)}%`
            : undefined;
        return (
          <span
            key={`paint-${seg.index}`}
            className={segClassName}
            style={style}
            title={title}
          />
        );
      })}
    </div>
  );
}
