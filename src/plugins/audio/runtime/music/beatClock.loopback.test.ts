// ADR 0166 K1: the beat clock against the heard grid on the real core (T1's deterministic loopback fixture). The clips
// click on every beat of their tempo map, so the core's output says where each beat is heard; each display frame asks
// the beat clock for the beats due (as K2's dispatch will) with that frame's `Audio.time` and Δ̄. Every click is
// predicted exactly once, on its sample, in the frame whose window [Audio.time, Audio.time + Δ̄) holds it.
import { afterEach, describe, expect, it } from "vitest";
import type { MusicEvent } from "../../../../engine/audio/musicTypes";
import { predictDue } from "./beatClock";
import { musicLoopback, resetMusicLoopback, RATE, type MusicLoopback } from "./testing/loopbackClock";

afterEach(() => resetMusicLoopback());

const BASE = 0.1;
const CLICK = 0.5;
/** A clip that clicks on each beat frame (file frames at 48 kHz). */
const clicking = (beatFrames: readonly number[], seconds: number) => {
  const set = new Set(beatFrames);
  return { seconds, signal: (i: number) => (set.has(i) ? CLICK : BASE) };
};
/** Beat frames of 4/4 at `bpm` from `from` (file frames), `count` beats. */
const beatsAt = (bpm: number, from: number, count: number) => Array.from({ length: count }, (_, k) => from + Math.round((k * 60 * RATE) / bpm));

interface Heard {
  time: number;
  frame: number;
  bar: number;
  beat: number;
  segment: string;
  now: number;
  interval: number;
}

/** Steps `frames` display frames, asking for the due beat after each frame's clock step. */
async function collect(r: MusicLoopback, frames: number): Promise<Heard[]> {
  const out: Heard[] = [];
  const e = { handle: null } as unknown as MusicEvent;
  for (let k = 0; k < frames; k++) {
    await r.step(1);
    const p = r.player();
    if (!p) continue;
    const now = r.backend.time;
    const interval = r.backend.frameInterval();
    if (predictDue(p, "beat", now, interval, e)) {
      expect(e.missed).toBe(0);
      out.push({ time: e.time, frame: r.frameOfTime(e.time), bar: e.bar, beat: e.beat, segment: e.segment, now, interval });
    }
  }
  return out;
}

/** The output frames that click (a click is one sample over the base level). */
const clicks = (r: MusicLoopback, from: number, to: number) => {
  const at: number[] = [];
  for (let i = from; i < Math.min(to, r.out.length); i++) if (r.out[i]! > (BASE + CLICK) / 2) at.push(i);
  return at;
};

describe("predicted beats match the heard grid on the core (K1)", () => {
  it("across a tempo change: every click predicted once, on its sample, in its frame", async (ctx) => {
    // 120 bpm for two bars, then 90 bpm (32,000 frames a beat).
    const files = [...beatsAt(120, 0, 8), ...beatsAt(90, 8 * 24_000, 12)];
    const r = await musicLoopback({
      clips: { "a.wav": clicking(files, 12) },
      events: {
        "m.audioevent.json": {
          format: "myco.audioevent@1", bus: "Music",
          root: { type: "segment", id: "A", value: "A", tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }, { at: "3:1:0", bpm: 90, beatsPerBar: 4, beatUnit: 4 }], tracks: [{ name: "t", clip: "a.wav" }] },
        },
      },
    });
    if (!r) return ctx.skip();
    r.play("m.audioevent.json");
    const heard = await collect(r, 1000); // 16 s of 62.5 Hz frames: past the clip's end (12 s, the exit)
    const start = heard[0]!.frame; // the clip's first sample is beat 1
    const want = clicks(r, start, r.out.length);
    expect(want).toEqual(files.map((f) => start + f));
    // Every click once, on its sample; nothing predicted past the exit.
    expect(heard.map((h) => h.frame)).toEqual(want);
    for (const h of heard) {
      expect(h.time).toBeGreaterThanOrEqual(h.now - 1e-9);
      expect(h.time).toBeLessThan(h.now + h.interval);
    }
    expect(heard.slice(7, 10).map((h) => [h.bar, h.beat])).toEqual([[2, 4], [3, 1], [3, 2]]);
    r.dispose();
  });

  it("over a quantised change to another segment: A's clicks then B's, none doubled or lost at the seam", async (ctx) => {
    const r = await musicLoopback({
      clips: { "a.wav": clicking(beatsAt(120, 0, 40), 20), "b.wav": clicking(beatsAt(100, 0, 33), 20) },
      events: {
        "sw.audioevent.json": {
          format: "myco.audioevent@1", bus: "Music",
          parameters: [{ name: "zone", labels: ["A", "B"] }],
          root: {
            type: "musicSwitch", id: "sw", parameter: "zone",
            children: [
              { type: "segment", id: "A", value: "A", tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }], tracks: [{ name: "t", clip: "a.wav" }] },
              { type: "segment", id: "B", value: "B", tempo: [{ at: "1:1:0", bpm: 100, beatsPerBar: 4, beatUnit: 4 }], tracks: [{ name: "t", clip: "b.wav" }] },
            ],
            transitions: [{ from: "A", to: "B", exit: "bar", fadeOut: { beats: 0 }, fadeIn: { beats: 0 } }],
          },
        },
      },
    });
    if (!r) return ctx.skip();
    const h = r.play("sw.audioevent.json");
    const heard = await collect(r, 300);
    h.setParameter("zone", "B");
    heard.push(...(await collect(r, 500)));
    const start = r.frameOfTime(heard[0]!.time);
    const want = clicks(r, start, r.out.length - r.frameFrames * 2);
    const got = heard.map((x) => x.frame).filter((f) => f <= want.at(-1)!);
    expect(got).toEqual(want);
    const seam = heard.findIndex((x) => x.segment === "B");
    expect(seam).toBeGreaterThan(0);
    expect(heard[seam]!).toMatchObject({ bar: 1, beat: 1 });
    expect(heard[seam - 1]!.beat).toBe(4); // A's last beat before its bar line
    for (const x of heard) {
      expect(x.time).toBeGreaterThanOrEqual(x.now - 1e-9);
      expect(x.time).toBeLessThan(x.now + x.interval);
    }
    r.dispose();
  });
});
