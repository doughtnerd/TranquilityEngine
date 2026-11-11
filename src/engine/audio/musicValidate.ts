/**
 * Tier 2 of interactive-music validation (ADR 0166 §2.6, task F3): `validateMusic` lints segments against **clip
 * facts**. Parsing (`parseMusicSegment`, F1a/F1b) checks shapes, limits and ids and never looks at audio; this module
 * checks what only the audio can say: stem length, rate and channels, gapless seams, the stream-or-decode rule, the
 * peak ring need against the pool, a tail longer than its loop, a cue past the audio.
 *
 * It is pure and decodes nothing. The caller injects `facts(path)` (the decoder's `ClipInfo`, reduced to
 * `MusicClipFacts`); the engine imports no plugin. It runs at the first play (warn once) and live in the editor, which
 * shows the same rows. It never throws and never mutates its input.
 *
 * **Entry points are generic over a list of segments** (F1b's `playlist` and `musicSwitch` are not needed here): a
 * caller flattens the event's tree into a `MusicGraph` (its segments, its library segments, and the possible
 * successions). F1b's containers supply `edges` (from a `musicSwitch` or `playlist`'s rules and order, F2's
 * transitions with their `bridge`); with `edges` absent every ordered pair of distinct `segments` is a possible
 * succession, which can only over-count the need.
 *
 * Stubs tagged `F3` are the lead's (the stream-or-decode rule, the ring need, the lint walk); the tests are
 * `musicValidate.test.ts`, whose cases are L-F3a's.
 */

import { MUSIC_RINGS_PRESETS } from "./settings";
import type { SegmentNode } from "./musicFormat";

// --- clip facts -------------------------------------------------------------------------------------------------------

/** The container or codec family of a clip, from the decoder's `ClipInfo.codec` (0 other, 1 PCM, 2 FLAC, 3 MP3, 4 Vorbis, 5 AAC). */
export type MusicCodec = "other" | "pcm" | "flac" | "mp3" | "vorbis" | "aac";

/**
 * What the lint needs to know about one clip. `frames` and `rate` give the length in time; `gapless` is
 * `Info.frames !== null` (the length is stated: the decoder already trims encoder delay and padding for MP3 with a
 * Xing, Info or LAME header, Vorbis and AAC, so the check is that the length is stated).
 */
export interface MusicClipFacts {
  /** Frames of the clip: the container's stated length, or the decoded total. */
  frames: number;
  /** Sample rate in Hz. */
  rate: number;
  /** 1 or 2 (ambisonic files are not music stems). */
  channels: number;
  /** The container stated the length exactly (`Info.frames !== null`); false for an MP3 without a length header. */
  gapless: boolean;
  /** Absent: unknown, and the codec rows (FLAC/WAV on low, MP3 gapless) don't fire. `gapless` alone still does. */
  codec?: MusicCodec;
  /** The encoded file size in bytes; absent: the encoded-cache row doesn't count the clip. */
  bytes?: number;
  /** Every sample is zero (the decoder's peak scan, when it has run); absent: unknown, never reported. */
  silent?: boolean;
}

/** `facts(path)`: the clip's facts, or `undefined` when the clip is missing or not yet probed (one `unknownClip` warning). */
export type MusicFactsLookup = (path: string) => MusicClipFacts | undefined;

// --- the rule's constants ---------------------------------------------------------------------------------------------

export const MUSIC_VALIDATE_LIMITS = {
  /** Stems of a segment may differ by this many frames (within: the shortest wins, warn; beyond: the segment refuses to play). */
  stemLengthSlackFrames: 1024,
  /** A clip up to this long is decoded; longer is streamed (R15: decoded stems, bridges and stingers cost no ring). */
  decodeMaxSeconds: 30,
  /** The encoded-cache budget in bytes per preset: 48 / 96 / 160 MiB (est., ARCH §4.2, §6). */
  encodedBudgetBytes: { low: 48 * 1024 * 1024, default: 96 * 1024 * 1024, high: 160 * 1024 * 1024 },
  /** A cue past the end of the audio by more than this many frames is reported (rounding slack, one frame). */
  cueSlackFrames: 1,
} as const;

export type MusicPreset = keyof typeof MUSIC_RINGS_PRESETS;

/** How a stem or span is played: `"decode"` (a decoded clip, no ring) or `"stream"` (one music ring while sounding or primed). */
export type StemMode = "decode" | "stream";

// --- the lint rows ----------------------------------------------------------------------------------------------------

/**
 * One code per row of §2.6. `severity` is `error` only where the segment refuses to play (`stemLengthMismatch`) or the
 * planner would refuse the sequence (`neverFits` is a warning at the lint and a refusal at play: ARCH R14).
 */
export type MusicLintCode =
  | "unknownClip"
  | "stemLengthMismatch"
  | "stemLengthTrimmed"
  | "stemRateMismatch"
  | "stemChannelsMismatch"
  | "noGapless"
  | "flacOnLow"
  | "encodedOverBudget"
  | "neverFits"
  | "decodedTooLong"
  | "silentStem"
  | "tailLongerThanLoop"
  | "alternativeLengthMismatch"
  | "cueBeyondAudio";

