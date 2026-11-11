// ADR 0162 (K4, leaf L-K4b): the fake backend's K0 members (`testing.ts`): fake voices take `setVelocity`,
// `setOcclusion` and `setDopplerRate`, and `makeFakeZoneIrService()` answers only when the test tells it to.
import { describe, expect, it } from "vitest";
import { makeFakeBackend, makeFakeZoneIrService, type FakeVoice } from "./testing";
import type { PlayRequest } from "./backend";

const req = (extra: Partial<PlayRequest> = {}): PlayRequest => ({ path: "a.wav", url: "a.wav", loop: false, stream: false, bus: "Master", ...extra });
const voice = (extra?: Partial<PlayRequest>): FakeVoice => {
  const b = makeFakeBackend();
  b.play(req(extra));
  return b.voices[0]!;
};

describe("fake voice K0 members", () => {
  it("setVelocity, setOcclusion and setDopplerRate record events and expose the latest values", () => {
    const v = voice();
    v.setVelocity({ x: 1, y: 2, z: 3 });
    v.setOcclusion(0.5, 2000);
    v.setDopplerRate(1.1);
    v.setOcclusion(0.25, 800);
    expect(v.events.slice(-4)).toEqual([
      { kind: "velocity", value: { x: 1, y: 2, z: 3 } },
      { kind: "occlusion", gain: 0.5, lpHz: 2000 },
      { kind: "doppler", factor: 1.1 },
      { kind: "occlusion", gain: 0.25, lpHz: 800 },
    ]);
    expect(v.velocity).toEqual({ x: 1, y: 2, z: 3 });
    expect(v.occlusionGain).toBe(0.25);
    expect(v.occlusionLpHz).toBe(800);
    expect(v.dopplerRate).toBe(1.1);
    v.end();
  });

  it("before any call: velocity null, occlusionGain 1, occlusionLpHz 24000, dopplerRate 1", () => {
    const v = voice();
    expect([v.velocity, v.occlusionGain, v.occlusionLpHz, v.dopplerRate]).toEqual([null, 1, 24000, 1]);
    v.end();
  });

  it("setVelocity copies the vector (a later change to the caller's object isn't seen)", () => {
    const v = voice();
    const p = { x: 1, y: 0, z: 0 };
    v.setVelocity(p);
    p.x = 9;
    expect(v.velocity).toEqual({ x: 1, y: 0, z: 0 });
    v.end();
  });

  it("a request's M3 fields are kept on `request` as given", () => {
    const m3: Partial<PlayRequest> = { occlusion: false, dopplerLevel: 2, reverbSend: 0.5, reverbSendCurve: [[0, 1], [1, 0]], ambisonic: true, yaw: 30, filter: { lowpass: 900, highpass: 80 }, aux: { bus: "FX", level: 0.7 } };
    const v = voice(m3);
    expect(v.request).toMatchObject(m3);
    v.end();
  });
});

describe("makeFakeZoneIrService", () => {
  it("prepare records the request and returns tokens 1, 2, ...", () => {
    const s = makeFakeZoneIrService();
    expect(s.prepare({ kernelId: 0xffff0200, preset: "hall", contextRate: 48000, maxFrames: 96000 })).toBe(1);
    expect(s.prepare({ kernelId: 0xffff0201, assetUrl: "ir.wav", contextRate: 48000, maxFrames: 48000 })).toBe(2);
    expect(s.requests).toEqual([
      { token: 1, kernelId: 0xffff0200, preset: "hall", contextRate: 48000, maxFrames: 96000 },
      { token: 2, kernelId: 0xffff0201, assetUrl: "ir.wav", contextRate: 48000, maxFrames: 48000 },
    ]);
  });

  it("prepared(token) calls onPrepared with the request's kernel id and frames (maxFrames by default)", () => {
    const s = makeFakeZoneIrService();
    const seen: unknown[] = [];
    s.onPrepared = (e) => seen.push(e);
    const t = s.prepare({ kernelId: 7, contextRate: 48000, maxFrames: 1000 });
    s.prepared(t);
    s.prepared(t, { frames: 500, truncated: true, prepareMs: 3 });
    expect(seen).toEqual([
      { token: t, kernelId: 7, frames: 1000, truncated: false, prepareMs: 1 },
      { token: t, kernelId: 7, frames: 500, truncated: true, prepareMs: 3 },
    ]);
  });

  it("failed(token) calls onFailed with the message and code 1 by default", () => {
    const s = makeFakeZoneIrService();
    const seen: unknown[] = [];
    s.onFailed = (e) => seen.push(e);
    const t = s.prepare({ kernelId: 9, contextRate: 44100, maxFrames: 10 });
    s.failed(t, "bad file");
    s.failed(t, "worse", 4);
    expect(seen).toEqual([
      { token: t, kernelId: 9, code: 1, message: "bad file" },
      { token: t, kernelId: 9, code: 4, message: "worse" },
    ]);
  });

  it("an unknown token answers nothing", () => {
    const s = makeFakeZoneIrService();
    let calls = 0;
    s.onPrepared = () => calls++;
    s.onFailed = () => calls++;
    s.prepared(5);
    s.failed(5, "x");
    expect(calls).toBe(0);
  });

  it("release, reprepareAll and dispose are recorded", () => {
    const s = makeFakeZoneIrService();
    s.release(3);
    s.reprepareAll?.(96000);
    expect(s.disposed).toBe(false);
    s.dispose?.();
    expect([s.released, s.reprepared, s.disposed]).toEqual([[3], [96000], true]);
  });
});
