// ADR 0331 instance submixes on the loopback host (the real wasm): the voices of a group with a submix run its chain
// (a 500 Hz low-pass removes a Nyquist tone), other groups don't; closing the submix gives the voices back their bus.
import { afterEach, describe, expect, it } from "vitest";
import type { Effect } from "../../../../engine/audio/effects/types";
import { loopbackAudio, closeLoopbackAudio } from "../testing";

const nyquist = Float32Array.from({ length: 48_000 }, (_, k) => (k % 2 === 0 ? 0.25 : -0.25));
const lowpass: Effect = { id: "lp", type: "lowpass", on: true, params: { cutoff: 500 } } as Effect;

afterEach(closeLoopbackAudio);

async function rig() {
  const audio = await loopbackAudio({ mixer: "own", preset: { maxLogical: 16, maxMixed: 8, limiterLookaheadMs: 0 }, decode: () => ({ channelData: [nyquist] }), dt: 0.003 });
  if (!audio) return null;
  const peak = async (frames: number): Promise<number> => {
    let p = 0;
    for (let f = 0; f < frames; f++) for (const s of (await audio.step()).left) p = Math.max(p, Math.abs(s));
    return p;
  };
  return { backend: audio.backend, peak };
}

describe("instance submixes on the core (ADR 0331)", () => {
  it("runs a group's chain on its voices; another group's voice plays straight; closing restores the bus", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, peak } = r;
    expect(backend.submixes.open(3, "SFX", [lowpass], "test")).toBe(true);
    const v = backend.play({ path: "n.wav", url: "n.wav", loop: true, stream: false, bus: "SFX", group: 3 })!;
    await peak(6);
    expect(await peak(4)).toBeLessThan(0.01);
    v.stop();
    await peak(4);
    const w = backend.play({ path: "n.wav", url: "n.wav", loop: true, stream: false, bus: "SFX", group: 4 })!;
    await peak(6);
    expect(await peak(4)).toBeCloseTo(0.25, 3);
    w.stop();
    backend.submixes.close(3);
    await peak(2);
    backend.play({ path: "n.wav", url: "n.wav", loop: true, stream: false, bus: "SFX", group: 3 });
    await peak(6);
    expect(await peak(4)).toBeCloseTo(0.25, 3);
    backend.dispose();
  });
});
