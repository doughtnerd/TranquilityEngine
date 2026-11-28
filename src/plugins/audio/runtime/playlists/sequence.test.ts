// ADR 0343 (M5): Sequence playlists through the public API on the fake backend's single clock (ADR 0286): stamped clip
// starts, sync and async clips, the clip map, sequence loops and hold points, release vs stop, tracks, automation,
// markers, positions and hot reload.
import { describe, expect, it } from "vitest";
import { Audio } from "../index";
import { Assets } from "../../../../myco";
import { eventKit, pla, sample } from "./testKit";

const kit = eventKit();
const fake = kit.fake;

/** A sequence asset: `seq({ length, tracks, loops, markers, tempo }, { playback: ... })`. */
const seq = (sequence: Record<string, unknown>, extra: Record<string, unknown> = {}) => pla("sequence", [], { sequence, ...extra });
/** One audio track of clips. */
const track = (clips: unknown[], extra: Record<string, unknown> = {}) => ({ id: `t${Math.random().toString(36).slice(2, 6)}`, kind: "audio", clips, ...extra });
/** A sample's sidecar edits. */
const meta = (sampleBlock: Record<string, unknown>) => ({ format: "myco.import@1", sample: sampleBlock });

/** Plays and steps: `at(t)` moves the heard clock to `t` and runs one frame. */
const at = (t: number): void => { kit.setTime(t); kit.frame(); };
const plays = () => fake.plays.map((p) => [p.path, p.at === undefined ? undefined : Math.round(p.at * 1e6) / 1e6]);
/** Where each voice starts in its file: its play's start offset (a trim, a clip offset, a map piece), null at 0. */
const seeks = () => fake.plays.map((p) => p.offset ?? null);
const lastFade = (i: number) => fake.voices[i]!.events.filter((e) => e.kind === "fadeShaped").at(-1);

describe("Sequence: clips on the timeline", () => {
  it("starts each clip stamped at its heard time, planned a little ahead", async () => {
    await kit.boot({ "s.playlist.json": seq({ length: 3, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 1 }, { id: "c2", sample: "b.wav", at: 1.5, length: 1 }])] }) });
    fake.durations.set("a.wav", 1);
    fake.durations.set("b.wav", 1);
    const h = Audio.play("s.playlist.json");
    expect(plays()).toEqual([["a.wav", 0]]);
    at(1.3);
    expect(plays()).toHaveLength(1);
    at(1.45);
    expect(plays()).toEqual([["a.wav", 0], ["b.wav", 1.5]]);
    at(3.5);
    expect(h.playing).toBe(true); // async voices still play (the fake never ends them on its own)
    for (const v of fake.voices) v.end();
    at(3.6);
    expect(h.playing).toBe(false);
  });

  it("an offset starts the sample later; gain adds to the track's volume; a muted or disabled track plays nothing", async () => {
    await kit.boot({
      "s.playlist.json": seq({ length: 2, tracks: [
        track([{ id: "c1", sample: "a.wav", at: 0, length: 1, offset: 0.5, gain: -6 }], { volume: -6 }),
        track([{ id: "c2", sample: "b.wav", at: 0, length: 1 }], { mute: true }),
        track([{ id: "c3", sample: "c.wav", at: 0, length: 1 }], { enabled: false }),
      ] }),
    });
    Audio.play("s.playlist.json");
    expect(plays()).toEqual([["a.wav", 0]]);
    expect(seeks()).toEqual([0.5]);
    expect(fake.plays[0]!.volume).toBeCloseTo(Math.pow(10, -12 / 20), 6);
  });

  it("a track at the fader's −60 dB floor is silent, not 0.001 (ADR 0456)", async () => {
    await kit.boot({ "s.playlist.json": seq({ length: 1, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 1 }], { volume: -60 })] }) });
    Audio.play("s.playlist.json");
    expect(fake.plays[0]!.volume).toBe(0);
  });

  it("solo plays only the soloed tracks; a track's output sends it to that bus", async () => {
    await kit.boot({
      "s.playlist.json": seq({ length: 1, tracks: [
        track([{ id: "c1", sample: "a.wav", at: 0, length: 1 }], { solo: true, output: "SFX" }),
        track([{ id: "c2", sample: "b.wav", at: 0, length: 1 }]),
      ] }),
    });
    Audio.play("s.playlist.json");
    expect(plays()).toEqual([["a.wav", 0]]);
    expect(fake.plays[0]!.bus).toBe("SFX");
  });

});

