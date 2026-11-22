// ADR 0337 §5, §7, §8 (A3): the audio planner per platform, and the step through a fake decoder and encoder: cache hits
// and misses, renders as the input, packages with their dependencies, streamed media left loose, the media table and the
// report.
import { describe, expect, it } from "vitest";
import { defaultEncodingConfig } from "../engine/audio/encoding/format";
import type { EncodingConfig } from "../engine/audio/encoding/types";
import { readAudioPack } from "../engine/audio/packaging/format";
import { audioDependencies, type PackageDef } from "../engine/audio/packaging/definitions";
import { encodeWavFloat32 } from "../engine/audio/sample/wavEncode";
import { decodeWavPcm } from "../engine/audio/sample/wavPcm";
import { AUDIO_CACHE_DIR, planAudio, processAudio, type AudioCacheStore, type AudioPlanInput, type AudioSidecarFacts, type DecodeAudio } from "./audio";
import type { AudioEncoder, EncodeRequest } from "./audioEncoder";
import { MANIFEST_FORMAT, type GameManifest } from "./format";
import type { WebBuildPlan } from "./webBuild";

// --- the planner ------------------------------------------------------------------------------------------------------

const CONFIG: EncodingConfig = {
  default: "Default",
  profiles: {
    Default: { codec: "auto", quality: 0.5, load: "decode", platforms: { android: { quality: 0.35, sampleRate: 32000 } } },
    Music: { codec: "vorbis", quality: 0.6, load: "stream", prefetchMs: 250 },
    Dialogue: { codec: "opus", quality: 0.3, channels: "mono", load: "compressed" },
    UI: { codec: "adpcm", load: "compressed" },
  },
  rules: [
    { path: "audio/music/**", profile: "Music" },
    { path: "audio/vo/**", profile: "Dialogue" },
    { path: "audio/ui/**", profile: "UI" },
  ],
  budgets: {},
};

function planInput(over: Partial<AudioPlanInput> & { sidecars?: Record<string, AudioSidecarFacts>; json?: Record<string, unknown> } = {}): AudioPlanInput {
  const json = over.json ?? {};
  return {
    platform: "web",
    files: ["audio/step.wav", "audio/music/theme.flac", "audio/vo/line.wav", "audio/ui/click.wav", "audio/amb/bed.mp3", "audio/amb/space.wav"],
    config: CONFIG,
    packages: [],
    sidecar: (p) => over.sidecars?.[p] ?? null,
    renderOwner: () => null,
    dependencies: audioDependencies((p) => json[p]),
    convert: true,
    ...over,
  };
}

