/**
 * Interactive music nodes of the audio event format (ADR 0166 / 0167; `docs/design/0166-audio-music/api-and-models.md`
 * §2.3): the `segment` node with its tempo map, cues, regions and tracks (stems with alternatives), the node ids, the
 * limits, and the writer. A pure, lenient parser in the house style of `eventFormat.ts`: bad entries are dropped or
 * clamped and each is reported in `problems`, with a message that names the path; it never throws.
 *
 * ```jsonc
 * { "type": "segment", "id": "explore", "value": "explore", "gridOffset": 0.5,
 *   "tempo": [ { "at": "1:1:0", "bpm": 120, "beatsPerBar": 4, "beatUnit": 4 } ],
 *   "cues": [ { "name": "entry", "at": "1:1:0" }, { "name": "exit", "at": "end" } ], "entry": "entry", "exit": "exit",
 *   "regions": [ { "id": "loop", "from": "1:1:0", "to": "9:1:0", "count": 0, "tailBeats": 4, "while": { "parameter": "Boss", "is": "alive" } } ],
 *   "tracks": [ { "name": "drums", "clip": "music/e-drums.ogg", "alternatives": ["music/e-drums-b.ogg"], "pick": "sequence",
 *                 "volume": 1, "bus": "Drums", "automation": [ { "parameter": "Intensity", "target": "volume", "curve": [[0,0],[1,1]], "quantize": "bar" } ] } ] }
 * ```
 *
 * **Extension points (this file is F1a's; the rest of the build adds to it, it never rewrites it):**
 * - F1b adds `playlist` and `musicSwitch` to `MUSIC_NODE_TYPES` and `MusicNode`, calls `parseSegmentNode` from
 *   `eventFormat.ts`'s node reader for `"segment"` (passing its node budget through `MusicParseContext.admit` and one
 *   shared `ids` set), routes music nodes through `musicNodeToJson` in `formatAudioEvent`, and lists `musicClips` in
 *   `eventClips`. It also owns the placement rule (a music node under a non-music container, or a 0158 node under a
 *   music container, is dropped with a problem) and `NodeBase.id`.
 * - F2 adds `transitions`, `stingers` and `library` on the containers, and their dangling-id checks.
 * - F3 validates against clip facts (stem length, rate, channels, gapless, cue past the audio).
 * - G1 compiles `tempo` into the grid (seconds and frames) and checks a beat past its bar's metre.
 *
 * This file imports only types from `eventFormat.ts` (F1b makes that file import this one; a value import back would
 * be a cycle), so the automation reader below repeats the 0158 one for the targets music allows.
 */

import { parseCurve, type Curve } from "../core/curve";
import type { Automation, NodeBase } from "./eventFormat";
import {
  comparePositions, formatPosition, isBarBeatTick, parsePosition, positionProblem, snapToBeat, snapToNextBar,
  MAX_POSITION_BAR, type BarBeatTick,
} from "./musicPosition";

// --- limits (§2.3) --------------------------------------------------------------------------------------------------

/** A node id: required on every music node, unique per event (§2.3). */
export const MUSIC_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;

/** Every format limit of the music nodes (§2.3). Rules, stingers and the library are F2's, listed for the one table. */
export const MUSIC_LIMITS = {
  /** Tempo markers per segment, 1..64. */
  tempoMarkers: 64,
  cues: 64,
  regions: 16,
  /** Tracks (stems) per segment, 1..16. */
  tracks: 16,
  /** Alternatives per track. */
  alternatives: 8,
  /** `playlist.children` (F1b). */
  playlistChildren: 256,
  /** Rules per container (F2). */
  rules: 256,
  /** Stingers per container (F2). */
  stingers: 32,
  /** Library segments per event (F2). */
  library: 64,
  /** `beatsPerBar` 1..32. */
  beatsPerBar: 32,
  /** A region's `count`: 0 forever, else 1..64. */
  regionCount: 64,
  /** A region's `tailBeats`, 0..16. */
  tailBeats: 16,
  /** A child's `plays`, 1..64. */
  plays: 64,
} as const;

/** `beatUnit`: the note value of a beat. */
export const BEAT_UNITS = [1, 2, 4, 8, 16] as const;
/** Beats per minute of a tempo marker. §2.2 gives no range; this is the lenient bound (an interpretation). */
export const MIN_BPM = 1;
export const MAX_BPM = 1000;
/** Largest `gridOffset`, seconds (a sanity bound, not in the spec). */
export const MAX_GRID_OFFSET = 3600;
/** Keys of one stem automation curve (the 0158 bound, `MAX_CURVE_KEYS`). */
export const MUSIC_CURVE_KEYS = 32;

export const TRACK_PICKS = ["random", "sequence"] as const;
export type TrackPick = (typeof TRACK_PICKS)[number];

/** Targets a stem's automation may drive. `pitch` is the 0158 third one: an error on music (owner decision 2, C13). */
export const MUSIC_AUTOMATION_TARGETS = ["volume", "lowpass"] as const;
export type MusicAutomationTarget = (typeof MUSIC_AUTOMATION_TARGETS)[number];
export const AUTOMATION_QUANTIZE = ["beat", "bar"] as const;
export type AutomationQuantize = (typeof AUTOMATION_QUANTIZE)[number];

