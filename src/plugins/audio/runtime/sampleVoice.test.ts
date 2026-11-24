// ADR 0342: every play of a sample applies its plan — a one-shot, an `AudioSource` and an `AudioZone` as a playlist voice
// does: the trimmed start (a start offset) and end (a stop with a short fade), the normalisation gain, and, when the
// caller loops, the sample's loop region (a held loop until `AudioSource.release`). A flattened render (`sample.source`)
// plays in the source's place without its baked gain applied again. Through the public API on the fake backend.
import { describe, expect, it, vi } from "vitest";
import { GameObject } from "../../../myco";
import { Audio, AudioSource, AudioZone } from "./index";
import { eventKit, pla, sample } from "./playlists/testKit";

const kit = eventKit();
const fake = kit.fake;
const IMPORT = "myco.import@1";
const SAMPLE = "myco.sample@1";
const GAIN_6DB = Math.pow(10, 6 / 20);
const NORMALIZE_6DB = { mode: "loudness", target: -16, gainDb: 6 };

const snippet = (source: string, range: [number, number], sampleBlock: Record<string, unknown> = {}) =>
  ({ format: SAMPLE, source, range, lineage: { kind: "snippet", parent: source, mode: "pin" }, sample: sampleBlock });

/** Advance the audio clock to `seconds` and run a frame (the playlist host's frame runs the trim stops). */
function at(seconds: number): void {
  kit.setTime(seconds);
  kit.frame();
}

function source(fields: Partial<Pick<AudioSource, "clip" | "loop" | "volume" | "pitch">>): AudioSource {
  return GameObject.create("n").addBehavior(AudioSource, { playOnAwake: false, ...fields });
}

describe("a one-shot of a sample (ADR 0342)", () => {
  it("a snippet plays only its range: it starts at the range's start and stops at its end", async () => {
    await kit.boot({ "audio/skid.wav": "data:skid", "audio/skid.brake.sample.json": snippet("audio/skid.wav", [0.8, 1.6]) });
    fake.durations.set("audio/skid.wav", 3);
    const h = Audio.playOneShot("audio/skid.brake.sample.json");
    expect(fake.plays[0]).toMatchObject({ path: "audio/skid.wav", offset: 0.8, oneShot: true });
    const v = fake.voices[0]!;
    at(0.75);
    expect(v.stopped).toBe(false);
    at(0.82);
    expect(v.stopped).toBe(true);
    expect(v.events).toContainEqual({ kind: "stop", fadeSeconds: 0.005 });
    expect(h.playing).toBe(false);
  });

  it("the trim's end counts at the one-shot's pitch", async () => {
    await kit.boot({ "a.wav.meta.json": { format: IMPORT, sample: { trim: [0.5, 1.5] } } });
    fake.durations.set("a.wav", 3);
    Audio.playOneShot("a.wav", { pitch: 2 });
    const v = fake.voices[0]!;
    at(0.45);
    expect(v.stopped).toBe(false);
    at(0.55);
    expect(v.stopped).toBe(true);
  });

  it("a trim that reaches the file's end leaves the voice to end by itself", async () => {
    await kit.boot({ "a.wav.meta.json": { format: IMPORT, sample: { trim: [0.5, 3] } } });
    fake.durations.set("a.wav", 3);
    Audio.playOneShot("a.wav");
    expect(fake.plays[0]!.offset).toBe(0.5);
    at(2.9);
    expect(fake.voices[0]!.events.some((e) => e.kind === "stop")).toBe(false);
  });

  it("`offset` starts into the trimmed sound; past the trim's end nothing plays", async () => {
    await kit.boot({ "x.sample.json": snippet("a.wav", [0.8, 1.6]) });
    fake.durations.set("a.wav", 3);
    Audio.playOneShot("x.sample.json", { offset: 0.25 });
    expect(fake.plays[0]!.offset).toBeCloseTo(1.05, 9);
    const h = Audio.playOneShot("x.sample.json", { offset: 1 });
    expect(fake.plays).toHaveLength(1);
    expect(h.playing).toBe(false);
  });

  it("the normalisation gain scales it, on top of the import volume and the one-shot's volume", async () => {
    await kit.boot({ "a.wav.meta.json": { format: IMPORT, volume: 0.5, sample: { normalize: NORMALIZE_6DB } } });
    Audio.playOneShot("a.wav", 0.5);
    expect(fake.voices[0]!.volume).toBeCloseTo(0.25 * GAIN_6DB, 6);
    expect("offset" in fake.plays[0]!).toBe(false);
  });

  it("a one-shot never loops, whatever loops the sample has", async () => {
    await kit.boot({ "a.wav.meta.json": { format: IMPORT, sample: { loops: [{ id: "l1", start: 0.5, end: 1.5 }] } } });
    Audio.playOneShot("a.wav");
    expect(fake.plays[0]!.loop).toBe(false);
    expect(fake.voices[0]!.events.some((e) => e.kind === "loop")).toBe(false);
  });
});

