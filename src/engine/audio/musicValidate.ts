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
 * The tests are `musicValidate.test.ts` (L-F3a). The tempo walk below is local arithmetic until G1's compiled grid
 * exists; swap it for G1's `musicGrid.ts` then.
 */

import { MUSIC_RINGS_PRESETS } from "./settings";
import type { MusicTrack, SegmentNode, TempoMarker } from "./musicFormat";
import { MUSIC_TICKS_PER_BEAT, parsePosition, isBarBeatTick } from "./musicPosition";

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
  /** `"alone"`, `"handover"`, `"tail"`, `"seam"` (A to B), `"bridge"` (A to bridge to B) or `"stinger"` (a stinger over a segment). */
  kind: "alone" | "handover" | "tail" | "seam" | "bridge" | "stinger";
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

/** The pool a call checks against: `options.rings`, else the preset's `MUSIC_RINGS_PRESETS`. */
export function musicPool(options?: MusicValidateOptions): number {
  return options?.rings ?? MUSIC_RINGS_PRESETS[options?.preset ?? "default"];
}

// --- tempo walk (local until G1's compiled grid lands; the same arithmetic) -----------------------------------------------

interface TempoStep { bar: number; bpb: number; secPerBeat: number; beats: number; seconds: number }

/** The markers as steps with cumulative beats and seconds at each; markers whose `at` doesn't parse are skipped. */
function tempoSteps(tempo: readonly TempoMarker[]): TempoStep[] {
  const steps: TempoStep[] = [];
  for (const m of tempo) {
    const p = parsePosition(m.at);
    if (!p || !isBarBeatTick(p) || !(m.bpm > 0)) continue;
    const prev = steps[steps.length - 1];
    const bars = prev ? Math.max(0, p.bar - prev.bar) : 0;
    steps.push({
      bar: p.bar, bpb: m.beatsPerBar, secPerBeat: 60 / m.bpm,
      beats: prev ? prev.beats + bars * prev.bpb : 0,
      seconds: prev ? prev.seconds + bars * prev.bpb * prev.secPerBeat : 0,
    });
  }
  return steps;
}

/** Beats from the grid start (bar 1 beat 1) of a `bar:beat:tick` position; null for a word or an unparsed text. */
function positionBeats(steps: readonly TempoStep[], at: string): number | null {
  const p = parsePosition(at);
  if (!p || !isBarBeatTick(p) || steps.length === 0) return null;
  let s = steps[0]!;
  for (const c of steps) if (c.bar <= p.bar) s = c;
  return s.beats + (p.bar - s.bar) * s.bpb + (p.beat - 1) + p.tick / MUSIC_TICKS_PER_BEAT;
}

function beatsToSeconds(steps: readonly TempoStep[], beats: number): number {
  let s = steps[0]!;
  for (const c of steps) if (c.beats <= beats) s = c;
  return s.seconds + (beats - s.beats) * s.secPerBeat;
}

function secondsToBeats(steps: readonly TempoStep[], seconds: number): number {
  let s = steps[0]!;
  for (const c of steps) if (c.seconds <= seconds) s = c;
  return s.beats + (seconds - s.seconds) / s.secPerBeat;
}

// --- helpers ----------------------------------------------------------------------------------------------------------

const candidates = (t: MusicTrack): string[] => [t.clip, ...t.alternatives];

/** Frames of `f` expressed at `rate`. */
const framesAt = (f: MusicClipFacts, rate: number): number => (f.rate === rate ? f.frames : (f.frames * rate) / f.rate);

interface Ctx {
  facts: MusicFactsLookup;
  options: MusicValidateOptions | undefined;
}

function memoFacts(facts: MusicFactsLookup): MusicFactsLookup {
  const cache = new Map<string, MusicClipFacts | undefined>();
  return (path) => {
    if (!cache.has(path)) cache.set(path, facts(path));
    return cache.get(path);
  };
}

/** Streamed main stems of a segment (a clip without facts is treated as decoded: it is reported as `unknownClip`). */
function streamedStems(seg: SegmentNode, c: Ctx): number {
  let n = 0;
  for (const t of seg.tracks) {
    const f = c.facts(t.clip);
    if (f && stemMode(t.clip, f, c.options) === "stream") n++;
  }
  return n;
}