/** A problem message that is an error, not a warning, begins with this (the pitch binding on a track, §2.3). */
export const MUSIC_ERROR_PREFIX = "error: ";
/** True for an error-level problem message. */
export const isMusicError = (problem: string): boolean => problem.startsWith(MUSIC_ERROR_PREFIX);

// --- the model ------------------------------------------------------------------------------------------------------

/** A tempo marker: where it takes effect (on a beat), beats of `beatUnit` per minute, and the metre. */
export interface TempoMarker {
  /** `"bar:beat:tick"`, tick 0; the first marker is `"1:1:0"`. */
  at: string;
  bpm: number;
  beatsPerBar: number;
  beatUnit: number;
}

/** The default tempo map: one marker, 120 bpm, 4/4. */
export const DEFAULT_TEMPO: readonly TempoMarker[] = [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }];

/** A named point in the segment. `at` is `"bar:beat:tick"`, `"start"` or `"end"` (canonical text). */
export interface MusicCue {
  name: string;
  at: string;
}

/** A region's loop condition: a labelled parameter equals `is`, or a numeric one is `atLeast` / `below` a value. */
export type RegionCondition =
  | { parameter: string; is: string }
  | { parameter: string; atLeast: number }
  | { parameter: string; below: number };

export interface MusicRegion {
  /** Unique within the segment. */
  id: string;
  /** `"bar:beat:tick"` or `"start"`. */
  from: string;
  /** `"bar:beat:tick"` or `"end"`; after `from`. */
  to: string;
  /** 0 = forever, else 1..64 passes. */
  count: number;
  /** Beats 0..16 of tail ringing past the loop end on the next pass's voices; absent: none. */
  tailBeats?: number;
  /** Keep looping while this holds (read at the commit point, ARCH); absent: `count` alone decides. */
  while?: RegionCondition;
}

/** A stem's automation: the 0158 binding, targets `volume` and `lowpass`, optionally quantised to the grid. */
export interface MusicAutomation {
  parameter: string;
  target: MusicAutomationTarget;
  curve: Curve;
  /** Evaluated on main at the grid point and applied as a stamped 20 ms ramp (§2.3); absent: follows the parameter. */
  quantize?: AutomationQuantize;
}

/** A stem: one clip, or one of several equal-length alternatives picked once per pass. */
export interface MusicTrack {
  /** Unique within the segment. */
  name: string;
  /** Asset path, without `asset:`. */
  clip: string;
  /** Up to 8 more clips of the same length; with `clip` they are the candidates. */
  alternatives: string[];
  pick: TrackPick;
  /** Linear gain 0..4. */
  volume: number;
  /** A bus name; empty: the event's. */
  bus: string;
  automation: MusicAutomation[];
}

/**
 * A segment: audio on a musical grid. `pitch`, `pitchRandom`, `delay`, `range`, `fade` and `automation` of `NodeBase`
 * are not read (one problem each) and carry neutral values, so the writer omits them (`musicNodeToJson`).
 */
export interface SegmentNode extends NodeBase {
  type: "segment";
  /** Required, `MUSIC_ID_PATTERN`, unique per event. */
  id: string;
  /** Seconds >= 0: where bar 1 beat 1 sits in the files (the pre-entry pickup when the entry is `1:1:0`). */
  gridOffset: number;
  /** 1..64 markers, strictly increasing, the first at `1:1:0`. */
  tempo: TempoMarker[];
  /** <= 64, unique names. */
  cues: MusicCue[];
  /** Name of the entry cue; absent: the cue named `entry` if any, else the grid start. See `segmentEntryPosition`. */
  entry?: string;
  /** Name of the exit cue; absent: the cue named `exit` if any, else the end. See `segmentExitPosition`. */
  exit?: string;
  /** <= 16. */
  regions: MusicRegion[];
  /** 1..16 stems (a segment with none plays nothing and is reported). */
  tracks: MusicTrack[];
  /** As a playlist child: how many times it plays per visit, 1..64 (default 1). */
  plays: number;
}

export const PLAYLIST_MODES = ["sequence", "random", "shuffle"] as const;
export type PlaylistMode = (typeof PLAYLIST_MODES)[number];
/** Largest `rounds` of a playlist (a sanity bound, not in the spec; 0 is forever). */
export const MAX_PLAYLIST_ROUNDS = 1000;

/** Fields the music containers share: children (music nodes), the `library` of bridge and stinger segments (§2.5). */
interface MusicContainerBase extends NodeBase {
  /** Required, `MUSIC_ID_PATTERN`, unique per event. */
  id: string;
  /** As a child of a playlist: how many times it plays per visit, 1..64 (default 1). */
  plays: number;
  /** <= 256 music nodes (`MUSIC_LIMITS.playlistChildren`). */
  children: MusicNode[];
  /** <= 64 segments that are bridges and stingers, not children (F2 adds the rules that name them). */
  library: SegmentNode[];
}

/** A playlist: its children in `mode` order, `rounds` times (§2.3). */
export interface PlaylistNode extends MusicContainerBase {
  type: "playlist";
  mode: PlaylistMode;
  /** Whole-list repeats; 0 forever. */
  rounds: number;
  /** `random` mode: skip the last n picks (capped at children - 1). */
  avoidRepeat: number;
}

