// ADR 0166 R7 acceptance: a seek lands on its planned frame with the 5 ms crossfade, on the real core through the whole
// runtime (`testing/loopbackClock.ts`). The clip is a ramp (level = file seconds / 4 x 0.5), so the output's level says
// which file position sounds. 120 bpm 4/4: bar 2 is file second 2.0 (level 0.25).
import { afterEach, describe, expect, it } from "vitest";
import { musicLoopback, resetMusicLoopback, RATE } from "./testing/loopbackClock";
import { seekMusic, SEEK_FADE_MS } from "./seek";

afterEach(() => resetMusicLoopback());

const SECONDS = 4;
const ramp = (i: number): number => (i / RATE / SECONDS) * 0.5;
const tempo = [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }];
const event = {
  format: "myco.audioevent@1",
  bus: "Music",
  root: { type: "segment", id: "A", tempo, tracks: [{ name: "t", clip: "r.wav" }] },
};
const clips = { "r.wav": { signal: ramp, seconds: SECONDS } };

async function playing(ctx: { skip: () => never }) {
  const r = await musicLoopback({ clips, events: { "m.audioevent.json": event } });
  if (!r) return ctx.skip();
  r.play("m.audioevent.json");
  await r.stepUntil(() => r.player()?.run?.state === "playing");
  await r.step(15);
  return r;
}

describe("music seek on the core (R7)", () => {
  it("lands on its planned frame at the asked bar, through a 5 ms crossfade", async (ctx) => {
    const r = await playing(ctx);
    const player = r.player()!;
    const startA = r.frameOfTime(player.run!.startAt);

    const res = seekMusic(player, "2:1:0");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const planned = r.frameOfTime(res.time);
    await r.stepUntil(() => player.run?.startFrame === 2 * RATE && player.transition === null);
    // The plan is a prediction: a group not ready at its stamp frame moves to the next frame's horizon (here at most a
    // few display frames, 768 frames each), never earlier. The seam is where the group actually starts.
    const seam = r.frameOfTime(player.run!.startAt);
    expect(seam).toBeGreaterThanOrEqual(planned);
    expect(seam - planned).toBeLessThanOrEqual(3 * r.frameFrames);
    await r.stepUntil(() => r.out.length > seam + 3000);

    // Before the seam the old position plays on; the crossfade is the 5 ms from the seam; after it the new position.
    const fadeFrames = Math.round((SEEK_FADE_MS / 1000) * RATE);
    expect(r.maxError(seam - 400, seam, (i) => ramp(i - startA))).toBeLessThan(2e-3);
    const mid = seam + fadeFrames / 2;
    const old = ramp(mid - startA);
    const fresh = ramp(2 * RATE + (mid - seam));
    expect(Math.abs(r.out[mid]! - old)).toBeGreaterThan(0.01);
    expect(Math.abs(r.out[mid]! - fresh)).toBeGreaterThan(0.01);
    expect(r.maxError(seam + fadeFrames + 20, seam + 3000, (i) => ramp(2 * RATE + (i - seam)))).toBeLessThan(2e-3);
    expect(r.late().groupsLate).toBe(0);
    expect(player.run?.startFrame).toBe(2 * RATE);
    expect(player.run?.node.id).toBe("A");
    r.dispose();
  });

  it("lands inside the segment by beat and tick, and clamps past the file's end", async (ctx) => {
    const r = await playing(ctx);
    const player = r.player()!;
    expect(seekMusic(player, "1:3:480").ok).toBe(true); // 2.5 beats in: 1.25 s
    await r.stepUntil(() => player.transition === null, 600);
    expect(player.run?.startFrame).toBe(Math.round(1.25 * RATE));
    expect(seekMusic(player, "99:1:0").ok).toBe(true); // far past the 4 s file: its last frame
    await r.stepUntil(() => player.transition === null, 600);
    expect(player.run?.startFrame).toBe(SECONDS * RATE - 1);
    r.dispose();
  });

  // F-25: the e2e seek case read `groupsLate` 1 now and then, with the clip resident: the group was stamped at F_now + L
  // exactly, and at the e2e's 10 frames a second L is one frame interval (100 ms, its cap), so a BATCH that reached the
  // core a little late started the group late. A seek now keeps a frame of slack, and lands where it said it would.
  it("starts on the reported frame, on time, though its BATCH reaches the core more than L late (10 frames a second)", async (ctx) => {
    const r = await musicLoopback({ clips, events: { "m.audioevent.json": event }, quantaPerFrame: 38 });
    if (!r) return ctx.skip();
    r.play("m.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    await r.step(15);
    const player = r.player()!;
    const L = (r.backend as unknown as { clockMap: { lookaheadFrames(): number } }).clockMap.lookaheadFrames();
    expect(L, "L is at its 100 ms cap: one frame interval").toBe(0.1 * RATE);

    // Asked between frames (as a page script or the editor transport asks): stamped in the next frame, whose BATCH is
    // held back 50 quanta (133 ms), longer than L.
    const res = seekMusic(player, "2:1:0");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    r.delayBatches(50);
    await r.stepUntil(() => player.transition === null, 100);
    await r.step(3);
    expect(r.late(), "the core started the group on its stamp").toEqual({ groupsLate: 0, maxSlipFrames: 0 });
    expect(r.frameOfTime(player.run!.startAt), "it starts on the frame the seek reported").toBe(r.frameOfTime(res.time));
    expect(player.counters.lateGroups).toBe(0);
    expect(player.run?.startFrame).toBe(2 * RATE);
    // The new position sounds from that frame on.
    const seam = r.frameOfTime(res.time);
    await r.stepUntil(() => r.out.length > seam + 3000);
    expect(r.maxError(seam + 400, seam + 3000, (i) => ramp(2 * RATE + (i - seam)))).toBeLessThan(2e-3);
    r.dispose();
  });

  it("replaces a seek that has not passed its cancel point", async (ctx) => {
    const r = await playing(ctx);
    const player = r.player()!;
    expect(seekMusic(player, "2:1:0").ok).toBe(true);
    expect(seekMusic(player, "1:2:0").ok).toBe(true);
    await r.stepUntil(() => player.transition === null, 600);
    expect(player.run?.startFrame).toBe(Math.round(0.5 * RATE));
    r.dispose();
  });
});
