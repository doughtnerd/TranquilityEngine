// ADR 0329: down-the-tree accumulation, playlist effects, linked playlists and Layer, through `Audio.play` on the fake backend.
import { describe, expect, it } from "vitest";
import { Audio } from "../Audio";
import { embed, eventKit, link, pl, pla, sample } from "../events/eventTestKit";

const kit = eventKit();
const fake = kit.fake;

const db = (x: number): number => Math.pow(10, x / 20);
const st = (x: number): number => Math.pow(2, x / 12);

describe("down the tree", () => {
  it("gains add in dB and pitch adds in semitones, from the root to the sample", async () => {
    await kit.boot({
      "t.playlist.json": pla("layer", [
        embed(pl("clip", [sample("a.wav", { volume: -2, pitch: 1 })], { volume: -3, pitch: 2 }), { volume: -4, pitch: 3 }),
      ], { volume: -6, pitch: -1 }),
    });
    Audio.play("t.playlist.json");
    expect(fake.plays).toHaveLength(1);
    expect(fake.plays[0]!.volume).toBeCloseTo(db(-6 - 4 - 3 - 2), 6);
    expect(fake.plays[0]!.pitch).toBeCloseTo(st(-1 + 3 + 2 + 1), 6);
  });

  it("the handle's volume and pitch options multiply on top", async () => {
    await kit.boot({ "t.playlist.json": pla("clip", [sample("a.wav")], { volume: -6 }) });
    Audio.play("t.playlist.json", { volume: 0.5, pitch: 2 });
    expect(fake.plays[0]!.volume).toBeCloseTo(0.5 * db(-6), 6);
    expect(fake.plays[0]!.pitch).toBeCloseTo(2, 6);
  });

  it("volumeRandom and pitchRandom draw within their ranges per trigger", async () => {
    await kit.boot({ "r.playlist.json": pla("clip", [sample("a.wav")], { volumeRandom: [-6, 0], pitchRandom: [-2, 2] }) });
    for (let i = 0; i < 40; i++) Audio.play("r.playlist.json");
    const vols = fake.plays.map((p) => p.volume!);
    const pitches = fake.plays.map((p) => p.pitch!);
    for (const v of vols) { expect(v).toBeGreaterThanOrEqual(db(-6) - 1e-9); expect(v).toBeLessThanOrEqual(1 + 1e-9); }
    for (const p of pitches) { expect(p).toBeGreaterThanOrEqual(st(-2) - 1e-9); expect(p).toBeLessThanOrEqual(st(2) + 1e-9); }
    expect(new Set(vols).size).toBeGreaterThan(30);
  });

  it("low-pass takes the minimum and high-pass the maximum of the playlist effects down the tree", async () => {
    const lp = (cutoff: number) => ({ id: `lp${cutoff}`, type: "lowpass", params: { cutoff } });
    const hp = (cutoff: number) => ({ id: `hp${cutoff}`, type: "highpass", params: { cutoff } });
    await kit.boot({
      "f.playlist.json": pla("layer", [embed(pl("clip", [sample("a.wav")], { effects: [lp(4000), hp(100)] }))], { effects: [lp(2000), hp(300)] }),
    });
    Audio.play("f.playlist.json");
    expect(fake.plays[0]!.filter).toEqual({ lowpass: 2000, highpass: 300 });
  });

  it("a gain effect adds its dB; other effect types are skipped with one warning per type", async () => {
    await kit.boot({
      "g.playlist.json": pla("clip", [sample("a.wav")], { effects: [{ id: "g", type: "gain", params: { gain: -6 } }, { id: "r", type: "reverb" }, { id: "r2", type: "reverb" }] }),
    });
    Audio.play("g.playlist.json");
    Audio.play("g.playlist.json");
    expect(fake.plays[0]!.volume).toBeCloseTo(db(-6), 6);
    const warns = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => String(c[0]).includes('"reverb" needs instance submixes'));
    expect(warns).toHaveLength(1);
  });

  it("an output override sends the entry to its bus and cuts its parent's playlist effects", async () => {
    await kit.boot({
      "o.playlist.json": pla("layer", [
        embed(pl("clip", [sample("a.wav")], { output: "SFX" })),
        embed(pl("clip", [sample("b.wav")])),
      ], { effects: [{ id: "lp", type: "lowpass", params: { cutoff: 1000 } }, { id: "g", type: "gain", params: { gain: -12 } }], volume: -3 }),
    });
    Audio.play("o.playlist.json");
    const a = fake.plays.find((p) => p.path === "a.wav")!;
    const b = fake.plays.find((p) => p.path === "b.wav")!;
    expect(a.bus).toBe("SFX");
    expect(a.filter).toBeUndefined();
    expect(a.volume).toBeCloseTo(db(-3), 6); // the level's own volume still applies; its effects don't
    expect(b.bus).toBe("Master");
    expect(b.filter).toEqual({ lowpass: 1000 });
    expect(b.volume).toBeCloseTo(db(-3 - 12), 6);
  });

  it("Audio.play's bus option sets the root output", async () => {
    await kit.boot({ "o.playlist.json": pla("clip", [sample("a.wav")]) });
    Audio.play("o.playlist.json", { bus: "SFX" });
    expect(fake.plays[0]!.bus).toBe("SFX");
  });

  it("a layer plays every entry", async () => {
    await kit.boot({ "l.playlist.json": pla("layer", [sample("a.wav"), sample("b.wav"), sample("c.wav")]) });
    Audio.play("l.playlist.json");
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav", "c.wav"]);
  });

  it("playback.delay starts the voices later on the audio clock", async () => {
    await kit.boot({ "d.playlist.json": pla("clip", [sample("a.wav")], { playback: { delay: 0.5 } }) });
    kit.setTime(2);
    Audio.play("d.playlist.json");
    expect(fake.plays[0]!.at).toBeCloseTo(2.5, 6);
  });

  it("sample sidecar edits: trim starts the voice at its start (a start offset), normalise adds its gain", async () => {
    await kit.boot({
      "a.wav.meta.json": { format: "myco.import@1", sample: { trim: [0.25, 0.75], normalize: { mode: "peak", target: -1, gainDb: 6 } } },
      "n.playlist.json": pla("clip", [sample("a.wav")]),
    });
    Audio.play("n.playlist.json");
    expect(fake.plays[0]!.volume).toBeCloseTo(db(6), 6);
    expect(fake.plays[0]!.offset).toBe(0.25);
  });

  it("a trimmed sample stops at its trim end", async () => {
    await kit.boot({ "n.playlist.json": pla("clip", [sample("a.wav", { trim: [0, 0.5] })]) });
    fake.durations.set("a.wav", 2);
    Audio.play("n.playlist.json");
    kit.setTime(0.4);
    kit.frame();
    expect(fake.voices[0]!.stopped).toBe(false);
    kit.setTime(0.51);
    kit.frame();
    expect(fake.voices[0]!.stopped).toBe(true);
  });
});

