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

const MIB = 1024 * 1024;

/** Four 60 s Vorbis clips of 30 MiB encoded each, for the encoded-cache budget (`encodedOverBudget`). */
const bigClips: Record<string, MusicClipFacts> = Object.fromEntries(
  ["a", "b", "c", "d"].map((k) => [`music/big-${k}.ogg`, clip(60, { bytes: 30 * MIB })]),
);

/**
 * L-F3a: the shared fixture table (named clips used by several cases); a case may also build its own with `clip()`.
 * Decoded clips are 30 s or shorter, streamed ones longer; the path's extension is its codec's family.
 */
export const FIXTURE_CLIPS: Readonly<Record<string, MusicClipFacts>> = {
  "music/short.ogg": clip(10),
  "music/short-b.ogg": clip(10),
  "music/short-44k.ogg": clip(10, { rate: 44_100 }),
  "music/short-mono.ogg": clip(10, { channels: 1 }),
  "music/short-plus-1.ogg": { ...clip(10), frames: secs(10) + 1 },
  "music/short-plus-1024.ogg": { ...clip(10), frames: secs(10) + 1024 },
  "music/short-plus-1025.ogg": { ...clip(10), frames: secs(10) + 1025 },
  "music/alt-11s.ogg": clip(11),
  "music/five-s.ogg": clip(5),
  "music/cue-2s.ogg": clip(2),
  "music/audible.ogg": clip(10, { silent: false }),
  "music/silent.ogg": clip(10, { silent: true }),
  "music/short.flac": clip(10, { codec: "flac" }),
  "music/edge-30s.ogg": clip(30),
  "music/bridge.ogg": clip(20),
  "music/bridge-long.ogg": clip(60),
  "music/long.ogg": clip(60),
  "music/long-b.ogg": clip(60),
  "music/long.flac": clip(60, { codec: "flac" }),
  "music/long.wav": clip(60, { codec: "pcm" }),
  "music/mp3.mp3": clip(60, { codec: "mp3" }),
  "music/mp3-nohdr.mp3": clip(60, { codec: "mp3", gapless: false }),
  "music/aac.m4a": clip(60, { codec: "aac" }),
  ...bigClips,
};
