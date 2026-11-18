import { create } from "zustand";

/**
 * Live matrix highlight while an analysis dock filter is active
 * (Value / Bluffs, Range equity bands, or Categories).
 * `null` = inactive (no dimming). A Set (possibly empty) = dim cells whose
 * hand-class label is not in the set.
 */
export type AnalysisHighlightSource =
  | "value-bluffs"
  | "equity-bands"
  | "categories"
  | null;

interface ValueBluffsHighlightState {
  /** Matrix cell texts (AA, AKs, …) matching the active filter. */
  highlightCells: ReadonlySet<string> | null;
  source: AnalysisHighlightSource;
  /** Short label for the visible matrix reset chip. */
  label: string | null;
  setHighlightCells: (
    cells: ReadonlySet<string> | null,
    meta?: { source?: AnalysisHighlightSource; label?: string | null },
  ) => void;
  clearHighlight: () => void;
}

export const useValueBluffsHighlightStore = create<ValueBluffsHighlightState>(
  (set) => ({
    highlightCells: null,
    source: null,
    label: null,
    setHighlightCells(cells, meta) {
      set({
        highlightCells: cells,
        source: cells == null ? null : (meta?.source ?? null),
        label: cells == null ? null : (meta?.label ?? null),
      });
    },
    clearHighlight() {
      set({ highlightCells: null, source: null, label: null });
    },
  }),
);
