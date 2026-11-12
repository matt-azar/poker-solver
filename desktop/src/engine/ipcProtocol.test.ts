import { describe, expect, it } from "vitest";
import {
  encodeIpcFrame,
  makeRequest,
  SOLVER_ENGINE_PROTOCOL,
  tryDecodeIpcFrame,
} from "./ipcProtocol";

describe("solver-engine ipc protocol", () => {
  it("round-trips a length-prefixed ready request", () => {
    const req = makeRequest("r1", "ready");
    const frame = encodeIpcFrame(req);
    expect(frame.byteLength).toBeGreaterThan(4);
    const decoded = tryDecodeIpcFrame(frame);
    expect(decoded).not.toBeNull();
    expect(decoded!.envelope.v).toBe(SOLVER_ENGINE_PROTOCOL);
    expect(decoded!.envelope.op).toBe("ready");
    expect(decoded!.bytesConsumed).toBe(frame.byteLength);
  });

  it("returns null until a full frame is buffered", () => {
    const frame = encodeIpcFrame(makeRequest("r2", "values", { node_index: 0 }));
    expect(tryDecodeIpcFrame(frame.subarray(0, 2))).toBeNull();
    expect(tryDecodeIpcFrame(frame.subarray(0, 4))).toBeNull();
    const decoded = tryDecodeIpcFrame(frame);
    expect(decoded?.envelope.op).toBe("values");
  });

  it("encodes Study node_id on values requests", () => {
    const frame = encodeIpcFrame(
      makeRequest("r3", "values", { node_id: "p0.t-1.r-1" }),
    );
    const decoded = tryDecodeIpcFrame(frame);
    expect(decoded?.envelope.body).toEqual({ node_id: "p0.t-1.r-1" });
  });
});