/** A switch on a labelled parameter; the children are keyed by `value`; transitions are the rules' (F2). */
export interface MusicSwitchNode extends MusicContainerBase {
  type: "musicSwitch";
  parameter: string;
  /** The label to use when none matches; absent: the first child. */
  default?: string;
}

export const MUSIC_NODE_TYPES = ["segment", "playlist", "musicSwitch"] as const;
export type MusicNodeType = (typeof MUSIC_NODE_TYPES)[number];
export type MusicNode = SegmentNode | PlaylistNode | MusicSwitchNode;
/** The music containers: the only nodes that may hold music nodes. */
export const isMusicContainer = (node: { type: string }): node is PlaylistNode | MusicSwitchNode =>
  node.type === "playlist" || node.type === "musicSwitch";

/** True when `type` is a music node type (F1b's dispatch in `eventFormat.ts`). */
export const isMusicNodeType = (type: unknown): type is MusicNodeType =>
  typeof type === "string" && (MUSIC_NODE_TYPES as readonly string[]).includes(type);

// --- the parse context ----------------------------------------------------------------------------------------------

/** What a music node parse shares with the event it sits in. */
export interface MusicParseContext {
  /** Problem messages, each naming its path. */
  problems: string[];
  /** Node ids already taken in this event (every music node, `library` segments too). The parser adds the ids it accepts. */
  ids: Set<string>;
  /**
   * Called once per node about to be accepted; false when the event's node budget (`MAX_EVENT_NODES`) is spent, and the
   * node is dropped with a problem. Absent: no budget.
   */
  admit?: (where: string) => boolean;
}

/** A fresh context for a stand-alone parse. */
export const newMusicContext = (): MusicParseContext => ({ problems: [], ids: new Set() });

// --- small readers (the 0158 `Reader`'s, repeated: see the header) -------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function num(raw: unknown, where: string, fallback: number, problems: string[], min = -Infinity, max = Infinity): number {
  if (raw === undefined) return fallback;
  if (!finite(raw)) { problems.push(`${where}: must be a number; using ${fallback}.`); return fallback; }
  if (raw < min || raw > max) {
    const c = Math.min(max, Math.max(min, raw));
    problems.push(`${where}: ${raw} is outside ${min}..${max}; using ${c}.`);
    return c;
  }
  return raw;
}

/** An integer: a fraction is rounded (no problem, as `priority` in 0158), the range clamped with a problem. */
const int = (raw: unknown, where: string, fallback: number, problems: string[], min: number, max: number): number =>
  Math.round(num(raw, where, fallback, problems, min, max));

function str(raw: unknown, where: string, fallback: string, problems: string[]): string {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string") { problems.push(`${where}: must be a string; using "${fallback}".`); return fallback; }
  return raw;
}

function pick<T extends string>(raw: unknown, where: string, options: readonly T[], fallback: T, problems: string[]): T {
  if (raw === undefined) return fallback;
  if (typeof raw === "string" && (options as readonly string[]).includes(raw)) return raw as T;
  problems.push(`${where}: must be one of ${options.join(", ")}; using "${fallback}".`);
  return fallback;
}

/** `[lo, hi]` in dB, clamped, swapped when reversed; absent or bad gives `[0, 0]`. */
function pair(raw: unknown, where: string, problems: string[], min: number, max: number): [number, number] {
  if (raw === undefined) return [0, 0];
  if (!Array.isArray(raw) || raw.length !== 2 || !finite(raw[0]) || !finite(raw[1])) {
    problems.push(`${where}: must be [low, high] numbers; using [0, 0].`);
    return [0, 0];
  }
  let lo = Math.min(max, Math.max(min, raw[0])), hi = Math.min(max, Math.max(min, raw[1]));
  if (lo !== raw[0] || hi !== raw[1]) problems.push(`${where}: clamped to ${min}..${max}.`);
  if (lo > hi) { problems.push(`${where}: low was above high; swapped.`); [lo, hi] = [hi, lo]; }
  return [lo, hi];
}

function list(raw: unknown, where: string, problems: string[]): unknown[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { problems.push(`${where}: must be a list.`); return []; }
  return raw;
}

/** `list`, cut at `max` entries with one problem. */
function capped(raw: unknown, where: string, max: number, problems: string[]): unknown[] {
  const items = list(raw, where, problems);
  if (items.length <= max) return items;
  problems.push(`${where}: at most ${max} entries; the rest are dropped.`);
  return items.slice(0, max);
}

/** The curve of a stem's automation: `parseCurve` capped at `MUSIC_CURVE_KEYS` keys; null when it has no keys. */
function musicCurve(raw: unknown, where: string, problems: string[]): Curve | null {
  const curve = parseCurve(raw, where, problems);
  if (!curve || curve.length === 0) return null;
  if (curve.length > MUSIC_CURVE_KEYS) {
    problems.push(`${where}: at most ${MUSIC_CURVE_KEYS} keys; the rest are dropped.`);
    curve.length = MUSIC_CURVE_KEYS;
  }
  return curve;
}

// --- tempo (§2.2, §2.3) ---------------------------------------------------------------------------------------------