const isLooping = (seg: SegmentNode): boolean => seg.regions.some((r) => r.count !== 1);

/** How many of a track's candidate files are streamed. */
function streamedCandidates(t: MusicTrack, c: Ctx): number {
  let n = 0;
  for (const p of candidates(t)) {
    const f = c.facts(p);
    if (f && stemMode(p, f, c.options) === "stream") n++;
  }
  return n;
}

const defaultEdges = (segments: readonly SegmentNode[]): MusicEdge[] =>
  segments.flatMap((a) => segments.filter((b) => b !== a).map((b) => ({ from: a.id, to: b.id })));

// --- entry points -----------------------------------------------------------------------------------------------------

/**
 * Lint every row of §2.6 over `graph`. Pure and total: a missing fact is one `unknownClip` warning per clip and the
 * rows that need it are skipped; a segment with no tracks reports nothing here (parse already reported it).
 */
export function validateMusic(graph: MusicGraph, facts: MusicFactsLookup, options?: MusicValidateOptions): MusicValidation {
  const c: Ctx = { facts: memoFacts(facts), options };
  const preset = options?.preset ?? "default";
  const pool = musicPool(options);
  const issues: MusicLintIssue[] = [];
  const refused: string[] = [];
  const unknown = new Set<string>();
  const limits = MUSIC_VALIDATE_LIMITS;

  const all = [...graph.segments, ...(graph.library ?? [])];
  for (const seg of all) {
    if (seg.tracks.length === 0) continue;
    const add = (code: MusicLintCode, severity: "error" | "warn", message: string, extra: Partial<MusicLintIssue> = {}): void => {
      issues.push({ code, severity, segment: seg.id, message, ...extra });
    };
    for (const t of seg.tracks) {
      for (const p of candidates(t)) {
        if (c.facts(p) === undefined && !unknown.has(p)) {
          unknown.add(p);
          add("unknownClip", "warn", `segment "${seg.id}", stem "${t.name}": no clip facts for "${p}"; its checks are skipped`, { track: t.name, clip: p });
        }
      }
    }
    // Rate, channels and length against the first stem with facts.
    const known = seg.tracks.flatMap((t) => { const f = c.facts(t.clip); return f ? [{ t, f }] : []; });
    const ref = known[0];
    if (ref) {
      for (const { t, f } of known.slice(1)) {
        if (f.rate !== ref.f.rate) add("stemRateMismatch", "warn", `segment "${seg.id}", stem "${t.name}": rate ${f.rate} Hz differs from stem "${ref.t.name}" (${ref.f.rate} Hz)`, { track: t.name, clip: t.clip });
        if (f.channels !== ref.f.channels) add("stemChannelsMismatch", "warn", `segment "${seg.id}", stem "${t.name}": ${f.channels} channel(s) differ from stem "${ref.t.name}" (${ref.f.channels})`, { track: t.name, clip: t.clip });
      }
      const lens = known.map(({ f }) => framesAt(f, ref.f.rate));
      const diff = Math.round(Math.max(...lens) - Math.min(...lens));
      if (diff > limits.stemLengthSlackFrames) {
        refused.push(seg.id);
        add("stemLengthMismatch", "error", `segment "${seg.id}": stems differ in length by ${diff} frames (more than ${limits.stemLengthSlackFrames}); the segment will not play`);
      } else if (diff > 0) {
        add("stemLengthTrimmed", "warn", `segment "${seg.id}": stems differ in length by ${diff} frames; the shortest wins`);
      }
    }
    // Per clip rows.
    for (const t of seg.tracks) {
      const base = c.facts(t.clip);
      for (const p of candidates(t)) {
        const f = c.facts(p);
        if (!f) continue;
        const where = `segment "${seg.id}", stem "${t.name}", clip "${p}"`;
        const ex = { track: t.name, clip: p };
        const mode = stemMode(p, f, options);
        if (!f.gapless && (f.codec === undefined || f.codec === "mp3")) add("noGapless", "warn", `${where}: no length header, so it cannot loop gaplessly`, ex);
        if (mode === "stream" && preset === "low" && (f.codec === "flac" || f.codec === "pcm")) add("flacOnLow", "warn", `${where}: a streamed ${f.codec === "flac" ? "FLAC" : "WAV"} stem keeps its whole encoded file in memory (about 190 MiB for 8 stems); too much for the low preset`, ex);
        if (options?.forceMode?.(p) === "decode" && f.frames / f.rate > limits.decodeMaxSeconds) add("decodedTooLong", "warn", `${where}: decoded stem of ${(f.frames / f.rate).toFixed(1)} s is over ${limits.decodeMaxSeconds} s`, ex);
        if (f.silent === true) add("silentStem", "warn", `${where}: the clip is silent`, ex);
        if (p !== t.clip && base && Math.round(framesAt(f, base.rate)) !== base.frames) add("alternativeLengthMismatch", "warn", `${where}: alternative differs in length from "${t.clip}" (${f.frames} against ${base.frames} frames)`, ex);
      }
    }
    // Tempo-dependent rows: tails and cues.
    const steps = tempoSteps(seg.tempo);
    const audioSeconds = ref ? Math.min(...known.map(({ f }) => f.frames / f.rate)) : undefined;
    if (steps.length > 0) {
      for (const r of seg.regions) {
        if (!r.tailBeats) continue;
        const from = r.from === "start" ? secondsToBeats(steps, -seg.gridOffset) : positionBeats(steps, r.from);
        const to = r.to === "end" ? (audioSeconds === undefined ? null : secondsToBeats(steps, audioSeconds - seg.gridOffset)) : positionBeats(steps, r.to);
        if (from === null || to === null) continue;
        if (r.tailBeats > to - from + 1e-9) add("tailLongerThanLoop", "warn", `segment "${seg.id}", region "${r.id}": tail of ${r.tailBeats} beats is longer than its loop (${(to - from).toFixed(2)} beats)`, { item: r.id });
      }
      if (ref && audioSeconds !== undefined) {
        for (const cue of seg.cues) {
          const b = positionBeats(steps, cue.at);
          if (b === null) continue;
          const sec = seg.gridOffset + beatsToSeconds(steps, b);
          if (sec > audioSeconds + limits.cueSlackFrames / ref.f.rate) add("cueBeyondAudio", "warn", `segment "${seg.id}", cue "${cue.name}" at ${cue.at} (${sec.toFixed(3)} s) is past the end of the audio (${audioSeconds.toFixed(3)} s)`, { item: cue.name });
        }
      }
    }
  }

  // Encoded cache: streamed main stems of a segment plus its possible successors.
  const byId = new Map(all.map((s) => [s.id, s] as const));
  const edges = graph.edges ?? defaultEdges(graph.segments);
  const budget = limits.encodedBudgetBytes[preset];
  for (const seg of graph.segments) {
    const paths = new Set<string>();
    const group = [seg, ...edges.filter((e) => e.from === seg.id).flatMap((e) => [byId.get(e.to), e.bridge ? byId.get(e.bridge) : undefined])];
    for (const g of group) for (const t of g?.tracks ?? []) paths.add(t.clip);
    let bytes = 0;
    for (const p of paths) {
      const f = c.facts(p);
      if (f?.bytes !== undefined && stemMode(p, f, options) === "stream") bytes += f.bytes;
    }
    if (bytes > budget) issues.push({ code: "encodedOverBudget", severity: "warn", segment: seg.id, message: `segment "${seg.id}" and its successors keep ${(bytes / 1048576).toFixed(0)} MiB of encoded streams; the ${preset} budget is ${(budget / 1048576).toFixed(0)} MiB` });
  }

  const needs = ringNeeds(graph, c.facts, options);
  const neverFits = new Set<string>();
  for (const n of needs) {
    if (n.rings <= pool) continue;
    n.segments.forEach((id) => neverFits.add(id));
    issues.push({ code: "neverFits", severity: "warn", segment: n.segments[0], message: `${n.kind} ${n.segments.map((id) => `"${id}"`).join(" to ")}: needs ${n.rings} rings; this preset has ${pool}` });
  }
  return { issues, refused, neverFits: [...neverFits], needs, peakRings: needs.reduce((m, n) => Math.max(m, n.rings), 0) };
}