describe("planAudio", () => {
  it("resolves each sound per platform through profiles, rules and the built-in defaults, with where each value came from", () => {
    const web = planAudio(planInput());
    const by = (p: string) => web.sounds.find((s) => s.path === p)!;
    expect(by("audio/step.wav")).toMatchObject({ codec: "vorbis", load: "decode" });
    expect(by("audio/step.wav").resolution.settings).toMatchObject({ quality: 0.5, sampleRate: "source" });
    expect(by("audio/music/theme.flac")).toMatchObject({ codec: "vorbis", load: "stream" });
    expect(by("audio/amb/bed.mp3")).toMatchObject({ codec: "source", load: "decode" });
    const android = planAudio(planInput({ platform: "android" }));
    const step = android.sounds.find((s) => s.path === "audio/step.wav")!;
    expect(step.resolution.settings).toMatchObject({ quality: 0.35, sampleRate: 32000 });
    expect(step.resolution.origins.quality).toEqual({ level: "profile", profile: "Default", platform: "android", via: { kind: "default" } });
  });

  it("ships ADPCM only inside packages and Opus on mono or stereo only (D56)", () => {
    const loose = planAudio(planInput({ sidecars: { "audio/vo/line.wav": { encoding: null, legacyStream: false, ambisonic: true } } }));
    const click = loose.sounds.find((s) => s.path === "audio/ui/click.wav")!;
    expect(click.codec).toBe("vorbis");
    expect(click.notes[0]).toMatch(/ADPCM lives only in packages/);
    const line = loose.sounds.find((s) => s.path === "audio/vo/line.wav")!;
    expect(line.codec).toBe("vorbis");
    expect(line.notes.join(" ")).toMatch(/Opus takes mono and stereo only/);
    expect(line.notes.join(" ")).toMatch(/"mono" is refused for an ambisonic file/);
    const packages: PackageDef[] = [{ name: "UI", include: ["audio/ui/**"], preload: true, platforms: null }];
    expect(planAudio(planInput({ packages })).sounds.find((s) => s.path === "audio/ui/click.wav")).toMatchObject({ codec: "adpcm", packages: ["UI"] });
  });

  it("puts sounds in the packages shipping on the platform, with their dependencies, and reports what matched nothing", () => {
    const json = { "playlists/forest.playlist.json": { format: "myco.playlist@1", type: "queue", entries: [{ sample: "audio/amb/space.wav" }, { sample: "audio/amb/gone.wav" }] } };
    const files = [...planInput().files, "playlists/forest.playlist.json"];
    const packages: PackageDef[] = [
      { name: "Forest", include: ["playlists/forest.playlist.json", "audio/nothing/**"], preload: false, platforms: null },
      { name: "Desk", include: ["audio/step.wav"], preload: false, platforms: ["desktop"] },
      { name: "Both", include: ["audio/amb/space.wav"], preload: true, platforms: null },
    ];
    const plan = planAudio(planInput({ files, packages, json }));
    expect(plan.packages.map((p) => [p.def.name, p.sounds])).toEqual([["Forest", ["audio/amb/space.wav"]], ["Both", ["audio/amb/space.wav"]]]);
    expect(plan.sounds.find((s) => s.path === "audio/amb/space.wav")!.packages).toEqual(["Forest", "Both"]);
    expect(plan.sounds.find((s) => s.path === "audio/step.wav")!.packages).toEqual([]);
    expect(plan.problems).toEqual(['package "Forest": "audio/nothing/**" matches no file.', 'package "Forest": playlists/forest.playlist.json names audio/amb/gone.wav, which isn\'t in the project.']);
    expect(planAudio(planInput({ files, packages, json, platform: "desktop" })).packages.map((p) => p.def.name)).toEqual(["Forest", "Desk", "Both"]);
  });

  it("resolves a render as the sample it belongs to, and ships sources unchanged without conversion", () => {
    const plan = planAudio(planInput({
      files: ["audio/music/theme.wav", "audio/music/theme.render-abc.wav"],
      renderOwner: (p) => (p === "audio/music/theme.render-abc.wav" ? { path: "audio/music/theme.wav", encoding: { quality: 0.9 }, ambisonic: false } : null),
    }));
    const render = plan.sounds.find((s) => s.path === "audio/music/theme.render-abc.wav")!;
    expect(render).toMatchObject({ renderOf: "audio/music/theme.wav", codec: "vorbis", load: "stream" });
    expect(render.resolution.settings.quality).toBe(0.9);
    expect(planAudio(planInput({ convert: false })).sounds.every((s) => s.codec === "source")).toBe(true);
  });
});

// --- the step ---------------------------------------------------------------------------------------------------------

/** One second of a 440 Hz tone, stereo, as a 32-bit float WAV. */
function tone(seconds = 1, rate = 48000, channels = 2): Uint8Array {
  const frames = Math.round(seconds * rate);
  const pcm = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) pcm[i * channels + c] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / rate);
  return encodeWavFloat32(pcm, channels, rate);
}

/** Decodes WAVs; anything else fails. */
const decode: DecodeAudio = async (bytes) => {
  const wav = decodeWavPcm(bytes);
  if (!wav) throw new Error("not a WAV");
  return { pcm: wav.pcm, channels: wav.channels, sampleRate: wav.rate };
};

/** A fake encoder: bytes `codec:quality:frames`, a quarter the PCM's size; counts its calls. */
function fakeEncoder(): AudioEncoder & { calls: EncodeRequest[] } {
  const calls: EncodeRequest[] = [];
  return {
    calls,
    async encode(r) {
      calls.push(r);
      const frames = r.pcm.length / r.channels;
      const rate = r.codec === "opus" ? 48000 : Math.min(r.sampleRate, r.rateCeiling ?? Infinity);
      const outFrames = Math.round((frames * rate) / r.sampleRate);
      const channels = r.mono ? 1 : r.channels;
      const label = new TextEncoder().encode(`${r.codec}:${r.quality}:${outFrames}:`);
      const bytes = new Uint8Array(Math.max(label.length, Math.round(outFrames * channels / 4)));
      bytes.set(label);
      return { bytes, codec: r.codec, sampleRate: rate, channels, frames: outFrames, preSkip: 0 };
    },
    close() {},
  };
}