/**
 * The tempo map. 1..64 markers; the first at `1:1:0`; absent or empty gives `DEFAULT_TEMPO`. A field a marker omits
 * keeps the previous marker's value. A marker not on a beat moves to the beat; one that changes the metre
 * (`beatsPerBar` or `beatUnit`) off beat 1 snaps to the next bar; markers are ordered, and one at or before its
 * predecessor is dropped. Each change is a problem naming the marker.
 */
function parseTempo(raw: unknown, where: string, problems: string[]): TempoMarker[] {
  const items = capped(raw, where, MUSIC_LIMITS.tempoMarkers, problems);
  type Draft = { pos: BarBeatTick; bpm: number; beatsPerBar: number; beatUnit: number; index: number };
  const drafts: Draft[] = [];
  let prev: { bpm: number; beatsPerBar: number; beatUnit: number } = { bpm: 120, beatsPerBar: 4, beatUnit: 4 };
  items.forEach((m, i) => {
    const w = `${where}[${i}]`;
    if (!isRecord(m)) return void problems.push(`${w}: must be an object; dropped.`);
    let pos: BarBeatTick;
    if (m.at === undefined && i === 0) pos = { bar: 1, beat: 1, tick: 0 };
    else {
      const p = parsePosition(m.at);
      if (!p || !isBarBeatTick(p)) return void problems.push(`${w}.at: ${positionProblem(m.at) ?? "must be a position"}; dropped.`);
      pos = p;
    }
    const bpm = num(m.bpm, `${w}.bpm`, prev.bpm, problems, MIN_BPM, MAX_BPM);
    const beatsPerBar = int(m.beatsPerBar, `${w}.beatsPerBar`, prev.beatsPerBar, problems, 1, MUSIC_LIMITS.beatsPerBar);
    let beatUnit = prev.beatUnit;
    if (m.beatUnit !== undefined) {
      if (typeof m.beatUnit === "number" && (BEAT_UNITS as readonly number[]).includes(m.beatUnit)) beatUnit = m.beatUnit;
      else problems.push(`${w}.beatUnit: must be one of ${BEAT_UNITS.join(", ")}; using ${prev.beatUnit}.`);
    }
    prev = { bpm, beatsPerBar, beatUnit };
    if (pos.tick !== 0) {
      const to = snapToBeat(pos);
      problems.push(`${w}.at: a tempo marker sits on a beat; moved from "${formatPosition(pos)}" to "${formatPosition(to)}".`);
      pos = to;
    }
    drafts.push({ pos, bpm, beatsPerBar, beatUnit, index: i });
  });
  if (drafts.length === 0) {
    if (items.length > 0) problems.push(`${where}: no usable marker; using ${DEFAULT_TEMPO[0].bpm} bpm ${DEFAULT_TEMPO[0].beatsPerBar}/${DEFAULT_TEMPO[0].beatUnit}.`);
    return DEFAULT_TEMPO.map((t) => ({ ...t }));
  }
  if (drafts.some((d, i) => i > 0 && comparePositions(drafts[i - 1].pos, d.pos) > 0)) {
    problems.push(`${where}: markers must be in order of position; sorted.`);
    drafts.sort((a, b) => comparePositions(a.pos, b.pos) || a.index - b.index);
  }
  const out: Draft[] = [];
  for (const d of drafts) {
    const before = out[out.length - 1];
    const w = `${where}[${d.index}]`;
    if (before && (before.beatsPerBar !== d.beatsPerBar || before.beatUnit !== d.beatUnit) && d.pos.beat !== 1) {
      const to = snapToNextBar(d.pos);
      if (to.bar > MAX_POSITION_BAR) { problems.push(`${w}.at: a metre change sits on beat 1 and there is no bar after "${formatPosition(d.pos)}"; dropped.`); continue; }
      problems.push(`${w}.at: a metre change sits on beat 1; moved from "${formatPosition(d.pos)}" to the next bar, "${formatPosition(to)}".`);
      d.pos = to;
    }
    if (before && comparePositions(before.pos, d.pos) >= 0) {
      problems.push(`${w}.at: already a marker at or after "${formatPosition(d.pos)}"; dropped.`);
      continue;
    }
    out.push(d);
  }
  const first = out[0];
  if (comparePositions(first.pos, { bar: 1, beat: 1, tick: 0 }) !== 0) {
    problems.push(`${where}[${first.index}].at: the first tempo marker is at 1:1:0; moved from "${formatPosition(first.pos)}".`);
    first.pos = { bar: 1, beat: 1, tick: 0 };
  }
  return out.map((d) => ({ at: formatPosition(d.pos), bpm: d.bpm, beatsPerBar: d.beatsPerBar, beatUnit: d.beatUnit }));
}

// --- cues, regions --------------------------------------------------------------------------------------------------

