// ADR 0158 §4 (M2 E4.4) end to end on the loopback host: a streamed voice with a sustain region (the event runtime's
// `setLoop` through `CoreBackend.automation`) loops the region through the real decoder worker and mixer wasm, its
// release lands at the end of the pass it was asked for in (the worker splices the core's ring there when it had
// already wrapped past it), and a hard rebuild mid-loop reopens the stream inside the region. The file is a 16-bit WAV
// at the context rate and the limiter has no look-ahead, so the output is the file's samples exactly and output index =
// core frame.
//
// Measured (the numbers E4.4 reports): the release lands 0 frames from the end of the pass that held the requested
// frame, for releases asked 5 to 6,000 frames before a seam, through a splice (a region shorter than the ring) and
// without one (a region longer than the ring).
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWav, signal } from "../decoder/testWav";
import { closeLoopbackAudio } from "../testing";
import { RATE, rig } from "../../testing/streamRig";
import { CoreAutomation, type CoreAutomationDeps, type LoopRecord } from "./coreAutomation";
import { VoiceFlag, VoiceState, VoiceTable } from "./voiceTable";
import type { AudioVoice } from "../backend";

const FILE_FRAMES = 2 * RATE;
const want = (k: number) => signal(k, 0) / 32768;
const file = () => makeWav(FILE_FRAMES, 2, RATE, signal);
/** The file frame a stream started at 0 plays at stream frame `k`, looping `start..end`. */
const looped = (k: number, start: number, end: number) => (k < end ? k : start + ((k - start) % (end - start)));

/** The output index of stream frame 0: the first non-zero sample, less the signal's leading zero frames. */
function onsetOf(out: readonly number[]): number {
  let first = 0;
  while (first < out.length && out[first] === 0) first++;
  let lead = 0;
  while (want(lead) === 0) lead++;
  return first - lead;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeLoopbackAudio();
});

/**
 * Plays `music/s.wav` streamed, looping `start..end` seconds; steps until the release would be asked for `before`
 * frames ahead of a seam of pass `pass` (as far as frame steps allow), releases, plays out; returns the measures.
 */
async function releaseRun(start: number, end: number, pass: number, before: number) {
  const r = await rig({ "music/s.wav": file() });
  if (!r) return null;
  const [a, b] = [Math.round(start * RATE), Math.round(end * RATE)];
  const voice = r.backend.play({ path: "music/s.wav", url: "", loop: true, stream: true, bus: "Music" })!;
  r.backend.automation.setLoop(voice, start, end, true);
  await r.step(2);
  await r.waitOpen(1);
  await r.step(4);
  const at = onsetOf(r.left);
  expect(at).toBeGreaterThan(0);
  const seam = at + b + pass * (b - a); // output index of the seam ending pass `pass`
  // The frame a record asked for now is stamped at: the horizon (`Audio.horizon`), on the context's frames.
  const clock = r.backend.clock!;
  const asked = () => (clock.horizon()! - clock.frameMap()!.timeOffset) * clock.frameMap()!.sampleRate;
  while (asked() + 512 < seam - before) await r.step(1);
  const requested = asked();
  r.backend.automation.setLoop(voice, start, end, false);
  await r.step(Math.ceil((FILE_FRAMES + (b - a) * (pass + 2)) / 512) + 20);
  const out = r.left;
  // The pass that held the requested frame ends at the first seam after it.
  const seams: number[] = [];
  for (let n = 0; at + b + n * (b - a) < out.length; n++) seams.push(at + b + n * (b - a));
  const expected = seams.find((s) => s > requested)!;
  // Where the tail (the file from `b` on) actually begins: the first seam followed by it.
  const tailAt = seams.find((s) => {
    for (let m = 0; m < 64; m++) if (out[s + m] !== want(b + m)) return false;
    return true;
  });
  // Every frame up to the tail loops; from it, the file plays on to its end and the voice ends.
  if (tailAt !== undefined) {
    for (let j = at; j < tailAt; j++) if (out[j] !== want(looped(j - at, a, b))) expect.fail(`output ${j}: not the loop (stream frame ${j - at})`);
    for (let m = 0; m < FILE_FRAMES - b; m++) if (out[tailAt + m] !== want(b + m)) expect.fail(`tail frame ${m}`);
    expect(out.slice(tailAt + FILE_FRAMES - b).every((s) => s === 0)).toBe(true);
  }
  const result = {
    lateness: tailAt === undefined ? Number.NaN : tailAt - expected,
    ahead: expected - requested,
    playing: voice.playing,
    underruns: r.link.lastStatus!.underruns,
    starves: r.backend.streams.stats.starves,
  };
  r.backend.dispose();
  return result;
}

