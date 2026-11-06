/** Resolve a child node id from a decision node's `children` entry. */
export function childIdAt(
  children: unknown[] | undefined,
  index: number,
): string | null {
  if (!children) {
    return null;
  }
  const child = children[index];
  if (!child) {
    return null;
  }
  if (typeof child === "string") {
    return child;
  }
  if (
    typeof child === "object" &&
    child !== null &&
    "node_id" in child &&
    typeof (child as { node_id?: unknown }).node_id === "string" &&
    (child as { node_id: string }).node_id
  ) {
    return (child as { node_id: string }).node_id;
  }
  return null;
}