/** `cues`: <= 64, unique non-empty names, `at` a position, `"start"` or `"end"`. */
function parseCues(raw: unknown, where: string, problems: string[]): MusicCue[] {
  const out: MusicCue[] = [];
  capped(raw, where, MUSIC_LIMITS.cues, problems).forEach((c, i) => {
    const w = `${where}[${i}]`;
    if (!isRecord(c) || typeof c.name !== "string" || c.name === "") return void problems.push(`${w}: name must be a non-empty string; dropped.`);
    if (out.some((o) => o.name === c.name)) return void problems.push(`${w}: another cue is already named "${c.name}"; dropped.`);
    const at = parsePosition(c.at, { start: true, end: true });
    if (!at) return void problems.push(`${w}.at: ${positionProblem(c.at, { start: true, end: true }) ?? "must be a position"}; the cue is dropped.`);
    out.push({ name: c.name, at: formatPosition(at) });
  });
  return out;
}

function parseCondition(raw: Record<string, unknown>, where: string, problems: string[]): RegionCondition | undefined {
  if (typeof raw.parameter !== "string" || raw.parameter === "") {
    problems.push(`${where}.parameter: must name a parameter; the condition is dropped.`);
    return undefined;
  }
  const forms = (["is", "atLeast", "below"] as const).filter((k) => raw[k] !== undefined);
  if (forms.length === 0) {
    problems.push(`${where}: needs one of is, atLeast or below; the condition is dropped.`);
    return undefined;
  }
  if (forms.length > 1) problems.push(`${where}: has ${forms.join(" and ")}; using ${forms[0]}.`);
  const key = forms[0];
  if (key === "is") {
    if (typeof raw.is !== "string" || raw.is === "") return void problems.push(`${where}.is: must be a label; the condition is dropped.`);
    return { parameter: raw.parameter, is: raw.is };
  }
  const v = raw[key];
  if (!finite(v)) return void problems.push(`${where}.${key}: must be a number; the condition is dropped.`);
  return key === "atLeast" ? { parameter: raw.parameter, atLeast: v } : { parameter: raw.parameter, below: v };
}

/** `regions`: <= 16; unique ids; `from` before `to`; `count` 0..64 (default 0); `tailBeats` 0..16; optional `while`. */
function parseRegions(raw: unknown, where: string, problems: string[]): MusicRegion[] {
  const out: MusicRegion[] = [];
  capped(raw, where, MUSIC_LIMITS.regions, problems).forEach((r, i) => {
    const w = `${where}[${i}]`;
    if (!isRecord(r) || typeof r.id !== "string" || r.id === "") return void problems.push(`${w}: id must be a non-empty string; dropped.`);
    if (out.some((o) => o.id === r.id)) return void problems.push(`${w}: another region is already named "${r.id}"; dropped.`);
    const from = parsePosition(r.from, { start: true });
    if (!from) return void problems.push(`${w}.from: ${positionProblem(r.from, { start: true }) ?? "must be a position"}; the region is dropped.`);
    const to = parsePosition(r.to, { end: true });
    if (!to) return void problems.push(`${w}.to: ${positionProblem(r.to, { end: true }) ?? "must be a position"}; the region is dropped.`);
    if (isBarBeatTick(from) && isBarBeatTick(to) && comparePositions(from, to) >= 0) {
      return void problems.push(`${w}: from "${formatPosition(from)}" is not before to "${formatPosition(to)}"; the region is dropped.`);
    }
    const region: MusicRegion = { id: r.id, from: formatPosition(from), to: formatPosition(to), count: int(r.count, `${w}.count`, 0, problems, 0, MUSIC_LIMITS.regionCount) };
    if (r.tailBeats !== undefined) region.tailBeats = num(r.tailBeats, `${w}.tailBeats`, 0, problems, 0, MUSIC_LIMITS.tailBeats);
    if (r.while !== undefined) {
      if (!isRecord(r.while)) problems.push(`${w}.while: must be an object; ignored.`);
      else { const c = parseCondition(r.while, `${w}.while`, problems); if (c) region.while = c; }
    }
    out.push(region);
  });
  return out;
}

// --- tracks ---------------------------------------------------------------------------------------------------------

const assetPath = (v: string): string => v.replace(/^asset:/, "");

function parseAutomation(raw: unknown, where: string, problems: string[]): MusicAutomation[] {
  const out: MusicAutomation[] = [];
  list(raw, where, problems).forEach((a, i) => {
    const w = `${where}[${i}]`;
    if (!isRecord(a) || typeof a.parameter !== "string" || a.parameter === "") return void problems.push(`${w}: parameter must name a parameter; dropped.`);
    if (a.target === "pitch") return void problems.push(`${MUSIC_ERROR_PREFIX}${w}.target: pitch automation is not allowed on music (it plays at rate 1); the binding is dropped.`);
    if (typeof a.target !== "string" || !(MUSIC_AUTOMATION_TARGETS as readonly string[]).includes(a.target)) {
      return void problems.push(`${w}: target must be one of ${MUSIC_AUTOMATION_TARGETS.join(", ")}; dropped.`);
    }
    const curve = musicCurve(a.curve, `${w}.curve`, problems);
    if (!curve) return void problems.push(`${w}: the curve has no keys; dropped.`);
    const binding: MusicAutomation = { parameter: a.parameter, target: a.target as MusicAutomationTarget, curve };
    if (a.quantize !== undefined) {
      if (typeof a.quantize === "string" && (AUTOMATION_QUANTIZE as readonly string[]).includes(a.quantize)) binding.quantize = a.quantize as AutomationQuantize;
      else problems.push(`${w}.quantize: must be one of ${AUTOMATION_QUANTIZE.join(", ")}; the binding follows the parameter.`);
    }
    out.push(binding);
  });
  return out;
}

