// ADR 0337 §2: the encoding resolver — every inheritance level, each key on its own, and where each value came from.
import { describe, expect, it } from "vitest";
import { parseEncodingConfig } from "./format";
import { originLabel, resolveEncoding, withEncodingKey, type EncodingSubject } from "./resolve";
import type { EncodingConfig } from "./types";

const problems: string[] = [];
const config: EncodingConfig = parseEncodingConfig(
  {
    default: "Default",
    profiles: {
      Default: { codec: "auto", quality: 0.5, load: "decode", platforms: { android: { quality: 0.35, sampleRate: 32000 } } },
      Music: { codec: "vorbis", quality: 0.6, load: "stream", prefetchMs: 250 },
      Dialogue: { codec: "opus", quality: 0.3, channels: "mono", load: "compressed" },
      UI: { codec: "adpcm", load: "compressed", platforms: { web: { channels: "mono" } } },
    },
    rules: [
      { path: "audio/music/**", profile: "Music" },
      { path: "audio/vo/**", profile: "Dialogue" },
      { path: "audio/music/stingers/**", profile: "UI" }, // never reached: first match wins
    ],
  },
  problems,
);

const file = (path: string, encoding: EncodingSubject["encoding"] = null, extra: Partial<EncodingSubject> = {}): EncodingSubject => ({ path, encoding, ...extra });

