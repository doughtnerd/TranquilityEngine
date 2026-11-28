/**
 * The clip resolver (ADR 0293): how a clip path becomes a play request, in one module. `AudioSource`, `Audio.playOneShot`,
 * `AudioZone` and the playlist runtime all start from `clipRequest`, so the URL, the import volume with the FuMa gain
 * (ADR 0040, 0162 §2.4), the stream-or-decode rule, the ambisonic flag and the bus are decided once.
 *
 * A clip path is an audio file or a derived sample (`*.sample.json`, ADR 0342). A derived sample plays its source audio
 * file (`clipSource`) with its resolved edits (`sampleEdits`, `samplePlan`): every function here answers for the source
 * file, so the backend only ever sees ordinary clips. Edits that name a flattened render play the render in the source's
 * place (ADR 0342 "Flatten"; its baked normalisation isn't applied again).
 *
 * Every play applies the sample plan the same way: `clipRequest` gives the level (`clipVolume`, with the normalisation
 * gain) and the trimmed start; `samplePass` the trim's end; the playlist runtime stops and loops its voices itself, and
 * every other caller plays through `playSampleVoice` (`sampleVoice.ts`), which stops a pass at the trim's end and loops
 * the sample's loop region.
 *
 * ADR 0354 §2: a path under a localised root resolves first to its file in the current audio language (`localiseClip`,
 * through the language's fallback chain), so everything below answers for that language's file and its own sidecar;
 * a path no language of the chain has resolves to no file (the callers' reason is `missingLanguage`).
 *
 * ADR 0351 §7: a build's media table (`media/packages.ts` `mediaSource`) comes before `Assets`: a packaged sound plays
 * its package's in-memory bytes (or its loose streamed media), a converted one streams when its load mode says so.
 *
 * It depends on `Assets` (URLs and import settings), the mixer (bus names), the clip registry (what it learned of an
 * ambisonic clip: its FuMa gain and its length) and the active backend's clip facts (`AudioBackend.clipCache`, G-1). It
 * imports neither `AudioSource.ts` nor the playlist runtime, so every caller imports it directly.
 */
import { dbToGain } from "../../../engine/audio/decibels";
import { mixer } from "../../../engine/audio/mixer";
import { Assets } from "../../../engine/scene/Assets";
import { ambisonicImportGain, ambisonicStreamsByDefault } from "./core/clipRegistry";
import { warnOnce } from "./core/handle";
import { audioBackend, hasAudioBackend, type AudioClipCache, type PlayRequest } from "./backend";
import { mediaSource } from "./media/packages";
import type { LoopBehaviour } from "../../../engine/audio/playlist/types";
import { isDerivedSamplePath } from "../../../engine/audio/sample/format";
import { resolveSample, type ResolvedSample, type SampleReader } from "../../../engine/audio/sample/resolve";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import { variantPath, type VariantMatch } from "../../../engine/localisation/variants";
import { audioChain, audioLanguage, audioLocalisation } from "./localisation/languageState";

/**
 * ADR 0342: what a sample path plays (`resolveSample`: an audio file with its sidecar block, or a derived sample, and
 * either's flattened render), cached per path with every file read on the way: the derived
 * files' JSON values and the parents' parsed sidecars, which are new objects after an edit or a hot reload. So a change to
 * the derived file, to a sample in its chain or to its parent's sidecar is picked up on the next call. Each problem is
 * warned once.
 */
interface CachedSample {
  readonly reads: readonly (readonly [kind: keyof SampleReader, path: string, value: unknown])[];
  readonly resolved: ResolvedSample;
}
const resolvedSamples = new Map<string, CachedSample>();

const liveReader: SampleReader = {
  has: (p) => Assets.has(p),
  json: (p) => Assets.get(p),
  sidecar: (p) => Assets.importSettings(p),
};

/** What a localised path no language of the chain has resolves to: nothing to play (ADR 0354 §3). */
const MISSING: ResolvedSample = Object.freeze({ path: "", source: "", render: null, edits: null, derived: false, problems: [] });

/**
 * ADR 0354 §2: the file a play of `path` loads in the current audio language. A path under a localised root
 * (`audio.json` `localisation.roots`) names the reference language's file; this swaps its language folder for the first
 * language of the current language's fallback chain that has the file (`variantPath`), with the language found. A path
 * outside every root comes back unchanged (language null); null when no language of the chain has it (`missingLanguage`).
 * Every function here answers for the localised file, so each variant plays with its own sidecar (trim, markers,
 * normalisation, lip-sync) and derived samples under a root localise too.
 */
export function localiseClip(path: string): VariantMatch | null {
  const roots = audioLocalisation().roots;
  if (roots.length === 0) return { path, language: null };
  return variantPath(path, audioChain(), roots, liveReader.has);
}

function resolvedSample(path: string): ResolvedSample {
  const local = localiseClip(path);
  return local === null ? MISSING : resolvedFile(local.path);
}

