// ADR 0342: a voice's loop program on the real core (the loopback host), through the core backend's automation sink:
// `setLoops` goes out as LOOPS behind the voice's PLAY, the core plays the loops (a ping-pong loop here, then a held
// forward loop), and `setLoop(…, false)` is the program's key-off. The clip is a ramp (frame k reads k / 4096), so the
// output tells the playhead.
import { afterEach, describe, expect, it } from "vitest";
import { closeLoopbackAudio, loopbackAudio } from "../testing";
import type { VoiceLoop } from "../automation";

const RATE = 48_000;
const Q = 128;
// Steep enough that the decoder's int16 holds every frame exactly (k / 4096 is 8k in int16).
const SCALE = 4096;
const ramp = Float32Array.from({ length: SCALE }, (_, k) => k / SCALE);

afterEach(closeLoopbackAudio);

const loop = (l: Partial<VoiceLoop> & { start: number; end: number }): VoiceLoop => ({
  direction: "forward", crossfade: 0, count: 0, active: "always", exit: "finish", exitFade: 0, reentry: "ignore", ...l,
});

describe("loop programs on the core (ADR 0342)", () => {
  it("plays a ping-pong loop for its count, parks nowhere, and lets a held loop go at the key-off", async () => {
    const loop0 = await loopbackAudio({ mixer: "own", preset: { maxLogical: 16, maxMixed: 8, limiterLookaheadMs: 0 }, decode: () => ({ channelData: [ramp] }) });
    if (!loop0) return; // the wasm isn't built here
    const { backend } = loop0;
    const voice = backend.play({ path: "ramp.wav", url: "", loop: false, stream: false, bus: "SFX", volume: 1, pitch: 1 })!;
    // 64 frames apart: a ping-pong loop played twice (forward to 192, back to 128, forward to 192 again), then a held loop.
    backend.automation!.setLoops(voice, 0, [
      loop({ start: 128 / RATE, end: 192 / RATE, direction: "pingPong", count: 2 }),
      loop({ start: 512 / RATE, end: 640 / RATE, active: "held" }),
    ]);
    const out: number[] = [];
    let started = false;
    for (let n = 0; n < 200 && out.length < 40 * Q; n++) {
      loop0.mainFrame(Q / RATE);
      const q = loop0.render(1).left;
      for (let k = 0; k < 4; k++) await Promise.resolve();
      if (!started && !q.some((s) => s !== 0)) continue;
      started = true;
      out.push(...q);
    }
    // The voice starts inside its first quantum: frame 0 (silent) sits just before the first non-zero sample.
    const base = out.findIndex((s) => s !== 0) - 1;
    const level = (out[base + 60]! - out[base + 10]!) / (50 / SCALE); // the unbound gain (pan law, bus)
    const frame = (k: number): number => Math.round((out[base + k]! / level) * SCALE);
    expect(frame(191)).toBe(191);
    expect(frame(193)).toBe(191); // turned back at 192
    expect(frame(256)).toBe(128);
    expect(frame(320)).toBe(192); // the second pass's turn: its count is done, so it plays on
    expect(frame(321)).toBe(193);
    // The held loop (512..640): still looping well after it.
    expect(frame(2000)).toBeGreaterThanOrEqual(512);
    expect(frame(2000)).toBeLessThan(640);
    backend.automation!.setLoop(voice, 0, 0, false);
    const after: number[] = [];
    for (let n = 0; n < 12; n++) {
      loop0.mainFrame(Q / RATE);
      after.push(...loop0.render(1).left);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
    expect(Math.round((after.at(-1)! / level) * SCALE)).toBeGreaterThan(640); // released: on past the loop
  });
});
