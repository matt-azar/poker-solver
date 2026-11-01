import { parseRangeProfile } from "./parse";
import type { RangeProfile } from "./types";
import fixture25 from "./fixtures/fixture-co-bb-srp-100bb-2.5x.json";
import fixture3x from "./fixtures/fixture-co-bb-srp-100bb-3x.json";

/** Bundled synthetic fixtures for demo/tests — not verified strategic data. */
export function loadBundledRangeProfiles(): RangeProfile[] {
  return [parseRangeProfile(fixture25), parseRangeProfile(fixture3x)];
}