function resolvedFile(path: string): ResolvedSample {
  const hit = resolvedSamples.get(path);
  if (hit && hit.reads.every(([kind, p, value]) => liveReader[kind](p) === value)) return hit.resolved;
  const reads: [keyof SampleReader, string, unknown][] = [];
  const record = <K extends keyof SampleReader>(kind: K) => ((p: string) => {
    const value = liveReader[kind](p);
    reads.push([kind, p, value]);
    return value;
  }) as SampleReader[K];
  const resolved = resolveSample(path, { has: record("has"), json: record("json"), sidecar: record("sidecar") });
  for (const line of resolved.problems) warnOnce(`sample:${path}:${line}`, line);
  resolvedSamples.set(path, { reads, resolved });
  return resolved;
}

/**
 * The audio file a play of `path` loads: `path` itself for an audio file; a derived sample's source, followed through a
 * chain of derived samples; "" when a derived sample has none (missing, broken, its source missing, or a cycle; warned
 * once with the path). When the edits name a flattened render that is in the project (ADR 0342, `SampleEdits.source`),
 * the render: it plays in place of the source (`clipSettingsPath` still names the source).
 */
export function clipSource(path: string): string {
  const r = resolvedSample(path);
  return r.render ?? r.source;
}

/**
 * The audio file whose import settings (volume, stream, ambisonic; ADR 0040) a play of `path` uses: the source audio
 * file, also when a flattened render plays in its place (the render is a stand-in for the source, not a new clip).
 */
function clipSettingsPath(path: string): string {
  if (isDerivedSamplePath(path)) return resolvedSample(path).source;
  // ADR 0354 §2: a localised file's own import settings (the path unchanged outside every root).
  return localiseClip(path)?.path ?? path;
}

/**
 * The sample edits a play of `path` uses (ADR 0342): an audio file's sidecar `sample` block (null without one); a derived
 * sample's resolved block (a following fork's inherited fields read live from its parent, a snippet's range as its trim).
 */
export function sampleEdits(path: string): SampleEdits | null {
  return resolvedSample(path).edits;
}

/** Whether `path`'s sidecar marks it ambisonic (ADR 0162 §2.4): it plays through the listener's rotation, with no position. */
export const isAmbisonicClip = (path: string): boolean => Assets.importSettings(clipSettingsPath(path)).ambisonic !== null;

/**
 * The clip's level, which scales every playback of it: its import volume (ADR 0040) times its FuMa import gain (§2.4; 1
 * for every other clip) times its sample plan's normalisation gain (ADR 0342, `samplePlan`; 1 when a render bakes it).
 */
export const clipVolume = (path: string): number => {
  return Assets.importSettings(clipSettingsPath(path)).volume * ambisonicImportGain(clipSource(path)) * samplePlan(path).gain;
};

/** The clip's facts (length, rate, channels) from the active backend's clip cache; undefined while unknown or with no backend. */
export function clipFacts(path: string): ReturnType<AudioClipCache["clipFacts"]> {
  return hasAudioBackend() ? audioBackend().clipCache?.clipFacts(clipSource(path)) : undefined;
}

/** The clip's length in seconds at pitch 1 from the active backend's clip cache; null while unknown or with no backend. */
export function clipDuration(path: string): number | null {
  try {
    return hasAudioBackend() ? audioBackend().clipCache?.clipDuration(clipSource(path)) ?? null : null;
  } catch {
    return null;
  }
}

/**
 * Whether a play of `path` streams rather than decodes: the import setting `stream`; an ambisonic clip (§2.4) also streams
 * once the registry found it longer than 5 s.
 */
export function clipStreams(path: string): boolean {
  const settingsPath = clipSettingsPath(path);
  const settings = Assets.importSettings(settingsPath);
  const media = mediaSource(clipSource(path), settingsPath);
  return (media ? media.stream : settings.stream) || (settings.ambisonic !== null && ambisonicStreamsByDefault(clipSource(path)));
}

/**
 * ADR 0342: what a sample's edits (`sampleEdits`: a sidecar's `sample` block, a derived sample's resolved block) mean for
 * playing it, as far as today's core goes. `trim` is the region played (seconds in the file; null: the whole file);
 * `gain` the normalisation gain, linear (1 when a flattened render plays: it bakes the gain); `loop` the sample's first
 * loop region with its behaviour (null: none). A hold point (start = end) and every loop after the first wait for the
 * core's loop modes (ADR 0342; the playlist runtime's loop adapter is the one place they arrive).
 */
export interface SamplePlan {
  trim: [number, number] | null;
  gain: number;
  loop: { start: number; end: number; behaviour: LoopBehaviour; count: number } | null;
}

const NO_PLAN: SamplePlan = Object.freeze({ trim: null, gain: 1, loop: null }) as SamplePlan;
/** Per edits object: the plan, and the plan when a render plays (its gain baked). */
const plans = new WeakMap<SampleEdits, { source: SamplePlan; render: SamplePlan }>();

