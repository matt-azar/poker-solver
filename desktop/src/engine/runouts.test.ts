import { describe, expect, it } from "vitest";
import { EngineClient } from "./client";
import { normalizeRunoutsPayload } from "./runouts";

/** Fixture shaped like explorer json_runout_values. */
const ENGINE_RUNOUTS_FIXTURE = {
  pending: false,
  kind: "runout",
  solution_id: "s1",
  job_id: "j1",
  node_id: "n:root/c",
  status_generation: 3,
  units: "chips",
  utility_basis: "root_centered",
  parent_ev_defined: true,
  parent_oop_ev: 1.25,
  parent_ip_ev: -1.25,
  cards: [
    {
      card: "As",
      child_id: "n:root/c/As",
      probability_defined: true,
      probability: 0.020408163,
      ev_defined: true,
      oop_ev: 2.5,
      ip_ev: -2.5,
    },
    {
      card: "Kh",
      child_id: "n:root/c/Kh",
      probability_defined: false,
      probability: null,
      ev_defined: false,
      oop_ev: null,
      ip_ev: null,
    },
    {
      card: "2c",
      child_id: "n:root/c/2c",
      probability_defined: true,
      probability: 0.020408163,
      ev_defined: true,
      oop_ev: 0.1,
      ip_ev: -0.1,
    },
  ],
  query_seconds: 0.012,
};

describe("normalizeRunoutsPayload", () => {
  it("maps engine cards[] into UI rows preserving count and child_id", () => {
    const model = normalizeRunoutsPayload(ENGINE_RUNOUTS_FIXTURE);
    expect(model.pending).toBe(false);
    expect(model.rows).toHaveLength(3);
    expect(model.rows.map((row) => row.childId)).toEqual([
      "n:root/c/As",
      "n:root/c/Kh",
      "n:root/c/2c",
    ]);
    expect(model.rows.map((row) => row.card)).toEqual(["As", "Kh", "2c"]);
    expect(model.units).toBe("chips");
    expect(model.utilityBasis).toBe("root_centered");
    expect(model.nodeId).toBe("n:root/c");
  });

  it("honors undefined probability/EV flags", () => {
    const model = normalizeRunoutsPayload(ENGINE_RUNOUTS_FIXTURE);
    const defined = model.rows[0]!;
    expect(defined.probabilityDefined).toBe(true);
    expect(defined.probability).toBeCloseTo(0.020408163, 9);
    expect(defined.evDefined).toBe(true);
    expect(defined.oopEv).toBe(2.5);

    const undefinedRow = model.rows[1]!;
    expect(undefinedRow.probabilityDefined).toBe(false);
    expect(undefinedRow.probability).toBeNull();
    expect(undefinedRow.evDefined).toBe(false);
    expect(undefinedRow.oopEv).toBeNull();
    expect(undefinedRow.ipEv).toBeNull();
  });

  it("keeps pending payloads pollable with empty rows", () => {
    const model = normalizeRunoutsPayload({
      pending: true,
      solution_id: "s1",
      job_id: "j1",
      node_id: "n:root/c",
      status_generation: 1,
    });
    expect(model.pending).toBe(true);
    expect(model.rows).toEqual([]);
    expect(model.nodeId).toBe("n:root/c");
  });

  it("does not invent rows from a legacy runouts[] key", () => {
    const model = normalizeRunoutsPayload({
      pending: false,
      runouts: [{ card: "As", node_id: "legacy", weight: 1 }],
    });
    expect(model.rows).toEqual([]);
  });
});

describe("EngineClient.getRunouts", () => {
  it("returns the normalized UI model from a real engine-shaped body", async () => {
    const client = new EngineClient({
      baseUrl: "http://engine.test",
      fetchImpl: async () =>
        new Response(JSON.stringify(ENGINE_RUNOUTS_FIXTURE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const model = await client.getRunouts("s1", "n:root/c");
    expect(model.rows).toHaveLength(3);
    expect(model.rows[0]?.childId).toBe("n:root/c/As");
    expect(model.units).toBe("chips");
    expect(model.utilityBasis).toBe("root_centered");
  });
});
