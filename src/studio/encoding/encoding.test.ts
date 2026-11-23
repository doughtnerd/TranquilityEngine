// ADR 0351 §6, A6: converting in the Studio through the conversion service and Hear as, with a fake encoder pool and a
// fake decoder — a conversion is keyed by content and settings, cached in memory and in the export's cache layout (a new
// session hits the disk cache without encoding), and Hear as serves the encoded bytes under the sound's own path so an
// audition plays them; ADPCM goes through the WAV path; Source and A/B serve the project's files again.
import { describe, expect, it } from "vitest";
import { parseAudioProject } from "../../engine/audio/project/format";
import type { AssetSource } from "../../engine/scene/Assets";
import { AUDIO_CACHE_DIR, type AudioCacheStore, type DecodeAudio } from "../../export/audio";
import type { AudioEncoder, EncodeRequest } from "../../export/audioEncoder";
import { createConversions } from "./conversion";
import { createHearAs, hearAsStatus } from "./hearAs";
import { convertProgress } from "./progress";
import { plannedSound, studioPlan, type StudioPlanSource } from "./studioPlan";

const SOURCE = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
const ENCODED: Record<string, Uint8Array> = { vorbis: new Uint8Array([79, 103, 103, 83, 9, 9]), adpcm: new Uint8Array([7, 7, 7, 7]), pcm: new Uint8Array([1]), opus: new Uint8Array([2]) };

/** A pool that encodes instantly and remembers what it was asked. */
function fakeEncoder(): AudioEncoder & { requests: EncodeRequest[] } {
  const requests: EncodeRequest[] = [];
  return {
    requests,
    encode: async (r) => {
      requests.push(r);
      return { bytes: ENCODED[r.codec]!, codec: r.codec, sampleRate: r.rateCeiling ?? r.sampleRate, channels: r.mono ? 1 : r.channels, frames: r.pcm.length / r.channels, preSkip: 0 };
    },
    close() {},
  };
}
const decode: DecodeAudio = async () => ({ pcm: new Float32Array(48_000 * 2), channels: 2, sampleRate: 48_000 });
function memoryCache(): AudioCacheStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return { files, read: async (p) => files.get(p) ?? null, write: async (p, b) => void files.set(p, b) };
}

const FILES = ["audio.json", "audio/step.wav", "audio/ui/click.wav", "audio/theme.ogg"];
const planSource = (raw: Record<string, unknown> = {}): StudioPlanSource => ({
  files: FILES,
  audio: parseAudioProject({ format: "myco.audio@1", ...raw }).project,
  json: () => undefined,
});

describe("conversions", () => {
  it("encode a planned sound once per content and settings, and fill the export's cache", async () => {
    const encoder = fakeEncoder();
    const cache = memoryCache();
    const conv = createConversions({ read: async () => SOURCE, decode, encoder: () => encoder, cache });
    const sound = plannedSound(studioPlan(planSource({ encoding: { profiles: { Low: { sampleRate: 22050, channels: "mono" } }, default: "Low" } }), "web"), "audio/step.wav")!;
    const [a, b] = await Promise.all([conv.convert(sound), conv.convert(sound)]);
    expect(encoder.requests).toHaveLength(1);
    expect(encoder.requests[0]).toMatchObject({ codec: "vorbis", quality: 0.5, rateCeiling: 22050, mono: true, channels: 2, sampleRate: 48_000 });
    expect(a).toMatchObject({ codec: "vorbis", bytes: ENCODED.vorbis, rate: 22050, channels: 1, sourceBytes: SOURCE.length });
    // Either concurrent call may be the one that encodes (whose key resolves first is up to the digest): one of them did.
    expect([a.cached, b.cached]).toContain(false);
    expect(b.key).toBe(a.key);
    expect(a.key).toMatch(/^[0-9a-f]{64}$/);
    expect(cache.files.get(`${AUDIO_CACHE_DIR}/${a.key}.ogg`)).toEqual(ENCODED.vorbis);
    expect(JSON.parse(new TextDecoder().decode(cache.files.get(`${AUDIO_CACHE_DIR}/${a.key}.json`)!))).toEqual({ codec: "vorbis", rate: 22050, channels: 1, frames: 48_000 });
    // Again in this session: from memory.
    expect((await conv.convert(sound)).cached).toBe(true);
    // A new session over the same folder: from the disk cache, no encode.
    const encoder2 = fakeEncoder();
    const hit = await createConversions({ read: async () => SOURCE, decode, encoder: () => encoder2, cache }).convert(sound);
    expect(encoder2.requests).toHaveLength(0);
    expect(hit).toMatchObject({ key: a.key, bytes: ENCODED.vorbis, cached: true });
  });

  it("ship a lossy source as it is, and Opus on more than two channels as Vorbis", async () => {
    const encoder = fakeEncoder();
    const conv = createConversions({ read: async () => SOURCE, decode: async () => ({ pcm: new Float32Array(400), channels: 4, sampleRate: 48_000 }), encoder: () => encoder, cache: memoryCache() });
    const ogg = await conv.convert(plannedSound(studioPlan(planSource(), "web"), "audio/theme.ogg")!);
    expect(ogg).toMatchObject({ codec: "source", bytes: SOURCE });
    expect(encoder.requests).toHaveLength(0);
    const opus = await conv.convert(plannedSound(studioPlan(planSource({ encoding: { profiles: { V: { codec: "opus" } }, default: "V" } }), "web"), "audio/step.wav")!);
    expect(opus.codec).toBe("vorbis");
    expect(opus.notes).toEqual(["Opus takes mono and stereo only; this 4-channel file ships as Vorbis."]);
  });
});