/** `validateMusic` over one segment alone (an editor's segment inspector, an import): the same rows, no successions. */
export function validateSegment(segment: SegmentNode, facts: MusicFactsLookup, options?: MusicValidateOptions): MusicValidation {
  return validateMusic({ segments: [segment], edges: [] }, facts, options);
}

/**
 * The stream-or-decode rule for one clip: `"decode"` when its length is at most `decodeMaxSeconds` (30 s, R15), else
 * `"stream"`; `forceMode` overrides.
 */
export function stemMode(path: string, facts: MusicClipFacts, options?: MusicValidateOptions): StemMode {
  const forced = options?.forceMode?.(path);
  if (forced) return forced;
  return facts.frames <= MUSIC_VALIDATE_LIMITS.decodeMaxSeconds * facts.rate ? "decode" : "stream";
}

/**
 * The music rings a segment needs **alone** at its peak: its streamed stems, plus one per streamed stem with
 * `alternatives` that hands over at a region wrap (a looping region), plus the streamed stems again for a region with
 * `tailBeats` (the tail rings on its own ring beside the next pass). Decoded stems cost nothing.
 */
export function segmentRingNeed(segment: SegmentNode, facts: MusicFactsLookup, options?: MusicValidateOptions): MusicRingNeed {
  const c: Ctx = { facts: memoFacts(facts), options };
  const streamed = streamedStems(segment, c);
  let best: MusicRingNeed = { kind: "alone", segments: [segment.id], rings: streamed };
  if (isLooping(segment)) {
    // A track with alternatives: old and new file overlap at the wrap, each streamed one holding a ring.
    let handover = 0;
    let any = false;
    for (const t of segment.tracks) {
      if (t.alternatives.length > 0) {
        const n = Math.min(2, streamedCandidates(t, c));
        if (n > 0) any = true;
        handover += n;
      } else {
        const f = c.facts(t.clip);
        if (f && stemMode(t.clip, f, options) === "stream") handover++;
      }
    }
    if (any && handover > best.rings) best = { kind: "handover", segments: [segment.id], rings: handover };
    if (segment.regions.some((r) => r.count !== 1 && (r.tailBeats ?? 0) > 0) && streamed * 2 > best.rings) {
      best = { kind: "tail", segments: [segment.id], rings: streamed * 2 };
    }
  }
  return best;
}

