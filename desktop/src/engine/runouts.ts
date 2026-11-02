/**
 * Normalize explorer `/runouts` JSON into a typed UI model.
 *
 * Engine shape (json_runout_values): `{ cards: [{ card, child_id, probability,
 * probability_defined, oop_ev, ip_ev, ev_defined }], units, utility_basis, ... }`.
 * The analysis table consumes camelCase rows + undefined flags.
 */

export interface RunoutCardModel {
  card: string;
  childId: string;
  probability: number | null;
  probabilityDefined: boolean;
  oopEv: number | null;
  ipEv: number | null;
  evDefined: boolean;
}

export interface RunoutsModel {
  pending: boolean;
  rows: RunoutCardModel[];
  units: string;
  utilityBasis: string;
  parentEvDefined: boolean;
  parentOopEv: number | null;
  parentIpEv: number | null;
  nodeId: string;
  solutionId?: string;
  jobId?: string;
  statusGeneration?: number;
  querySeconds?: number | null;
  kind?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeCard(raw: unknown): RunoutCardModel | null {
  const row = asRecord(raw);
  if (!row) {
    return null;
  }
  const card = asString(row.card);
  const childId = asString(row.child_id);
  if (!card && !childId) {
    return null;
  }
  const probabilityDefined = asBool(row.probability_defined, false);
  const evDefined = asBool(row.ev_defined, false);
  return {
    card,
    childId,
    probabilityDefined,
    probability: probabilityDefined ? asOptionalNumber(row.probability) : null,
    evDefined,
    oopEv: evDefined ? asOptionalNumber(row.oop_ev) : null,
    ipEv: evDefined ? asOptionalNumber(row.ip_ev) : null,
  };
}

/** Map a raw engine `/runouts` body (or pending placeholder) into RunoutsModel. */
export function normalizeRunoutsPayload(raw: unknown): RunoutsModel {
  const body = asRecord(raw) ?? {};
  const pending = asBool(body.pending, false);
  const cards = Array.isArray(body.cards) ? body.cards : [];
  const rows: RunoutCardModel[] = [];
  for (const entry of cards) {
    const card = normalizeCard(entry);
    if (card) {
      rows.push(card);
    }
  }
  const parentEvDefined = asBool(body.parent_ev_defined, false);
  return {
    pending,
    rows,
    units: asString(body.units),
    utilityBasis: asString(body.utility_basis),
    parentEvDefined,
    parentOopEv: parentEvDefined ? asOptionalNumber(body.parent_oop_ev) : null,
    parentIpEv: parentEvDefined ? asOptionalNumber(body.parent_ip_ev) : null,
    nodeId: asString(body.node_id),
    solutionId: typeof body.solution_id === "string" ? body.solution_id : undefined,
    jobId: typeof body.job_id === "string" ? body.job_id : undefined,
    statusGeneration:
      typeof body.status_generation === "number" ? body.status_generation : undefined,
    querySeconds: asOptionalNumber(body.query_seconds),
    kind: typeof body.kind === "string" ? body.kind : undefined,
  };
}
