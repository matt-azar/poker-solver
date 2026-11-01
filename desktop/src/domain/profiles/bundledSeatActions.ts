import { seatActionFromTextFile } from "./seatActionParse";
import type { SeatActionRange } from "./seatActionTypes";

/**
 * Eager raw imports of user-provided seat×action packs (Ranges.zip).
 * Keep filenames stable — parser maps them to catalogue ids.
 */
const rawModules = import.meta.glob("./packs/seat-action/*.txt", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/** Load all bundled seat×action atoms from the Drive Ranges.zip pack. */
export function loadBundledSeatActions(): SeatActionRange[] {
  const out: SeatActionRange[] = [];
  const seen = new Set<string>();
  for (const [path, text] of Object.entries(rawModules)) {
    const filename = path.split("/").pop() ?? path;
    try {
      const atom = seatActionFromTextFile(
        filename,
        String(text),
        `configs/range-profiles/packs/seat-action/${filename}`,
      );
      if (seen.has(atom.id)) {
        // Collision: keep first, suffix the duplicate id.
        atom.id = `${atom.id}-dup-${seen.size}`;
      }
      seen.add(atom.id);
      out.push(atom);
    } catch (err) {
      console.warn(`[seat-action] skip ${filename}:`, err);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
