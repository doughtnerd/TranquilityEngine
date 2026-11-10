// The §3.7 classifier, row by row (A3.4b, leaf L1).
import { describe, expect, it } from "vitest";
import { classifyDeviceChange, INTERRUPTED_RETRY_MS, STALL_MS, type DeviceObservation, type DeviceSnapshot } from "./deviceChange";

const snap = (over: Partial<DeviceSnapshot> = {}): DeviceSnapshot => ({ state: "running", rate: 48_000, sink: "", ...over });
const obs = (over: Partial<DeviceObservation> = {}): DeviceObservation => ({
  before: snap(),
  after: snap(),
  deviceRate: null,
  heartbeatAgeMs: 20,
  visible: true,
  pageSuspended: false,
  interruptedForMs: 0,
  ...over,
});

describe("classifyDeviceChange", () => {
  it("leaves a running context with a fresh heartbeat (Chromium follows the default device)", () => {
    expect(classifyDeviceChange(obs())).toEqual({ action: "leave" });
    expect(classifyDeviceChange(obs({ deviceRate: 48_000, before: snap({ sink: "a" }), after: snap({ sink: "b" }) }))).toEqual({ action: "leave" });
  });

  it("leaves a device event whose rate is unknown or unchanged (D9: a device coming or going isn't a rebuild)", () => {
    expect(classifyDeviceChange(obs({ before: snap({ sink: "a" }), after: snap({ sink: "b" }), deviceRate: null }))).toEqual({ action: "leave" });
    expect(classifyDeviceChange(obs({ before: snap({ sink: "a" }), after: snap({ sink: "b" }), deviceRate: 48_000 }))).toEqual({ action: "leave" });
  });

  it("rebuilds at the device rate when the probed device runs at another rate than the context", () => {
    expect(classifyDeviceChange(obs({ deviceRate: 44_100 }))).toEqual({ action: "rebuild", reason: "rate" });
    expect(classifyDeviceChange(obs({ before: snap({ sink: "a" }), after: snap({ sink: "b" }), deviceRate: 44_100 }))).toEqual({ action: "rebuild", reason: "rate" });
  });

  it("rebuilds for a rate when the context's own rate changed", () => {
    expect(classifyDeviceChange(obs({ before: snap({ rate: 44_100 }) }))).toEqual({ action: "rebuild", reason: "rate" });
  });

  it("rebuilds a closed context for the device", () => {
    expect(classifyDeviceChange(obs({ after: snap({ state: "closed" }) }))).toEqual({ action: "rebuild", reason: "device" });
    // closed wins over a stale heartbeat and a hidden page
    expect(classifyDeviceChange(obs({ after: snap({ state: "closed" }), heartbeatAgeMs: 9_999, visible: false }))).toEqual({ action: "rebuild", reason: "device" });
  });

  it("rebuilds a stall: no STATUS for 1 s while running and visible", () => {
    expect(classifyDeviceChange(obs({ heartbeatAgeMs: STALL_MS - 1 }))).toEqual({ action: "leave" });
    expect(classifyDeviceChange(obs({ heartbeatAgeMs: STALL_MS }))).toEqual({ action: "rebuild", reason: "stall" });
  });

  it("never calls a hidden page stalled, nor one with no STATUS yet", () => {
    expect(classifyDeviceChange(obs({ heartbeatAgeMs: 30_000, visible: false }))).toEqual({ action: "leave" });
    expect(classifyDeviceChange(obs({ heartbeatAgeMs: null }))).toEqual({ action: "leave" });
  });

  it("does not call a suspended context stalled", () => {
    expect(classifyDeviceChange(obs({ after: snap({ state: "suspended" }), heartbeatAgeMs: 30_000, pageSuspended: true }))).toEqual({ action: "leave" });
  });

  it("resumes an interrupted context, and rebuilds once the resume has failed for 2 s", () => {
    const after = snap({ state: "interrupted" });
    expect(classifyDeviceChange(obs({ after, interruptedForMs: 0 }))).toEqual({ action: "resume" });
    expect(classifyDeviceChange(obs({ after, interruptedForMs: INTERRUPTED_RETRY_MS - 1 }))).toEqual({ action: "resume" });
    expect(classifyDeviceChange(obs({ after, interruptedForMs: INTERRUPTED_RETRY_MS }))).toEqual({ action: "rebuild", reason: "device" });
  });

  it("resumes a suspend nobody asked for, and leaves the page's own", () => {
    const after = snap({ state: "suspended" });
    expect(classifyDeviceChange(obs({ after, pageSuspended: false }))).toEqual({ action: "resume" });
    expect(classifyDeviceChange(obs({ after, pageSuspended: true }))).toEqual({ action: "leave" });
  });

  it("leaves a context that was never running (locked: the unlock layer's gesture resumes it)", () => {
    const suspended = snap({ state: "suspended" });
    expect(classifyDeviceChange(obs({ before: suspended, after: suspended }))).toEqual({ action: "leave" });
  });

  it("an interrupted context on a hidden page is still resumed", () => {
    expect(classifyDeviceChange(obs({ after: snap({ state: "interrupted" }), visible: false }))).toEqual({ action: "resume" });
  });
});