describe("resolveEncoding", () => {
  it("parses the ADR's example section without problems", () => {
    expect(problems).toEqual([]);
  });

  it("gives the built-in defaults per platform when nothing is set", () => {
    const empty = parseEncodingConfig(undefined, []);
    for (const [platform, quality] of [["web", 0.5], ["desktop", 0.6], ["android", 0.4]] as const) {
      const r = resolveEncoding(file("a.wav"), platform, empty);
      expect(r.settings).toEqual({ codec: "auto", quality, sampleRate: "source", channels: "source", load: "decode", prefetchMs: 0 });
      expect(Object.values(r.origins).every((o) => o.level === "builtin" && o.platform === platform)).toBe(true);
      expect(r.profiles).toEqual([]);
    }
  });

  it("walks sidecar platform → sidecar → profile platform → profile → rule profile → default profile → built-in, per key", () => {
    // Every level sets a different key, so each key's origin names one level.
    const cfg = parseEncodingConfig(
      {
        default: "D",
        profiles: {
          S: { platforms: { android: { load: "compressed" } }, channels: "mono" }, // the sidecar's profile
          R: { platforms: { android: { prefetchMs: 100 } }, sampleRate: 22050 }, // the rule's
          D: { codec: "opus" }, // the default
        },
        rules: [{ path: "sfx/**", profile: "R" }],
      },
      [],
    );
    const subject = file("sfx/hit.wav", { profile: "S", quality: 0.9, platforms: { android: { quality: 0.2 } } });
    // quality: the sidecar's android override beats its base.
    const r = resolveEncoding(subject, "android", cfg);
    expect(r.settings).toEqual({ codec: "opus", quality: 0.2, sampleRate: 22050, channels: "mono", load: "compressed", prefetchMs: 100 });
    expect(r.origins.quality).toEqual({ level: "sidecar", file: "sfx/hit.wav", platform: "android" });
    expect(r.origins.load).toEqual({ level: "profile", profile: "S", platform: "android", via: { kind: "sidecar", file: "sfx/hit.wav" } });
    expect(r.origins.channels).toEqual({ level: "profile", profile: "S", platform: null, via: { kind: "sidecar", file: "sfx/hit.wav" } });
    expect(r.origins.prefetchMs).toEqual({ level: "profile", profile: "R", platform: "android", via: { kind: "rule", index: 0, path: "sfx/**" } });
    expect(r.origins.sampleRate).toEqual({ level: "profile", profile: "R", platform: null, via: { kind: "rule", index: 0, path: "sfx/**" } });
    expect(r.origins.codec).toEqual({ level: "profile", profile: "D", platform: null, via: { kind: "default" } });
    expect(r.profiles.map((p) => p.name)).toEqual(["S", "R", "D"]);
    // On web the android overrides drop out: quality from the sidecar's base, load and prefetch from the built-in.
    const web = resolveEncoding(subject, "web", cfg);
    expect(web.settings).toMatchObject({ quality: 0.9, load: "decode", prefetchMs: 0 });
    expect(web.origins.quality).toEqual({ level: "sidecar", file: "sfx/hit.wav", platform: null });
    expect(web.origins.load).toEqual({ level: "builtin", platform: "web" });
  });

  it("takes a profile from the first matching rule", () => {
    const r = resolveEncoding(file("audio/music/stingers/win.wav"), "desktop", config);
    expect(r.settings).toMatchObject({ codec: "vorbis", quality: 0.6, load: "stream", prefetchMs: 250 });
    expect(r.profiles[0]).toEqual({ name: "Music", via: { kind: "rule", index: 0, path: "audio/music/**" } });
    expect(originLabel(r.origins.codec, "audio/music/stingers/win.wav")).toBe("Music profile (rule audio/music/**)");
  });

  it("falls back to the default profile for keys the chosen profile leaves unset", () => {
    // UI sets no quality: Default's android override answers, then Default's base on web.
    const ui = file("audio/ui/click.wav", { profile: "UI" });
    expect(resolveEncoding(ui, "android", config).settings).toEqual({ codec: "adpcm", quality: 0.35, sampleRate: 32000, channels: "source", load: "compressed", prefetchMs: 0 });
    const web = resolveEncoding(ui, "web", config);
    expect(web.settings).toMatchObject({ quality: 0.5, channels: "mono", sampleRate: "source" });
    expect(originLabel(web.origins.channels, "audio/ui/click.wav")).toBe("UI profile · Web");
    expect(originLabel(web.origins.quality, "audio/ui/click.wav")).toBe("Default profile (default)");
    expect(originLabel(web.origins.sampleRate, "audio/ui/click.wav")).toBe("built-in (Web)");
  });

  it("consults a profile named twice once, at its nearest place", () => {
    const r = resolveEncoding(file("audio/x.wav", { profile: "Default" }), "web", config);
    expect(r.profiles).toEqual([{ name: "Default", via: { kind: "sidecar", file: "audio/x.wav" } }]);
  });

  it("skips a profile name that doesn't exist with a problem, falling back to the next", () => {
    const r = resolveEncoding(file("audio/vo/line.wav", { profile: "Gone" }), "web", config);
    expect(r.problems).toEqual(['audio/vo/line.wav: its sidecar names profile "Gone", which doesn\'t exist; falling back past it.']);
    expect(r.settings.codec).toBe("opus"); // the rule's Dialogue profile
    const cfg = parseEncodingConfig({ default: "Nope", profiles: {}, rules: [{ path: "**", profile: "Missing" }] }, []);
    const r2 = resolveEncoding(file("a.wav"), "desktop", cfg);
    expect(r2.problems).toHaveLength(2);
    expect(r2.settings.quality).toBe(0.6);
  });

  it("reads a sidecar's legacy stream: true as load: stream, below an explicit load", () => {
    const legacy = resolveEncoding(file("audio/amb/wind.ogg", null, { legacyStream: true }), "web", config);
    expect(legacy.settings.load).toBe("stream");
    expect(legacy.origins.load).toEqual({ level: "sidecar", file: "audio/amb/wind.ogg", platform: null, legacy: "stream" });
    expect(originLabel(legacy.origins.load, "audio/amb/wind.ogg")).toBe("this file (stream: true)");
    const explicit = resolveEncoding(file("audio/amb/wind.ogg", { load: "compressed" }, { legacyStream: true }), "web", config);
    expect(explicit.settings.load).toBe("compressed");
  });

  it("resolves a derived sample through its own block, then its source's sidecar, rules and profiles", () => {
    const source = { path: "audio/vo/line.wav", encoding: { quality: 0.45, platforms: { android: { sampleRate: 16000 as const } } } };
    const derived = file("audio/clips/line_cut.sample.json", { prefetchMs: 40 }, { source });
    const r = resolveEncoding(derived, "android", config);
    expect(r.settings).toMatchObject({ prefetchMs: 40, quality: 0.45, sampleRate: 16000, codec: "opus", channels: "mono" });
    expect(r.origins.prefetchMs).toMatchObject({ level: "sidecar", file: "audio/clips/line_cut.sample.json" });
    expect(r.origins.quality).toMatchObject({ level: "sidecar", file: "audio/vo/line.wav", platform: null });
    // The derived sample's own path matches no rule, so the source's path picks Dialogue.
    expect(r.profiles[0]).toEqual({ name: "Dialogue", via: { kind: "rule", index: 1, path: "audio/vo/**" } });
    expect(originLabel(r.origins.quality, derived.path)).toBe("source line.wav");
    // The source's profile is used when the derived sample names none.
    const named = resolveEncoding(file("x.sample.json", null, { source: { path: "y.wav", encoding: { profile: "UI" } } }), "desktop", config);
    expect(named.profiles[0]).toEqual({ name: "UI", via: { kind: "sidecar", file: "y.wav" } });
  });

  it("needs its fallback: with no layer but the sidecar, every unset key is the built-in's", () => {
    // The guard against a resolver that stops at the first layer: keys that layer leaves unset must still be filled.
    const r = resolveEncoding(file("a.wav", { codec: "pcm" }), "web", parseEncodingConfig(undefined, []));
    expect(r.settings).toEqual({ codec: "pcm", quality: 0.5, sampleRate: "source", channels: "source", load: "decode", prefetchMs: 0 });
  });
});

describe("withEncodingKey", () => {
  it("sets and clears a key for every platform or one, dropping what empties", () => {
    let e = withEncodingKey(null, null, "quality", 0.7);
    expect(e).toEqual({ quality: 0.7 });
    e = withEncodingKey(e, "android", "channels", "mono");
    expect(e).toEqual({ quality: 0.7, platforms: { android: { channels: "mono" } } });
    e = withEncodingKey(e, "android", "channels", undefined);
    expect(e).toEqual({ quality: 0.7 });
    expect(withEncodingKey(e, null, "quality", undefined)).toBeNull();
    const keepProfile = withEncodingKey({ profile: "UI", quality: 1 }, null, "quality", undefined);
    expect(keepProfile).toEqual({ profile: "UI" });
  });
});