describe("Sequence: reverse and the Amp envelope (ADR 0362)", () => {
  it("a reversed clip reads its span backwards: from its end down to its offset, decoded whole, stopping there", async () => {
    await kit.boot({
      "a.wav.meta.json": { format: "myco.import@1", stream: true },
      "s.playlist.json": seq({ length: 2, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 0.5, offset: 0.25, reverse: true }, { id: "c2", sample: "a.wav", at: 1, length: 0, reverse: true }])] }),
    });
    fake.durations.set("a.wav", 1);
    Audio.play("s.playlist.json");
    expect(fake.plays[0]).toMatchObject({ path: "a.wav", reverse: true, stream: false, offset: 0.75 });
    // It stops where it reaches its offset (0.5 s of audio later), as a forward trim stops at its end.
    at(0.6);
    expect(fake.voices[0]!.events.some((e) => e.kind === "stop")).toBe(true);
    // A clip over the whole sample starts at the file's end (no offset).
    at(0.95);
    expect(fake.plays[1]).toMatchObject({ reverse: true, stream: false });
    expect(fake.plays[1]!.offset).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("reverse"));
  });

  it("a reversed sync clip plays its map mirrored: the tail first, the loop's passes backwards, the pickup last", async () => {
    // a.wav: 4 s, loop 1..2. Forward the 6 s clip is 0..2 (pickup and first pass), 1..2, 1..2, then the tail 2..4.
    await kit.boot({
      "a.wav.meta.json": meta({ loops: [{ id: "l1", start: 1, end: 2, active: "always" }] }),
      "s.playlist.json": seq({ length: 0, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 6, sync: true, reverse: true }])] }),
    });
    fake.durations.set("a.wav", 4);
    Audio.play("s.playlist.json");
    at(1.95); at(2.95);
    expect(plays()).toEqual([["a.wav", 0], ["a.wav", 2], ["a.wav", 3]]);
    // Each piece starts at its stretch's end and reads down: 4 → 2 (the file's end: no offset), then 2 → 1 a pass.
    expect(seeks()).toEqual([null, 2, 2]);
    expect(fake.plays.every((p) => p.reverse === true)).toBe(true);
    expect(lastFade(0)).toEqual({ kind: "fadeShaped", to: 0, seconds: 0.002, law: "linear", at: 2, stopAtEnd: true });
    // ADR 0362: its loop drives the playhead: always active, it wraps at the mirrored first pass (clip 4 s) back one
    // pass, so 2 → 1 plays again and again, on a piece boundary each time.
    at(3.95); at(4.95); at(5.95);
    expect(plays().slice(3)).toEqual([["a.wav", 4], ["a.wav", 5], ["a.wav", 6]]);
    expect(seeks().slice(3)).toEqual([2, 2, 2]);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("loop drives the playhead only"));
  });

  it("a reversed sync clip's held loop holds the playhead until release, then plays on through its first pass and pickup", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ loops: [{ id: "l1", start: 1, end: 2, active: "held" }] }),
      "s.playlist.json": seq({ length: 0, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 6, sync: true, reverse: true }])] }),
    });
    fake.durations.set("a.wav", 4);
    const h = Audio.play("s.playlist.json");
    at(3.95); at(4.95);
    expect(plays()).toEqual([["a.wav", 0], ["a.wav", 2], ["a.wav", 3], ["a.wav", 4], ["a.wav", 5]]);
    h.release();
    // Released in the pass from 5: it leaves at that pass's end (6), into the mirrored first pass and pickup (2 → 0).
    at(5.95);
    expect(plays().at(-1)).toEqual(["a.wav", 6]);
    expect(seeks().at(-1)).toBe(2);
    at(6.95); at(7.95);
    expect(plays()).toHaveLength(6);
  });

  it("a reversed sync clip with no pass to repeat besides its first follows the playhead, with one warning", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ loops: [{ id: "l1", start: 1, end: 2, active: "always" }] }),
      "s.playlist.json": seq({ length: 0, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 4, sync: true, reverse: true }])] }),
    });
    fake.durations.set("a.wav", 4);
    Audio.play("s.playlist.json");
    at(3.95);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("a reversed clip's loop drives the playhead only with a pass to repeat"));
  });

  it("an async reversed clip loops its region backwards while the loop is active", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ loops: [{ id: "l1", start: 1, end: 2, active: "held" }] }),
      "s.playlist.json": seq({ length: 6, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 6, reverse: true }])] }),
    });
    fake.durations.set("a.wav", 4);
    Audio.play("s.playlist.json");
    expect(fake.plays[0]).toMatchObject({ reverse: true });
    expect(fake.plays[0]!.offset).toBeUndefined();
    // The region is in source seconds, as every loop (the core mirrors it for the reversed voice).
    expect(fake.voices[0]!.events.find((e) => e.kind === "loop")).toMatchObject({ start: 1, end: 2, looping: true });
  });

  it("reverse on a playlist clip does nothing, with one warning", async () => {
    await kit.boot({
      "c.playlist.json": pla("clip", [sample("a.wav")]),
      "s.playlist.json": seq({ length: 1, tracks: [{ id: "t", kind: "playlist", clips: [{ id: "c1", playlist: "c.playlist.json", at: 0, length: 1, reverse: true }] }] }),
    });
    Audio.play("s.playlist.json");
    expect(fake.plays[0]!.reverse).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("a playlist or generator clip plays forward"));
  });

  it("a clip's Amp envelope goes to each of its voices from where it starts in the clip; not to the clip's submix", async () => {
    const envelope = { id: "env", type: "envelope", params: { attack: 10, hold: 5, decay: 20, sustain: 50, release: 300 } };
    await kit.boot({
      "a.wav.meta.json": meta({ loops: [{ id: "l1", start: 1, end: 2, active: "always" }] }),
      "s.playlist.json": seq({ length: 0, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 6, sync: true, effects: [envelope] }])] }),
    });
    fake.durations.set("a.wav", 4);
    const h = Audio.play("s.playlist.json");
    const stages = { attack: 0.01, hold: 0.005, decay: 0.02, sustain: 0.5, release: 0.3 };
    expect(fake.plays[0]!.envelope).toEqual({ stages, length: 6, offset: 0 });
    // The next piece (the loop's second pass) starts 2 s into the clip, so 2 s into its envelope.
    at(1.95);
    expect(fake.plays[1]!.envelope).toEqual({ stages, length: 6, offset: 2 });
    h.stop();
    // Nothing tried to run the envelope as a playlist effect (it isn't the submix's).
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("envelope"));
  });

  it("a bypassed Amp envelope plays nothing; a playlist clip's voices take the clip's envelope", async () => {
    await kit.boot({
      "c.playlist.json": pla("clip", [sample("b.wav")]),
      "s.playlist.json": seq({ length: 2, tracks: [
        track([{ id: "c1", sample: "a.wav", at: 0, length: 1, effects: [{ id: "e", type: "envelope", on: false }] }]),
        { id: "t2", kind: "playlist", clips: [{ id: "c2", playlist: "c.playlist.json", at: 0, length: 1.5, effects: [{ id: "e2", type: "envelope", params: { attack: 100 } }] }] },
      ] }),
    });
    Audio.play("s.playlist.json");
    const a = fake.plays.find((p) => p.path === "a.wav")!;
    const b = fake.plays.find((p) => p.path === "b.wav")!;
    expect(a.envelope).toBeUndefined();
    expect(b.envelope).toMatchObject({ stages: { attack: 0.1 }, length: 1.5, offset: 0 });
  });
});