describe("stream region loops on the loopback host (E4.4)", () => {
  it("a streamed sustain region loops gaplessly from the first pass on", async (ctx) => {
    const r = await rig({ "music/s.wav": file() });
    if (!r) return ctx.skip();
    const voice = r.backend.play({ path: "music/s.wav", url: "", loop: true, stream: true, bus: "Music" })!;
    // The event runtime's sustain region: 0.25..0.5 s, set right after the play (before the file's rate is known).
    r.backend.automation.setLoop(voice, 0.25, 0.5, true);
    await r.step(2);
    await r.waitOpen(1);
    await r.step(Math.ceil((1.6 * RATE) / 512));
    const at = onsetOf(r.left);
    expect(at).toBeGreaterThan(0);
    const n = r.left.length - at;
    expect(n).toBeGreaterThan(24_000 + 4 * 12_000);
    for (let k = 0; k < n; k++) if (r.left[at + k] !== want(looped(k, 12_000, 24_000))) expect.fail(`stream frame ${k}: ${r.left[at + k]} vs file frame ${looped(k, 12_000, 24_000)}`);
    expect(voice.playing).toBe(true);
    expect(r.backend.streams.stats.starves).toBe(0);
    expect(r.link.lastStatus!.underruns).toBe(0);
    r.backend.dispose();
  });

  // A region shorter than the ring (12,000 frames): the worker has always wrapped past the release's seam, so it splices.
  for (const before of [6_000, 1_000, 100, 5]) {
    it(`a release asked ${before} frames before a seam lands on it (a splice)`, async (ctx) => {
      const m = await releaseRun(0.25, 0.5, 3, before);
      if (!m) return ctx.skip();
      expect(m.ahead).toBeGreaterThan(0);
      expect(m.ahead).toBeLessThanOrEqual(before + 512);
      expect(m.lateness).toBe(0);
      expect(m.playing).toBe(false);
      expect(m.starves).toBe(0);
      expect(m.underruns).toBe(0);
    });
  }

  // A region longer than the ring (0.2..1.4 s, 57,600 frames), asked 40,000 frames before a seam: the worker hadn't sent it.
  for (const pass of [0, 1]) {
    it(`a release early in pass ${pass} of a region longer than the ring lands at its end (no splice)`, async (ctx) => {
      const m = await releaseRun(0.2, 1.4, pass, 40_000);
      if (!m) return ctx.skip();
      expect(m.ahead).toBeGreaterThan(30_000);
      expect(m.lateness).toBe(0);
      expect(m.playing).toBe(false);
      expect(m.starves).toBe(0);
    });
  }

  it("a hard rebuild mid-loop reopens the stream inside its region, and it keeps looping", async (ctx) => {
    // ADR 0223: the stream rig (the production assembly; the backend connects its stream port, the loopback serves it).
    const r = await rig({ "music/s.wav": file() });
    if (!r) return ctx.skip();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = r.left;
    const health = r.audio.host.health;
    const [a, b] = [12_000, 24_000];
    const voice = r.backend.play({ path: "music/s.wav", url: "", loop: true, stream: true, bus: "Music" })!;
    r.backend.automation.setLoop(voice, a / RATE, b / RATE, true);
    await vi.waitFor(async () => {
      await r.step(1);
      expect(r.worklet().frames).toBeGreaterThan(0);
    });
    // Into the third pass (stream frames past 48,000), then a trap.
    await r.step(110);
    const at = onsetOf(out);
    expect(out.length - at).toBeGreaterThan(b + 2 * (b - a));
    for (let k = 0; at + k < out.length; k++) if (out[at + k] !== want(looped(k, a, b))) expect.fail(`before the trap, stream frame ${k}`);
    r.audio.trap();
    await r.step(2);
    expect(health.traps).toBe(1);
    const restartAt = out.length;
    await vi.waitFor(async () => {
      await r.step(1);
      expect(out.slice(restartAt).some((s) => s !== 0)).toBe(true);
    });
    await r.step(80);
    expect(health.recoveries).toBe(1);
    expect(voice.playing).toBe(true);
    let on = restartAt;
    while (out[on] === 0) on++;
    // The new core's output is the region from some frame inside it, then loops on (across at least two seams).
    let pos = -1;
    for (let p = a; p < b && pos < 0; p++) {
      let ok = true;
      for (let k = 0; k < 64 && ok; k++) ok = out[on + k] === want(looped(p - a + k, 0, b - a) + a);
      if (ok) pos = p;
    }
    expect(pos).toBeGreaterThanOrEqual(a);
    expect(pos).toBeLessThan(b);
    expect(out.length - on).toBeGreaterThan(2 * (b - a));
    for (let k = 0; on + k < out.length; k++) {
      const f = a + ((pos - a + k) % (b - a));
      if (out[on + k] !== want(f)) expect.fail(`after the reopen, frame ${k}: want file frame ${f}`);
    }
  }, 30_000);
});

