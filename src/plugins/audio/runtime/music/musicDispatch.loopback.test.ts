// ADR 0166 K2 on the real core (T1's loopback fixture): a `GameBehavior` on the node of an `AudioSource` that plays music
// hears `onMusicBeat` and `onMusicBar` through the engine's own `engine.AudioMusic` step. Each click of the clip is one
// call, in the frame whose window [Audio.time, Audio.time + Δ̄) holds it, across a tempo change.
import { afterEach, describe, expect, it } from "vitest";
import { GameBehavior, GameObject } from "../../../../myco";
import type { MusicEvent } from "../../../../engine/audio/musicTypes";
import { AudioSource } from "../AudioSource";
import { musicLoopback, resetMusicLoopback, RATE, type MusicLoopback } from "./testing/loopbackClock";

afterEach(() => resetMusicLoopback());

const BASE = 0.1;
const CLICK = 0.5;
const beatsAt = (bpm: number, from: number, count: number) => Array.from({ length: count }, (_, k) => from + Math.round((k * 60 * RATE) / bpm));

interface Call {
  e: MusicEvent;
  now: number;
  interval: number;
  frame: number;
}

class Listener extends GameBehavior {
  beats: Call[] = [];
  bars: Call[] = [];
  /** Set by the test each frame before the step: the frame's clock is read in the hook. */
  r!: MusicLoopback;
  onMusicBeat(e: MusicEvent): void {
    this.beats.push({ e: { ...e }, now: this.r.backend.time, interval: this.r.backend.frameInterval(), frame: this.r.frameOfTime(e.time) });
  }
  onMusicBar(e: MusicEvent): void {
    this.bars.push({ e: { ...e }, now: this.r.backend.time, interval: this.r.backend.frameInterval(), frame: this.r.frameOfTime(e.time) });
  }
}

const clicking = (frames: readonly number[], seconds: number) => {
  const set = new Set(frames);
  return { seconds, signal: (i: number) => (set.has(i) ? CLICK : BASE) };
};

describe("onMusicBeat / onMusicBar on the core (K2)", () => {
  it("a component on the AudioSource's node hears every beat once, in its frame, across a tempo change", async (ctx) => {
    // 120 bpm for two bars, then 90 bpm.
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
    const node = GameObject.create("music");
    const listener = node.addBehavior(Listener);
    listener.r = r;
    node.addBehavior(AudioSource, { clip: "asset:m.audioevent.json", playOnAwake: false }).play();
    await r.step(1000); // 16 s of 62.5 Hz frames: past the clip's end (12 s)

    const heard = listener.beats;
    const start = heard[0]!.frame; // the clip's first sample is beat 1
    const want: number[] = [];
    for (let i = start; i < r.out.length; i++) if (r.out[i]! > (BASE + CLICK) / 2) want.push(i);
    expect(want).toEqual(files.map((f) => start + f));
    expect(heard.map((h) => h.frame)).toEqual(want);
    for (const h of heard) {
      expect(h.e.missed).toBe(0);
      expect(h.e.time).toBeGreaterThanOrEqual(h.now - 1e-9);
      expect(h.e.time).toBeLessThan(h.now + h.interval);
      expect(h.e.heardIn).toBeCloseTo(h.e.time - h.now, 9);
      expect(h.e.segment).toBe("A");
      expect(h.e.handle.playing).toBeDefined();
    }
    expect(heard.slice(7, 10).map((h) => [h.e.bar, h.e.beat, h.e.tempo])).toEqual([[2, 4, 120], [3, 1, 90], [3, 2, 90]]);
    // Bars: beat 1 of each bar, 3 bars of 4 beats at 120 then 90: bars 1..5.
    expect(listener.bars.map((b) => [b.e.bar, b.e.beat])).toEqual([[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]]);
    r.dispose();
  });

  it("a component that gains the hook mid-play owes nothing for the stretch before: no backlog, no repeat", async (ctx) => {
    const r = await musicLoopback({
      clips: { "a.wav": clicking(beatsAt(120, 0, 40), 20) },
      events: {
        "m.audioevent.json": {
          format: "myco.audioevent@1", bus: "Music",
          root: { type: "segment", id: "A", value: "A", tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }], tracks: [{ name: "t", clip: "a.wav" }] },
        },
      },
    });
    if (!r) return ctx.skip();
    const node = GameObject.create("music");
    const listener = node.addBehavior(Listener);
    listener.r = r;
    listener.enabled = false;
    node.addBehavior(AudioSource, { clip: "asset:m.audioevent.json", playOnAwake: false }).play();
    await r.step(250); // 4 s, eight beats, unheard by the component
    expect(listener.beats).toEqual([]);
    const enabledAt = r.backend.time;
    listener.enabled = true;
    await r.step(250);
    expect(listener.beats.length).toBeGreaterThanOrEqual(7);
    expect(listener.beats[0]!.e.time).toBeGreaterThanOrEqual(enabledAt - 1e-9);
    const times = listener.beats.map((b) => b.e.time);
    expect(new Set(times).size).toBe(times.length);
    for (const h of listener.beats) expect(h.e.missed).toBe(0);
    r.dispose();
  });

  it("handle.onMusic (K5): a script on Audio.play hears each beat once, on time, plus bars and a cue; none after unsubscribe", async (ctx) => {
    const files = beatsAt(120, 0, 24);
    const r = await musicLoopback({
      clips: { "a.wav": clicking(files, 12) },
      events: {
        "m.audioevent.json": {
          format: "myco.audioevent@1", bus: "Music",
          root: { type: "segment", id: "A", value: "A", cues: [{ name: "drop", at: "2:1:0" }], tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }], tracks: [{ name: "t", clip: "a.wav" }] },
        },
      },
    });
    if (!r) return ctx.skip();
    const beats: Call[] = [];
    const bars: number[] = [];
    const cues: (string | undefined)[] = [];
    const h = r.play("m.audioevent.json");
    const call = (e: MusicEvent): Call => ({ e: { ...e }, now: r.backend.time, interval: r.backend.frameInterval(), frame: r.frameOfTime(e.time) });
    const offBeat = h.onMusic("beat", (e) => beats.push(call(e)));
    h.onMusic("bar", (e) => bars.push(e.bar));
    h.onMusic("cue", (e) => cues.push(e.cue));
    await r.stepUntil(() => beats.length >= 12);
    const start = beats[0]!.frame;
    for (const b of beats) {
      expect(b.e.missed).toBe(0);
      expect(b.e.time).toBeGreaterThanOrEqual(b.now - 1e-9);
      expect(b.e.time).toBeLessThan(b.now + b.interval);
    }
    expect(beats.map((b) => b.frame)).toEqual(files.slice(0, beats.length).map((f) => start + f));
    offBeat();
    offBeat();
    const heardBeats = beats.length;
    await r.step(500); // 8 s more: bars and the cue keep coming, beats do not
    expect(beats.length).toBe(heardBeats);
    expect(bars.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(cues).toContain("drop");
    r.dispose();
  });
});
