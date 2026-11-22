// D20 (ADR 0329): a playlist's markers, beats and bars reach the components on the playing AudioSource's node
// (`onAudioMarker`, `onMusicBeat`, `onMusicBar`) and `handle.onMusic` listeners. Through the public API on the fake
// backend's single clock.
import { describe, expect, it } from "vitest";
import type { MusicEvent } from "../../../../engine/audio/musicTypes";
import { Audio, AudioSource, type AudioMarkerEvent } from "../index";
import { GameBehavior, GameObject } from "../../../../myco";
import { eventKit, pla, sample } from "./testKit";

const kit = eventKit();
const fake = kit.fake;
const at = (t: number): void => { kit.setTime(t); kit.frame(); };
const run = (from: number, to: number, step = 0.05): void => { for (let t = from; t <= to + 1e-9; t += step) at(Math.round(t * 1e6) / 1e6); };

/** A 60 BPM 4/4 sequence: one beat a second, a bar every four. */
const tempoSeq = () => pla("sequence", [], {
  sequence: { length: 16, tempo: { bpm: 60, meter: "4/4" }, tracks: [{ id: "t", kind: "audio", clips: [{ id: "c1", sample: "a.wav", at: 0, length: 16, sync: true }] }] },
});

class Ears extends GameBehavior {
  log: string[] = [];
  onAudioMarker(e: AudioMarkerEvent): void { this.log.push(`${e.type} ${e.name} ${e.sample} ${Math.round(e.time * 1e6) / 1e6}`); }
}
class Drummer extends GameBehavior {
  log: string[] = [];
  onMusicBeat(e: MusicEvent): void { this.log.push(`beat ${e.bar}.${e.beat} m${e.missed}`); }
  onMusicBar(e: MusicEvent): void { this.log.push(`bar ${e.bar} ${e.tempo} ${e.beatsPerBar}`); }
}

describe("onAudioMarker", () => {
  it("a behaviour on the AudioSource's node hears every marker type of the playlist it plays, once each", async () => {
    await kit.boot({
      "a.wav.meta.json": { format: "myco.import@1", sample: { markers: [{ id: "k", type: "cue", name: "Kick", at: 0.5 }, { id: "x", type: "exit", name: "Out", at: 0.75 }] } },
      "c.playlist.json": pla("clip", [sample("a.wav")]),
    });
    fake.durations.set("a.wav", 1);
    const node = GameObject.create("emitter");
    const ears = node.addBehavior(Ears);
    node.addBehavior(AudioSource, { clip: "c.playlist.json", playOnAwake: false }).play();
    run(0.05, 0.95);
    expect(ears.log).toEqual(["cue Kick a.wav 0.5", "exit Out a.wav 0.75"]);
  });

  it("a playlist played without a node reaches only the handle's listeners", async () => {
    await kit.boot({
      "a.wav.meta.json": { format: "myco.import@1", sample: { markers: [{ id: "k", type: "hit", name: "Hit", at: 0.25 }] } },
      "c.playlist.json": pla("clip", [sample("a.wav")]),
    });
    fake.durations.set("a.wav", 1);
    const ears = GameObject.create("bystander").addBehavior(Ears);
    const heard: string[] = [];
    Audio.play("c.playlist.json").onMarker("hit", (e) => heard.push(e.name));
    run(0.05, 0.5);
    expect(heard).toEqual(["Hit"]);
    expect(ears.log).toEqual([]);
  });
});

describe("playlist beat callbacks", () => {
  it("onMusicBeat and onMusicBar on the AudioSource's node follow a sequence's tempo", async () => {
    await kit.boot({ "s.playlist.json": tempoSeq() });
    fake.durations.set("a.wav", 16);
    const node = GameObject.create("band");
    const drummer = node.addBehavior(Drummer);
    node.addBehavior(AudioSource, { clip: "s.playlist.json", playOnAwake: false }).play();
    run(0.05, 4.5);
    expect(drummer.log).toEqual([
      "beat 1.1 m0", "bar 1 60 4", "beat 1.2 m0", "beat 1.3 m0", "beat 1.4 m0", "beat 2.1 m0", "bar 2 60 4",
    ]);
  });

  it("handle.onMusic hears beats and bars until unsubscribed, coalesces a gap, and is silent without a tempo", async () => {
    await kit.boot({ "s.playlist.json": tempoSeq(), "q.playlist.json": pla("clip", [sample("b.wav")], { playback: { plays: "untilStopped" } }) });
    fake.durations.set("a.wav", 16);
    const h = Audio.play("s.playlist.json");
    const beats: MusicEvent[] = [];
    const bars: number[] = [];
    const off = h.onMusic("beat", (e) => beats.push({ ...e }));
    h.onMusic("bar", (e) => bars.push(e.bar));
    expect(h.onMusic("cue", () => { throw new Error("no cues"); })).toBeTypeOf("function");
    run(0.05, 1.5);
    expect(beats.map((e) => [e.bar, e.beat, e.missed])).toEqual([[1, 1, 0], [1, 2, 0]]);
    expect(beats[1]!.time).toBeCloseTo(1, 6);
    expect(beats[1]!.heardIn).toBeGreaterThanOrEqual(0);
    expect(beats[1]!.handle.playing).toBe(true);
    at(6.5); // a gap of five beats: one call for the latest (2.3 at 6 s), the others missed
    expect(beats.at(-1)).toMatchObject({ bar: 2, beat: 3, missed: 4 });
    expect(bars).toEqual([1, 2]);
    off();
    run(6.55, 8.5);
    expect(beats).toHaveLength(3);
    expect(bars).toEqual([1, 2, 3]);

    const flat = Audio.play("q.playlist.json");
    const none: number[] = [];
    flat.onMusic("beat", (e) => none.push(e.time));
    run(8.55, 10);
    expect(none).toEqual([]);
  });
});