describe("spatial", () => {
  it("distances come from the attenuation preset the playlist names; the handle's position moves its voices", async () => {
    await kit.boot({
      "near.attenuation.json": { format: "myco.attenuation@1", minDistance: 2, maxDistance: 40 },
      "s.playlist.json": pla("clip", [sample("a.wav")], { spatial: { attenuation: "near.attenuation.json", occlusion: false, doppler: 1.5 } }),
    });
    const h = Audio.play("s.playlist.json", { position: { x: 1, y: 2, z: 3 } });
    expect(fake.plays[0]).toMatchObject({ attenuation: { minDistance: 2, maxDistance: 40, rolloff: "inverse" }, position: { x: 1, y: 2, z: 3 }, occlusion: false, dopplerLevel: 1.5 });
    expect(h.position).toEqual({ x: 1, y: 2, z: 3 });
    h.position = { x: 4, y: 5, z: 6 };
    expect(fake.voices[0]!.position).toEqual({ x: 4, y: 5, z: 6 });
  });

  it("inline attenuation; a flat playlist ignores the position", async () => {
    await kit.boot({
      "i.playlist.json": pla("clip", [sample("a.wav")], { spatial: { attenuation: { minDistance: 3, maxDistance: 9 } } }),
      "f.playlist.json": pla("clip", [sample("b.wav")]),
    });
    Audio.play("i.playlist.json", { position: { x: 0, y: 0, z: 1 } });
    const flat = Audio.play("f.playlist.json", { position: { x: 0, y: 0, z: 1 } });
    expect(fake.plays[0]!.attenuation).toEqual({ minDistance: 3, maxDistance: 9, rolloff: "inverse" });
    expect(fake.plays[1]!.position).toBeUndefined();
    expect(flat.position).toBeNull();
  });
});

describe("linked playlists", () => {
  it("resolve by path", async () => {
    await kit.boot({
      "outer.playlist.json": pla("layer", [link("inner.playlist.json", { volume: -6 })]),
      "inner.playlist.json": pla("clip", [sample("b.wav")], { volume: -3 }),
    });
    Audio.play("outer.playlist.json");
    expect(fake.plays.map((p) => p.path)).toEqual(["b.wav"]);
    expect(fake.plays[0]!.volume).toBeCloseTo(db(-9), 6);
  });

  it("keep their own pick state: a linked Queue's round robin advances across parents", async () => {
    await kit.boot({
      "x.playlist.json": pla("layer", [link("rr.playlist.json")]),
      "y.playlist.json": pla("layer", [link("rr.playlist.json")]),
      "rr.playlist.json": pla("queue", [sample("a.wav"), sample("b.wav"), sample("c.wav")], { queue: { pick: "roundRobin" } }),
    });
    Audio.play("x.playlist.json");
    Audio.play("y.playlist.json");
    Audio.play("rr.playlist.json");
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav", "c.wav"]);
  });

  it("refuse a cycle: the entry that would contain itself plays nothing, with one warning", async () => {
    await kit.boot({
      "a.playlist.json": pla("layer", [sample("a.wav"), link("b.playlist.json")]),
      "b.playlist.json": pla("layer", [sample("b.wav"), link("a.playlist.json")]),
    });
    Audio.play("a.playlist.json");
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav"]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("would contain itself"));
  });

  it("a missing linked playlist plays nothing and warns once", async () => {
    await kit.boot({ "a.playlist.json": pla("layer", [sample("a.wav"), link("gone.playlist.json")]) });
    Audio.play("a.playlist.json");
    Audio.play("a.playlist.json");
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "a.wav"]);
    expect((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => String(c[0]).includes("gone.playlist.json"))).toHaveLength(1);
  });

  it("an edited asset plays its new version on the next trigger (hot reload)", async () => {
    const assets: Record<string, unknown> = { "h.playlist.json": pla("clip", [sample("a.wav")]) };
    await kit.boot(assets);
    Audio.play("h.playlist.json");
    const { Assets } = await import("../../../../myco");
    Assets.addSource(Assets.fromObject({ "h.playlist.json": pla("clip", [sample("b.wav")]) }));
    Audio.play("h.playlist.json");
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav"]);
  });
});