/**
 * `path`'s sample plan from its edits (`sampleEdits`), cached per edits object, so an edit to either file is picked up.
 * With a flattened render in the project (`clipSource`), its gain is 1: the render bakes the normalisation; its trim and
 * loop are the edits' own (the render keeps the source's timeline, ADR 0342).
 */
export function samplePlan(path: string): SamplePlan {
  const r = resolvedSample(path);
  const edits = r.edits;
  if (!edits) return NO_PLAN;
  let cached = plans.get(edits);
  if (!cached) {
    const loop = edits.loops.find((l) => l.end > l.start) ?? null;
    const source: SamplePlan = {
      trim: edits.trim ? [edits.trim[0], edits.trim[1]] : null,
      gain: edits.normalize.mode === "off" ? 1 : dbToGain(edits.normalize.gainDb),
      loop: loop ? { start: loop.start, end: loop.end, count: loop.count, behaviour: { active: loop.active, exit: loop.exit, exitFadeMs: loop.exitFadeMs, reentry: loop.reentry, ...(loop.binding ? { binding: loop.binding } : {}) } } : null,
    };
    cached = { source, render: { ...source, gain: 1 } };
    plans.set(edits, cached);
  }
  return r.render !== null ? cached.render : cached.source;
}

/** ADR 0342: a trimmed sample's end. The voice stops there with this fade, so the cut doesn't click. */
export const SAMPLE_END_FADE = 0.005;

/**
 * ADR 0342: one pass of a sample, as every caller plays it (one-shots, `AudioSource`, `AudioZone`, playlist voices).
 * `offset` is where the voice starts (seconds in the file: the trim's start plus the caller's skip; 0 the file's start),
 * `length` the seconds it sounds at pitch 1 until the trim's end or the file's (null while neither is known), and `early`
 * whether the trim ends before the file does: then the caller stops the voice after `length / pitch` seconds, with
 * `SAMPLE_END_FADE`, unless it loops.
 */
export interface SamplePass {
  offset: number;
  length: number | null;
  early: boolean;
}

/**
 * The pass of `path` over `trim` (default: its plan's, `samplePlan`) that starts `skip` seconds into the trimmed sound.
 * The file's length is the backend clip cache's (`clipDuration`).
 */
export function samplePass(path: string, trim: [number, number] | null = samplePlan(path).trim, skip = 0): SamplePass {
  const from = trim ? trim[0] : 0;
  const fileLength = clipDuration(path);
  const to = trim ? Math.min(trim[1], fileLength ?? Infinity) : fileLength;
  return {
    offset: Math.max(0, from + skip),
    length: to !== null && Number.isFinite(to) ? Math.max(0, to - from - skip) : null,
    early: trim !== null && (fileLength === null || trim[1] < fileLength - 1e-6),
  };
}

/**
 * The base play request for `path`, played on `output` (a mixer bus name; empty or unknown: Master): its URL
 * (throws for a missing asset), `loop`, the stream rule, the bus, `volume` = the clip's level (`clipVolume`: the import
 * volume with the FuMa gain and the sample's normalisation gain), `offset` = the sample's trimmed start (`samplePass`;
 * absent at 0), and `ambisonic: true` for an ambisonic sound. A derived sample (ADR 0342) plays its source file: `path`,
 * the URL and the import settings are the source's (it throws when there is none); a flattened render plays in the
 * source's place with the source's import settings. The trim's end and the sample's loop are the caller's (they act on
 * the playing voice): `playSampleVoice` for clips, the playlist runtime for its voices. A fresh object: the caller
 * scales `volume` by its own level and adds its fields.
 */
export function clipRequest(path: string, loop: boolean, output: string | undefined): PlayRequest {
  const file = clipSource(path);
  if (file === "") throw new Error(localiseClip(path) === null ? `"${path}" has no file in ${audioLanguage()} or its fallbacks` : `the derived sample "${path}" has no audio file to play`);
  const settingsPath = clipSettingsPath(path);
  const settings = Assets.importSettings(settingsPath);
  const ambisonic = settings.ambisonic !== null;
  // ADR 0351 §7: a build's media table first (a packaged sound's in-memory bytes, its loose streamed media, a converted
  // sound's load mode), else the project file and its import setting.
  const media = mediaSource(file, settingsPath);
  const req: PlayRequest = {
    path: file, url: media?.url ?? Assets.url(file), loop, stream: (media ? media.stream : settings.stream) || (ambisonic && ambisonicStreamsByDefault(file)),
    bus: mixer.resolveOutput(output), volume: settings.volume * ambisonicImportGain(file) * samplePlan(path).gain,
  };
  const offset = samplePass(path).offset;
  if (offset > 0) req.offset = offset;
  if (ambisonic) req.ambisonic = true;
  return req;
}