/** `tracks`: 1..16 stems with unique names; a segment with none plays nothing (reported, kept). */
function parseTracks(raw: unknown, where: string, problems: string[]): MusicTrack[] {
  const out: MusicTrack[] = [];
  capped(raw, where, MUSIC_LIMITS.tracks, problems).forEach((t, i) => {
    const w = `${where}[${i}]`;
    if (!isRecord(t)) return void problems.push(`${w}: must be an object; dropped.`);
    let name = typeof t.name === "string" && t.name !== "" ? t.name : "";
    if (name === "") {
      name = `track${i + 1}`;
      problems.push(`${w}.name: ${t.name === undefined ? "missing" : "must be a non-empty string"}; using "${name}".`);
    }
    if (out.some((o) => o.name === name)) return void problems.push(`${w}: another track is already named "${name}"; dropped.`);
    const clip = assetPath(str(t.clip, `${w}.clip`, "", problems));
    if (clip === "") problems.push(`${w}: clip is empty; it plays nothing.`);
    const alternatives: string[] = [];
    capped(t.alternatives, `${w}.alternatives`, MUSIC_LIMITS.alternatives, problems).forEach((a, j) => {
      if (typeof a !== "string" || a === "") return void problems.push(`${w}.alternatives[${j}]: must be a clip path; dropped.`);
      alternatives.push(assetPath(a));
    });
    out.push({
      name, clip, alternatives,
      pick: pick(t.pick, `${w}.pick`, TRACK_PICKS, "sequence", problems),
      volume: num(t.volume, `${w}.volume`, 1, problems, 0, 4),
      bus: str(t.bus, `${w}.bus`, "", problems),
      automation: parseAutomation(t.automation, `${w}.automation`, problems),
    });
  });
  if (out.length === 0) problems.push(`${where}: has no tracks; it plays nothing.`);
  return out;
}

// --- the segment node -----------------------------------------------------------------------------------------------

/** `NodeBase` keys a music node reads and ignores (§2.3; `automation` is a track's, not a segment's). One problem each. */
const IGNORED_ON_MUSIC = ["pitch", "pitchRandom", "delay", "range", "fade", "automation"] as const;

/**
 * The shared start of every music node parse: object, valid unique id, node budget; claims the id and reports the
 * ignored `NodeBase` keys. Null (with a problem) when the node is dropped.
 */
function openMusicNode(raw: unknown, where: string, ctx: MusicParseContext, what: string): { raw: Record<string, unknown>; id: string } | null {
  const p = ctx.problems;
  if (!isRecord(raw)) { p.push(`${where}: a ${what} must be an object; dropped.`); return null; }
  if (typeof raw.id !== "string" || !MUSIC_ID_PATTERN.test(raw.id)) {
    p.push(`${where}.id: ${raw.id === undefined ? "required on a music node" : `${JSON.stringify(raw.id)} is not a valid id`}; ids are 1-48 letters, digits, "_" or "-"; the node is dropped.`);
    return null;
  }
  const id = raw.id;
  if (ctx.ids.has(id)) { p.push(`${where}.id: another node is already named "${id}"; dropped.`); return null; }
  if (ctx.admit && !ctx.admit(where)) { p.push(`${where}: the event's node limit is spent; dropped.`); return null; }
  ctx.ids.add(id);
  for (const key of IGNORED_ON_MUSIC) {
    if (raw[key] !== undefined) p.push(`${where}.${key}: ${key === "automation" ? "put automation on a track" : "not used on music (no pitch, delay, range or fade on a music node)"}; ignored.`);
  }
  return { raw, id };
}

/**
 * Parse one `segment` node (`raw.type` is assumed to be `"segment"`; the caller dispatched on it). Null (with a problem)
 * when `raw` is not an object, has no valid id, repeats an id of `ctx.ids`, or the event's node budget is spent;
 * otherwise a node, with every bad field clamped or dropped and reported. `where` is the path used in messages.
 */
export function parseSegmentNode(rawNode: unknown, where: string, ctx: MusicParseContext): SegmentNode | null {
  const p = ctx.problems;
  const open = openMusicNode(rawNode, where, ctx, "segment");
  if (!open) return null;
  const { raw, id } = open;
  const node: SegmentNode = {
    type: "segment", id,
    volume: num(raw.volume, `${where}.volume`, 1, p, 0, 4),
    pitch: 1, pitchRandom: [0, 0], delay: 0, automation: [], fade: 0,
    volumeRandom: pair(raw.volumeRandom, `${where}.volumeRandom`, p, -96, 24),
    weight: num(raw.weight, `${where}.weight`, 1, p, 0, 1e6),
    gridOffset: num(raw.gridOffset, `${where}.gridOffset`, 0, p, 0, MAX_GRID_OFFSET),
    tempo: parseTempo(raw.tempo, `${where}.tempo`, p),
    cues: parseCues(raw.cues, `${where}.cues`, p),
    regions: parseRegions(raw.regions, `${where}.regions`, p),
    tracks: parseTracks(raw.tracks, `${where}.tracks`, p),
    plays: int(raw.plays, `${where}.plays`, 1, p, 1, MUSIC_LIMITS.plays),
  };
  if (raw.value !== undefined) node.value = str(raw.value, `${where}.value`, "", p);
  for (const key of ["entry", "exit"] as const) {
    if (raw[key] === undefined) continue;
    const name = raw[key];
    if (typeof name !== "string") p.push(`${where}.${key}: must be a cue name; using the default.`);
    else if (!node.cues.some((c) => c.name === name)) p.push(`${where}.${key}: no cue named "${name}"; using the default.`);
    else node[key] = name;
  }
  return node;
}

