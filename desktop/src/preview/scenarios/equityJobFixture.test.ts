import { describe, expect, it } from "vitest";
import {
  assertExpectedEquitySubmission,
  createEquityJobFixtureSession,
  EXPECTED_EQUITY_SUBMISSION,
} from "./equityJobFixture";

const validStart = {
  version: 1,
  client_revision: "r-test",
  method: EXPECTED_EQUITY_SUBMISSION.method,
  target_samples: 1000,
  seed: 1,
  board: [...EXPECTED_EQUITY_SUBMISSION.board],
  dead_cards: [],
  players: EXPECTED_EQUITY_SUBMISSION.players.map((p) => ({ ...p })),
};

describe("equityJobFixture", () => {
  it("accepts the expected AA vs KK river start body", () => {
    expect(() => assertExpectedEquitySubmission(validStart)).not.toThrow();
  });

  it("refuses wrong method / board / ranges with a useful message", () => {
    expect(() =>
      assertExpectedEquitySubmission({
        ...validStart,
        method: "monte_carlo",
        board: ["As", "Kd", "Qc"],
        players: [
          { id: "p1", range: "AA" },
          { id: "p2", range: "KK" },
        ],
      }),
    ).toThrow(/method got|board got|players\[0\]\.range/);
  });

  it("starts a job, polls running then completed, and cancels", async () => {
    const session = createEquityJobFixtureSession();
    const started = session.handle("start_equity_job", validStart, "req-1");
    expect(started?.ok).toBe(true);
    expect(started?.body).toMatchObject({ job_id: expect.any(String), state: "queued" });
    const jobId = (started?.body as { job_id: string }).job_id;

    const running = session.handle("get_equity_job", { job_id: jobId }, "req-2");
    expect(running?.body).toMatchObject({ state: "running", job_id: jobId });

    const done = session.handle("get_equity_job", { job_id: jobId }, "req-3");
    expect(done?.body).toMatchObject({
      state: "completed",
      job_id: jobId,
      result: {
        model: "check-down",
        actual_method: "exact",
        players: [
          { id: "p1", equity: 1 },
          { id: "p2", equity: 0 },
        ],
      },
    });

    const started2 = session.handle(
      "start_equity_job",
      { ...validStart, client_revision: "r2" },
      "req-4",
    );
    const job2 = (started2?.body as { job_id: string }).job_id;
    const cancelled = session.handle("cancel_equity_job", { job_id: job2 }, "req-5");
    expect(cancelled?.body).toMatchObject({ state: "cancelled", job_id: job2 });
  });

  it("throws from start_equity_job when submission is wrong", () => {
    const session = createEquityJobFixtureSession();
    expect(() =>
      session.handle(
        "start_equity_job",
        { ...validStart, players: [{ id: "p1", range: "QQ" }, { id: "p2", range: "JJ" }] },
        "req-bad",
      ),
    ).toThrow(/start_equity_job refused/);
  });

  it("ignores non-calculator ops", () => {
    const session = createEquityJobFixtureSession();
    expect(session.handle("status", null, "req-x")).toBeNull();
  });
});
