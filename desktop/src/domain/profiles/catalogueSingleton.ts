import { createRangeProfileCatalogue, type RangeProfileCatalogue } from "./catalogue";
import { loadBundledRangeProfiles } from "./bundledFixtures";

let catalogue: RangeProfileCatalogue | null = null;

function browserStorage(): Storage | undefined {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Shared catalogue: bundled synthetic fixtures + user imports from localStorage. */
export function getRangeProfileCatalogue(): RangeProfileCatalogue {
  if (!catalogue) {
    catalogue = createRangeProfileCatalogue(loadBundledRangeProfiles(), browserStorage());
  }
  return catalogue;
}

/** Test helper — reset singleton between cases. */
export function resetRangeProfileCatalogueForTests(): void {
  catalogue = null;
}
