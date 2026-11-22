// ADR 0293: the clip resolver turns a clip path into the base play request every caller (sources, one-shots, zones,
// playlist voices) starts from. Driven through its own interface on the fake backend, whose clip cache reports the
// clips' facts (ADR 0286), and the project's assets and buses.
import { describe, expect, it } from "vitest";
import { clipFacts, clipRequest, clipStreams, clipVolume, isAmbisonicClip } from "./clipResolver";
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