describe("A play's start offset (EventOptions.offset)", () => {
  it("starts a sequence's playhead there: a clip under it starts part-way, later clips at their times", async () => {
    await kit.boot({ "s.playlist.json": seq({ length: 4, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 2, offset: 0.25 }, { id: "c2", sample: "b.wav", at: 2.5, length: 1 }])] }) });
    fake.durations.set("a.wav", 3);
    fake.durations.set("b.wav", 1);
    Audio.play("s.playlist.json", { offset: 1.5 });
    expect(fake.plays.map((p) => [p.path, p.offset])).toEqual([["a.wav", 1.75]]); // the clip's own offset plus 1.5 s
    at(0.95);
    expect(plays()).toEqual([["a.wav", 0], ["b.wav", 1]]); // b at 2.5 s on the timeline: 1 s after the start
    expect(fake.plays[1]!.offset).toBeUndefined();
  });

  it("starts a clip playlist's sample that far in; a one-pass sample it has passed doesn't play", async () => {
    await kit.boot({ "c.playlist.json": pla("clip", [sample("a.wav")]) });
    fake.durations.set("a.wav", 2);
    Audio.play("c.playlist.json", { offset: 0.5 });
    expect(fake.plays.map((p) => p.offset)).toEqual([0.5]);
    Audio.play("c.playlist.json", { offset: 3 });
    expect(fake.plays).toHaveLength(1);
    Audio.play("c.playlist.json", { offset: -1 });
    expect(fake.plays.at(-1)!.offset).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("offset must be a finite number"));
  });
});