/**
 * Parse the own fields of a `playlist` or `musicSwitch` (`raw.type` says which; the caller dispatched): id, budget,
 * ignored keys, `plays`, and the kind's keys. Children and `library` are left empty: the caller (the event reader, which
 * owns the recursion, depth and the placement rule) reads each child of `musicChildrenList`, then calls
 * `parseMusicLibrary` and `finishMusicContainer`. Null (with a problem) when the node is dropped.
 */
export function parseMusicContainerHead(rawNode: unknown, where: string, ctx: MusicParseContext): PlaylistNode | MusicSwitchNode | null {
  const p = ctx.problems;
  const kind = isRecord(rawNode) && rawNode.type === "musicSwitch" ? "musicSwitch" : "playlist";
  const open = openMusicNode(rawNode, where, ctx, kind);
  if (!open) return null;
  const { raw, id } = open;
  const base = {
    id, children: [] as MusicNode[], library: [] as SegmentNode[],
    volume: num(raw.volume, `${where}.volume`, 1, p, 0, 4),
    pitch: 1, pitchRandom: [0, 0] as [number, number], delay: 0, automation: [] as Automation[], fade: 0,
    volumeRandom: pair(raw.volumeRandom, `${where}.volumeRandom`, p, -96, 24),
    weight: num(raw.weight, `${where}.weight`, 1, p, 0, 1e6),
    plays: int(raw.plays, `${where}.plays`, 1, p, 1, MUSIC_LIMITS.plays),
  };
  const value = raw.value !== undefined ? str(raw.value, `${where}.value`, "", p) : undefined;
  if (kind === "playlist") {
    const node: PlaylistNode = {
      ...base, type: "playlist",
      mode: pick(raw.mode, `${where}.mode`, PLAYLIST_MODES, "sequence", p),
      rounds: int(raw.rounds, `${where}.rounds`, 1, p, 0, MAX_PLAYLIST_ROUNDS),
      avoidRepeat: int(raw.avoidRepeat, `${where}.avoidRepeat`, 0, p, 0, MUSIC_LIMITS.playlistChildren),
    };
    if (value !== undefined) node.value = value;
    return node;
  }
  const node: MusicSwitchNode = { ...base, type: "musicSwitch", parameter: str(raw.parameter, `${where}.parameter`, "", p) };
  if (node.parameter === "") p.push(`${where}: parameter is empty; it plays its default.`);
  if (raw.default !== undefined) node.default = str(raw.default, `${where}.default`, "", p);
  if (value !== undefined) node.value = value;
  return node;
}

/** The raw `children` list of a music container, cut at `MUSIC_LIMITS.playlistChildren` with one problem. */
export function musicChildrenList(raw: unknown, where: string, problems: string[]): unknown[] {
  return capped(raw, where, MUSIC_LIMITS.playlistChildren, problems);
}

/** `library`: <= 64 segments (ids shared with the event's, each counted as a node); anything else is dropped. */
export function parseMusicLibrary(raw: unknown, where: string, ctx: MusicParseContext): SegmentNode[] {
  const out: SegmentNode[] = [];
  capped(raw, where, MUSIC_LIMITS.library, ctx.problems).forEach((s, i) => {
    const w = `${where}[${i}]`;
    if (isRecord(s) && s.type !== "segment") return void ctx.problems.push(`${w}: a library holds segments; this ${JSON.stringify(s.type)} is dropped.`);
    const seg = parseSegmentNode(s, w, ctx);
    if (seg) out.push(seg);
  });
  return out;
}

/**
 * Checks that need the children: an empty container plays nothing; a musicSwitch child needs a `value` and values are
 * unique; a playlist's `avoidRepeat` is capped at children - 1.
 */
export function finishMusicContainer(node: PlaylistNode | MusicSwitchNode, where: string, problems: string[]): void {
  if (node.children.length === 0) problems.push(`${where}: has no children; it plays nothing.`);
  if (node.type === "playlist") {
    const max = Math.max(0, node.children.length - 1);
    if (node.avoidRepeat > max) {
      if (node.children.length > 0) problems.push(`${where}.avoidRepeat: ${node.avoidRepeat} is outside 0..${max}; using ${max}.`);
      node.avoidRepeat = max;
    }
    return;
  }
  const seen = new Set<string>();
  node.children.forEach((c, i) => {
    if (c.value === undefined) return void problems.push(`${where}.children[${i}]: a musicSwitch child needs a value; it plays only as the default.`);
    if (seen.has(c.value)) problems.push(`${where}.children[${i}].value: another child already has the value "${c.value}"; the first wins.`);
    seen.add(c.value);
  });
}

