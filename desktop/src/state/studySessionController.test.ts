import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analysisRequestIsCurrent,
  beginAnalysisRequest,
  invalidateAllAnalysisRequests,
  pollAnalysis,
  resetAnalysisCacheForTests,
  resetStatusPollingForTests,
  startStatusPolling,
  stopStatusPolling,
  isStatusPollActive,
} from "./studySessionController";

describe("studySessionController", () => {
  afterEach(() => {
    stopStatusPolling();
    resetStatusPollingForTests();
    resetAnalysisCacheForTests();
  });

  it("start/stop status polling arms and clears the session flag", () => {
    const kick = vi.fn();
    startStatusPolling(kick);
    expect(isStatusPollActive()).toBe(true);
    expect(kick).toHaveBeenCalledTimes(1);
    startStatusPolling(kick);
    expect(kick).toHaveBeenCalledTimes(1);
    stopStatusPolling();
    expect(isStatusPollActive()).toBe(false);
  });

  it("abandons in-flight analysis when navigation invalidates the token", async () => {
    const { token } = beginAnalysisRequest("values", "s1", "n1", 1);
    let fetches = 0;
    const pending = pollAnalysis(
      "values",
      token,
      async () => {
        fetches += 1;
        return { pending: true };
      },
      () => {
        throw new Error("stale ready must not paint");
      },
      () => {
        throw new Error("stale error must not paint");
      },
    );
    await Promise.resolve();
    invalidateAllAnalysisRequests();
    expect(analysisRequestIsCurrent("values", token)).toBe(false);
    await pending;
    expect(fetches).toBeGreaterThanOrEqual(1);
  });

  it("revision bump starts a new analysis identity", () => {
    const first = beginAnalysisRequest("equity", "s1", "n1", 1);
    const second = beginAnalysisRequest("equity", "s1", "n1", 2);
    expect(analysisRequestIsCurrent("equity", first.token)).toBe(false);
    expect(analysisRequestIsCurrent("equity", second.token)).toBe(true);
    expect(second.identity.revision).toBe(2);
  });
});
