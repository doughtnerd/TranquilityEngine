// ADR 0328 (loops on stream voices) end to end on the loopback host: a streamed sample's loop program (the playlist
// runtime's `setLoops`, as a sample's sidecar loops reach a voice) plays through the real decoder worker and mixer wasm.
// The worker wraps sample-accurately and crossfades each seam (`myco_decode_seam`, the clip voice's shapes), so a loop
// whose region doesn't meet itself (a sine with a fractional number of cycles in it) wraps with no gap and no click;
// a counted loop plays its passes, then the stream plays on to the file's end and the voice ends; a program's second
// loop loops in its turn. The file is a 16-bit WAV at the context rate and the limiter has no look-ahead, so output
// index = core frame and, away from the seams, the output is the file's samples exactly.
//
// Measured (reported): the largest sample-to-sample step across every seam against the sine's own (`maxStep`, the
// project's click detector).
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWav } from "../decoder/testWav";
import { maxStep } from "../golden/maxStep";
import { closeLoopbackAudio } from "../testing";
import { RATE, rig } from "../../testing/streamRig";
import type { VoiceLoop } from "../automation";

const FILE_FRAMES = 2 * RATE;
const AMP = 12_000;
/** 440 Hz: 109.09 frames a cycle, so no region of a whole number of frames holds whole cycles (its seam jumps). */
const HZ = 440;
const tone = (k: number) => Math.round(AMP * Math.sin((2 * Math.PI * HZ * k) / RATE));
const file = () => makeWav(FILE_FRAMES, 2, RATE, (k) => tone(k));
const want = (k: number) => tone(k) / 32768;
/** The sine's own largest step between neighbouring samples. */
const SINE_STEP = (AMP / 32768) * 2 * Math.sin((Math.PI * HZ) / RATE);

afterEach(async () => {
  vi.restoreAllMocks();
  await closeLoopbackAudio();
});

const loop = (start: number, end: number, crossfade: number, count = 0, extra: Partial<VoiceLoop> = {}): VoiceLoop => ({
  start, end, direction: "forward", crossfade, count, active: "always", exit: "finish", exitFade: 0, reentry: "ignore", ...extra,
});

/** The output index of stream frame 0: the first non-zero sample, less the signal's leading zero frames. */
function onsetOf(out: readonly number[]): number {
  let first = 0;
  while (first < out.length && out[first] === 0) first++;
  let lead = 0;
  while (want(lead) === 0) lead++;
  return first - lead;
}

/** Plays `music/s.wav` streamed with `program` for `seconds`; returns the left channel from the voice's onset and the voice. */
async function play(program: VoiceLoop[], seconds: number) {
  const r = await rig({ "music/s.wav": file() });
  if (!r) return null;
  const voice = r.backend.play({ path: "music/s.wav", url: "", loop: true, stream: true, bus: "Music", group: 1 })!;
  r.backend.automation.setLoops(voice, 1, program);
  await r.step(2);
  await r.waitOpen(1);
  await r.step(Math.ceil((seconds * RATE) / 512));
  const at = onsetOf(r.left);
  expect(at).toBeGreaterThan(0);
  const out = Array.from(r.left.slice(at));
  return { r, voice, out };
}

/** The largest step within `half` frames either side of each seam in `seams` (output indices from the onset). */
function seamStep(out: readonly number[], seams: readonly number[], half = 600): number {
  const x = Float32Array.from(out);
  let m = 0;
  for (const s of seams) if (s + half < x.length) m = Math.max(m, maxStep(x, s - half, s + half));
  return m;
}

