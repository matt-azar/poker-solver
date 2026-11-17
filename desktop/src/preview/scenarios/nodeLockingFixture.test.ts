import { describe, expect, it } from "vitest";
import { SolverIpcError } from "../../engine/transport";
import { EXPECTED_EQUITY_SUBMISSION } from "./equityJobFixture";
import {
  assertExpectedLockSubmission,
  createNodeLockingFixtureHandler,
  EXPECTED_LOCK_SUBMISSION,
  NODE_LOCKING_ROOT_ID,
} from "./nodeLockingFixture";

describe("nodeLockingFixture", () => {
  it("serves a published status + root node for the Study scenario", async () => {
    const { handler } = createNodeLockingFixtureHandler();
    const status = await handler("status", null);
    expect(status.ok).toBe(true);
    expect(status.body).toMatchObject({
      solution_id: "s1",
      running: false,
      has_training: true,
    });

    const node = await handler("node", { node_id: NODE_LOCKING_ROOT_ID });
    expect(node.body).toMatchObject({
      node_id: NODE_LOCKING_ROOT_ID,
      kind: "decision",
      actions: ["Check", "Bet 50"],
    });
  });

  it("returns resolve_locked only after expected lock frequencies are submitted", async () => {
    const { handler } = createNodeLockingFixtureHandler();
    await handler("put_lock", {
      node_id: EXPECTED_LOCK_SUBMISSION.nodeId,
      kind: "full",
      scope: "node",
      probs: [0.8, 0.2],
    });
    const resolved = await handler("resolve_locked", { iterations: 8, warm_start: 0 });
    expect(resolved.body).toMatchObject({
      terminal_reason: "completed",
      solution_id: 1,
    });
  });

  it("fails resolve_locked with a useful message on wrong frequencies", async () => {
    const { handler, recordPutLockForTests } = createNodeLockingFixtureHandler();
    recordPutLockForTests({
      node_id: EXPECTED_LOCK_SUBMISSION.nodeId,
      kind: "full",
      scope: "node",
      hand_indices: [],
      // Deliberate regression: wrong Check frequency (must not pass).
      probs: [0.1, 0.9],
    });
    await expect(handler("resolve_locked", { iterations: 8 })).rejects.toThrow(
      /Check frequency got 0\.1000 want 0\.8/,
    );
  });

  it("fails resolve_locked when node id or scope is wrong", async () => {
    expect(() =>
      assertExpectedLockSubmission({
        node_id: "p9.t-1.r-1",
        kind: "full",
        scope: "line",
        hand_indices: [],
        probs: [0.8, 0.2],
      }),
    ).toThrow(/node_id got .*p9|scope got .*line/);
  });

  it("fails resolve_locked when no put_lock was sent", async () => {
    const { handler } = createNodeLockingFixtureHandler();
    await expect(handler("resolve_locked", { iterations: 8 })).rejects.toThrow(
      /no put_lock received/,
    );
  });

  it("keeps values pending for the pending-ev reviewer state", async () => {
    const { handler } = createNodeLockingFixtureHandler("pending-ev");
    const values = await handler("values", { node_id: NODE_LOCKING_ROOT_ID });
    expect(values.body).toEqual({ pending: true, node_id: NODE_LOCKING_ROOT_ID });
  });

  it("throws connection_loss for the dropped-connection reviewer state", async () => {
    const { handler } = createNodeLockingFixtureHandler("dropped-connection");
    await expect(handler("status", null)).rejects.toBeInstanceOf(SolverIpcError);
    await expect(handler("status", null)).rejects.toMatchObject({
      ipcClass: "connection_loss",
    });
  });

  it("holds values until release under test-controlled timing", async () => {
    const { handler, holdValues, releaseValues } = createNodeLockingFixtureHandler();
    holdValues("p1.t-1.r-1");
    let released = false;
    const pending = handler("values", { node_id: "p1.t-1.r-1" }).then((env) => {
      released = true;
      return env;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(released).toBe(false);
    releaseValues("p1.t-1.r-1");
    const env = await pending;
    expect(env.body).toMatchObject({ node_id: "p1.t-1.r-1", node_ev: 21.5 });
  });

  it("serves Equity Calculator jobs for the expected AA vs KK river", async () => {
    const { handler } = createNodeLockingFixtureHandler();
    const started = await handler("start_equity_job", {
      version: 1,
      client_revision: "nl-eq",
      method: EXPECTED_EQUITY_SUBMISSION.method,
      board: [...EXPECTED_EQUITY_SUBMISSION.board],
      dead_cards: [],
      players: EXPECTED_EQUITY_SUBMISSION.players.map((p) => ({ ...p })),
    });
    expect(started.body).toMatchObject({ state: "queued" });
    const jobId = (started.body as { job_id: string }).job_id;
    await handler("get_equity_job", { job_id: jobId });
    const done = await handler("get_equity_job", { job_id: jobId });
    expect(done.body).toMatchObject({
      state: "completed",
      result: { players: [{ equity: 1 }, { equity: 0 }] },
    });
  });
});
