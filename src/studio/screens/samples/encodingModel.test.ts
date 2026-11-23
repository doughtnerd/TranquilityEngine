// ADR 0351 §6, A6: the Samples Inspector's Encoding section through its model — where each value comes from (the
// inheritance display), overrides per key for one platform or every platform and their resets, the profile choice, the
// profile and folder-rule matches, and the readouts (estimated until converted, exact after).
import { describe, expect, it } from "vitest";
import { parseEncodingConfig } from "../../../engine/audio/encoding/format";
import { resolveEncoding } from "../../../engine/audio/encoding/resolve";
import { defaultImportSettings, type ImportSettings } from "../../../engine/scene/importSettings";
import type { PlannedSound } from "../../../export/audio";
import { encodingRows, overrideKey, platformReadout, profileMatches, resetKey, setProfile } from "./encodingModel";

const config = parseEncodingConfig({
  default: "Default",
  profiles: {
    Default: { codec: "auto", quality: 0.5, load: "decode", platforms: { android: { quality: 0.35, sampleRate: 32000 } } },
    Music: { codec: "vorbis", quality: 0.6, load: "stream", prefetchMs: 250, platforms: { android: { quality: 0.3 } } },
    UI: { codec: "adpcm", load: "compressed" },
  },
  rules: [{ path: "audio/music/**", profile: "Music" }, { path: "audio/**/*.wav", profile: "UI" }],
}, []);

const PATH = "audio/music/theme.wav";
const settingsWith = (over: Partial<ImportSettings> = {}): ImportSettings => ({ ...defaultImportSettings(), ...over });
const resolve = (s: ImportSettings, platform: "web" | "desktop" | "android") => resolveEncoding({ path: PATH, encoding: s.encoding, legacyStream: s.stream }, platform, config);
const row = (s: ImportSettings, platform: "web" | "desktop" | "android", key: string) => encodingRows(resolve(s, platform), PATH).find((r) => r.key === key)!;
const next = (r: ReturnType<typeof overrideKey>): ImportSettings => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};

describe("Encoding section rows", () => {
  it("show each key's value and where it came from: the file, a platform override, the rule's profile, the default, built-in", () => {
    const s = settingsWith({ encoding: { quality: 0.8, platforms: { android: { channels: "mono" } } } });
    const rows = encodingRows(resolve(s, "android"), PATH);
    expect(rows.map((r) => [r.key, r.text, r.from, r.overridden, r.platformOverride])).toEqual([
      ["codec", "Vorbis", "Music profile (rule audio/music/**)", false, false],
      ["quality", "0.80", "this file", true, false],
      ["sampleRate", "32 kHz", "Default profile (default) · Android", false, false],
      ["channels", "Mono", "this file · Android", true, true],
      ["load", "Stream", "Music profile (rule audio/music/**)", false, false],
      ["prefetchMs", "250 ms", "Music profile (rule audio/music/**)", false, false],
    ]);
    // Web has no sample-rate layer anywhere: the engine's built-in default.
    expect(row(s, "web", "sampleRate").from).toBe("built-in (Web)");
  });

  it("show the legacy stream flag as the file's load", () => {
    const s = settingsWith({ stream: true });
    expect(row(s, "web", "load")).toMatchObject({ text: "Stream", from: "this file (stream: true)", overridden: true });
  });
});