/** A cache in memory. */
function memoryCache(): AudioCacheStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return { files, read: async (p) => files.get(p) ?? null, write: async (p, b) => void files.set(p, b) };
}

const text = (v: unknown) => JSON.stringify(v);

/** A project: audio.json with profiles and packages, sounds, a playlist, a sidecar naming a Studio render. */
function project(over: Record<string, string | Uint8Array> = {}): Record<string, string | Uint8Array> {
  return {
    "project.json": text({ name: "Game" }),
    "audio.json": text({
      format: "myco.audio@1",
      encoding: {
        default: "Default",
        profiles: { Default: { codec: "auto", quality: 0.5, platforms: { android: { quality: 0.35 } } }, Music: { codec: "vorbis", load: "stream", prefetchMs: 250 }, UI: { codec: "adpcm", load: "compressed" } },
        rules: [{ path: "audio/music/**", profile: "Music" }, { path: "audio/ui/**", profile: "UI" }],
        budgets: { web: { downloadMB: 0.001, memoryMB: 0.001 } },
      },
      packages: [
        { name: "Core", preload: true, include: ["audio/ui/**"] },
        { name: "Forest", include: ["playlists/forest.playlist.json"] },
      ],
    }),
    "audio/step.wav": tone(0.5),
    "audio/ui/click.wav": tone(0.1),
    "audio/amb/bird.wav": tone(1, 48000, 1),
    "audio/music/theme.wav": tone(2),
    "audio/amb/old.mp3": new Uint8Array([0xff, 0xfb, 1, 2, 3]),
    "playlists/forest.playlist.json": text({ format: "myco.playlist@1", type: "queue", entries: [{ sample: "audio/amb/bird.wav" }, { sample: "audio/music/theme.wav" }] }),
    "audio/fx/boom.wav": tone(0.25),
    "audio/fx/boom.wav.meta.json": text({ format: "myco.import@1", sample: { source: "boom.flat.wav" } }),
    "audio/fx/boom.flat.wav": tone(0.5),
    ...over,
  };
}

function build(files: Record<string, string | Uint8Array>): WebBuildPlan {
  const copies = Object.keys(files).sort();
  const manifest: GameManifest = { format: MANIFEST_FORMAT, name: "Game", mainScene: null, files: copies, scripts: [] };
  return { manifest, copies, generated: new Map([["game.json", `${text(manifest)}\n`]]) };
}

async function run(files: Record<string, string | Uint8Array>, options: { encoder?: AudioEncoder | null; cache?: AudioCacheStore; platform?: "web" | "desktop" | "android"; plan?: WebBuildPlan } = {}) {
  const lines: string[] = [];
  const out = await processAudio(options.plan ?? build(files), {
    platform: options.platform ?? "web",
    read: async (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`no ${p}`);
      return v;
    },
    encoder: options.encoder === undefined ? fakeEncoder() : options.encoder,
    decode,
    cache: options.cache,
    log: (l) => lines.push(l),
  });
  return { ...out, lines };
}

