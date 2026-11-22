// ADR 0337 §2: encoding settings read and written — the sidecar block (through importSettings' interface), audio.json's
// section (through the project format's), round trips and problems.
import { describe, expect, it } from "vitest";
import { formatImportSettings, IMPORT_PLATFORMS, parseImportSettings } from "../../scene/importSettings";
import { audioProjectToJson, defaultAudioProject, parseAudioProject } from "../project/format";
import { ENCODING_PLATFORMS, shippedCodec } from "./defaults";
import { defaultEncodingConfig, encodingConfigToJson, parseEncodingConfig, parseSidecarEncoding, sidecarEncodingToJson } from "./format";

const sidecar = (encoding: unknown) => parseImportSettings({ format: "myco.import@1", encoding }, "a.wav.meta.json");

describe("the sidecar's encoding block", () => {
  it("round-trips through the sidecar text", () => {
    const { settings, problems } = sidecar({ profile: "UI", quality: 0.7, platforms: { android: { channels: "mono", sampleRate: 22050 } } });
    expect(problems).toEqual([]);
    expect(settings.encoding).toEqual({ profile: "UI", quality: 0.7, platforms: { android: { channels: "mono", sampleRate: 22050 } } });
    const text = formatImportSettings(settings);
    expect(JSON.parse(text).encoding).toEqual({ profile: "UI", quality: 0.7, platforms: { android: { channels: "mono", sampleRate: 22050 } } });
    expect(parseImportSettings(JSON.parse(text)).settings).toEqual(settings);
  });

  it("is absent from sidecars without it, and an empty block isn't written", () => {
    expect(sidecar(undefined).settings.encoding).toBeNull();
    const empty = sidecar({});
    expect(empty.settings.encoding).toBeNull();
    expect(JSON.parse(formatImportSettings(empty.settings))).toEqual({ format: "myco.import@1" });
  });

  it("skips bad values, unknown keys and unknown platforms with one problem each, and clamps numbers", () => {
    const problems: string[] = [];
    const e = parseSidecarEncoding(
      {
        codec: "mp3", quality: 3, sampleRate: 12345, channels: "stereo", load: "lazy", prefetchMs: 9999.4, bitrate: 128, profile: "",
        platforms: { ios: { quality: 0.1 }, web: { profile: "X", platforms: {}, load: "stream" }, desktop: 5 },
      },
      "enc",
      problems,
    );
    expect(e).toEqual({ quality: 1, prefetchMs: 2000, platforms: { web: { load: "stream" } } });
    expect(problems).toEqual([
      'enc.codec: must be one of "auto", "source", "pcm", "adpcm", "vorbis", "opus"; ignored.',
      "enc.quality: 3 is outside 0..1; using 1.",
      'enc.sampleRate: must be "source" or one of 11025, 16000, 22050, 24000, 32000, 44100, 48000; ignored.',
      'enc.channels: must be "source" or "mono"; ignored.',
      'enc.load: must be one of "decode", "compressed", "stream"; ignored.',
      "enc.prefetchMs: 9999.4 is outside 0..2000; using 2000.",
      "enc.bitrate: unknown key; ignored.",
      "enc.platforms.ios: unknown platform (expected web, desktop, android); skipped.",
      "enc.platforms.web.profile: can't differ per platform; ignored.",
      "enc.platforms.web.platforms: can't differ per platform; ignored.",
      "enc.platforms.desktop: must be an object; skipped.",
      "enc.profile: must be a profile name; ignored.",
    ]);
    expect(parseSidecarEncoding("loud", "enc", problems)).toBeNull();
  });

  it("writes keys in a fixed order", () => {
    const out = sidecarEncodingToJson({ load: "stream", platforms: { android: { quality: 0.2 }, web: { quality: 0.3 } }, codec: "vorbis", profile: "M" });
    expect(Object.keys(out!)).toEqual(["profile", "codec", "load", "platforms"]);
    expect(Object.keys(out!.platforms as object)).toEqual(["web", "android"]);
  });
});