describe("an AudioSource playing a sample (ADR 0342)", () => {
  it("applies the normalisation gain at the play and on every volume change", async () => {
    await kit.boot({ "a.wav.meta.json": { format: IMPORT, volume: 0.5, sample: { normalize: NORMALIZE_6DB } } });
    const src = source({ clip: "a.wav", volume: 0.5 });
    src.play();
    const v = fake.voices[0]!;
    expect(fake.plays[0]!.volume).toBeCloseTo(0.25 * GAIN_6DB, 6);
    src.volume = 1;
    kit.frame();
    expect(v.volume).toBeCloseTo(0.5 * GAIN_6DB, 6);
  });

  it("not looping, a snippet stops at its range's end", async () => {
    await kit.boot({ "x.sample.json": snippet("a.wav", [0.2, 0.7]) });
    fake.durations.set("a.wav", 3);
    const src = source({ clip: "x.sample.json" });
    src.play();
    expect(fake.plays[0]).toMatchObject({ path: "a.wav", offset: 0.2, loop: false });
    at(0.45);
    expect(src.isPlaying).toBe(true);
    at(0.52);
    expect(src.isPlaying).toBe(false);
  });

  it("a pause holds the trim's end: the voice isn't cut while paused and stops where its playback reaches the end", async () => {
    await kit.boot({ "x.sample.json": snippet("a.wav", [0.2, 0.7]) });
    fake.durations.set("a.wav", 3);
    const src = source({ clip: "x.sample.json" });
    src.play();
    const v = fake.voices[0]!;
    at(0.3); // 0.5 s into the file: 0.2 s of the trim left
    src.pause();
    at(1);
    expect(v.stopped).toBe(false);
    src.resume();
    at(1.15);
    expect(v.stopped).toBe(false);
    at(1.25);
    expect(v.stopped).toBe(true);
  });

  it("a pitch change after the play moves the trim's end", async () => {
    await kit.boot({ "x.sample.json": snippet("a.wav", [0.2, 1.2]) });
    fake.durations.set("a.wav", 3);
    const src = source({ clip: "x.sample.json" });
    src.play();
    const v = fake.voices[0]!;
    at(0.2); // 0.4 s into the file: 0.8 s of the trim left, 0.4 s at pitch 2
    src.pitch = 2;
    kit.frame();
    expect(v.pitch).toBe(2);
    at(0.55);
    expect(v.stopped).toBe(false);
    at(0.65);
    expect(v.stopped).toBe(true);
  });

  it("a released held loop plays out to the trim's end and stops there, not at the file's end", async () => {
    const loops = (exit: string) => ({ format: IMPORT, sample: { trim: [0.2, 2], loops: [{ id: "l1", start: 0.5, end: 1.5, active: "held", exit }] } });
    await kit.boot({ "f.wav": "data:,", "f.wav.meta.json": loops("finish"), "j.wav": "data:,", "j.wav.meta.json": loops("jump") });
    fake.durations.set("f.wav", 3);
    fake.durations.set("j.wav", 3);
    const finish = source({ clip: "f.wav", loop: true });
    const jump = source({ clip: "j.wav", loop: true });
    finish.play();
    jump.play();
    const [fv, jv] = [fake.voices[0]!, fake.voices[1]!];
    at(1.7); // 1.9 s played: in the loop at 0.9
    expect(fv.stopped).toBe(false);
    finish.release(); // 1.1 s to the trim's end
    jump.release(); // jumps to 1.5: 0.5 s to the trim's end
    at(2.15);
    expect(jv.stopped).toBe(false);
    at(2.25);
    expect(jv.stopped).toBe(true);
    at(2.75);
    expect(fv.stopped).toBe(false);
    at(2.85);
    expect(fv.stopped).toBe(true);
  });

  it("`loop` loops the sidecar's loop region, from the trimmed start, and never stops at the trim's end", async () => {
    await kit.boot({ "a.wav.meta.json": { format: IMPORT, sample: { trim: [0.2, 2], loops: [{ id: "l1", start: 0.5, end: 1.5 }] } } });
    fake.durations.set("a.wav", 3);
    const src = source({ clip: "a.wav", loop: true });
    src.play();
    expect(fake.plays[0]).toMatchObject({ offset: 0.2, loop: true });
    const v = fake.voices[0]!;
    expect(v.events).toContainEqual({ kind: "loop", start: 0.5, end: 1.5, looping: true });
    at(5);
    expect(v.stopped).toBe(false);
  });

  it("`loop` without a sample loop loops the trimmed region", async () => {
    await kit.boot({ "x.sample.json": snippet("a.wav", [0.8, 1.6]) });
    const src = source({ clip: "x.sample.json", loop: true });
    src.play();
    expect(fake.voices[0]!.events).toContainEqual({ kind: "loop", start: 0.8, end: 1.6, looping: true });
  });

  it("a held loop lets go on `release` by its exit; an `always` loop ignores it", async () => {
    await kit.boot({
      "h.wav": "data:,", "h.wav.meta.json": { format: IMPORT, sample: { loops: [{ id: "l1", start: 0.5, end: 1.5, active: "held", exit: "jump" }] } },
      "a.wav.meta.json": { format: IMPORT, sample: { loops: [{ id: "l1", start: 0.5, end: 1.5, active: "always" }] } },
    });
    const held = source({ clip: "h.wav", loop: true });
    held.play();
    held.release();
    const hv = fake.voices[0]!;
    expect(hv.events.slice(-2)).toEqual([{ kind: "loop", start: 0.5, end: 1.5, looping: false }, { kind: "seek", seconds: 1.5 }]);
    held.release();
    expect(hv.events.filter((e) => e.kind === "loop")).toHaveLength(2);
    const always = source({ clip: "a.wav", loop: true });
    always.play();
    always.release();
    expect(fake.voices[1]!.events.filter((e) => e.kind === "loop")).toEqual([{ kind: "loop", start: 0.5, end: 1.5, looping: true }]);
  });

  it("a clip without sample edits plays as before: whole, at its import volume, looping by its own points", async () => {
    await kit.boot({ "a.wav.meta.json": { format: IMPORT, volume: 0.5 } });
    const src = source({ clip: "a.wav", loop: true });
    src.play();
    expect(fake.plays[0]).toEqual(expect.not.objectContaining({ offset: expect.anything() }));
    expect(fake.voices[0]!.volume).toBeCloseTo(0.5, 6);
    expect(fake.voices[0]!.events.some((e) => e.kind === "loop")).toBe(false);
  });
});

