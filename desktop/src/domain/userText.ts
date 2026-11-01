/**
 * Sentence-case user-facing text and spell the ICM acronym.
 * Copy that already contains an uppercase letter is left in place
 * except for the acronym replacement, so this is safe to apply twice.
 */
export function presentUserText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  let out = trimmed;
  if (!/[A-Z]/.test(out)) {
    out = out.charAt(0).toUpperCase() + out.slice(1);
  }
  return out.replace(/\bicm\b/gi, "ICM");
}
