// ADR 0293: the clip resolver turns a clip path into the base play request every caller (sources, one-shots, event
// clips, music stems) starts from. Driven through its own interface on the fake backend, whose clip cache reports the
// clips' facts (ADR 0286), and the project's assets and buses.
import { describe, expect, it } from "vitest";
import { clipFacts, clipRequest, clipStreams, clipVolume, isAmbisonicClip } from "./clipResolver";
import { eventKit } from "./events/eventTestKit";

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

  it("music decodes up to 30 s and streams beyond once the backend knows the clip's facts, else follows the import setting", async () => {
    await kit.boot({ "long.ogg": "data:l", "short.ogg": "data:s", "s.ogg": "data:x", "s.ogg.meta.json": { format: IMPORT, stream: true } });
    expect([clipStreams("long.ogg", "music"), clipStreams("s.ogg", "music")]).toEqual([false, true]);
    expect(clipFacts("long.ogg")).toBeUndefined();
    kit.fake.facts.set("long.ogg", { frames: 31 * RATE, rate: RATE, channels: 2, gapless: true });
    kit.fake.facts.set("short.ogg", { frames: 30 * RATE, rate: RATE, channels: 2, gapless: true });
    kit.fake.facts.set("s.ogg", { frames: 10 * RATE, rate: RATE, channels: 2, gapless: true });
    expect(clipFacts("long.ogg")?.frames).toBe(31 * RATE);
    expect(["long.ogg", "short.ogg", "s.ogg"].map((p) => clipStreams(p, "music"))).toEqual([true, false, false]);
    expect(clipRequest("long.ogg", true, undefined, "music").stream).toBe(true);
    // The import setting still decides a sound.
    expect(clipStreams("long.ogg")).toBe(false);
  });

  it("music is never ambisonic (the music lint refuses ambisonic stems)", async () => {
    await kit.boot({ "amb.wav": "data:amb", "amb.wav.meta.json": { format: IMPORT, ambisonic: { convention: "ambix" } } });
    expect("ambisonic" in clipRequest("amb.wav", false, undefined, "music")).toBe(false);
  });
});
