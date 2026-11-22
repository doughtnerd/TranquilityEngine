// ADR 0293: the clip resolver turns a clip path into the base play request every caller (sources, one-shots, zones,
// playlist voices) starts from. Driven through its own interface on the fake backend, whose clip cache reports the
// clips' facts (ADR 0286), and the project's assets and buses.
import { describe, expect, it, vi } from "vitest";
import { Assets } from "../../../myco";
import { clipFacts, clipRequest, clipSource, clipStreams, clipVolume, isAmbisonicClip, sampleEdits, samplePlan } from "./clipResolver";
import { eventKit } from "./playlists/testKit";

const kit = eventKit();
const RATE = 48_000;
const IMPORT = "myco.import@1";

describe("the clip resolver (ADR 0293)", () => {
  it("gives the URL, the bus (unknown or empty: Master) and the import volume", async () => {
    await kit.boot({ "q.wav": "data:q", "q.wav.meta.json": { format: IMPORT, volume: 0.25 } });
    expect(clipRequest("a.wav", true, "SFX")).toEqual({ path: "a.wav", url: "data:,", loop: true, stream: false, bus: "SFX", volume: 1 });
    expect(clipRequest("q.wav", false, undefined)).toMatchObject({ url: "data:q", bus: "Master", volume: 0.25 });
    expect(clipRequest("q.wav", false, "Nope").bus).toBe("Master");
    expect(clipVolume("q.wav")).toBe(0.25);
  });

  it("throws for a missing clip, as every caller expects", async () => {
    await kit.boot({});
    expect(() => clipRequest("gone.wav", false, undefined)).toThrow(/not found/);
  });

  it("a sound streams by its import setting; an ambisonic sound carries the flag", async () => {
    await kit.boot({
      "s.wav": "data:s", "s.wav.meta.json": { format: IMPORT, stream: true },
      "amb.wav": "data:amb", "amb.wav.meta.json": { format: IMPORT, ambisonic: { convention: "ambix" } },
    });
    expect(clipRequest("s.wav", false, undefined).stream).toBe(true);
    expect(clipRequest("a.wav", false, undefined).stream).toBe(false);
    const amb = clipRequest("amb.wav", false, undefined);
    expect([amb.ambisonic, amb.stream, isAmbisonicClip("amb.wav")]).toEqual([true, false, true]);
    expect("ambisonic" in clipRequest("a.wav", false, undefined)).toBe(false);
  });

  it("the clip's facts come from the backend's clip cache once it knows them; the import setting decides streaming", async () => {
    await kit.boot({ "long.ogg": "data:l", "s.ogg": "data:x", "s.ogg.meta.json": { format: IMPORT, stream: true } });
    expect(clipFacts("long.ogg")).toBeUndefined();
    kit.fake.facts.set("long.ogg", { frames: 31 * RATE, rate: RATE, channels: 2, gapless: true });
    expect(clipFacts("long.ogg")?.frames).toBe(31 * RATE);
    expect([clipStreams("long.ogg"), clipStreams("s.ogg")]).toEqual([false, true]);
  });
});

describe("derived samples through the clip resolver (ADR 0328)", () => {
  const SAMPLE = "myco.sample@1";
  const LOOP = { id: "l1", start: 0.5, end: 1.5 };

  it("a derived sample's request is its source file's: path, URL, import volume and stream rule", async () => {
    await kit.boot({
      "audio/skid.wav": "data:skid", "audio/skid.wav.meta.json": { format: IMPORT, volume: 0.5, stream: true },
      "audio/skid.dup.sample.json": { format: SAMPLE, source: "audio/skid.wav", range: null, lineage: { kind: "duplicate", parent: "audio/skid.wav", mode: "pin" } },
    });
    expect(clipRequest("audio/skid.dup.sample.json", false, "SFX")).toEqual({ path: "audio/skid.wav", url: "data:skid", loop: false, stream: true, bus: "SFX", volume: 0.5 });
    expect([clipSource("audio/skid.dup.sample.json"), clipVolume("audio/skid.dup.sample.json"), clipStreams("audio/skid.dup.sample.json")]).toEqual(["audio/skid.wav", 0.5, true]);
  });

  it("a snippet's plan trims to its range; the plan's gain and loop are its block's", async () => {
    await kit.boot({
      "x.sample.json": { format: SAMPLE, source: "a.wav", range: [0.8, 1.6], lineage: { kind: "snippet", parent: "a.wav", mode: "pin" }, sample: { normalize: { mode: "peak", target: -1, gainDb: 6 } } },
    });
    const plan = samplePlan("x.sample.json");
    expect(plan.trim).toEqual([0.8, 1.6]);
    expect(plan.gain).toBeCloseTo(Math.pow(10, 6 / 20));
    expect(sampleEdits("x.sample.json")?.trim).toEqual([0.8, 1.6]);
  });

  it("a following fork picks up an edit to its parent's sidecar, and an edit to its own file", async () => {
    const files: Record<string, unknown> = {
      "a.wav.meta.json": { format: IMPORT, sample: { kind: "loop", loops: [LOOP] } },
      "f.sample.json": { format: SAMPLE, source: "a.wav", range: null, lineage: { kind: "fork", parent: "a.wav", mode: "follow", baseline: { kind: "loop", loops: [LOOP] } }, sample: { kind: "loop", loops: [LOOP] } },
    };
    await kit.boot({});
    Assets.addSource(Assets.fromObject(files));
    expect(samplePlan("f.sample.json").loop?.end).toBe(1.5);
    files["a.wav.meta.json"] = { format: IMPORT, sample: { kind: "loop", loops: [{ ...LOOP, end: 1.25 }] } };
    expect(samplePlan("f.sample.json").loop?.end).toBe(1.25);
    files["f.sample.json"] = { ...(files["f.sample.json"] as object), sample: { kind: "loop", loops: [{ ...LOOP, start: 0.25, end: 1 }] } };
    expect(samplePlan("f.sample.json").loop).toMatchObject({ start: 0.25, end: 1 });
  });

  it("a derived sample with no playable source throws from clipRequest and warns once, naming it", async () => {
    await kit.boot({ "m.sample.json": { format: SAMPLE, source: "gone.wav", range: null, lineage: { kind: "duplicate", parent: "gone.wav", mode: "pin" } } });
    const warn = vi.mocked(console.warn);
    expect(() => clipRequest("m.sample.json", false, undefined)).toThrow(/m\.sample\.json/);
    expect(() => clipRequest("m.sample.json", false, undefined)).toThrow();
    expect(clipSource("nope.sample.json")).toBe("");
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('its source "gone.wav" isn\'t in the project'))).toHaveLength(1);
    expect(lines.some((l) => l.includes("nope.sample.json"))).toBe(true);
  });
});
