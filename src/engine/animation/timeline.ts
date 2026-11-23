/**
 * Timelines (ADR 0371 "Assets", 0372 `TimelineDirector`, D46): parse and write `*.timeline.json`, format
 * `myco.timeline@1`. A timeline is a clip used as a timeline: the same tracks (tracks.ts), bound relative to the
 * director's node, compiled to `myco.anim@1` like a clip. Bone tracks are refused (a timeline binds nodes; a character's
 * motion comes in through `subclip` tracks or the character's own Animator, slot-played by a `control` track).
 *
 * ```jsonc
 * {
 *   "format": "myco.timeline@1",
 *   "name": "Intro",              // default ""
 *   "rate": 30,                   // Hz (default 30)
 *   "duration": 12,               // seconds
 *   "loop": false,                // default false
 *   "tracks": [ … ]               // tracks.ts, every kind but "bone"; nodePath is relative to the director
 * }
 * ```
 *
 * Overlapping `subclip` keys on one track crossfade (D46). Limits are `TRACK_LIMITS`, declared once.
 *
 * Pure; no plugin, no DOM. Internal: not public API.
 */
import { parseTracks, readTiming, trackReferences, trackToJson, type Track } from "./tracks";
import { compact, jsonText, LenientReader, readRoot, referencePaths, withPath, type FormatParse, type JsonRecord } from "./shared";

/** @internal The format name. */
export const TIMELINE_FORMAT = "myco.timeline@1";
/** @internal The file ending. */
export const TIMELINE_SUFFIX = ".timeline.json";

/** @internal A timeline. */
export interface Timeline {
  readonly format: typeof TIMELINE_FORMAT;
  readonly name: string;
  readonly rate: number;
  readonly duration: number;
  readonly loop: boolean;
  readonly tracks: readonly Track[];
}

/** @internal A new, empty timeline: ten seconds at 30 Hz. */
export const emptyTimeline = (): Timeline => ({ format: TIMELINE_FORMAT, name: "", rate: 30, duration: 10, loop: false, tracks: [] });

/** @internal A `*.timeline.json` value, leniently: never throws; problem lines start with `path` when given. */
export function parseTimeline(raw: unknown, path?: string): FormatParse<Timeline> {
  const problems: string[] = [];
  const o = readRoot(raw, TIMELINE_FORMAT, "a timeline", problems);
  const r = new LenientReader(problems);
  const { rate, duration } = readTiming(r, o);
  const value: Timeline = {
    format: TIMELINE_FORMAT,
    name: r.str(o.name, "name", ""),
    rate,
    duration,
    loop: r.bool(o.loop, "loop", false),
    tracks: parseTracks(r, o.tracks, "tracks", { duration, bones: false }),
  };
  return { value, problems: withPath(problems, path) };
}

/** @internal A timeline as canonical JSON (defaults left out). */
export const timelineToJson = (t: Timeline): JsonRecord =>
  compact({ format: TIMELINE_FORMAT, name: t.name || undefined, rate: t.rate === 30 ? undefined : t.rate, duration: t.duration, loop: t.loop || undefined, tracks: t.tracks.map(trackToJson) });

/** @internal A timeline's file text. */
export const formatTimeline = (t: Timeline): string => jsonText(timelineToJson(t));

/** @internal The project files a timeline names (subclips, audio, asset keys), once each. */
export const timelineReferences = (t: Timeline): string[] => referencePaths(trackReferences(t.tracks));