describe("an AudioZone playing a sample (ADR 0342)", () => {
  const withListener = { "s.json": { format: "myco.scene@1", nodes: [{ id: "ear", name: "ear", components: [{ type: "engine.Transform", data: { position: [0, 1, 0] } }, { type: "engine.AudioListener", data: {} }] }] } };

  it("loops the sample's loop region from its trimmed start, at its normalised level", async () => {
    await kit.boot({ ...withListener, "a.wav.meta.json": { format: IMPORT, sample: { trim: [0.1, 2.5], normalize: NORMALIZE_6DB, loops: [{ id: "l1", start: 0.5, end: 2, active: "held" }] } } });
    GameObject.create("zone").addBehavior(AudioZone, { sound: "a.wav", width: 40, depth: 40 });
    kit.frame();
    expect(fake.plays[0]).toMatchObject({ path: "a.wav", loop: true, offset: 0.1 });
    const v = fake.voices[0]!;
    expect(v.events).toContainEqual({ kind: "loop", start: 0.5, end: 2, looping: true });
    expect(v.volume).toBeCloseTo(GAIN_6DB, 6);
  });
});

describe("a playlist voice of a sample (ADR 0342)", () => {
  it("applies the normalisation gain once", async () => {
    await kit.boot({ "a.wav.meta.json": { format: IMPORT, volume: 0.5, sample: { normalize: NORMALIZE_6DB } }, "p.playlist.json": pla("clip", [sample("a.wav")]) });
    Audio.play("p.playlist.json");
    expect(fake.voices[0]!.volume).toBeCloseTo(0.5 * GAIN_6DB, 6);
  });
});

