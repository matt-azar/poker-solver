/** Simple incrementing revision helpers for request/draft stale-response protection. */

export function initialRevision(start = 0): number {
  return start;
}

export function bumpRevision(current: number): number {
  return current + 1;
}

export function nextRevision(current: number): number {
  return bumpRevision(current);
}

export function revisionsEqual(expected: number, actual: number): boolean {
  return expected === actual;
}

export function assertRevision(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new Error(
      `Stale setup revision: expected ${expected}, got ${actual}`,
    );
  }
}

export function isStaleProposal(
  proposalRevision: number,
  currentRevision: number,
): boolean {
  return proposalRevision !== currentRevision;
}
