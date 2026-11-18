import { describe, expect, it } from "vitest";
import {
  applyOpenJobLocalReset,
  beginPendingJob,
  buildTrainRequestBody,
  captureStudyIdentityScopes,
  CHECKPOINT_STATUS_KEYS,
  commitJobOnAdmission,
  createCompositeSolveIntent,
  defaultStopJobId,
  emptyJobIdBook,
  hostMayAdmitTrain,
  interpretCancelReply,
  isTrainAdmissionSuccess,
  JOB_LOCAL_STATUS_KEYS,
  latchSolveCancel,
  maySendTrain,
  noteBuildComplete,
  noteSolveTerminal,
  noteTrainAdmitted,
  resetJobLocalOnOpenSuccess,
  stopAppliesDuringBuild,
} from "./jobIntent";

describe("composite Build→Train intent", () => {
  it("keeps one cancellable intent across Build and pre-train", () => {
    let intent = createCompositeSolveIntent("job-a");
    expect(intent.phase).toBe("building");
    expect(maySendTrain(intent)).toBe(true);
    expect(stopAppliesDuringBuild(intent)).toBe(true);

    intent = noteBuildComplete(intent);
    expect(intent.phase).toBe("awaiting_train");
    expect(maySendTrain(intent)).toBe(true);
    expect(stopAppliesDuringBuild(intent)).toBe(true);
  });

  it("latches cancel before train so the client must not send train", () => {
    let intent = createCompositeSolveIntent("job-a");
    intent = latchSolveCancel(intent);
    expect(intent.cancelLatched).toBe(true);
    expect(maySendTrain(intent)).toBe(false);
    expect(hostMayAdmitTrain({
      jobId: intent.jobId,
      cancelLatched: intent.cancelLatched,
      sessionBusy: false,
    })).toBe(false);

    intent = noteBuildComplete(intent);
    expect(maySendTrain(intent)).toBe(false);
  });

  it("models host admission refusal when session is busy", () => {
    expect(
      hostMayAdmitTrain({
        jobId: "job-b",
        cancelLatched: false,
        sessionBusy: true,
      }),
    ).toBe(false);
    expect(
      hostMayAdmitTrain({
        jobId: "job-b",
        cancelLatched: false,
        sessionBusy: false,
      }),
    ).toBe(true);
  });

  it("Stop during Build is a handoff noop ack when host says not_running", () => {
    const intent = noteBuildComplete(createCompositeSolveIntent("job-a"));
    const ack = interpretCancelReply(
      { cancelled: false, reason: "not_running" },
      intent,
    );
    expect(ack.kind).toBe("noop_not_running");
    expect(ack.duringBuildHandoff).toBe(true);

    const afterTrain = noteTrainAdmitted(createCompositeSolveIntent("job-a"));
    const midTrain = interpretCancelReply(
      { cancelled: false, reason: "not_running" },
      afterTrain,
    );
    expect(midTrain.duringBuildHandoff).toBe(false);
  });

  it("does not send train after terminal or after admission", () => {
    const admitted = noteTrainAdmitted(createCompositeSolveIntent("job-a"));
    expect(admitted.trainAdmitted).toBe(true);
    expect(maySendTrain(admitted)).toBe(false);
    expect(stopAppliesDuringBuild(admitted)).toBe(false);

    const done = noteSolveTerminal(createCompositeSolveIntent("job-a"));
    expect(maySendTrain(done)).toBe(false);
  });
});

describe("active job commit rules", () => {
  it("promotes pending to active only on successful admission", () => {
    let book = beginPendingJob(emptyJobIdBook(), "job-a");
    expect(defaultStopJobId(book)).toBeNull();

    book = commitJobOnAdmission(book, { accepted: true, running: true });
    expect(book.activeJobId).toBe("job-a");
    expect(book.pendingJobId).toBeNull();
    expect(defaultStopJobId(book)).toBe("job-a");
  });

  it("rejected second train preserves authoritative active for default Stop", () => {
    let book = commitJobOnAdmission(
      beginPendingJob(emptyJobIdBook(), "job-a"),
      { accepted: true },
    );
    expect(defaultStopJobId(book)).toBe("job-a");

    book = beginPendingJob(book, "job-b");
    expect(book.pendingJobId).toBe("job-b");
    expect(defaultStopJobId(book)).toBe("job-a");

    book = commitJobOnAdmission(book, { busy: true, error_code: "busy" });
    expect(book.activeJobId).toBe("job-a");
    expect(book.pendingJobId).toBeNull();
    expect(defaultStopJobId(book)).toBe("job-a");
    expect(isTrainAdmissionSuccess({ busy: true })).toBe(false);
  });

  it("does not treat cancelled / not_running as admission success", () => {
    expect(isTrainAdmissionSuccess({ accepted: false, error_code: "cancelled" })).toBe(
      false,
    );
    expect(
      isTrainAdmissionSuccess({ running: false, error_code: "not_running" }),
    ).toBe(false);
  });
});