describe("Sequence: sync clips", () => {
  // a.wav: 4 s, loop 1..2 held. A 6 s sync clip: pickup + first pass 0..2, passes 2..3 and 3..4, tail 4..6.
  const assets = (loop: Record<string, unknown> = { active: "held" }, extraMeta: Record<string, unknown> = {}) => ({
    "a.wav.meta.json": meta({ loops: [{ id: "l1", start: 1, end: 2, ...loop }], ...extraMeta }),
    "s.playlist.json": seq({ length: 0, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 6, sync: true }])] }),
  });

  it("plays each piece of the clip map as one voice, spliced at its heard time; its active loop wraps the playhead back a pass", async () => {
    await kit.boot(assets());
    fake.durations.set("a.wav", 4);
    const h = Audio.play("s.playlist.json");
    at(1.95); at(2.95); at(3.95);
    expect(plays()).toEqual([["a.wav", 0], ["a.wav", 2], ["a.wav", 3], ["a.wav", 4]]);
    expect(seeks()).toEqual([null, 1, 1, 1]);
    expect(lastFade(0)).toEqual({ kind: "fadeShaped", to: 0, seconds: 0.002, law: "linear", at: 2, stopAtEnd: true });
    // Held: at 4 the loop wraps back to the last pass (3), so the next pass starts at heard 5.
    at(4.95);
    expect(plays().at(-1)).toEqual(["a.wav", 5]);
    expect(seeks().at(-1)).toBe(1);
    // Released: the loop finishes its pass (a held loop's exit is finish) and the tail plays at heard 6, cut at the clip's end (8).
    h.release();
    at(5.95);
    expect(plays().at(-1)).toEqual(["a.wav", 6]);
    expect(seeks().at(-1)).toBe(2);
    at(7.95);
    expect(lastFade(fake.voices.length - 1)).toEqual({ kind: "fadeShaped", to: 0, seconds: 0.005, law: "linear", at: 8, stopAtEnd: true });
    at(8.1);
    expect(h.playing).toBe(false);
  });

  it("a held loop over a clip as long as its sample (one pass, Sound Lab's engine-single) holds the playhead until release (J6.3)", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ loops: [{ id: "run", start: 0.5, end: 1.5, active: "held" }] }),
      "s.playlist.json": seq({ length: 2.5, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 2.5, sync: true }])] }),
    });
    fake.durations.set("a.wav", 2.5);
    const h = Audio.play("s.playlist.json");
    at(1.45); at(2.45); at(3.45);
    // Held: each time the playhead reaches 1.5 it wraps to 0.5, a new voice from the loop's start (sample 0.5).
    expect(plays()).toEqual([["a.wav", 0], ["a.wav", 1.5], ["a.wav", 2.5], ["a.wav", 3.5]]);
    expect(seeks().slice(1)).toEqual([0.5, 0.5, 0.5]);
    expect(h.playing).toBe(true);
    h.release();
    at(4.45);
    expect(plays().at(-1)).toEqual(["a.wav", 4.5]); // the pass finishes, then the tail
    expect(seeks().at(-1)).toBe(1.5);
  });

  it("an inactive finish loop leaves at the next Exit marker in the pass (jumping to the tail); jump leaves at once", async () => {
    await kit.boot({
      ...assets({ active: "parameter", binding: { parameter: "Go", op: ">", value: 0.5 } }, { markers: [{ id: "m1", type: "exit", name: "Out", at: 1.5 }] }),
      "s.playlist.json": seq({ length: 0, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 4, sync: true }])] }, { parameters: [{ name: "Go", min: 0, max: 1, default: 1 }] }),
    });
    fake.durations.set("a.wav", 4);
    const h = Audio.play("s.playlist.json");
    at(1.95); // a 4 s clip has one pass (region 1..2): it wraps at 2 back to 1
    expect(plays()).toEqual([["a.wav", 0], ["a.wav", 2]]);
    at(2.1);
    h.setParameter("Go", 0); // planned to 2.2 (pass position 1.2): the Exit marker at 1.5 is heard at 2.5
    at(2.45);
    expect(plays().at(-1)).toEqual(["a.wav", 2.5]);
    expect(seeks().at(-1)).toBe(2);
  });

  it("a clip loop override replaces the sample's loop behaviour", async () => {
    await kit.boot({
      ...assets({ active: "always" }),
      "s.playlist.json": seq({ length: 0, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 6, sync: true, loops: { l1: { active: "held", exit: "jump" } } }])] }),
    });
    fake.durations.set("a.wav", 4);
    const h = Audio.play("s.playlist.json");
    at(1.0);
    h.release(); // held → inactive, exit jump: the playhead skips to the tail (4) at once
    at(1.1);
    expect(plays().at(-1)).toEqual(["a.wav", 1.1]);
    expect(seeks().at(-1)).toBe(2);
  });

  it("where sync loops overlap the higher track drives and the other follows, with one warning", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ loops: [{ id: "l1", start: 1, end: 2, active: "always" }] }),
      "b.wav.meta.json": meta({ loops: [{ id: "l1", start: 0.5, end: 1.5, active: "always" }] }),
      "s.playlist.json": seq({ length: 0, tracks: [
        track([{ id: "c1", sample: "a.wav", at: 0, length: 3, sync: true }]),
        track([{ id: "c2", sample: "b.wav", at: 0, length: 3, sync: true }]),
      ] }),
    });
    fake.durations.set("a.wav", 3);
    fake.durations.set("b.wav", 3);
    Audio.play("s.playlist.json");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("overlaps a higher track's"));
    at(1.45); // b's own passes don't move the playhead: at 1.5 its map goes on to its tail (1.5)
    at(1.95); // a drives: at 2 the playhead wraps to 1; b follows at its map there (sample 1)
    const b = fake.plays.map((p, i) => [p.path, p.at, seeks()[i]]).filter((p) => p[0] === "b.wav");
    expect(b).toEqual([["b.wav", 0, null], ["b.wav", 1.5, 1.5], ["b.wav", 2, 1]]);
  });
});

