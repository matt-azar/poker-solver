import { describe, expect, it } from "vitest";
import readyFixture from "../fixtures/ready.json";
import statusColdFixture from "../fixtures/status-cold.json";
import statusSolvedFixture from "../fixtures/status-solved.json";
import { decodeErrorPayload } from "./error";
import { EXPLORER_READY_PROTOCOL } from "./policy";
import { decodeReadyPayload } from "./ready";
import { decodeStatusPayload } from "./status";

describe("decodeReadyPayload", () => {
  it("accepts the pinned ready fixture", () => {
    const ready = decodeReadyPayload(readyFixture);
    expect(ready.ok).toBe(true);
    expect(ready.protocol).toBe(EXPLORER_READY_PROTOCOL);
    expect(ready.port).toBe(35931);
    expect(ready.launch_id).toBe("contract-1");
  });

  it("rejects missing protocol and wrong types", () => {
    expect(() => decodeReadyPayload({ ok: true, port: 1 })).toThrow(/protocol/);
    expect(() =>
      decodeReadyPayload({
        ok: true,
        protocol: 2,
        port: 1,
        max_pair_runouts: 1,
        launch_id: "x",
      }),
    ).toThrow(/incompatible/);
    expect(() => decodeReadyPayload(null)).toThrow(/object/);
  });
});

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
