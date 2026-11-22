/**
 * One test per mapping rule of the `myco.audioevent@1` → `myco.playlist@1` migration (ADR 0329, 0333). Each builds an
 * event the way callers do (`parseAudioEvent` of the JSON) and checks the playlist fields and notes.
 */
import { describe, expect, it } from "vitest";
import { parseAudioEvent } from "../eventFormat";
import type { Attenuation } from "../attenuation/types";
import type { EmbeddedEntry, PlaylistBody, SampleEntry } from "../playlist/types";
import { migrateAudioEvent, type MigrateOptions } from "./audioEvent1";
import { validatePlaylist } from "./testing/playlistShape";

const PATH = "audio/a.audioevent.json";

function mig(json: Record<string, unknown>, options: MigrateOptions = {}, parseProblems = false) {
  const { value, problems } = parseAudioEvent({ format: "myco.audioevent@1", ...json });
  if (!parseProblems) expect(problems).toEqual([]);
  const out = migrateAudioEvent(value, PATH, options);
  expect(validatePlaylist(out.playlist)).toEqual([]);
  return out;
}

const clip = (path: string, extra: Record<string, unknown> = {}) => ({ type: "clip", clip: path, ...extra });
const embedded = (b: PlaylistBody, i: number): PlaylistBody => (b.entries[i] as EmbeddedEntry).embedded;
const sampleOf = (b: PlaylistBody): SampleEntry => b.entries[0] as SampleEntry;
const hasNote = (notes: string[], text: string) => expect(notes.some((n) => n.startsWith(PATH) && n.includes(text)), `${text} in\n${notes.join("\n")}`).toBe(true);
const lengths = (table: Record<string, number>): MigrateOptions => ({ sampleSeconds: (p) => table[p] });