describe("Sequence: async clips", () => {
  it("run their own clock: not cut when the playhead leaves; a held loop ends on release through the loop adapter", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ loops: [{ id: "l1", start: 0.2, end: 0.8, active: "held" }] }),
      "s.playlist.json": seq({ length: 2, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 1 }])] }),
    });
    fake.durations.set("a.wav", 1);
    const h = Audio.play("s.playlist.json");
    expect(fake.plays[0]!.loop).toBe(true);
    at(2.5); // the playhead ended at 2; the voice still loops
    expect(fake.voices[0]!.stopped).toBe(false);
    expect(h.playing).toBe(true);
    h.release();
    expect(fake.voices[0]!.events).toContainEqual({ kind: "loop", start: 0.2, end: 0.8, looping: false });
    fake.voices[0]!.end();
    at(2.6);
    expect(h.playing).toBe(false);
  });
});

describe("Sequence: loops and hold points", () => {
  it("a sequence loop wraps sync clips (spliced) and stops async clips it jumps back before; release lets it finish", async () => {
    await kit.boot({
      "s.playlist.json": seq({ length: 2, loops: [{ id: "l", start: 0, end: 2, active: "held" }], tracks: [
        track([{ id: "c1", sample: "b.wav", at: 0, length: 2, sync: true }]),
        track([{ id: "c2", sample: "a.wav", at: 1, length: 0.5 }]),
      ] }),
    });
    fake.durations.set("b.wav", 2);
    fake.durations.set("a.wav", 0.5);
    const h = Audio.play("s.playlist.json");
    at(0.95); at(1.95); at(2.95);
    expect(plays()).toEqual([["b.wav", 0], ["a.wav", 1], ["b.wav", 2], ["a.wav", 3]]);
    expect(lastFade(0)).toMatchObject({ to: 0, at: 2, stopAtEnd: true }); // the first pass's sync voice
    expect(lastFade(1)).toMatchObject({ to: 0, seconds: 0.005, at: 2, stopAtEnd: true }); // async, jumped back before it
    h.release();
    at(3.5);
    expect(plays()).toHaveLength(4);
    at(3.95);
    expect(lastFade(2)).toMatchObject({ to: 0, at: 4, stopAtEnd: true }); // cut at the sequence's end
  });

  it("an active hold point parks the playhead; clips after it wait; markers report as the playhead passes them", async () => {
    await kit.boot({
      "s.playlist.json": seq({
        length: 3,
        loops: [{ id: "h", start: 1, end: 1, active: "held" }],
        markers: [{ id: "m1", name: "Out", at: 0.5, type: "exit" }, { id: "m2", name: "Go", at: 1, type: "cue" }, { id: "m3", name: "note", at: 0.2 }],
        tracks: [track([{ id: "c1", sample: "b.wav", at: 1, length: 1 }])],
      }),
    });
    const h = Audio.play("s.playlist.json");
    const heard: string[] = [];
    h.onMarker("cue", (e) => heard.push(`cue ${e.name} ${e.time} ${e.sample}`));
    h.onMarker("exit", (e) => heard.push(`exit ${e.name} ${e.time}`));
    at(0.4);
    expect(heard).toEqual([]);
    at(0.95);
    expect(heard).toEqual(["exit Out 0.5"]);
    at(1);
    expect(heard).toEqual(["exit Out 0.5", "cue Go 1 s.playlist.json"]);
    at(3);
    expect(fake.plays).toHaveLength(0);
    h.release();
    at(3.05);
    expect(plays()).toEqual([["b.wav", 3.05]]);
    expect(heard).toHaveLength(2); // the cue at the hold isn't reported again as it leaves
  });

  it("stop fades every clip over 120 ms", async () => {
    await kit.boot({ "s.playlist.json": seq({ length: 4, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 4, sync: true }])] }) });
    const h = Audio.play("s.playlist.json");
    h.stop();
    expect(fake.voices[0]!.events.at(-1)).toEqual({ kind: "stop", fadeSeconds: 0.12 });
    expect(h.playing).toBe(false);
  });

  it("untilStopped stays alive after the playhead's end until stopped", async () => {
    await kit.boot({ "s.playlist.json": seq({ length: 1, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 1, sync: true }])] }, { playback: { plays: "untilStopped" } }) });
    fake.durations.set("a.wav", 1);
    const h = Audio.play("s.playlist.json");
    at(2);
    fake.voices[0]!.end();
    at(2.1);
    expect(h.playing).toBe(true);
    h.stop();
    expect(h.playing).toBe(false);
  });
});

