/**
 * The clip resolver (ADR 0293): how a clip path becomes a play request, in one module. `AudioSource`, `Audio.playOneShot`,
 * the event runtime and music segment runs all start from `clipRequest`, so the URL, the import volume with the FuMa
 * gain (ADR 0040, 0162 §2.4), the stream-or-decode rule, the ambisonic flag and the bus are decided once.
 *
 * It depends on `Assets` (URLs and import settings), the mixer (bus names), the clip registry (what it learned of an
 * ambisonic clip: its FuMa gain and its length) and the active backend's clip facts (`AudioBackend.clipCache`, G-1). It
 * imports neither `AudioSource.ts` nor the event runtime, so every caller imports it directly.
 */
import { mixer } from "../../../engine/audio/mixer";
import { Assets } from "../../../engine/scene/Assets";
import { stemMode, type MusicClipFacts } from "../../../engine/audio/musicValidate";
import { ambisonicImportGain, ambisonicStreamsByDefault } from "./core/clipRegistry";
import { audioBackend, hasAudioBackend, type PlayRequest } from "./backend";
import type { LoopBehaviour } from "../../../engine/audio/playlist/types";
import type { SampleEdits } from "../../../engine/audio/sample/types";

/**
 * What the clip is played as. `"sound"` (sources, one-shots, event clips): the import setting `stream`, and an ambisonic
 * clip (§2.4) is sent with `ambisonic` set and streams once the registry found it longer than 5 s. `"music"` (a segment's
 * stems, ADR 0166 §2.6): decoded up to 30 s and streamed beyond when the clip's facts are known, else the import setting;
 * never ambisonic (the music lint refuses ambisonic stems, `musicValidate.ts`).
 */
export type ClipUse = "sound" | "music";

/** Whether `path`'s sidecar marks it ambisonic (ADR 0162 §2.4): it plays through the listener's rotation, with no position. */
export const isAmbisonicClip = (path: string): boolean => Assets.importSettings(path).ambisonic !== null;

/** The clip's import volume (ADR 0040), which scales every playback of it, times its FuMa import gain (§2.4; 1 for every other clip). */
export const clipVolume = (path: string): number => Assets.importSettings(path).volume * ambisonicImportGain(path);

/** The clip's facts (length, rate, channels) from the active backend's clip cache; undefined while unknown or with no backend. */
export function clipFacts(path: string): MusicClipFacts | undefined {
  return hasAudioBackend() ? audioBackend().clipCache?.clipFacts(path) : undefined;
}

/** Whether a play of `path` as `use` streams rather than decodes (see `ClipUse`). */
export function clipStreams(path: string, use: ClipUse = "sound"): boolean {
  const settings = Assets.importSettings(path);
  if (use === "music") {
    const facts = clipFacts(path);
    return facts && facts.rate > 0 ? stemMode(path, facts) === "stream" : settings.stream;
  }
  return settings.stream || (settings.ambisonic !== null && ambisonicStreamsByDefault(path));
}

/**
 * ADR 0328: what a sample's sidecar edits (`<file>.meta.json` `sample`) mean for playing it, as far as today's core goes.
 * `trim` is the region played (seconds in the file; null: the whole file); `gain` the normalisation gain, linear; `loop`
 * the sample's first loop region with its behaviour (null: none). A hold point (start = end) and every loop after the
 * first wait for the core's loop modes (ADR 0328; the playlist runtime's loop adapter is the one place they arrive).
 */
export interface SamplePlan {
  trim: [number, number] | null;
  gain: number;
  loop: { start: number; end: number; behaviour: LoopBehaviour; count: number } | null;
}

const NO_PLAN: SamplePlan = Object.freeze({ trim: null, gain: 1, loop: null }) as SamplePlan;
const plans = new WeakMap<SampleEdits, SamplePlan>();

/** `path`'s sample plan from its sidecar (cached per parsed sidecar block, so a sidecar edit is picked up). */
export function samplePlan(path: string): SamplePlan {
  const edits = Assets.importSettings(path).sample;
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
 * The base play request for `path`, played as `use` on `output` (a mixer bus name; empty or unknown: Master): its URL
 * (throws for a missing asset), `loop`, the stream rule, the bus, `volume` = the import volume with the FuMa gain, and
 * `ambisonic: true` for an ambisonic sound. A fresh object: the caller scales `volume` by its own level and adds its fields.
 */
export function clipRequest(path: string, loop: boolean, output: string | undefined, use: ClipUse = "sound"): PlayRequest {
  const settings = Assets.importSettings(path);
  const ambisonic = use === "sound" && settings.ambisonic !== null;
  const req: PlayRequest = {
    path, url: Assets.url(path), loop, stream: use === "music" ? clipStreams(path, use) : settings.stream || (ambisonic && ambisonicStreamsByDefault(path)),
    bus: mixer.resolveOutput(output), volume: settings.volume * ambisonicImportGain(path),
  };
  if (ambisonic) req.ambisonic = true;
  return req;
}