describe("containers (ADR 0158 nodes)", () => {
  it("clip → Clip with one sample, loop off, gains in dB and pitch in semitones", () => {
    const { playlist, notes } = mig({ root: clip("a.wav", { volume: 0.5, pitch: 2 }) });
    expect(playlist.type).toBe("clip");
    expect(playlist.entries).toHaveLength(1);
    expect(sampleOf(playlist)).toMatchObject({ kind: "sample", sample: "a.wav", loop: "off", trim: null });
    expect(playlist.volume).toBeCloseTo(-6.021, 3);
    expect(playlist.pitch).toBe(12);
    expect(playlist.playback.plays).toBe("oneShot");
    expect(notes).toEqual([]);
  });

  it("a looping clip loops its sample (on) and plays until stopped", () => {
    const { playlist, notes } = mig({ root: clip("a.wav", { loop: true }) });
    expect(sampleOf(playlist).loop).toBe("on");
    expect(playlist.playback.plays).toBe("untilStopped");
    hasNote(notes, `"inherit"`);
  });

  it("startOffset becomes a trim when the sample's length is known, else a note", () => {
    expect(sampleOf(mig({ root: clip("a.wav", { startOffset: 0.25 }) }, lengths({ "a.wav": 2 })).playlist).trim).toEqual([0.25, 2]);
    const without = mig({ root: clip("a.wav", { startOffset: 0.25 }) });
    expect(sampleOf(without.playlist).trim).toBeNull();
    hasNote(without.notes, "startOffset 0.25 s needs the sample's length");
  });

  it("loop + loopRegion → a one-clip Sequence whose loop is the region (always), shifted by the start offset", () => {
    const { playlist } = mig({ root: clip("a.wav", { loop: true, loopRegion: [0.5, 1.5], startOffset: 0.25 }) }, lengths({ "a.wav": 3 }));
    expect(playlist.type).toBe("sequence");
    const seq = playlist.sequence!;
    expect(seq.length).toBe(2.75);
    expect(seq.tracks).toHaveLength(1);
    expect(seq.tracks[0]).toMatchObject({ kind: "audio", clips: [{ sample: "a.wav", at: 0, length: 2.75, offset: 0.25 }] });
    expect(seq.loops).toEqual([{ id: "l1", start: 0.25, end: 1.25, active: "always", exit: "finish", exitFadeMs: 0, reentry: "ignore" }]);
    expect(playlist.playback.plays).toBe("untilStopped");
  });

  it("a sustain clip → a held sequence loop over its region (or the whole clip)", () => {
    const region = mig({ root: clip("a.wav", { sustain: true, loopRegion: [0.5, 1.5] }) }, lengths({ "a.wav": 2 })).playlist;
    expect(region.sequence!.loops[0]).toMatchObject({ start: 0.5, end: 1.5, active: "held", exit: "finish" });
    expect(region.playback.plays).toBe("oneShot");
    const whole = mig({ root: clip("a.wav", { sustain: true }) }, lengths({ "a.wav": 2 })).playlist;
    expect(whole.sequence!.loops[0]).toMatchObject({ start: 0, end: 2, active: "held" });
    const unknown = mig({ root: clip("a.wav", { sustain: true }) });
    expect(unknown.playlist.sequence!.loops).toEqual([]);
    hasNote(unknown.notes, "length unknown");
  });

  it("random → Queue random with avoidRepeat and weights (integers kept, others scaled to 0..100)", () => {
    const a = mig({ root: { type: "random", avoidRepeat: 1, children: [clip("a.wav", { weight: 3 }), clip("b.wav"), clip("c.wav", { weight: 0 })] } }).playlist;
    expect(a.type).toBe("queue");
    expect(a.queue).toEqual({ pick: "random", avoidRepeat: 1, continuous: null });
    expect(a.entries.map((e) => e.weight)).toEqual([3, 1, 0]);
    expect(embedded(a, 0).type).toBe("clip");
    expect(sampleOf(embedded(a, 1)).sample).toBe("b.wav");
    const b = mig({ root: { type: "random", children: [clip("a.wav", { weight: 0.5 }), clip("b.wav", { weight: 0.25 })] } });
    expect(b.playlist.entries.map((e) => e.weight)).toEqual([100, 50]);
    hasNote(b.notes, "weights were scaled");
  });

  it("continuous random → Queue with continuous gapMs (a negative gap kept, with a note)", () => {
    const { playlist, notes } = mig({ root: { type: "random", mode: "continuous", gap: -0.5, children: [clip("a.wav"), clip("b.wav")] } });
    expect(playlist.queue!.continuous).toEqual({ gapMs: -500 });
    expect(playlist.playback.plays).toBe("untilStopped");
    hasNote(notes, "overlaps picks");
  });

  it("step sequence → Queue round robin (reset noted); continuous sequence → continuous round robin", () => {
    const step = mig({ root: { type: "sequence", reset: 2, children: [clip("a.wav"), clip("b.wav")] } });
    expect(step.playlist.queue).toEqual({ pick: "roundRobin", avoidRepeat: 0, continuous: null });
    hasNote(step.notes, "reset after 2 s idle");
    const cont = mig({ root: { type: "sequence", mode: "continuous", gap: 0.25, loop: true, children: [clip("a.wav")] } });
    expect(cont.playlist.queue).toEqual({ pick: "roundRobin", avoidRepeat: 0, continuous: { gapMs: 250 } });
    expect(cont.notes).toEqual([]);
    hasNote(mig({ root: { type: "sequence", mode: "continuous", children: [clip("a.wav")] } }).notes, "stopped after its last child");
  });

  it("switch → Switch: map over the local labels (unmatched labels → the default child), onChange keep/restart/crossfade", () => {
    const params = [{ name: "Surface", labels: ["Grass", "Wood", "Metal"], default: "Grass" }];
    const children = [clip("g.wav", { value: "Grass" }), clip("w.wav", { value: "Wood" })];
    const keep = mig({ parameters: params, root: { type: "switch", parameter: "Surface", default: "Wood", children } }).playlist;
    expect(keep.switch).toEqual({
      parameter: "Surface", map: { Grass: 0, Wood: 1, Metal: 1 }, labelGain: {}, rules: [],
      onChange: { when: "nextTrigger", how: "cut", length: { ms: 0 } },
    });
    expect(mig({ parameters: params, root: { type: "switch", parameter: "Surface", onChange: "restart", children } }).playlist.switch!.onChange)
      .toEqual({ when: "now", how: "cut", length: { ms: 0 } });
    expect(mig({ parameters: params, root: { type: "switch", parameter: "Surface", onChange: "crossfade", crossfade: 0.3, children } }).playlist.switch!.onChange)
      .toEqual({ when: "now", how: "crossfade", length: { ms: 300 } });
  });

  it("switch on a global parameter maps only the children's values, with a note", () => {
    const { playlist, notes } = mig({ root: { type: "switch", parameter: "Surface", children: [clip("g.wav", { value: "Grass" })] } });
    expect(playlist.switch!.map).toEqual({ Grass: 0 });
    hasNote(notes, `"Surface" is not a local parameter`);
  });

  it("blend → Blend 1D with entries at range midpoints; a note where fades overlapped", () => {
    const { playlist, notes } = mig({
      parameters: [{ name: "RPM", min: 0, max: 1 }],
      root: { type: "blend", parameter: "RPM", children: [clip("a.wav", { range: [0, 0.1], fade: 0.4 }), clip("b.wav", { range: [0.45, 0.55], fade: 0.4 }), clip("c.wav", { range: [0.9, 1], fade: 0.4 })] },
    });
    expect(playlist.blend).toMatchObject({ axes: [{ parameter: "RPM" }], fade: "crossfade", curve: "linear", follow: { glideMs: 0 }, envelope: { mode: "off" } });
    expect(playlist.entries.map((e) => e.x)).toEqual([0.05, 0.5, 0.95]);
    expect(playlist.entries.every((e) => e.atZeroWeight === "continue")).toBe(true);
    hasNote(notes, "fades overlapped");
  });

  it("blend children with plateaus or gaps between fades are noted", () => {
    const { notes } = mig({ root: { type: "blend", parameter: "X", children: [clip("a.wav", { range: [0, 0.1], fade: 0.2 }), clip("b.wav", { range: [0.9, 1], fade: 0.2 })] } });
    hasNote(notes, "plateaus and fade widths became points");
  });

  it("blend children at points whose fades reach their neighbours migrate without a note", () => {
    const { notes } = mig({ root: { type: "blend", parameter: "X", children: [clip("a.wav", { range: [0, 0], fade: 1 }), clip("b.wav", { range: [1, 1], fade: 1 })] } });
    expect(notes).toEqual([]);
  });

  it("layer → Layer; a delayed child is an embedded playlist with playback.delay (above 2 s clamped, noted)", () => {
    const { playlist, notes } = mig({ root: { type: "layer", children: [clip("a.wav"), clip("b.wav", { delay: 0.5 }), clip("c.wav", { delay: 3 })] } });
    expect(playlist.type).toBe("layer");
    expect([0, 1, 2].map((i) => embedded(playlist, i).playback.delay)).toEqual([0, 0.5, 2]);
    hasNote(notes, "delay 3 s is above the playlist limit");
  });

  it("node volume, pitch and randomness go on the embedded playlist", () => {
    const { playlist } = mig({ root: { type: "layer", children: [clip("a.wav", { volume: 2, pitch: 0.5, volumeRandom: [-3, 0], pitchRandom: [-1, 1] })] } });
    expect(embedded(playlist, 0)).toMatchObject({ volume: 6.021, pitch: -12, volumeRandom: [-3, 0], pitchRandom: [-1, 1] });
  });

  it("sustain → Sequence: start, loop and end in a row with a held loop over the loop clip's region", () => {
    const { playlist } = mig({
      root: { type: "sustain", start: clip("s.wav"), loop: clip("l.wav", { loop: true, loopRegion: [0.5, 1.5] }), end: clip("e.wav"), release: "now", releaseFade: 0.1 },
    }, lengths({ "s.wav": 1, "l.wav": 2, "e.wav": 0.5 }));
    const seq = playlist.sequence!;
    expect(seq.length).toBe(3.5);
    const sustain = seq.tracks.find((t) => t.name === "Sustain")!;
    expect(sustain.clips.map((c) => [c.at, c.length])).toEqual([[0, 1], [3, 0.5]]);
    expect(seq.tracks.find((t) => t.name === "Loop")!.clips).toMatchObject([{ sample: "l.wav", at: 1, length: 2 }]);
    expect(seq.loops).toEqual([{ id: "l1", start: 1.5, end: 2.5, active: "held", exit: "crossfade", exitFadeMs: 100, reentry: "ignore" }]);
  });

  it("sustain release loopEnd finishes the pass; a non-clip loop section is a playlist clip (noted)", () => {
    const { playlist, notes } = mig({ root: { type: "sustain", loop: { type: "random", children: [clip("l.wav")] }, release: "loopEnd" } }, lengths({ "l.wav": 2 }));
    expect(playlist.sequence!.loops[0]).toMatchObject({ start: 0, end: 2, active: "held", exit: "finish" });
    expect(playlist.sequence!.tracks[0].clips[0].playlist).toMatchObject({ type: "queue" });
    hasNote(notes, "the loop section is a random");
  });
});