/** A stand-alone parse of one segment (tests, the editor): fresh ids, path `segment`. */
export function parseMusicSegment(raw: unknown): { value: SegmentNode | null; problems: string[] } {
  const ctx = newMusicContext();
  const value = parseSegmentNode(raw, "segment", ctx);
  return { value, problems: ctx.problems };
}

/** A new segment with one empty-clip-free default: id, default tempo, no cues or regions, the given tracks. */
export function emptySegment(id: string, tracks: MusicTrack[] = []): SegmentNode {
  return {
    type: "segment", id, volume: 1, pitch: 1, pitchRandom: [0, 0], volumeRandom: [0, 0], delay: 0, automation: [], weight: 1, fade: 0,
    gridOffset: 0, tempo: DEFAULT_TEMPO.map((t) => ({ ...t })), cues: [], regions: [], tracks, plays: 1,
  };
}

// --- reading the model ----------------------------------------------------------------------------------------------

/** Where the segment is entered: the entry cue's `at`; else the cue named `entry`; else the grid start, `"1:1:0"`. */
export function segmentEntryPosition(seg: SegmentNode): string {
  const name = seg.entry ?? "entry";
  return seg.cues.find((c) => c.name === name)?.at ?? "1:1:0";
}

/** Where the segment is left: the exit cue's `at`; else the cue named `exit`; else the end, `"end"`. */
export function segmentExitPosition(seg: SegmentNode): string {
  const name = seg.exit ?? "exit";
  return seg.cues.find((c) => c.name === name)?.at ?? "end";
}

/**
 * The clip paths of a music node (each track's clip, then its alternatives), once each, in order (`eventClips`). A
 * container lists its children's clips depth first, then its `library` segments'.
 */
export function musicClips(node: MusicNode): string[] {
  const out = new Set<string>();
  const add = (n: MusicNode): void => {
    if (n.type === "segment") {
      for (const t of n.tracks) {
        if (t.clip) out.add(t.clip);
        for (const a of t.alternatives) if (a) out.add(a);
      }
    } else {
      n.children.forEach(add);
      n.library.forEach(add);
    }
  };
  add(node);
  return [...out];
}

// --- the writer -----------------------------------------------------------------------------------------------------

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function trackToJson(t: MusicTrack): Record<string, unknown> {
  const out: Record<string, unknown> = { name: t.name, clip: t.clip };
  if (t.alternatives.length > 0) out.alternatives = t.alternatives;
  if (t.alternatives.length > 0 || t.pick !== "sequence") out.pick = t.pick;
  if (t.volume !== 1) out.volume = t.volume;
  if (t.bus !== "") out.bus = t.bus;
  if (t.automation.length > 0) out.automation = t.automation.map((a) => ({ parameter: a.parameter, target: a.target, curve: a.curve, ...(a.quantize ? { quantize: a.quantize } : {}) }));
  return out;
}

/**
 * The JSON value of a music node, keys in a stable order (`type`, `id` first) and defaults omitted, so `parse(write(x))`
 * equals `x` and the text is idempotent. The ignored `NodeBase` keys are never written (they would be reported on the
 * next read). `formatAudioEvent` (F1b) routes music nodes through this.
 */
export function musicNodeToJson(node: MusicNode): Record<string, unknown> {
  const out: Record<string, unknown> = { type: node.type, id: node.id };
  if (node.value !== undefined) out.value = node.value;
  if (node.weight !== 1) out.weight = node.weight;
  if (node.plays !== 1) out.plays = node.plays;
  if (node.volume !== 1) out.volume = node.volume;
  if (node.volumeRandom[0] !== 0 || node.volumeRandom[1] !== 0) out.volumeRandom = node.volumeRandom;
  if (node.type === "playlist") {
    if (node.mode !== "sequence") out.mode = node.mode;
    if (node.rounds !== 1) out.rounds = node.rounds;
    if (node.avoidRepeat !== 0) out.avoidRepeat = node.avoidRepeat;
  }
  if (node.type === "musicSwitch") {
    out.parameter = node.parameter;
    if (node.default !== undefined) out.default = node.default;
  }
  if (node.type !== "segment") {
    out.children = node.children.map(musicNodeToJson);
    if (node.library.length > 0) out.library = node.library.map(musicNodeToJson);
    return out;
  }
  if (node.gridOffset !== 0) out.gridOffset = node.gridOffset;
  if (!sameJson(node.tempo, DEFAULT_TEMPO)) out.tempo = node.tempo;
  if (node.cues.length > 0) out.cues = node.cues;
  if (node.entry !== undefined) out.entry = node.entry;
  if (node.exit !== undefined) out.exit = node.exit;
  if (node.regions.length > 0) out.regions = node.regions.map((r) => ({ id: r.id, from: r.from, to: r.to, count: r.count, ...(r.tailBeats !== undefined ? { tailBeats: r.tailBeats } : {}), ...(r.while ? { while: r.while } : {}) }));
  out.tracks = node.tracks.map(trackToJson);
  return out;
}

/** One music node as JSON text, two-space indent, trailing newline (as the editor writes assets). */
export function formatMusicNode(node: MusicNode): string {
  return JSON.stringify(musicNodeToJson(node), null, 2) + "\n";
}