describe("processAudio", () => {
  it("converts loose sounds at their own path, and lists them in the media table", async () => {
    const encoder = fakeEncoder();
    const { plan, report } = await run(project(), { encoder });
    const step = plan.binaries!.get("project/audio/step.wav")!;
    expect(new TextDecoder().decode(step.subarray(0, 12))).toBe("vorbis:0.5:2");
    expect(plan.manifest.audio!.media["audio/step.wav"]).toEqual({ codec: "vorbis", load: "decode", rate: 48000, channels: 2, frames: 24000 });
    // A lossy source with no settings ships as it is: no conversion, no media entry, its copy written.
    expect(plan.manifest.audio!.media["audio/amb/old.mp3"]).toBeUndefined();
    expect(plan.binaries!.has("project/audio/amb/old.mp3")).toBe(false);
    expect(plan.omit!.has("audio/amb/old.mp3")).toBe(false);
    expect(report!.sounds.find((s) => s.path === "audio/step.wav")).toMatchObject({ codec: "vorbis", sourceBytes: project()["audio/step.wav"].length, cached: false, memoryBytes: 24000 * 2 * 2 });
    expect(report!.sounds.find((s) => s.path === "audio/step.wav")!.from).toMatchObject({ codec: "Default profile (default)", quality: "Default profile (default)", sampleRate: "built-in (Web)" });
  });

  it("converts a sample's render, with the sample's settings, in the render's place", async () => {
    const encoder = fakeEncoder();
    const { plan, report } = await run(project(), { encoder });
    const render = report!.sounds.find((s) => s.path === "audio/fx/boom.flat.wav")!;
    expect(render.renderOf).toBe("audio/fx/boom.wav");
    expect(render.frames).toBe(24000); // the render's half second, not the source's quarter
    expect(plan.binaries!.has("project/audio/fx/boom.flat.wav")).toBe(true);
    // An export render (in the plan's binaries, not the project) is the input too.
    const exported = build(project());
    const withRender: WebBuildPlan = { ...exported, manifest: { ...exported.manifest, files: [...exported.manifest.files, "audio/step.render-0123.wav"] }, binaries: new Map([["project/audio/step.render-0123.wav", tone(0.75)]]), generated: new Map([...exported.generated, ["project/audio/step.wav.meta.json", text({ format: "myco.import@1", sample: { source: "step.render-0123.wav" } })]]) };
    const r = await run(project(), { plan: withRender });
    expect(r.report!.sounds.find((s) => s.path === "audio/step.render-0123.wav")).toMatchObject({ renderOf: "audio/step.wav", frames: 36000 });
  });

  it("caches by content: a second build encodes nothing, a change to the bytes or the settings misses", async () => {
    const cache = memoryCache();
    const first = fakeEncoder();
    await run(project(), { encoder: first, cache });
    expect(first.calls.length).toBeGreaterThan(0);
    expect([...cache.files.keys()].every((k) => k.startsWith(`${AUDIO_CACHE_DIR}/`))).toBe(true);
    const second = fakeEncoder();
    const again = await run(project(), { encoder: second, cache });
    expect(second.calls).toEqual([]);
    expect(again.report!.sounds.filter((s) => s.codec !== "source").every((s) => s.cached)).toBe(true);
    expect(new TextDecoder().decode(again.plan.binaries!.get("project/audio/step.wav")!.subarray(0, 12))).toBe("vorbis:0.5:2");
    // New bytes for one sound: only it encodes again.
    const third = fakeEncoder();
    await run(project({ "audio/step.wav": tone(0.6) }), { encoder: third, cache });
    expect(third.calls.map((c) => c.pcm.length / c.channels)).toEqual([28800]);
    // Another platform's settings: the sounds whose settings differ miss.
    const fourth = fakeEncoder();
    await run(project(), { encoder: fourth, cache, platform: "android" });
    expect(fourth.calls.length).toBeGreaterThan(0);
  });

  it("builds packages with their dependencies, leaves streamed media loose and doesn't write packaged sources", async () => {
    const { plan, report } = await run(project());
    const audio = plan.manifest.audio!;
    expect(audio.packages.map((p) => [p.name, p.url, p.preload])).toEqual([["Core", "audio/packages/Core.mycopak", true], ["Forest", "audio/packages/Forest.mycopak", false]]);
    const core = readAudioPack(plan.binaries!.get("audio/packages/Core.mycopak")!);
    if ("error" in core) throw new Error(core.error);
    expect(core.pack.toc.entries.map((e) => [e.path, e.codec, e.load])).toEqual([["audio/ui/click.wav", "adpcm", "compressed"]]);
    const forest = readAudioPack(plan.binaries!.get("audio/packages/Forest.mycopak")!);
    if ("error" in forest) throw new Error(forest.error);
    expect(forest.pack.toc.entries.map((e) => [e.path, e.codec, e.load, e.prefetch])).toEqual([
      ["audio/amb/bird.wav", "vorbis", "decode", null],
      ["audio/music/theme.wav", "pcm", "stream", { frames: 12000 }],
    ]);
    expect(new TextDecoder().decode(forest.pack.data("audio/amb/bird.wav")!.subarray(0, 7))).toBe("vorbis:");
    const theme = audio.media["audio/music/theme.wav"];
    expect(theme).toMatchObject({ package: "Forest", codec: "vorbis", load: "stream", frames: 96000 });
    expect(theme.url).toMatch(/^audio\/stream\/[0-9a-f]{16}\.ogg$/);
    expect(new TextDecoder().decode(plan.binaries!.get(theme.url!)!.subarray(0, 7))).toBe("vorbis:");
    expect(audio.media["audio/ui/click.wav"]).toMatchObject({ package: "Core", codec: "adpcm", load: "compressed" });
    for (const p of ["audio/ui/click.wav", "audio/amb/bird.wav", "audio/music/theme.wav"]) {
      expect(plan.omit!.has(p)).toBe(true);
      expect(plan.binaries!.has(`project/${p}`)).toBe(false);
      expect(plan.manifest.files).toContain(p); // still known by path
    }
    expect(report!.packages.map((p) => [p.name, p.sounds])).toEqual([["Core", ["audio/ui/click.wav"]], ["Forest", ["audio/amb/bird.wav", "audio/music/theme.wav"]]]);
    // The stream sound's memory is its prefetch head; the package's is its entries'.
    expect(report!.sounds.find((s) => s.path === "audio/music/theme.wav")!.memoryBytes).toBe(12000 * 2 * 2);
    expect(JSON.parse(plan.generated.get("game.json")!).audio).toEqual(audio);
  });

  it("names every package a sound is in when it's in several", async () => {
    const files = project({ "audio.json": text({ format: "myco.audio@1", packages: [{ name: "A", include: ["audio/step.wav"] }, { name: "B", include: ["audio/step.wav"] }] }) });
    const { plan } = await run(files);
    expect(plan.manifest.audio!.media["audio/step.wav"]).toMatchObject({ package: "A", packages: ["A", "B"] });
  });

  it("warns past the platform's budgets, never fails, and sums the report", async () => {
    const { report, lines } = await run(project());
    expect(report!.budgets.warnings).toHaveLength(2);
    expect(report!.budgets.warnings[0]).toMatch(/audio download .* over the web budget of 0.001 MB/);
    expect(report!.budgets.warnings[1]).toMatch(/preload packages plus the largest other package/);
    expect(lines.some((l) => /^audio: \d+ files, .* MB → .* MB for web; 2 packages$/.test(l))).toBe(true);
    expect(lines.filter((l) => l.startsWith("warning: "))).toHaveLength(2);
    const core = report!.packages.find((p) => p.name === "Core")!, forest = report!.packages.find((p) => p.name === "Forest")!;
    expect(report!.totals.memoryBytes).toBe(core.memoryBytes + forest.memoryBytes);
  });

  it("ships sources unchanged with --no-audio-convert, still in their packages, and says so", async () => {
    const { plan, report, lines } = await run(project(), { encoder: null });
    expect(report!.converted).toBe(false);
    expect(report!.sounds.every((s) => s.codec === "source")).toBe(true);
    expect(plan.binaries!.has("project/audio/step.wav")).toBe(false);
    const core = readAudioPack(plan.binaries!.get("audio/packages/Core.mycopak")!);
    if ("error" in core) throw new Error(core.error);
    expect(core.pack.toc.entries[0]).toMatchObject({ path: "audio/ui/click.wav", codec: "source", rate: 48000, channels: 2 });
    expect(lines.some((l) => /--no-audio-convert: sources shipped unchanged/.test(l))).toBe(true);
  });

  it("leaves a build with no audio and no packages alone", async () => {
    const files = { "project.json": text({}) };
    const plan = build(files);
    const out = await run(files, { plan });
    expect(out.plan).toBe(plan);
    expect(out.report).toBeNull();
  });

  it("uses the platform's packages only", async () => {
    const files = project({ "audio.json": text({ format: "myco.audio@1", packages: [{ name: "Desk", include: ["audio/step.wav"], platforms: ["desktop"] }] }) });
    expect((await run(files)).plan.manifest.audio!.packages).toEqual([]);
    expect((await run(files, { platform: "desktop" })).plan.manifest.audio!.packages.map((p) => p.name)).toEqual(["Desk"]);
  });

  it("starts from the empty settings without audio.json", () => {
    expect(defaultEncodingConfig()).toEqual({ default: null, profiles: {}, rules: [], budgets: {} });
  });
});