describe("Sequence: playlist tracks, automation, sample markers", () => {
  it("a playlist clip resolves once when the playhead enters it", async () => {
    await kit.boot({
      "q.playlist.json": pla("queue", [sample("a.wav"), sample("b.wav")], { queue: { pick: "roundRobin" } }),
      "s.playlist.json": seq({ length: 2, loops: [{ id: "l", start: 0, end: 1, active: "held" }], tracks: [{ id: "p", kind: "playlist", clips: [{ id: "c1", playlist: "q.playlist.json", at: 0.5, length: 0.25 }] }] }),
    });
    Audio.play("s.playlist.json");
    at(0.45); at(1.45);
    expect(plays()).toEqual([["a.wav", 0.5], ["b.wav", 1.5]]);
  });

  it("clip-time volume automation is the voice-time curve shifted to where the voice starts; parameter automation binds", async () => {
    await kit.boot({
      "s.playlist.json": seq({ length: 2, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 2, automation: [{ id: "a1", target: "volume", input: "clipTime", curve: [[0, 0], [1, -20]] }] }])] }),
    });
    Audio.play("s.playlist.json");
    at(0.5);
    const vols = fake.voices[0]!.events.filter((e) => e.kind === "volume").map((e) => (e as { value: number }).value);
    expect(vols.at(-1)).toBeCloseTo(Math.pow(10, -10 / 20), 4);
  });

  it("a sync clip's sample Cue markers report once per pass as the playhead passes them; hidden markers don't", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ loops: [{ id: "l1", start: 1, end: 2, active: "always" }], markers: [{ id: "k1", type: "cue", name: "Kick", at: 1.25 }, { id: "k2", type: "cue", name: "Hidden", at: 0.5 }] }),
      "s.playlist.json": seq({ length: 0, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 4, sync: true, hiddenMarkers: ["k2"] }])] }),
    });
    fake.durations.set("a.wav", 3);
    const h = Audio.play("s.playlist.json");
    const heard: number[] = [];
    h.onMarker("cue", (e) => { expect(e.sample).toBe("a.wav"); expect(e.name).toBe("Kick"); heard.push(e.time); });
    for (let t = 0.1; t < 3.5; t += 0.1) at(t);
    expect(heard).toEqual([1.25, 2.25, 3.25]);
  });

  it("an async clip's (and a Clip playlist's) sample markers report from its voice, loops unrolled", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ loops: [{ id: "l1", start: 0, end: 1, active: "always" }], markers: [{ id: "k1", type: "cue", name: "Tick", at: 0.5 }] }),
      "c.playlist.json": pla("clip", [sample("a.wav")]),
    });
    fake.durations.set("a.wav", 1);
    const h = Audio.play("c.playlist.json");
    const heard: number[] = [];
    h.onMarker("cue", (e) => heard.push(Math.round(e.time * 1e6) / 1e6));
    for (let t = 0.1; t < 2.95; t += 0.1) at(t);
    expect(heard).toEqual([0.5, 1.5, 2.5]);
  });

  it("ADR 0362: an async reversed clip's sample markers report from its voice reading down, its loop backwards", async () => {
    // a.wav: 4 s, loop 1..2 always, cues at 3.5 (tail) and 1.25 (in the loop). Reversed from 4 s down: 3.5 is heard
    // at 0.5 s, then the loop runs 2 → 1 again and again, 1.25 heard 0.75 s into each pass from 2 s on.
    await kit.boot({
      "a.wav.meta.json": meta({ loops: [{ id: "l1", start: 1, end: 2, active: "always" }], markers: [{ id: "k1", type: "cue", name: "Tail", at: 3.5 }, { id: "k2", type: "cue", name: "Loop", at: 1.25 }] }),
      "s.playlist.json": seq({ length: 6, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 6, reverse: true }])] }),
    });
    fake.durations.set("a.wav", 4);
    const h = Audio.play("s.playlist.json");
    const heard: string[] = [];
    h.onMarker("cue", (e) => heard.push(`${e.name} ${Math.round(e.time * 1e6) / 1e6}`));
    for (let t = 0.1; t < 4.95; t += 0.1) at(t);
    expect(heard).toEqual(["Tail 0.5", "Loop 2.75", "Loop 3.75", "Loop 4.75"]);
  });
});

