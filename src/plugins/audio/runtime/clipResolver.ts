/**
 * The clip resolver (ADR 0293): how a clip path becomes a play request, in one module. `AudioSource`, `Audio.playOneShot`,
 * `AudioZone` and the playlist runtime all start from `clipRequest`, so the URL, the import volume with the FuMa gain
 * (ADR 0040, 0162 §2.4), the stream-or-decode rule, the ambisonic flag and the bus are decided once.
 *
 * A clip path is an audio file or a derived sample (`*.sample.json`, ADR 0328). A derived sample plays its source audio
 * file (`clipSource`) with its resolved edits (`sampleEdits`, `samplePlan`): every function here answers for the source
 * file, so the backend only ever sees ordinary clips.
 *
 * It depends on `Assets` (URLs and import settings), the mixer (bus names), the clip registry (what it learned of an
 * ambisonic clip: its FuMa gain and its length) and the active backend's clip facts (`AudioBackend.clipCache`, G-1). It
 * imports neither `AudioSource.ts` nor the playlist runtime, so every caller imports it directly.
 */
import { mixer } from "../../../engine/audio/mixer";
import { Assets } from "../../../engine/scene/Assets";
import { ambisonicImportGain, ambisonicStreamsByDefault } from "./core/clipRegistry";
import { warnOnce } from "./core/handle";
import { audioBackend, hasAudioBackend, type AudioClipCache, type PlayRequest } from "./backend";
import type { LoopBehaviour } from "../../../engine/audio/playlist/types";
import { isDerivedSamplePath } from "../../../engine/audio/sample/format";
import { resolveSample, type ResolvedSample, type SampleReader } from "../../../engine/audio/sample/resolve";
import type { SampleEdits } from "../../../engine/audio/sample/types";

/**
 * ADR 0328: what a derived sample plays (`resolveSample`), cached per path with every file read on the way: the derived
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

function resolvedSample(path: string): ResolvedSample {
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
 * once with the path).
 */
export function clipSource(path: string): string {
  return isDerivedSamplePath(path) ? resolvedSample(path).source : path;
}

/**
 * The sample edits a play of `path` uses (ADR 0328): an audio file's sidecar `sample` block (null without one); a derived
 * sample's resolved block (a following fork's inherited fields read live from its parent, a snippet's range as its trim).
 */
export function sampleEdits(path: string): SampleEdits | null {
  return isDerivedSamplePath(path) ? resolvedSample(path).edits : Assets.importSettings(path).sample;
}

/** Whether `path`'s sidecar marks it ambisonic (ADR 0162 §2.4): it plays through the listener's rotation, with no position. */
export const isAmbisonicClip = (path: string): boolean => Assets.importSettings(clipSource(path)).ambisonic !== null;

/** The clip's import volume (ADR 0040), which scales every playback of it, times its FuMa import gain (§2.4; 1 for every other clip). */
export const clipVolume = (path: string): number => {
  const source = clipSource(path);
  return Assets.importSettings(source).volume * ambisonicImportGain(source);
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
  const source = clipSource(path);
  const settings = Assets.importSettings(source);
  return settings.stream || (settings.ambisonic !== null && ambisonicStreamsByDefault(source));
}

/**
 * ADR 0328: what a sample's edits (`sampleEdits`: a sidecar's `sample` block, a derived sample's resolved block) mean for
 * playing it, as far as today's core goes. `trim` is the region played (seconds in the file; null: the whole file);
 * `gain` the normalisation gain, linear; `loop` the sample's first loop region with its behaviour (null: none). A hold
 * point (start = end) and every loop after the first wait for the core's loop modes (ADR 0328; the playlist runtime's
 * loop adapter is the one place they arrive).
 */
export interface SamplePlan {
  trim: [number, number] | null;
  gain: number;
  loop: { start: number; end: number; behaviour: LoopBehaviour; count: number } | null;
}

const NO_PLAN: SamplePlan = Object.freeze({ trim: null, gain: 1, loop: null }) as SamplePlan;
const plans = new WeakMap<SampleEdits, SamplePlan>();

/** `path`'s sample plan from its edits (`sampleEdits`), cached per edits object, so an edit to either file is picked up. */
export function samplePlan(path: string): SamplePlan {
  const edits = sampleEdits(path);
  if (!edits) return NO_PLAN;
  let plan = plans.get(edits);
  if (!plan) {
    const loop = edits.loops.find((l) => l.end > l.start) ?? null;
    plan = {
      trim: edits.trim ? [edits.trim[0], edits.trim[1]] : null,
      gain: edits.normalize.mode === "off" ? 1 : Math.pow(10, edits.normalize.gainDb / 20),
      loop: loop ? { start: loop.start, end: loop.end, count: loop.count, behaviour: { active: loop.active, exit: loop.exit, exitFadeMs: loop.exitFadeMs, reentry: loop.reentry, ...(loop.binding ? { binding: loop.binding } : {}) } } : null,
    };
    plans.set(edits, plan);
  }
  return plan;
}

/**
 * The base play request for `path`, played on `output` (a mixer bus name; empty or unknown: Master): its URL
 * (throws for a missing asset), `loop`, the stream rule, the bus, `volume` = the import volume with the FuMa gain, and
 * `ambisonic: true` for an ambisonic sound. A derived sample (ADR 0328) plays its source file: `path`, the URL and the
 * import settings are the source's (it throws when there is none); the caller applies `samplePlan(path)` as for any
 * sample. A fresh object: the caller scales `volume` by its own level and adds its fields.
 */
export function clipRequest(path: string, loop: boolean, output: string | undefined): PlayRequest {
  const source = clipSource(path);
  if (source === "") throw new Error(`the derived sample "${path}" has no audio file to play`);
  const settings = Assets.importSettings(source);
  const ambisonic = settings.ambisonic !== null;
  const req: PlayRequest = {
    path: source, url: Assets.url(source), loop, stream: settings.stream || (ambisonic && ambisonicStreamsByDefault(source)),
    bus: mixer.resolveOutput(output), volume: settings.volume * ambisonicImportGain(source),
  };
  if (ambisonic) req.ambisonic = true;
  return req;
}