describe("event fields", () => {
  it("limit, steal, cooldown, priority, bus and volume/pitch become playback, output, dB and semitones", () => {
    const { playlist, notes } = mig({
      bus: "SFX", volume: 0.5, pitch: 0.5, priority: 200, cooldown: 7, volumeRandom: [-2, 0], pitchRandom: [-1, 1],
      limit: { maxInstances: 40, steal: "quietest" }, root: clip("a.wav", { volume: 0.5 }),
    });
    expect(playlist.output).toBe("SFX");
    expect(playlist.playback).toEqual({ plays: "oneShot", maxInstances: 32, whenFull: "stealQuietest", cooldown: 5, chance: 1, delay: 0, priority: 200 });
    expect(playlist.volume).toBeCloseTo(-12.04, 2);
    expect(playlist.pitch).toBe(-12);
    expect(playlist.volumeRandom).toEqual([-2, 0]);
    expect(playlist.pitchRandom).toEqual([-1, 1]);
    hasNote(notes, "maxInstances 40");
    hasNote(notes, "7 s is above 5 s");
  });

  it("steal none → refuse; oldest → stealOldest; an empty bus is inherited (null)", () => {
    expect(mig({ limit: { maxInstances: 2, steal: "none" }, root: clip("a.wav") }).playlist.playback.whenFull).toBe("refuse");
    const p = mig({ limit: { maxInstances: 2, steal: "oldest" }, root: clip("a.wav") }).playlist;
    expect(p.playback.whenFull).toBe("stealOldest");
    expect(p.output).toBeNull();
  });

  it("the event's and the root's random ranges add, with a note", () => {
    const { playlist, notes } = mig({ volumeRandom: [-2, 0], root: clip("a.wav", { volumeRandom: [-1, 1] }) });
    expect(playlist.volumeRandom).toEqual([-3, 1]);
    hasNote(notes, "random ranges were added");
  });

  it("parameters are copied as local parameters", () => {
    const parameters = [{ name: "Speed", min: 0, max: 10, default: 2, seekSpeed: 5 }, { name: "Mode", labels: ["a", "b"], default: "b" }];
    expect(mig({ parameters, root: clip("a.wav") }).playlist.parameters).toEqual(parameters);
  });

  it("spatial linear rolloff → volume keys from 0 dB at min to silence at max; default reverb send → dB over metres", () => {
    const { playlist } = mig({ spatial: { minDistance: 2, maxDistance: 14, rolloff: "linear", occlusion: false, dopplerLevel: 0.5 }, root: clip("a.wav") });
    const sp = playlist.spatial!;
    expect(sp).toMatchObject({ occlusion: false, doppler: 0.5, spread: null });
    const att = sp.attenuation as Exclude<typeof sp.attenuation, string | null>;
    expect(att.minDistance).toBe(2);
    expect(att.maxDistance).toBe(14);
    const vol = att.curves.volume!;
    expect(vol.slice(0, 2)).toEqual([[0, 0], [2, 0]]);
    expect(vol[vol.length - 1]).toEqual([14, -96]);
    expect(vol[7]).toEqual([8, -6.021]); // halfway: gain 0.5
    const send = att.curves.reverbSend!;
    expect(send[0]).toEqual([2, 0]);
    expect(send[send.length - 1]).toEqual([14, -6.021]);
  });

  it("spatial inverse rolloff → min/d sampled to max (noted); occlusion defaults on, doppler 0", () => {
    const { playlist, notes } = mig({ spatial: { minDistance: 1, maxDistance: 100, rolloff: "inverse" }, root: clip("a.wav") });
    const volume = (playlist.spatial!.attenuation as Attenuation).curves.volume!;
    expect(volume[volume.length - 1]).toEqual([100, -40]);
    expect(volume[7][1]).toBeCloseTo(20 * Math.log10(1 / volume[7][0]), 2);
    expect(playlist.spatial).toMatchObject({ occlusion: true, doppler: 0 });
    hasNote(notes, `rolloff "inverse" sampled`);
  });

  it("reverbSendCurve and sends.reverb → the reverbSend curve in dB keyed on metres", () => {
    const { playlist } = mig({
      spatial: { minDistance: 0, maxDistance: 10, rolloff: "linear", reverbSendCurve: [[0, 1], [1, 0.25, "step"]] }, sends: { reverb: 0.5 }, root: clip("a.wav"),
    });
    const send = (playlist.spatial!.attenuation as Attenuation).curves.reverbSend!;
    expect(send[0]).toEqual([0, -6.021]);
    expect(send[send.length - 1]).toEqual([10, -18.062, "step"]);
  });

  it("filter → low-pass and high-pass effects on the playlist (off values skipped)", () => {
    expect(mig({ filter: { lowpass: 800, highpass: 120 }, root: clip("a.wav") }).playlist.effects).toEqual([
      { id: "fx1", type: "lowpass", on: true, params: { cutoff: 800 } },
      { id: "fx2", type: "highpass", on: true, params: { cutoff: 120 } },
    ]);
    expect(mig({ filter: { lowpass: 20000, highpass: 20 }, root: clip("a.wav") }).playlist.effects).toEqual([]);
  });

  it("an aux send and a flat reverb send are dropped with notes", () => {
    const { notes } = mig({ sends: { reverb: 0.5, Cave: 0.3 }, root: clip("a.wav") });
    hasNote(notes, `aux send to "Cave"`);
    hasNote(notes, "a reverb send of 0.5 on a flat event");
  });
});

