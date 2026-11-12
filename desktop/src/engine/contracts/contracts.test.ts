import { describe, expect, it } from "vitest";
import statusColdFixture from "../fixtures/status-cold.json";
import statusSolvedFixture from "../fixtures/status-solved.json";
import { decodeErrorPayload } from "./error";
import { decodeStatusPayload } from "./status";

describe("decodeStatusPayload", () => {
  it("accepts cold and solved fixtures and keeps additive fields", () => {
    const cold = decodeStatusPayload(statusColdFixture);
    expect(cold.running).toBe(false);
    expect(cold.status_generation).toBe(0);
    expect(cold.solution_id).toBeNull();

    const solved = decodeStatusPayload(statusSolvedFixture);
    expect(solved.solution_id).toBe("s1");
    expect(solved.player0_expected_utility).toBe(50);
    expect(solved.future_additive_field).toBe("ignored");
  });

  it("rejects missing required flags", () => {
    expect(() =>
      decodeStatusPayload({
        paused: false,
        cancelled: false,
        status_generation: 0,
      }),
    ).toThrow(/running/);
  });
});

describe("decodeErrorPayload", () => {
  it("reads string error bodies", () => {
    expect(decodeErrorPayload({ error: "missing path" })).toBe("missing path");
    expect(decodeErrorPayload({ ok: false })).toBeNull();
  });
});
