import { create } from "zustand";

/**
 * Live matrix highlight while the Value / Bluffs dock tab is open.
 * `null` = inactive (no dimming). A Set (possibly empty) = dim cells whose
 * hand-class label is not in the set.
 */
interface ValueBluffsHighlightState {
  /** Matrix cell texts (AA, AKs, …) matching the active filter. */
  highlightCells: ReadonlySet<string> | null;
  setHighlightCells: (cells: ReadonlySet<string> | null) => void;
}

export const useValueBluffsHighlightStore = create<ValueBluffsHighlightState>(
  (set) => ({
    highlightCells: null,
    setHighlightCells(cells) {
      set({ highlightCells: cells });
    },
  }),
);