export interface MusicLintIssue {
  code: MusicLintCode;
  severity: "error" | "warn";
  /** The segment's id; absent for a graph-wide row. */
  segment?: string;
  /** The stem's name, when the row is about one. */
  track?: string;
  /** The clip path, when the row is about one. */
  clip?: string;
  /** The region id (`tailLongerThanLoop`) or cue name (`cueBeyondAudio`). */
  item?: string;
  /** A sentence for the log and the editor; names the segment and stem (and, for `neverFits`, "needs N rings; this preset has M"). */
  message: string;
}

/** One possible succession the ring walk covers. */
export interface MusicEdge {
  /** A segment id in `segments`. */
  from: string;
  /** A segment id in `segments`. */
  to: string;
  /** A library segment id played between them (A to bridge to B); absent: a direct seam. */
  bridge?: string;
}

/** The segments of one event, flattened: the input of `validateMusic`. */
export interface MusicGraph {
  /** Playlist and switch children, the segments that can play as the main line. */
  segments: readonly SegmentNode[];
  /** Bridge and stinger segments (F2's `library`). */
  library?: readonly SegmentNode[];
  /** The possible successions; absent: every ordered pair of distinct `segments`, direct. */
  edges?: readonly MusicEdge[];
  /** Library stingers that can sound over a segment: ids in `library`; each costs its streamed stems on top of the playing segment's. */
  stingers?: readonly string[];
}

export interface MusicValidateOptions {
  /** The pool: `audio.music.rings`, 0..16. Absent: the preset's. */
  rings?: number;
  /** Absent: `"default"`. Selects the pool (when `rings` is absent), the FLAC row and the encoded budget. */
  preset?: MusicPreset;
  /** Override the stream-or-decode rule for a path (an asset setting or import hint); `"decode"` over `decodeMaxSeconds` is `decodedTooLong`. */
  forceMode?: (path: string) => StemMode | undefined;
}

/** A segment's streamed stems at each point of a sequence, for the editor's table and the planner's refusal. */
export interface MusicRingNeed {
  /** `"alone"`, `"handover"`, `"tail"`, `"seam"` (A to B) or `"bridge"` (A to bridge to B). */
  kind: "alone" | "handover" | "tail" | "seam" | "bridge";
  /** The segment ids involved, in order. */
  segments: string[];
  /** Streamed stems sounding or primed at the sequence's peak. */
  rings: number;
}

export interface MusicValidation {
  /** Every row that fired, in a stable order: by segment, then row. */
  issues: MusicLintIssue[];
  /** Ids of segments that refuse to play (a stem length beyond slack). */
  refused: string[];
  /** Ids of the segments in any sequence that needs more rings than the pool (each such sequence also has a `neverFits` issue). */
  neverFits: string[];
  /** The peak ring need of every sequence walked, so the editor can show it; the maximum is the graph's need. */
  needs: MusicRingNeed[];
  /** The graph's peak ring need (the maximum of `needs`; 0 when everything is decoded). */
  peakRings: number;
}

// --- entry points -----------------------------------------------------------------------------------------------------

/**
 * Lint every row of §2.6 over `graph`. Pure and total: a missing fact is one `unknownClip` warning per clip and the
 * rows that need it are skipped; a segment with no tracks reports nothing here (parse already reported it).
 * Tag: F3 (the lead).
 */
export function validateMusic(graph: MusicGraph, facts: MusicFactsLookup, options?: MusicValidateOptions): MusicValidation {
  void graph; void facts; void options;
  throw new Error("F3: validateMusic not implemented");
}

/** `validateMusic` over one segment alone (an editor's segment inspector, an import): the same rows, no successions. Tag: F3. */
export function validateSegment(segment: SegmentNode, facts: MusicFactsLookup, options?: MusicValidateOptions): MusicValidation {
  return validateMusic({ segments: [segment], edges: [] }, facts, options);
}

/**
 * The stream-or-decode rule for one clip: `"decode"` when its length is at most `decodeMaxSeconds` (30 s, R15), else
 * `"stream"`; `forceMode` overrides. Tag: F3.
 */
export function stemMode(path: string, facts: MusicClipFacts, options?: MusicValidateOptions): StemMode {
  void path; void facts; void options;
  throw new Error("F3: stemMode not implemented");
}

/**
 * The music rings a segment needs **alone** at its peak: its streamed stems, plus one per streamed stem with
 * `alternatives` that hands over at a region wrap (a looping region), plus the streamed stems again for a region with
 * `tailBeats` (the tail rings on its own ring beside the next pass). Decoded stems cost nothing. Tag: F3.
 */
export function segmentRingNeed(segment: SegmentNode, facts: MusicFactsLookup, options?: MusicValidateOptions): MusicRingNeed {
  void segment; void facts; void options;
  throw new Error("F3: segmentRingNeed not implemented");
}

/**
 * The peak of every possible sequence of `graph`: each segment alone, each edge A to B (streamed(A) + streamed(B):
 * A's rings are held while it fades and rings out), each bridged edge (max of A + bridge and bridge + B), and each
 * stinger over each segment. Tag: F3.
 */
export function ringNeeds(graph: MusicGraph, facts: MusicFactsLookup, options?: MusicValidateOptions): MusicRingNeed[] {
  void graph; void facts; void options;
  throw new Error("F3: ringNeeds not implemented");
}

/** The pool a call checks against: `options.rings`, else the preset's `MUSIC_RINGS_PRESETS`. */
export function musicPool(options?: MusicValidateOptions): number {
  return options?.rings ?? MUSIC_RINGS_PRESETS[options?.preset ?? "default"];
}