describe("Open job-local reset", () => {
  it("clears job-local targets and terminal errors while listing checkpoint keys", () => {
    const reset = resetJobLocalOnOpenSuccess();
    expect(reset.jobLocal.iterations_requested).toBeNull();
    expect(reset.jobLocal.job_id).toBeNull();
    expect(reset.jobLocal.last_error).toBeNull();
    expect(reset.jobLocal.failed).toBe(false);
    expect(reset.jobLocal.cancelled).toBe(false);
    expect(reset.jobIds).toEqual(emptyJobIdBook());
    expect(reset.intent).toBeNull();

    expect(JOB_LOCAL_STATUS_KEYS).toContain("iterations_requested");
    expect(JOB_LOCAL_STATUS_KEYS).toContain("last_error");
    expect(CHECKPOINT_STATUS_KEYS).toContain("iterations");
    expect(CHECKPOINT_STATUS_KEYS).toContain("policy_revision");
    expect(CHECKPOINT_STATUS_KEYS).toContain("solution_id");
  });

  it("merges reset onto status without wiping checkpoint metadata", () => {
    const status = {
      iterations: 8,
      iterations_requested: 48,
      solution_id: "s1",
      policy_revision: 2,
      pot: 100,
      job_id: "stale-job",
      running: false,
      failed: true,
      last_error: "prior train fault",
      cancelled: true,
      board: ["Ah", "Kh", "Qh"],
      has_training: true,
    };
    const next = applyOpenJobLocalReset(status);
    expect(next.iterations).toBe(8);
    expect(next.solution_id).toBe("s1");
    expect(next.policy_revision).toBe(2);
    expect(next.pot).toBe(100);
    expect(next.board).toEqual(["Ah", "Kh", "Qh"]);
    expect(next.has_training).toBe(true);
    expect(next.iterations_requested).toBeNull();
    expect(next.job_id).toBeNull();
    expect(next.last_error).toBeNull();
    expect(next.error).toBeNull();
    expect(next.failed).toBe(false);
    expect(next.cancelled).toBe(false);
    expect(next.running).toBe(false);
  });
});

describe("train request body samples", () => {
  it("includes samples alongside iterations when UI exposes Samples on solve", () => {
    expect(
      buildTrainRequestBody("solve", { iterations: 30, samples: 15 }),
    ).toEqual({ iterations: 30, samples: 15 });
  });

  it("forwards samples on continue and resolve_locked when exposed", () => {
    expect(
      buildTrainRequestBody("continue", {
        iterations: 20,
        samples: 5,
        time_limit: 10,
      }),
    ).toEqual({ iterations: 20, samples: 5, time_limit: 10 });

    expect(
      buildTrainRequestBody("resolve_locked", {
        iterations: 40,
        samples: 8,
        warm_start: true,
        accuracy: 0.01,
      }),
    ).toEqual({
      iterations: 40,
      samples: 8,
      warm_start: 1,
      accuracy: 0.01,
    });
  });

  it("omits samples when UI did not supply a positive value", () => {
    expect(buildTrainRequestBody("solve", { iterations: 30 })).toEqual({
      iterations: 30,
    });
    expect(
      buildTrainRequestBody("solve", { iterations: 30, samples: 0 }),
    ).toEqual({ iterations: 30 });
    expect(
      buildTrainRequestBody("solve", { iterations: 30, samples: null }),
    ).toEqual({ iterations: 30 });
  });
});

describe("identity scopes", () => {
  it("keeps launch, policy revision, status sequence, and equity generation distinct", () => {
    const scopes = captureStudyIdentityScopes({
      launchId: "launch-7",
      policyRevision: 4,
      statusSequence: 21,
      equityGeneration: 6,
    });
    expect(scopes).toEqual({
      launchId: "launch-7",
      policyRevision: 4,
      statusSequence: 21,
      equityGeneration: 6,
    });
    // Same published revision can yield different status vs equity numbers.
    expect(scopes.statusSequence).not.toBe(scopes.equityGeneration);
    expect(scopes.policyRevision).not.toBe(scopes.statusSequence);
  });

  it("maps status_generation into statusSequence only when statusSequence omitted", () => {
    const scopes = captureStudyIdentityScopes({
      policyRevision: 4,
      status_generation: 21,
      equityGeneration: 6,
    });
    expect(scopes.statusSequence).toBe(21);
    expect(scopes.equityGeneration).toBe(6);
  });
});
