// ADR 0162 (K4, leaf L-K4b): the fake backend's K0 members (`testing.ts`): fake voices take `setVelocity`,
// `setOcclusion` and `setDopplerRate`, and `makeFakeZoneIrService()` answers only when the test tells it to.
import { describe, it } from "vitest";

describe("fake voice K0 members", () => {
  it.skip("setVelocity, setOcclusion and setDopplerRate record events and expose the latest values", () => {});
  it.skip("before any call: velocity null, occlusionGain 1, occlusionLpHz 24000, dopplerRate 1", () => {});
  it.skip("setVelocity copies the vector (a later change to the caller's object isn't seen)", () => {});
  it.skip("a request's M3 fields are kept on `request` as given", () => {});
});

describe("makeFakeZoneIrService", () => {
  it.skip("prepare records the request and returns tokens 1, 2, ...", () => {});
  it.skip("prepared(token) calls onPrepared with the request's kernel id and frames (maxFrames by default)", () => {});
  it.skip("failed(token) calls onFailed with the message and code 1 by default", () => {});
  it.skip("an unknown token answers nothing", () => {});
  it.skip("release, reprepareAll and dispose are recorded", () => {});
});