describe("loops on stream voices (ADR 0328)", () => {
  it("a crossfaded loop wraps with no gap or click; without the crossfade the same seam clicks", async (ctx) => {
    // 12,037 frames: 110.34 cycles, so the region's end doesn't meet its start.
    const [a, b] = [12_000, 24_037];
    const seams = [b, b + (b - a), b + 2 * (b - a), b + 3 * (b - a)];
    const faded = await play([loop(a / RATE, b / RATE, 0.01)], 1.4);
    if (!faded) return ctx.skip();
    const stepFaded = seamStep(faded.out, seams);
    // Up to the first seam the stream is the file, sample for sample; it keeps sounding (no gap) to the end of the run.
    for (let k = 0; k < b; k++) if (faded.out[k] !== want(k)) expect.fail(`frame ${k} before the first seam`);
    const quiet = faded.out.slice(0, seams[3]! + 1000).findIndex((v, i, x) => i > 0 && v === 0 && x[i - 1] === 0);
    expect(quiet).toBe(-1);
    // Past the crossfade (480 frames) the loop reads the region's start again, exactly.
    for (let k = 480; k < 2000; k++) if (faded.out[b + k] !== want(a + k)) expect.fail(`frame ${k} after the seam`);
    expect(faded.voice.playing).toBe(true);
    expect(faded.r.backend.streams.stats.starves).toBe(0);
    faded.r.backend.dispose();
    await closeLoopbackAudio();

    const hard = await play([loop(a / RATE, b / RATE, 0)], 1.4);
    if (!hard) return ctx.skip();
    const stepHard = seamStep(hard.out, seams);
    hard.r.backend.dispose();
    console.info(`[stream loops] seam step: crossfaded ${stepFaded.toFixed(5)}, no crossfade ${stepHard.toFixed(5)}, the sine's own ${SINE_STEP.toFixed(5)}`);
    expect(stepFaded).toBeLessThan(SINE_STEP * 1.5);
    expect(stepHard).toBeGreaterThan(SINE_STEP * 3);
  }, 60_000);

  it("a counted loop plays its passes, then the stream plays on to the file's end and the voice ends", async (ctx) => {
    const [a, b] = [24_000, 36_037];
    const m = await play([loop(a / RATE, b / RATE, 0.005, 3)], 3);
    if (!m) return ctx.skip();
    // Three passes: the file to b, the region twice more, then on from b to the file's end.
    const total = b + 2 * (b - a) + (FILE_FRAMES - b);
    const tail = b + 2 * (b - a);
    for (let k = 240; k < FILE_FRAMES - b; k++) if (m.out[tail + k] !== want(b + k)) expect.fail(`tail frame ${k}`);
    expect(m.out.slice(total, total + 2048).every((v) => v === 0)).toBe(true);
    expect(m.voice.playing).toBe(false);
    expect(seamStep(m.out, [b, b + (b - a), tail])).toBeLessThan(SINE_STEP * 1.5);
    m.r.backend.dispose();
  }, 60_000);

  it("a program's second loop loops in its turn after the first has played its count", async (ctx) => {
    const [a1, b1, a2, b2] = [12_000, 24_037, 48_000, 60_037];
    const m = await play([loop(a1 / RATE, b1 / RATE, 0.005, 2), loop(a2 / RATE, b2 / RATE, 0.005, 0)], 3);
    if (!m) return ctx.skip();
    // 0..b1 (the first pass), the first region once more, on from b1 to b2, then a2..b2 for ever.
    const [len1, len2] = [b1 - a1, b2 - a2];
    const runOn = b1 + len1;
    const second = runOn + (b2 - b1);
    for (let k = 240; k < len1; k++) if (m.out[b1 + k] !== want(a1 + k)) expect.fail(`second pass frame ${k}`);
    for (let k = 0; k < b2 - b1; k++) if (m.out[runOn + k] !== want(b1 + k)) expect.fail(`run-on frame ${k}`);
    for (let k = 240; k < len2; k++) if (m.out[second + k] !== want(a2 + k)) expect.fail(`second loop frame ${k}`);
    expect(m.voice.playing).toBe(true);
    expect(seamStep(m.out, [b1, second, second + len2])).toBeLessThan(SINE_STEP * 1.5);
    m.r.backend.dispose();
  }, 60_000);
});
