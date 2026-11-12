// ADR 0166 R4b: a streamed music member's region release on the loopback host (the real core and decoder worker,
// `testing/streamRig.ts` with a music ring pool). A member's stream is musicOps's, not the stream manager's, so its
// loop record (`AutomationSink.setLoop`, what `loopTail.ts` sends when R4b releases a `while` region or a counted
// region's passes are used up) reaches the worker through `streams.setLoop` → `musicOps.setLoop` → `loopStream`, at
// the end of the voice's current pass. Before R4b the stream manager dropped it (no entry for a member's stream) and the
// member looped for ever. The file is a 16-bit WAV at the context rate and the limiter has no look-ahead, so the output
// is the file's samples exactly and output index = core frame.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWav, signal } from "../decoder/testWav";
import { RATE, rig } from "../../testing/streamRig";
import type { MusicGroupRequest } from "../backend";

const FILE_FRAMES = 2 * RATE;
const want = (k: number) => signal(k, 0) / 32768;
const file = () => makeWav(FILE_FRAMES, 2, RATE, signal);
/** The file frame a stream started at 0 plays at stream frame `k`, looping `start..end`. */
const looped = (k: number, start: number, end: number) => (k < end ? k : start + ((k - start) % (end - start)));

afterEach(() => vi.restoreAllMocks());

/**
 * Plays `music/s.wav` as a streamed music group member looping `start..end` seconds; steps until the release would be
 * asked `before` frames ahead of the seam ending pass `pass` (as far as frame steps allow), releases it through the
 * automation sink, plays out; returns the measures.
 */
async function memberRelease(start: number, end: number, pass: number, before: number) {
  const r = await rig({ "music/s.wav": file() }, { musicRings: 2 });
  if (!r) return null;
  const [a, b] = [Math.round(start * RATE), Math.round(end * RATE)];
  const music = r.backend.music;
  const req: MusicGroupRequest = {
    instance: 1,
    group: 3,
    members: [{ stem: "s0", play: { path: "music/s.wav", url: "", loop: false, stream: true, bus: "Music" }, startFrame: 0, loop: true, loopStartFrame: a, loopEndFrame: b }],
  };
  expect(music.admitGroup(req).ok).toBe(true);
  music.primeGroup(req);
  await vi.waitFor(
    async () => {
      r.streamPort?.()?.pump();
      await r.step(1);
      expect(music.primedState(3)?.ready).toBe(true);
    },
    { timeout: 5_000, interval: 5 },
  );
  const [voice] = music.stampGroup({ group: 3, at: r.backend.time + 0.05 });
  expect(voice).toBeTruthy();
  await r.step(12);
  let at = 0;
  while (at < r.left.length && r.left[at] === 0) at++;
  let lead = 0;
  while (want(lead) === 0) lead++;
  at -= lead;
  expect(at).toBeGreaterThan(0);
  const seam = at + b + pass * (b - a); // output index of the seam ending pass `pass + 1`
  // biome-ignore lint: test-only access to the backend's clock
  const clock = (r.backend as unknown as { clockMap: { framesNow(): number; lookaheadFrames(): number } }).clockMap;
  const asked = () => clock.framesNow() + clock.lookaheadFrames();
  while (asked() + 512 < seam - before) await r.step(1);
  const requested = asked();
  r.backend.automation.setLoop(voice!, start, end, false);
  await r.step(Math.ceil((FILE_FRAMES + (b - a) * (pass + 2)) / 512) + 20);
  const out = r.left;
  const seams: number[] = [];
  for (let n = 0; at + b + n * (b - a) < out.length; n++) seams.push(at + b + n * (b - a));
  const expected = seams.find((s) => s > requested)!;
  const tailAt = seams.find((s) => {
    for (let m = 0; m < 64; m++) if (out[s + m] !== want(b + m)) return false;
    return true;
  });
  if (tailAt !== undefined) {
    for (let j = at; j < tailAt; j++) if (out[j] !== want(looped(j - at, a, b))) expect.fail(`output ${j}: not the loop (stream frame ${j - at})`);
    for (let m = 0; m < FILE_FRAMES - b; m++) if (out[tailAt + m] !== want(b + m)) expect.fail(`after the region, frame ${m}`);
    expect(out.slice(tailAt + FILE_FRAMES - b).every((s) => s === 0)).toBe(true);
  }
  const result = {
    lateness: tailAt === undefined ? Number.NaN : tailAt - expected,
    ahead: expected - requested,
    playing: voice!.playing,
    underruns: r.backend.mirror.underruns,
  };
  r.backend.dispose();
  return result;
}

describe("a streamed music member's region release (R4b, the worker's region-release splice)", () => {
  // A region shorter than the ring (12,000 frames): the worker has wrapped past the seam already, so it splices.
  for (const before of [3_000, 600]) {
    it(`released ${before} frames before a seam, it plays on past the region from that seam (a splice)`, async (ctx) => {
      const m = await memberRelease(0.25, 0.5, 2, before);
      if (!m) return ctx.skip();
      expect(m.ahead).toBeGreaterThan(0);
      expect(m.ahead).toBeLessThanOrEqual(before + 512);
      expect(m.lateness).toBe(0);
      expect(m.playing).toBe(false); // it played the file to its end and ended
      expect(m.underruns).toBe(0);
    });
  }

  // A region longer than the ring (0.2..1.4 s), asked 40,000 frames before a seam: the worker hadn't sent it yet.
  it("released early in a pass of a region longer than the ring, it plays on from that pass's end (no splice)", async (ctx) => {
    const m = await memberRelease(0.2, 1.4, 1, 40_000);
    if (!m) return ctx.skip();
    expect(m.ahead).toBeGreaterThan(30_000);
    expect(m.lateness).toBe(0);
    expect(m.playing).toBe(false);
  });
});