/**
 * The peak of every possible sequence of `graph`: each segment alone, each edge A to B (streamed(A) + streamed(B):
 * A's rings are held while it fades and rings out), each bridged edge (max of A + bridge and bridge + B), and each
 * stinger over each segment.
 */
export function ringNeeds(graph: MusicGraph, facts: MusicFactsLookup, options?: MusicValidateOptions): MusicRingNeed[] {
  const c: Ctx = { facts: memoFacts(facts), options };
  const byId = new Map([...graph.segments, ...(graph.library ?? [])].map((s) => [s.id, s] as const));
  const out: MusicRingNeed[] = [];
  for (const s of graph.segments) out.push(segmentRingNeed(s, c.facts, options));
  for (const e of graph.edges ?? defaultEdges(graph.segments)) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const sa = streamedStems(a, c), sb = streamedStems(b, c);
    if (e.bridge === undefined) {
      out.push({ kind: "seam", segments: [a.id, b.id], rings: sa + sb });
      continue;
    }
    const br = byId.get(e.bridge);
    if (!br) continue;
    const sbr = streamedStems(br, c);
    out.push({ kind: "bridge", segments: [a.id, br.id, b.id], rings: Math.max(sa + sbr, sbr + sb) });
  }
  for (const id of graph.stingers ?? []) {
    const st = byId.get(id);
    if (!st) continue;
    const ss = streamedStems(st, c);
    for (const s of graph.segments) out.push({ kind: "stinger", segments: [s.id, st.id], rings: streamedStems(s, c) + ss });
  }
  return out;
}

