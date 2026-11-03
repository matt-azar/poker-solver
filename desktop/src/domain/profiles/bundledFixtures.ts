import { parseRangeProfile } from "./parse";
import type { RangeProfile } from "./types";
// Canonical copies live under configs/range-profiles/ — do not reintroduce desktop duplicates.
import fixture25 from "../../../../configs/range-profiles/fixture-co-bb-srp-100bb-2.5x.json";
import fixture25Nl from "../../../../configs/range-profiles/fixture-co-bb-srp-100bb-2.5x-100nl.json";
import fixture3x from "../../../../configs/range-profiles/fixture-co-bb-srp-100bb-3x.json";
import fixtureBtnBb3bp from "../../../../configs/range-profiles/fixture-btn-bb-3bp-100bb-100nl.json";

/** Bundled synthetic fixtures for demo/tests — not verified strategic data. */
export function loadBundledRangeProfiles(): RangeProfile[] {
  return [
    parseRangeProfile(fixture25),
    parseRangeProfile(fixture25Nl),
    parseRangeProfile(fixture3x),
    parseRangeProfile(fixtureBtnBb3bp),
  ];
}
