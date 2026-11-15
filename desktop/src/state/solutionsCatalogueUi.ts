/** Ephemeral UI flag for the in-app solutions catalogue modal. */
import { create } from "zustand";

export type SolutionsCatalogueMode = "save" | "open";

interface SolutionsCatalogueUiState {
  mode: SolutionsCatalogueMode | null;
  openCatalogue: (mode: SolutionsCatalogueMode) => void;
  closeCatalogue: () => void;
}

export const useSolutionsCatalogueUi = create<SolutionsCatalogueUiState>((set) => ({
  mode: null,
  openCatalogue(mode) {
    set({ mode });
  },
  closeCatalogue() {
    set({ mode: null });
  },
}));