describe("automation", () => {
  it("event automation → a voice curve on every root entry, volume resampled into dB", () => {
    const { playlist } = mig({
      parameters: [{ name: "Speed", min: 0, max: 1 }],
      automation: [{ parameter: "Speed", target: "volume", curve: [[0, 0.5], [1, 1]] }],
      root: { type: "random", children: [clip("a.wav"), clip("b.wav")] },
    });
    for (const e of playlist.entries) {
      expect(e.curves.gain!.input).toEqual({ parameter: "Speed" });
      expect(e.curves.gain!.curve).toEqual([[0, -6.021], [0.25, -4.082], [0.5, -2.499], [0.75, -1.16], [1, 0]]);
    }
  });

  it("node automation → its entry's curves: pitch ratio in semitones, low-pass in Hz", () => {
    const { playlist } = mig({
      root: {
        type: "layer", children: [clip("a.wav", {
          automation: [{ parameter: "P", target: "pitch", curve: [[0, 1], [1, 2]] }, { parameter: "P", target: "lowpass", curve: [[0, 500], [1, 8000, "smooth"]] }],
        })],
      },
    });
    const c = playlist.entries[0].curves;
    expect(c.pitch!.curve[0]).toEqual([0, 0]);
    expect(c.pitch!.curve[c.pitch!.curve.length - 1]).toEqual([1, 12]);
    expect(c.lowpass!.curve).toEqual([[0, 500], [1, 8000, "smooth"]]);
  });

  it("a clip root's automation lands on its sample entry; two curves on one parameter combine, other inputs are noted", () => {
    const { playlist, notes } = mig({
      automation: [{ parameter: "A", target: "volume", curve: [[0, 1], [1, 0.5]] }, { parameter: "B", target: "volume", curve: [[0, 1]] }],
      root: clip("a.wav", { automation: [{ parameter: "A", target: "volume", curve: [[0, 0.5], [1, 0.5]] }] }),
    });
    const gain = sampleOf(playlist).curves.gain!;
    expect(gain.input).toEqual({ parameter: "A" });
    expect(gain.curve[0]).toEqual([0, -6.021]);
    expect(gain.curve[gain.curve.length - 1][1]).toBeCloseTo(-12.04, 2);
    hasNote(notes, "combined");
    hasNote(notes, "different inputs");
  });

  it("automation on a sequence root → track automation; low-pass becomes a track effect with its cutoff automated", () => {
    const { playlist } = mig({
      automation: [{ parameter: "P", target: "volume", curve: [[0, 1]] }, { parameter: "P", target: "lowpass", curve: [[0, 400], [1, 9000]] }],
      root: clip("a.wav", { sustain: true }),
    }, lengths({ "a.wav": 1 }));
    const t = playlist.sequence!.tracks[0];
    expect(t.automation.map((a) => a.target)).toEqual(["volume", `fx:${t.effects[0].id}:cutoff`]);
    expect(t.effects[0]).toMatchObject({ type: "lowpass", on: true });
    expect(t.automation[1].curve).toEqual([[0, 400], [1, 9000]]);
  });
});