describe("Sequence: musical clock, positions and hot reload", () => {
  const tempoSeq = (extra: Record<string, unknown> = {}) => seq({ length: 16, tempo: { bpm: 60, meter: "4/4" }, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 16, sync: true }])], ...extra });

  it("handle.music reads bar, beat and tempo on the playhead; nextGrid finds the next bar", async () => {
    await kit.boot({ "s.playlist.json": tempoSeq() });
    fake.durations.set("a.wav", 16);
    const h = Audio.play("s.playlist.json");
    at(2.5);
    const m = h.music!;
    expect([m.segment, m.bar, m.beat, m.beatFraction, m.tempo, m.beatsPerBar, m.beatUnit]).toEqual(["s.playlist.json", 1, 3, 0.5, 60, 4, 4]);
    expect(m.nextGrid("bar")).toEqual({ time: 4, bar: 2, beat: 1, segment: "s.playlist.json" });
    expect(m.nextGrid("beat")).toEqual({ time: 3, bar: 1, beat: 4, segment: "s.playlist.json" });
  });

  it("without a tempo of its own a sequence reads its sync clip's sample tempo through the clip map", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ tempo: { bpm: 60, meter: "4/4" } }),
      "s.playlist.json": seq({ length: 16, tracks: [track([{ id: "c1", sample: "a.wav", at: 1, length: 12, sync: true }])] }),
    });
    fake.durations.set("a.wav", 16);
    const h = Audio.play("s.playlist.json");
    at(3); // sample time 2
    const m = h.music!;
    expect([m.bar, m.beat, m.tempo]).toEqual([1, 3, 60]);
    expect(m.nextGrid("bar")).toEqual({ time: 5, bar: 2, beat: 1, segment: "s.playlist.json" });
    expect(m.seek("2:1:0")).toMatchObject({ ok: false }); // seeking needs the sequence's own tempo
  });

  it("seek jumps the playhead at the planned time: sync clips restart at their map there", async () => {
    await kit.boot({ "s.playlist.json": tempoSeq() });
    fake.durations.set("a.wav", 16);
    const h = Audio.play("s.playlist.json");
    at(2.5);
    expect(h.music!.seek("3:1:0")).toEqual({ ok: true, time: 2.6 });
    expect(h.music!.seek("9:1:0")).toMatchObject({ ok: false, reason: "invalid" });
    at(2.55);
    expect(plays().at(-1)).toEqual(["a.wav", 2.6]);
    expect(seeks().at(-1)).toBe(8);
    expect(lastFade(0)).toMatchObject({ to: 0, at: 2.6, stopAtEnd: true });
  });

  /** Plays through the fake with each new voice reading `waitingForData` while `waits(request)` says so, as the core's do. */
  const waitingVoices = (waits: (r: { path: string; stream: boolean }) => boolean): (() => void) => {
    const real = fake.play;
    fake.play = (r) => {
      const v = real(r);
      if (v && waits(r)) (v as { reason: string | null }).reason = "waitingForData";
      return v;
    };
    return () => { fake.play = real; };
  };

  it("D44: an unstamped sequence whose clip is still loading starts again each frame until the data is there, then plans", async () => {
    await kit.boot({ "s.playlist.json": tempoSeq() });
    fake.durations.set("a.wav", 16);
    let loading = true;
    const restore = waitingVoices(() => loading);
    try {
      const h = Audio.play("s.playlist.json");
      at(0.1);
      at(0.2);
      expect(fake.plays.length, "a new voice each frame while the clip loads").toBe(3);
      loading = false;
      at(0.3); // this frame's new voice is not waiting: the sequence plans from it
      at(0.4);
      at(0.5);
      expect(fake.plays.length).toBe(4);
      expect(h.music?.bar).toBe(1);
    } finally { restore(); }
  });

  it("an unstamped sequence of a streamed clip starts once: a stream voice waits for its data by design and isn't restarted (Flappy's town music)", async () => {
    await kit.boot({ "a.wav.meta.json": { format: "myco.import@1", stream: true }, "s.playlist.json": tempoSeq() });
    fake.durations.set("a.wav", 16);
    const restore = waitingVoices((r) => r.stream); // a stream voice reads waitingForData from its play until it sounds
    try {
      const h = Audio.play("s.playlist.json");
      for (let t = 0.1; t < 2; t += 0.1) at(t);
      expect(fake.plays.map((p) => [p.path, p.stream]), "one play of the stream, not one a frame").toEqual([["a.wav", true]]);
      expect(fake.voices[0]!.events.some((e) => e.kind === "fadeShaped" && e.to === 0), "never stopped for a new start").toBe(false);
      expect(h.music, "its musical clock runs (the music rows read it)").not.toBeUndefined();
      expect(h.music!.bar).toBe(1);
    } finally { restore(); }
  });

  it("an edited sequence swaps at the next bar, at the same time when the tempo is unchanged", async () => {
    await kit.boot({ "s.playlist.json": tempoSeq() });
    fake.durations.set("a.wav", 16);
    fake.durations.set("b.wav", 16);
    Audio.play("s.playlist.json");
    at(1);
    Assets.addSource(Assets.fromObject({ "s.playlist.json": seq({ length: 16, tempo: { bpm: 60, meter: "4/4" }, tracks: [track([{ id: "c1", sample: "b.wav", at: 0, length: 16, sync: true }])] }) }));
    at(1.1);
    expect(plays()).toEqual([["a.wav", 0]]);
    at(3.95);
    expect(plays()).toEqual([["a.wav", 0], ["b.wav", 4]]);
    expect(seeks().at(-1)).toBe(4);
    expect(lastFade(0)).toEqual({ kind: "fadeShaped", to: 0, seconds: 0.005, law: "linear", at: 4, stopAtEnd: true });
  });
});
