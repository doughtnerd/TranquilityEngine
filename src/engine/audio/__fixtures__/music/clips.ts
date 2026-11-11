/**
 * Fixture clip facts for `musicValidate.test.ts` (L-F3a fills the table). A fixture "clip" is a `MusicClipFacts`
 * record keyed by path: no audio bytes. Seconds are converted with `secs()` so a case reads in time.
 */

import type { MusicClipFacts, MusicFactsLookup } from "../../musicValidate";

/** Frames for `seconds` at `rate`. */
export const secs = (seconds: number, rate = 48_000): number => Math.round(seconds * rate);

/** A clip's facts: 48 kHz stereo gapless Vorbis of `seconds`, with `over` on top. */
export const clip = (seconds: number, over: Partial<MusicClipFacts> = {}): MusicClipFacts => ({
  frames: secs(seconds, over.rate ?? 48_000), rate: 48_000, channels: 2, gapless: true, codec: "vorbis", ...over,
});

/** The lookup over a path table; an absent path is `undefined` (an `unknownClip`). */
export const lookup = (table: Readonly<Record<string, MusicClipFacts>>): MusicFactsLookup => (path) => table[path];

/** L-F3a: the shared fixture table (named clips used by several cases); a case may also build its own with `clip()`. */
export const FIXTURE_CLIPS: Readonly<Record<string, MusicClipFacts>> = {};