const tempo = [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }];
const segment = (extra: Record<string, unknown> = {}) => ({ type: "segment", id: "s", tempo, tracks: [{ name: "a", clip: "m/a.wav" }], ...extra });

describe("interactive music", () => {
  it("segment → Sequence at its tempo; stems as sync audio tracks spanning it; cues and the exit as markers", () => {
    const { playlist, notes } = mig({
      root: segment({ cues: [{ name: "entry", at: "1:1:0" }, { name: "hit", at: "2:3:0" }], tracks: [{ name: "drums", clip: "m/d.wav", volume: 0.5, bus: "Drums" }] }),
    }, lengths({ "m/d.wav": 8 }));
    const seq = playlist.sequence!;
    expect(seq.tempo).toEqual({ bpm: 120, meter: "4/4" });
    expect(seq.length).toBe(8);
    expect(seq.tracks).toMatchObject([{ name: "drums", kind: "audio", volume: -6.021, output: "Drums", clips: [{ sample: "m/d.wav", at: 0, length: 8, sync: true }] }]);
    expect(seq.markers).toEqual([{ id: "m1", name: "entry", at: 0 }, { id: "m2", name: "hit", at: 3 }, { id: "m3", name: "exit", at: 8 }]);
    expect(notes).toEqual([]);
  });

  it("positions use gridOffset and the whole tempo map; later tempo markers are noted", () => {
    const { playlist, notes } = mig({
      root: segment({
        gridOffset: 0.5, tempo: [...tempo, { at: "2:1:0", bpm: 60, beatsPerBar: 3, beatUnit: 4 }],
        cues: [{ name: "a", at: "3:1:0" }, { name: "b", at: "3:1:480" }],
      }),
    }, lengths({ "m/a.wav": 20 }));
    expect(playlist.sequence!.markers.slice(0, 2).map((m) => m.at)).toEqual([5.5, 6]);
    expect(playlist.sequence!.tempo).toEqual({ bpm: 120, meter: "4/4" });
    hasNote(notes, "2 tempo markers");
    hasNote(notes, "gridOffset 0.5");
  });

  it("alternatives → a Queue of embedded Clips on a playlist track (pick random → random, sequence → round robin)", () => {
    const { playlist, notes } = mig({ root: segment({ tracks: [{ name: "a", clip: "m/a.wav", alternatives: ["m/b.wav"], pick: "random" }] }) }, lengths({ "m/a.wav": 4, "m/b.wav": 4 }));
    const t = playlist.sequence!.tracks[0];
    expect(t.kind).toBe("playlist");
    const q = t.clips[0].playlist as PlaylistBody;
    expect(q.queue).toEqual({ pick: "random", avoidRepeat: 0, continuous: null });
    expect(q.entries.map((e) => sampleOf((e as EmbeddedEntry).embedded).sample)).toEqual(["m/a.wav", "m/b.wav"]);
    expect(t.clips[0].sync).toBe(true);
    hasNote(notes, "alternatives became a Queue");
  });

  it("regions → sequence loops: forever → always (until stopped); while a label → a parameter binding; count and tail noted", () => {
    const { playlist, notes } = mig({
      parameters: [{ name: "Loop", labels: ["hold", "release"], default: "hold" }, { name: "N", min: 0, max: 1 }],
      root: segment({
        regions: [
          { id: "all", from: "1:1:0", to: "end", count: 0 },
          { id: "hold", from: "1:1:0", to: "2:1:0", count: 0, tailBeats: 4, while: { parameter: "Loop", is: "hold" } },
          { id: "rel", from: "2:1:0", to: "3:1:0", count: 2, while: { parameter: "Loop", is: "release" } },
          { id: "n", from: "3:1:0", to: "4:1:0", count: 0, while: { parameter: "N", atLeast: 0.5 } },
        ],
      }),
    }, lengths({ "m/a.wav": 8 }));
    expect(playlist.sequence!.loops).toEqual([
      { id: "all", start: 0, end: 8, active: "always", exit: "finish", exitFadeMs: 0, reentry: "ignore" },
      { id: "hold", start: 0, end: 2, active: "parameter", binding: { parameter: "Loop", op: "<", value: 0.5 }, exit: "finish", exitFadeMs: 0, reentry: "ignore" },
      { id: "rel", start: 2, end: 4, active: "parameter", binding: { parameter: "Loop", op: ">", value: 0.5 }, exit: "finish", exitFadeMs: 0, reentry: "ignore" },
      { id: "n", start: 4, end: 6, active: "parameter", binding: { parameter: "N", op: ">", value: 0.5 }, exit: "finish", exitFadeMs: 0, reentry: "ignore" },
    ]);
    expect(playlist.playback.plays).toBe("untilStopped");
    hasNote(notes, "tailBeats 4");
    hasNote(notes, "played 2 passes");
  });

  it("without the stems' length, clips are 0 s and positions at the end are dropped, with notes", () => {
    const { playlist, notes } = mig({ root: segment({ regions: [{ id: "all", from: "1:1:0", to: "end", count: 0 }] }) });
    expect(playlist.sequence!.length).toBe(0);
    expect(playlist.sequence!.loops).toEqual([]);
    expect(playlist.sequence!.markers).toEqual([]);
    hasNote(notes, "the stems' length is unknown");
    hasNote(notes, `region "all" can't be placed`);
  });

  it("stem automation → track automation (volume in dB; low-pass via an effect); quantize is noted", () => {
    const { playlist, notes } = mig({
      root: segment({ tracks: [{ name: "a", clip: "m/a.wav", automation: [{ parameter: "I", target: "volume", curve: [[0, 0], [1, 1]], quantize: "beat" }, { parameter: "I", target: "lowpass", curve: [[0, 300]] }] }] }),
    }, lengths({ "m/a.wav": 2 }));
    const t = playlist.sequence!.tracks[0];
    expect(t.automation[0]).toMatchObject({ target: "volume", input: { parameter: "I" } });
    expect(t.automation[0].curve[0]).toEqual([0, -96]);
    expect(t.automation[1].target).toBe(`fx:${t.effects[0].id}:cutoff`);
    hasNote(notes, `quantize "beat"`);
  });

  it("music playlist → continuous Queue; sequence mode repeats children by plays; rounds noted", () => {
    const { playlist, notes } = mig({ root: { type: "playlist", id: "p", rounds: 1, children: [segment({ id: "a", plays: 2 }), segment({ id: "b" })] } }, lengths({ "m/a.wav": 2 }));
    expect(playlist.queue).toEqual({ pick: "roundRobin", avoidRepeat: 0, continuous: { gapMs: 0 } });
    expect(playlist.entries).toHaveLength(3);
    expect(playlist.playback.plays).toBe("untilStopped");
    hasNote(notes, "rounds 1");
    const shuffle = mig({ root: { type: "playlist", id: "p", mode: "shuffle", children: [segment({ id: "a" }), segment({ id: "b" })] } }, lengths({ "m/a.wav": 2 }));
    expect(shuffle.playlist.queue!.pick).toBe("shuffle");
    const random = mig({ root: { type: "playlist", id: "p", mode: "random", avoidRepeat: 1, children: [segment({ id: "a" }), segment({ id: "b" })] } }, lengths({ "m/a.wav": 2 }));
    expect(random.playlist.queue).toMatchObject({ pick: "random", avoidRepeat: 1 });
  });

  const world = (transitions: unknown[], extra: Record<string, unknown> = {}) => ({
    parameters: [{ name: "State", labels: ["explore", "combat"], default: "explore" }],
    root: {
      type: "musicSwitch", id: "w", parameter: "State", default: "explore",
      children: [segment({ id: "explore", value: "explore" }), segment({ id: "combat", value: "combat" })],
      library: [segment({ id: "riser", tracks: [{ name: "r", clip: "m/r.wav" }] })], transitions, ...extra,
    },
  });

  it("musicSwitch → Switch; with no rules onChange is the old default (next bar, 1 beat crossfade)", () => {
    const { playlist } = mig(world([]), lengths({ "m/a.wav": 4, "m/r.wav": 2 }));
    expect(playlist.type).toBe("switch");
    expect(playlist.switch).toMatchObject({ parameter: "State", map: { explore: 0, combat: 1 }, rules: [], onChange: { when: "bar", how: "crossfade", length: { beats: 1 } } });
  });

  it("transition rules → change rules: exit → when, fades → length, bridge → transition, * → * → onChange", () => {
    const { playlist, notes } = mig(world([
      { from: "explore", to: "combat", exit: "beat", fadeOut: { beats: 0 }, fadeIn: { beats: 0 } },
      { from: "combat", to: "explore", exit: "exitCue", fadeOut: { seconds: 0.5 }, fadeIn: { seconds: 0.5 }, bridge: { segment: "riser" } },
      { from: "combat", to: "*", exit: "immediate", fadeOut: { beats: 2 }, fadeIn: { beats: 1, curve: "linear" }, enter: "sameTime" },
      { from: "explore", to: "*", exit: "nextCue" },
      { from: "explore", to: "explore", exit: { every: "bar", n: 2 } },
      { from: "*", to: "*", exit: "bar", fadeOut: { beats: 4 }, fadeIn: { beats: 4 } },
    ]), lengths({ "m/a.wav": 4, "m/r.wav": 2 }), true);
    const sw = playlist.switch!;
    expect(sw.onChange).toEqual({ when: "bar", how: "crossfade", length: { beats: 4 } });
    expect(sw.rules[0]).toEqual({ from: "explore", to: "combat", when: "beat", how: "cut", length: { beats: 0 } });
    expect(sw.rules[1]).toMatchObject({ from: "combat", to: "explore", when: "exit", how: "transition", length: { ms: 500 } });
    expect((sw.rules[1].transition as EmbeddedEntry).embedded.sequence!.tracks[0].clips[0].sample).toBe("m/r.wav");
    expect(sw.rules[2]).toEqual({ from: "combat", to: "*", when: "now", how: "crossfade", length: { beats: 2 } });
    expect(sw.rules[3].when).toBe("exit");
    expect(sw.rules[4].when).toBe("bar");
    hasNote(notes, "fade out and fade in differ");
    hasNote(notes, `enter "sameTime"`);
    hasNote(notes, `exit "nextCue" became "exit"`);
    hasNote(notes, `"every 2 bars" became "bar"`);
  });

  it("stingers → stingers with the library segment embedded; at, ifLate, dontRepeat, volume and bus kept", () => {
    const { playlist, notes } = mig(world([], {
      stingers: [
        { trigger: "hit", segment: "riser", at: "bar", dontRepeat: 0.25, ifTooLate: "skip", volume: 0.5, bus: "Stingers" },
        { trigger: "now", segment: "riser", at: "immediate" },
        { trigger: "cue", segment: "riser", at: { cue: "drop" } },
      ],
    }), lengths({ "m/a.wav": 4, "m/r.wav": 2 }));
    expect(playlist.stingers.map((s) => [s.trigger, s.at, s.ifLate, s.dontRepeat])).toEqual([["hit", "bar", "skip", 0.25], ["now", "now", "nextGrid", 0], ["cue", "exit", "nextGrid", 0]]);
    const first = playlist.stingers[0].playlist as EmbeddedEntry;
    expect(first.volume).toBeCloseTo(-6.021, 3);
    expect(first.embedded.output).toBe("Stingers");
    expect(first.embedded.type).toBe("sequence");
    hasNote(notes, `"at the cue drop" became "exit"`);
  });
});