describe("overrides and resets", () => {
  it("override a key for one platform only, then reset it back to the inherited value", () => {
    const base = settingsWith();
    const android = next(overrideKey(base, "android", "quality", 0.9));
    expect(android.encoding).toEqual({ platforms: { android: { quality: 0.9 } } });
    expect(row(android, "android", "quality")).toMatchObject({ text: "0.90", from: "this file · Android", platformOverride: true });
    // Other platforms still inherit.
    expect(row(android, "web", "quality")).toMatchObject({ text: "0.60", from: "Music profile (rule audio/music/**)", overridden: false });
    const reset = next(resetKey(android, "android", "quality"));
    expect(reset.encoding).toBeNull();
    expect(row(reset, "android", "quality")).toMatchObject({ text: "0.30", from: "Music profile (rule audio/music/**) · Android", overridden: false });
  });

  it("override a key for every platform; a reset takes the platform's own override first, then every platform's", () => {
    const both = next(overrideKey(next(overrideKey(settingsWith(), null, "codec", "opus")), "web", "codec", "pcm"));
    expect(both.encoding).toEqual({ codec: "opus", platforms: { web: { codec: "pcm" } } });
    expect(row(both, "web", "codec").text).toBe("PCM");
    expect(row(both, "desktop", "codec")).toMatchObject({ text: "Opus", from: "this file" });
    const once = next(resetKey(both, "web", "codec"));
    expect(row(once, "web", "codec")).toMatchObject({ text: "Opus", from: "this file" });
    const twice = next(resetKey(once, "web", "codec"));
    expect(twice.encoding).toBeNull();
    expect(row(twice, "web", "codec").from).toBe("Music profile (rule audio/music/**)");
    expect(resetKey(twice, "web", "codec")).toEqual({ refused: "this file doesn't set codec; it is inherited" });
  });

  it("keep the legacy stream flag in step with an every-platform load override, and clear it on reset", () => {
    const s = next(overrideKey(settingsWith(), null, "load", "stream"));
    expect(s).toMatchObject({ stream: true, encoding: { load: "stream" } });
    const d = next(overrideKey(s, null, "load", "compressed"));
    expect(d).toMatchObject({ stream: false, encoding: { load: "compressed" } });
    const r = next(resetKey(d, "web", "load"));
    expect(r).toMatchObject({ stream: false, encoding: null });
    // An old sidecar's `stream: true` is reset like an override.
    expect(next(resetKey(settingsWith({ stream: true }), "web", "load")).stream).toBe(false);
  });

  it("clamp numbers and refuse mono for an ambisonic file", () => {
    expect(next(overrideKey(settingsWith(), null, "quality", 1.7)).encoding).toEqual({ quality: 1 });
    expect(next(overrideKey(settingsWith(), "android", "prefetchMs", 2500.4)).encoding).toEqual({ platforms: { android: { prefetchMs: 2000 } } });
    const amb = settingsWith({ ambisonic: { order: 1, convention: "ambix" } });
    expect(overrideKey(amb, null, "channels", "mono")).toEqual({ refused: "an ambisonic file keeps its channels (mono would lose the sound field)" });
  });

  it("choose the file's profile, keeping its overrides; an unknown profile is refused", () => {
    const s = next(setProfile(settingsWith({ encoding: { quality: 0.7 } }), "UI", config));
    expect(s.encoding).toEqual({ quality: 0.7, profile: "UI" });
    expect(row(s, "web", "codec")).toMatchObject({ text: "ADPCM", from: "UI profile" });
    expect(next(setProfile(s, null, config)).encoding).toEqual({ quality: 0.7 });
    expect(setProfile(s, "Nope", config)).toEqual({ refused: 'there\'s no profile named "Nope"' });
  });
});

describe("profile and rule matches", () => {
  it("list the profiles consulted nearest first, then rules that match after the first", () => {
    const m = profileMatches(resolve(settingsWith(), "web"), config, PATH);
    expect(m).toEqual([
      { text: "Music profile · rule audio/music/**", kind: "uses" },
      { text: "Default profile · the project default", kind: "fallback" },
      { text: "rule audio/**/*.wav (UI) also matches; an earlier rule wins", kind: "shadowed" },
    ]);
  });
});

describe("readouts", () => {
  const sound = (s: ImportSettings, codec: PlannedSound["codec"]): PlannedSound => ({ path: PATH, renderOf: null, resolution: resolve(s, "web"), codec, load: resolve(s, "web").settings.load, ambisonic: false, packages: ["Music"], notes: [] });
  const facts = { bytes: 10_000_000, frames: 48000 * 60, rate: 48000, channels: 2 };

  it("estimate until converted, then give the conversion's figures", () => {
    const s = settingsWith({ encoding: { load: "decode", sampleRate: 24000 } });
    const est = platformReadout("web", sound(s, "vorbis"), facts, null);
    expect(est.figures).toMatchObject({ codec: "vorbis", rate: 24000, channels: 2, frames: 24000 * 60, exact: false, memoryBytes: 24000 * 60 * 2 * 2 });
    expect(est.figures!.bytes).toBeGreaterThan(300_000);
    expect(est.packages).toEqual(["Music"]);
    const exact = platformReadout("web", sound(s, "vorbis"), facts, { key: "k", codec: "vorbis", bytes: new Uint8Array(500_000), rate: 24000, channels: 2, frames: 24000 * 60, sourceBytes: 10_000_000, cached: false, notes: [] });
    expect(exact.figures).toMatchObject({ bytes: 500_000, exact: true });
    expect(exact.ratio).toBe(0.05);
  });

  it("count a streamed sound's memory as its prefetch head, a compressed one's as its bytes", () => {
    const streamed = platformReadout("web", sound(settingsWith(), "vorbis"), facts, null);
    expect(streamed.load).toBe("stream");
    expect(streamed.figures!.memoryBytes).toBe(Math.round(0.25 * 48000) * 2 * 2);
    const compressed = platformReadout("web", sound(settingsWith({ encoding: { load: "compressed" } }), "vorbis"), facts, null);
    expect(compressed.figures!.memoryBytes).toBe(compressed.figures!.bytes);
  });

  it("wait for the source's length unless it ships as its source", () => {
    const unknown = { bytes: 1234, frames: null, rate: null, channels: null };
    expect(platformReadout("web", sound(settingsWith(), "vorbis"), unknown, null).figures).toBeNull();
    expect(platformReadout("web", sound(settingsWith(), "source"), unknown, null).figures).toMatchObject({ bytes: 1234, exact: false });
  });
});