/** Hear as over fakes: the asset sources it adds, the URLs it makes (to their bytes) and what changed. */
function hearAsRig(raw: Record<string, unknown> = {}) {
  const encoder = fakeEncoder();
  const conv = createConversions({ read: async () => SOURCE, decode, encoder: () => encoder, cache: memoryCache() });
  const sources: AssetSource[] = [];
  const urls = new Map<string, Uint8Array>();
  const changed: string[] = [];
  const wavs: string[] = [];
  let n = 0;
  const source = planSource(raw);
  const hear = createHearAs({
    planned: (path, platform) => plannedSound(studioPlan(source, platform), path),
    convert: (s) => conv.convert(s),
    toWav: async (c, path) => (wavs.push(`${path}:${c.codec}`), new Uint8Array([87, 65, 86, 69])),
    assets: { addSource: (s) => void sources.unshift(s), removeSource: (s) => void sources.splice(sources.indexOf(s) >>> 0, sources.includes(s) ? 1 : 0), notifyChanged: (p) => void changed.push(p) },
    urls: { make: (b) => { const u = `blob:${++n}`; urls.set(u, b); return u; }, revoke: (u) => void urls.delete(u) },
  });
  /** What a play of `path` loads now: the first source that has it (the project's otherwise). */
  const served = (path: string): Uint8Array | "project" => {
    const s = sources.find((x) => x.has(path));
    return s ? urls.get(s.get(path) as string)! : "project";
  };
  return { hear, encoder, served, changed, wavs, sources };
}

describe("Hear as", () => {
  it("auditions what a platform ships: the encoded bytes, served under the sound's own path", async () => {
    const { hear, encoder, served, changed } = hearAsRig();
    hear.set("android");
    let heard: Uint8Array | "project" | null = null;
    const handle = await hear.audition("audio/step.wav", (p) => ((heard = served(p)), "handle"));
    expect(handle).toBe("handle");
    expect(heard).toEqual(ENCODED.vorbis);
    expect(encoder.requests[0]).toMatchObject({ codec: "vorbis", quality: 0.4 }); // Android's built-in quality
    expect(changed).toEqual(["audio/step.wav"]);
    expect(hear.served.value.get("audio/step.wav")).toBe("vorbis");
    expect(hear.busy.value).toBe(0);
  });

  it("decodes ADPCM (no loose container) to a WAV first", async () => {
    const { hear, served, wavs } = hearAsRig({ encoding: { profiles: { UI: { codec: "adpcm", load: "compressed" } }, rules: [{ path: "audio/ui/**", profile: "UI" }] }, packages: [{ name: "Core", include: ["audio/ui/**"] }] });
    hear.set("web");
    await hear.prepare(["audio/ui/click.wav"]);
    expect(wavs).toEqual(["audio/ui/click.wav:adpcm"]);
    expect(served("audio/ui/click.wav")).toEqual(new Uint8Array([87, 65, 86, 69]));
  });

  it("plays the project's files again on Source, and A/B flips back to the last platform", async () => {
    const { hear, served, changed, sources } = hearAsRig();
    hear.set("desktop");
    await hear.prepare(["audio/step.wav"]);
    expect(served("audio/step.wav")).toEqual(ENCODED.vorbis);
    hear.toggle();
    expect(hear.choice.value).toBe("source");
    expect(served("audio/step.wav")).toBe("project");
    expect(changed).toEqual(["audio/step.wav", "audio/step.wav"]);
    expect(await hear.prepare(["audio/step.wav"])).toBe(true); // Source: nothing to convert
    hear.toggle();
    expect(hear.choice.value).toBe("desktop");
    await hear.prepare(["audio/step.wav"]);
    expect(served("audio/step.wav")).toEqual(ENCODED.vorbis);
    hear.dispose();
    expect(sources).toHaveLength(0);
  });

  it("serves nothing for a sound that ships as its source, and drops a conversion the choice outran", async () => {
    const { hear, served } = hearAsRig();
    hear.set("web");
    await hear.prepare(["audio/theme.ogg"]);
    expect(served("audio/theme.ogg")).toBe("project");
    expect(hear.served.value.get("audio/theme.ogg")).toBe("source");
    const late = hear.prepare(["audio/step.wav"]);
    hear.set("source");
    expect(await late).toBe(false);
    expect(served("audio/step.wav")).toBe("project");
  });

  it("words its chip", () => {
    expect(hearAsStatus("source", 0, null)).toEqual({ text: "Source", tone: "neutral" });
    expect(hearAsStatus("android", 2, null)).toEqual({ text: "Converting for Android…", tone: "warning" });
    expect(hearAsStatus("web", 0, null)).toEqual({ text: "Hearing Web", tone: "accent" });
    expect(hearAsStatus("web", 0, "x").tone).toBe("danger");
  });
});

describe("Convert now's progress", () => {
  it("reads the export's progress lines", () => {
    expect(convertProgress("audio: audio/step.wav → vorbis [3/12]")).toEqual({ done: 3, total: 12 });
    expect(convertProgress("audio: audio/a.wav (cached) [12/12]")).toEqual({ done: 12, total: 12 });
    expect(convertProgress("audio: 12 files, 1.0 MB → 0.2 MB for web; 0 packages")).toBeNull();
  });
});