describe("audio.json's encoding section", () => {
  const section = {
    default: "Default",
    profiles: {
      Default: { codec: "auto", quality: 0.5, load: "decode", platforms: { android: { quality: 0.35, sampleRate: 32000 } } },
      Music: { codec: "vorbis", quality: 0.6, load: "stream", prefetchMs: 250 },
    },
    rules: [{ path: "audio/music/**", profile: "Music" }],
    budgets: { web: { downloadMB: 40, memoryMB: 64 }, android: { downloadMB: 60, memoryMB: 48 } },
  };

  it("round-trips through audio.json with the mix", () => {
    const parsed = parseAudioProject({ format: "myco.audio@1", encoding: section });
    expect(parsed.problems).toEqual([]);
    expect(parsed.project.encoding).toEqual(section);
    const json = audioProjectToJson(parsed.project);
    expect(json.encoding).toEqual(section);
    expect(parseAudioProject(JSON.parse(JSON.stringify(json))).project).toEqual(parsed.project);
  });

  it("is left out of audio.json when empty, and absent reads as the empty section", () => {
    expect(defaultAudioProject().encoding).toBeUndefined();
    expect(audioProjectToJson(defaultAudioProject())).not.toHaveProperty("encoding");
    expect(parseAudioProject({ format: "myco.audio@1", encoding: {} }).project.encoding).toBeUndefined();
    expect(parseEncodingConfig(undefined, [])).toEqual(defaultEncodingConfig());
    expect(encodingConfigToJson(defaultEncodingConfig())).toBeNull();
  });

  it("keeps names that match no profile, with a problem, and drops malformed entries", () => {
    const problems: string[] = [];
    const c = parseEncodingConfig(
      {
        default: "Nope", extra: 1,
        profiles: { " Bad": {}, Ok: { quality: "high" }, Worse: 3 },
        rules: [{ path: "a/**", profile: "Ghost" }, { path: "", profile: "Ok" }, "b/**"],
        budgets: { web: { downloadMB: -1, memoryMB: "x", cpu: 1 }, mars: {} },
      },
      problems,
    );
    expect(c).toEqual({ default: "Nope", profiles: { Ok: {} }, rules: [{ path: "a/**", profile: "Ghost" }], budgets: { web: { downloadMB: 0 } } });
    expect(problems).toEqual([
      "encoding.extra: unknown key; ignored.",
      'encoding.profiles. Bad: a profile name can\'t be empty, start or end with a space, or be "__proto__"; dropped.',
      "encoding.profiles.Ok.quality: must be a number from 0 to 1; ignored.",
      "encoding.profiles.Worse: must be an object; dropped.",
      'encoding.default: no profile is named "Nope"; files fall back to the built-in defaults.',
      'encoding.rules[0]: no profile is named "Ghost"; files it catches fall back past it.',
      'encoding.rules[1]: needs a "path" glob and a "profile" name; dropped.',
      'encoding.rules[2]: needs a "path" glob and a "profile" name; dropped.',
      "encoding.budgets.web.downloadMB: -1 is outside 0..100000; using 0.",
      "encoding.budgets.web.memoryMB: must be a number from 0 to 100000; ignored.",
      "encoding.budgets.web.cpu: unknown key; ignored.",
      "encoding.budgets.mars: unknown platform (expected web, desktop, android); skipped.",
    ]);
    expect(parseEncodingConfig([], problems)).toEqual(defaultEncodingConfig());
  });
});

describe("platforms and codecs", () => {
  it("lists android beside web and desktop, in one order everywhere", () => {
    expect(IMPORT_PLATFORMS).toEqual(["web", "desktop", "android"]);
    expect([...ENCODING_PLATFORMS]).toEqual([...IMPORT_PLATFORMS]);
    // Image overrides take android too (ADR 0337 §1).
    const s = parseImportSettings({ format: "myco.import@1", platforms: { android: { maxSize: 256 } } });
    expect(s.problems).toEqual([]);
    expect(s.settings.platforms.android).toEqual({ maxSize: 256 });
  });

  it("ships lossless sources as Vorbis under auto and lossy ones unchanged", () => {
    expect(shippedCodec("auto", "a/b.WAV")).toBe("vorbis");
    expect(shippedCodec("auto", "a/b.flac")).toBe("vorbis");
    expect(shippedCodec("auto", "a/b.aiff")).toBe("vorbis");
    expect(shippedCodec("auto", "a/b.mp3")).toBe("source");
    expect(shippedCodec("auto", "a/b.ogg")).toBe("source");
    expect(shippedCodec("source", "a/b.wav")).toBe("source");
    expect(shippedCodec("adpcm", "a/b.mp3")).toBe("adpcm");
  });
});