describe("a flattened render (ADR 0342, `sample.source`)", () => {
  it("plays in the source's place with the source's import settings; its baked gain isn't applied again; trim still applies", async () => {
    await kit.boot({
      "a.flat1.wav": "data:flat",
      "a.wav.meta.json": { format: IMPORT, volume: 0.5, sample: { trim: [0.1, 1], normalize: NORMALIZE_6DB, source: "a.flat1.wav" } },
    });
    fake.durations.set("a.flat1.wav", 3);
    Audio.playOneShot("a.wav");
    expect(fake.plays[0]).toMatchObject({ path: "a.flat1.wav", url: "data:flat", offset: 0.1 });
    expect(fake.voices[0]!.volume).toBeCloseTo(0.5, 6);
    const src = source({ clip: "a.wav" });
    src.play();
    expect(fake.plays[1]).toMatchObject({ path: "a.flat1.wav" });
    expect(fake.voices[1]!.volume).toBeCloseTo(0.5, 6);
    at(0.95);
    expect(fake.voices[0]!.stopped).toBe(true);
  });

  it("a bare name is found beside the source; a derived sample plays its source's render", async () => {
    await kit.boot({
      "audio/x.wav": "data:x", "audio/x.flat1.wav": "data:xflat",
      "audio/x.wav.meta.json": { format: IMPORT, sample: { source: "x.flat1.wav" } },
      "audio/x.dup.sample.json": { format: SAMPLE, source: "audio/x.wav", range: [0.5, 1], lineage: { kind: "duplicate", parent: "audio/x.wav", mode: "pin" }, sample: { source: "x.flat1.wav" } },
    });
    Audio.playOneShot("audio/x.wav");
    expect(fake.plays[0]).toMatchObject({ path: "audio/x.flat1.wav", url: "data:xflat" });
    Audio.playOneShot("audio/x.dup.sample.json");
    expect(fake.plays[1]).toMatchObject({ path: "audio/x.flat1.wav", offset: 0.5 });
  });

  it("a render that isn't in the project warns once with the path; the source plays with every edit", async () => {
    await kit.boot({ "a.wav.meta.json": { format: IMPORT, sample: { normalize: NORMALIZE_6DB, source: "gone.flat1.wav" } } });
    Audio.playOneShot("a.wav");
    Audio.playOneShot("a.wav");
    expect(fake.plays[0]!.path).toBe("a.wav");
    expect(fake.voices[0]!.volume).toBeCloseTo(GAIN_6DB, 6);
    const lines = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('a.wav: its render "gone.flat1.wav" isn\'t in the project'))).toHaveLength(1);
  });
});