describe("CoreAutomation's stream seam and a held-back PLAY (E4.4, C6)", () => {
  function sink() {
    const table = new VoiceTable(8);
    const loops: [string, ...unknown[]][] = [];
    const state = { now: 10_000, batches: 3 };
    const writer: CoreAutomationDeps["writer"] = {
      automate: () => {},
      param: () => {},
      curves: () => {},
      busAutomate: () => {},
      setLoop: (id, at, a, b, l) => void loops.push(["setLoop", id, at, a, b, l]),
    };
    const auto = new CoreAutomation({
      table,
      writer,
      clockMap: { framesNow: () => state.now, lookaheadFrames: () => 1000 },
      playheads: { positionNow: () => 0, start: () => {}, retime: () => {} },
      clipInfo: () => ({ id: 1, path: "a.wav", state: "ready", refs: 1, frames: 96_000, channels: 2, sampleRate: 48_000, format: 0, bytes: 0, failure: null }),
      busIndex: () => 0,
      session: { mayQueue: true },
      streamLoop: (i, loop: LoopRecord, at) => void loops.push(["stream", i, loop, at]),
      writerBatches: () => state.batches,
    });
    const voice = (flags = 0): AudioVoice => {
      const id = table.allocate(0, 128, 0, VoiceState.PLAYING as never);
      table.flags[id & 0xffff] = flags;
      return { id } as AudioVoice;
    };
    return { auto, loops, state, voice };
  }

  it("routes a stream voice's loop and release to the stream manager, asked for where a SET_LOOP would land", () => {
    const { auto, loops, voice } = sink();
    const v = voice(VoiceFlag.STREAM);
    auto.onPlaySent(v.id, v.id & 0xffff, undefined);
    auto.setLoop(v, 0.25, 0.5, true);
    auto.setLoop(v, 0.25, 0.5, false);
    expect(loops).toEqual([
      ["stream", v.id & 0xffff, { start: 0.25, end: 0.5, looping: true }, 11_000],
      ["stream", v.id & 0xffff, { start: 0.25, end: 0.5, looping: false }, 11_000],
    ]);
  });

  it("a PLAY still staged (no batch out since) keeps later records behind its stamp even once that is past", () => {
    const { auto, loops, state, voice } = sink();
    const v = voice();
    auto.onPlaySent(v.id, v.id & 0xffff, 10_500);
    state.now = 11_000; // the stamp fell behind F_now while the pool was empty
    auto.setLoop(v, 0.25, 0.5, true);
    state.batches++; // it went out
    auto.setLoop(v, 0.25, 0.5, false);
    expect(loops.map((l) => l[2])).toEqual([10_500, undefined]);
  });
});
