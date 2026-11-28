/**
 * Samples (ADR 0342): the sidecar's `sample` block and derived samples (`*.sample.json`, `myco.sample@1`), parsed and
 * written; the legacy `loopStart`/`loopEnd` read as one loop; and forks resolved against their parent (follow and pin).
 *
 * The parse is lenient (bad values fall back to defaults with one problem line; nothing throws) and canonical: loops are
 * sorted by start and don't overlap, the trim contains every loop, markers are sorted by time, ids are unique. Writers
 * leave out what equals its default, and parsing what they write gives the same value back.
 *
 * Pure; no plugin, no DOM.
 */
import { colourNoteJson, readColourNote } from "../markColour";
import { deepEqual } from "../deepEqual";
import { parseMeter } from "../meter";
import { effectsToJson, parseEffects } from "../effects/catalogue";
import { curveToJson, IdScope, isFiniteNumber, isRecord, LenientReader, type JsonRecord } from "../lenientRead";
import { loopBehaviourToJson, parseLoopBehaviour } from "../playlist/loopBehaviour";
import { isLineKey } from "../localisation/lines/format";
import { NOTE_NAME_PATTERN } from "./noteNames";
import {
  SAMPLE_FORMAT, SAMPLE_SUFFIX, type DerivedSampleAsset, type LoopDirection, type LoopFileSnapshot, type MarkerFileSnapshot, type MarkerType,
  type SampleAutomation, type SampleEdits, type SampleKind, type SampleLineage, type SampleLoop, type SampleMarker, type SampleNormalize, type SampleRoot,
  type SampleTempo, type TempoMarker, type ValueSource, RESERVED_RANGES, type RangeLook, type ReservedRange, type SampleRanges,
} from "./types";

export const SAMPLE_KINDS: readonly SampleKind[] = ["oneshot", "loop", "sustain", "music"];
export const LOOP_DIRECTIONS: readonly LoopDirection[] = ["forward", "pingPong", "backward"];
export const MARKER_TYPES: readonly MarkerType[] = ["note", "exit", "hit", "cue", "entry"];
export const VALUE_SOURCES: readonly ValueSource[] = ["file", "detected", "set"];
export const NORMALIZE_MODES: readonly SampleNormalize["mode"][] = ["off", "loudness", "peak"];
export const LINEAGE_KINDS: readonly SampleLineage["kind"][] = ["snippet", "fork", "duplicate"];

/** Limits of a sample block, declared once (ADR 0306). */
export const SAMPLE_LIMITS = Object.freeze({
  loops: 64,
  markers: 1024,
  cuts: 1024,
  tempoMarkers: 256,
  /** Loop crossfade, ms. */
  crossfadeMs: 500,
  /** Loop repeat count; 0 = endless. */
  loopCount: 999,
  minBpm: 20,
  maxBpm: 400,
  /** Root note fine tune, cents either way. */
  cents: 50,
  /** Automation lanes of the baked chain. */
  automation: 32,
  /** ADR 0354 §7: lip-sync keys of one file. */
  lipsyncKeys: 20_000,
  /** Characters of a custom viseme name. */
  visemeName: 16,
});

/** ADR 0354 §7: the visemes of the `rhubarb` set (Rhubarb Lip Sync's Preston Blair shapes, X = rest). */
export const RHUBARB_VISEMES: readonly string[] = ["A", "B", "C", "D", "E", "F", "G", "H", "X"];

const FX_TARGET = /^fx:[^:]+:[^:]+$/;

/** Default loop crossfade, ms (the prototype's). */
export const DEFAULT_CROSSFADE_MS = 20;
/** Default normalisation targets: integrated LUFS for loudness, dBFS for peak. */
export const DEFAULT_LOUDNESS_TARGET = -16;
export const DEFAULT_PEAK_TARGET = -1;
/** The name a marker type gets when none is given (exit, hit and entry have fixed names in the Studio). */
export const MARKER_DEFAULT_NAMES: Record<MarkerType, string> = { note: "Marker", exit: "Exit", hit: "Hit point", cue: "cue", entry: "Entry" };

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** True for a derived-sample asset path. */
export const isDerivedSamplePath = (path: string): boolean => path.toLowerCase().endsWith(SAMPLE_SUFFIX);

/** Snap to zero crossings defaults on, except for music (the prototype's rule). */
const defaultSnapToZero = (kind: SampleKind): boolean => kind !== "music";

/** The edits of an untouched sample. */
export function defaultSampleEdits(kind: SampleKind = "oneshot"): SampleEdits {
  return {
    kind, trim: null, loops: [], markers: [], tempo: null, root: null,
    normalize: { mode: "off", target: DEFAULT_LOUDNESS_TARGET, gainDb: 0 },
    effects: [], automation: [], frozen: false, cuts: [], deleted: [], closedGaps: [], stinger: false, snapToZero: defaultSnapToZero(kind),
  };
}

// --- parse -----------------------------------------------------------------------------------------------------------

function parseLoopFile(raw: unknown, where: string, r: LenientReader): LoopFileSnapshot | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    r.problem(where, "must be an object or null; dropped.");
    return null;
  }
  if (raw.chunk !== undefined && raw.chunk !== "smpl") r.problem(`${where}.chunk`, 'must be "smpl"; using "smpl".');
  const start = r.num(raw.start, `${where}.start`, 0, 0);
  return {
    chunk: "smpl",
    index: r.int(raw.index, `${where}.index`, 0, 0),
    start,
    end: r.num(raw.end, `${where}.end`, start, start),
    direction: r.pick(raw.direction, `${where}.direction`, LOOP_DIRECTIONS, "forward"),
    count: r.int(raw.count, `${where}.count`, 0, 0, SAMPLE_LIMITS.loopCount),
  };
}

function parseMarkerFile(raw: unknown, where: string, r: LenientReader): MarkerFileSnapshot | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    r.problem(where, "must be an object or null; dropped.");
    return null;
  }
  const at = r.num(raw.at, `${where}.at`, 0, 0);
  const out: MarkerFileSnapshot = {
    chunk: r.pick(raw.chunk, `${where}.chunk`, ["cue", "ltxt"] as const, "cue"),
    id: r.int(raw.id, `${where}.id`, 0, 0),
    at,
    name: r.str(raw.name, `${where}.name`, ""),
  };
  if (raw.end !== undefined) out.end = r.num(raw.end, `${where}.end`, at, at);
  return out;
}

function parseLoop(raw: unknown, where: string, r: LenientReader, ids: IdScope): SampleLoop | null {
  if (!isRecord(raw)) {
    r.problem(where, "a loop must be an object; dropped.");
    return null;
  }
  let start = r.num(raw.start, `${where}.start`, 0, 0);
  let end = r.num(raw.end, `${where}.end`, start, 0);
  if (end < start) {
    r.problem(where, "end was before start; swapped.");
    [start, end] = [end, start];
  }
  const count = r.int(raw.count, `${where}.count`, 0, 0, SAMPLE_LIMITS.loopCount);
  const loop: SampleLoop = {
    id: ids.take(raw.id, where, "l"),
    start, end,
    direction: r.pick(raw.direction, `${where}.direction`, LOOP_DIRECTIONS, "forward"),
    crossfadeMs: r.num(raw.crossfadeMs, `${where}.crossfadeMs`, DEFAULT_CROSSFADE_MS, 0, SAMPLE_LIMITS.crossfadeMs),
    count,
    ...parseLoopBehaviour(raw, where, r.problems, count > 0 ? "always" : "held"),
    file: parseLoopFile(raw.file, `${where}.file`, r),
  };
  const note = r.optStr(raw.note, `${where}.note`);
  if (note !== undefined && note !== "") loop.note = note;
  return loop;
}

function parseMarker(raw: unknown, where: string, r: LenientReader, ids: IdScope): SampleMarker | null {
  if (!isRecord(raw)) {
    r.problem(where, "a marker must be an object; dropped.");
    return null;
  }
  const type = r.pick(raw.type, `${where}.type`, MARKER_TYPES, "note");
  const at = r.num(raw.at, `${where}.at`, 0, 0);
  const marker: SampleMarker = {
    id: ids.take(raw.id, where, "m"),
    type,
    name: r.str(raw.name, `${where}.name`, MARKER_DEFAULT_NAMES[type]),
    at,
    file: parseMarkerFile(raw.file, `${where}.file`, r),
  };
  if (raw.end !== undefined) {
    if (type !== "note") r.problem(`${where}.end`, "only a note can be a range; dropped.");
    else if (!isFiniteNumber(raw.end) || raw.end < at) r.problem(`${where}.end`, `must be a time at or after ${at}; dropped.`);
    else marker.end = raw.end;
  }
  if (raw.color !== undefined) {
    if (type !== "note") r.problem(`${where}.color`, "only a note has a colour; dropped.");
    else if ((Number.isInteger(raw.color) && (raw.color as number) >= 1 && (raw.color as number) <= 8) || (typeof raw.color === "string" && HEX_COLOUR.test(raw.color))) marker.color = raw.color as number | string;
    else r.problem(`${where}.color`, "must be a series index 1..8 or #rrggbb; dropped.");
  }
  const note = r.optStr(raw.note, `${where}.note`);
  if (note !== undefined && note !== "") marker.note = note;
  return marker;
}

function parseTempo(raw: unknown, where: string, r: LenientReader): SampleTempo | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    r.problem(where, "must be an object or null; dropped.");
    return null;
  }
  const map: TempoMarker[] = [];
  r.list(raw.map, `${where}.map`).forEach((m, i) => {
    const w = `${where}.map[${i}]`;
    if (!isRecord(m)) return void r.problem(w, "a tempo marker must be an object; dropped.");
    if (map.length >= SAMPLE_LIMITS.tempoMarkers) return void r.problem(w, `at most ${SAMPLE_LIMITS.tempoMarkers} tempo markers; dropped.`);
    map.push({ at: r.num(m.at, `${w}.at`, 0, 0), bpm: r.num(m.bpm, `${w}.bpm`, 120, SAMPLE_LIMITS.minBpm, SAMPLE_LIMITS.maxBpm), meter: parseMeter(m.meter, `${w}.meter`, r) });
  });
  if (map.some((m, i) => i > 0 && map[i - 1].at > m.at)) {
    r.problem(`${where}.map`, "tempo markers were not in time order; sorted.");
    map.sort((a, b) => a.at - b.at);
  }
  return {
    bpm: r.num(raw.bpm, `${where}.bpm`, 120, SAMPLE_LIMITS.minBpm, SAMPLE_LIMITS.maxBpm),
    meter: parseMeter(raw.meter, `${where}.meter`, r),
    map,
    source: r.pick(raw.source, `${where}.source`, VALUE_SOURCES, "set"),
  };
}

function parseRoot(raw: unknown, where: string, r: LenientReader): SampleRoot | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    r.problem(where, "must be an object or null; dropped.");
    return null;
  }
  if (typeof raw.note !== "string" || !NOTE_NAME_PATTERN.test(raw.note)) {
    r.problem(`${where}.note`, 'must be a note name like "C4" or "F#3"; root dropped.');
    return null;
  }
  return {
    note: raw.note,
    cents: r.num(raw.cents, `${where}.cents`, 0, -SAMPLE_LIMITS.cents, SAMPLE_LIMITS.cents),
    source: r.pick(raw.source, `${where}.source`, VALUE_SOURCES, "set"),
  };
}

function parseNormalize(raw: unknown, where: string, r: LenientReader): SampleNormalize {
  const out: SampleNormalize = { mode: "off", target: DEFAULT_LOUDNESS_TARGET, gainDb: 0 };
  const o = r.record(raw, where);
  if (!o) return out;
  out.mode = r.pick(o.mode, `${where}.mode`, NORMALIZE_MODES, "off");
  out.target = out.mode === "peak"
    ? r.num(o.target, `${where}.target`, DEFAULT_PEAK_TARGET, -60, 0)
    : r.num(o.target, `${where}.target`, DEFAULT_LOUDNESS_TARGET, -70, 0);
  out.gainDb = r.num(o.gainDb, `${where}.gainDb`, 0, -96, 96);
  return out;
}

/** The baked chain's automation lanes: `fx:<effect id>:<parameter>` targets over sample time (`clipTime`). */
function parseSampleAutomation(raw: unknown, where: string, r: LenientReader): SampleAutomation[] {
  const out: SampleAutomation[] = [];
  const ids = new IdScope(r);
  r.list(raw, where).forEach((a, i) => {
    const w = `${where}[${i}]`;
    if (out.length >= SAMPLE_LIMITS.automation) return void r.problem(w, `at most ${SAMPLE_LIMITS.automation} automation lanes; dropped.`);
    if (!isRecord(a)) return void r.problem(w, "automation must be an object; dropped.");
    if (typeof a.target !== "string" || !FX_TARGET.test(a.target)) return void r.problem(`${w}.target`, "must be fx:<effect id>:<parameter>; dropped.");
    const curve = r.curve(a.curve, `${w}.curve`);
    if (!curve || curve.length === 0) return void r.problem(`${w}.curve`, "needs keys; dropped.");
    if (a.input !== undefined && a.input !== "clipTime") r.problem(`${w}.input`, 'a sample\'s automation reads sample time; using "clipTime".');
    out.push({ id: ids.take(a.id, w, "a"), target: a.target as SampleAutomation["target"], input: "clipTime", curve, bypass: r.bool(a.bypass, `${w}.bypass`, false) });
  });
  return out;
}

/** Sorted, unique times ≥ 0, at most `limit`. */
function parseTimes(raw: unknown, where: string, r: LenientReader, limit: number): number[] {
  const out: number[] = [];
  let dropped = false;
  for (const v of r.list(raw, where)) {
    if (!isFiniteNumber(v) || v < 0) dropped = true;
    else if (!out.includes(v)) out.push(v);
  }
  if (dropped) r.problem(where, "times must be numbers ≥ 0; the others are dropped.");
  if (out.some((v, i) => i > 0 && out[i - 1] > v)) {
    r.problem(where, "times were not in order; sorted.");
    out.sort((a, b) => a - b);
  }
  if (out.length > limit) {
    r.problem(where, `at most ${limit}; the rest are dropped.`);
    out.length = limit;
  }
  return out;
}

/**
 * A sidecar's `sample` block, leniently, into canonical edits. A non-object gives the defaults with a problem. The
 * repairs (each with a problem line): loops sorted by start; a loop overlapping the one before it dropped; a trim that
 * doesn't contain every loop widened to contain them; markers sorted by time; repeated ids replaced.
 */
export function parseSampleEdits(raw: unknown, where: string, problems: string[]): SampleEdits {
  const r = new LenientReader(problems);
  if (!isRecord(raw)) {
    r.problem(where, "must be an object; using the defaults.");
    return defaultSampleEdits();
  }
  const kind = r.pick(raw.kind, `${where}.kind`, SAMPLE_KINDS, "oneshot");
  const out = defaultSampleEdits(kind);

  if (raw.trim !== undefined && raw.trim !== null) {
    const t = raw.trim;
    if (!Array.isArray(t) || t.length !== 2 || !isFiniteNumber(t[0]) || !isFiniteNumber(t[1]) || t[0] < 0 || t[1] <= t[0]) {
      r.problem(`${where}.trim`, "must be [start, end] seconds with 0 ≤ start < end, or null; using the whole file.");
    } else out.trim = [t[0], t[1]];
  }

  const loopIds = new IdScope(r);
  const loops: SampleLoop[] = [];
  r.list(raw.loops, `${where}.loops`).forEach((l, i) => {
    const w = `${where}.loops[${i}]`;
    if (loops.length >= SAMPLE_LIMITS.loops) return void r.problem(w, `at most ${SAMPLE_LIMITS.loops} loops; dropped.`);
    const loop = parseLoop(l, w, r, loopIds);
    if (loop) loops.push(loop);
  });
  if (loops.some((l, i) => i > 0 && loops[i - 1].start > l.start)) {
    r.problem(`${where}.loops`, "loops were not in time order; sorted.");
    loops.sort((a, b) => a.start - b.start);
  }
  for (const loop of loops) {
    const prev = out.loops[out.loops.length - 1];
    // Touching is fine (a loop may start where the last ended); a hold point inside a loop overlaps it.
    if (prev && loop.start < prev.end) {
      r.problem(`${where}.loops`, `loop "${loop.id}" (${loop.start}..${loop.end}) overlaps loop "${prev.id}" (${prev.start}..${prev.end}); dropped.`);
      continue;
    }
    out.loops.push(loop);
  }
  if (out.trim && out.loops.length > 0) {
    const lo = Math.min(out.trim[0], out.loops[0].start);
    const hi = Math.max(out.trim[1], ...out.loops.map((l) => l.end));
    if (lo !== out.trim[0] || hi !== out.trim[1]) {
      r.problem(`${where}.trim`, `must contain every loop; widened to [${lo}, ${hi}].`);
      out.trim = [lo, hi];
    }
  }

  const markerIds = new IdScope(r);
  r.list(raw.markers, `${where}.markers`).forEach((m, i) => {
    const w = `${where}.markers[${i}]`;
    if (out.markers.length >= SAMPLE_LIMITS.markers) return void r.problem(w, `at most ${SAMPLE_LIMITS.markers} markers; dropped.`);
    const marker = parseMarker(m, w, r, markerIds);
    if (marker) out.markers.push(marker);
  });
  if (out.markers.some((m, i) => i > 0 && out.markers[i - 1].at > m.at)) {
    r.problem(`${where}.markers`, "markers were not in time order; sorted.");
    out.markers.sort((a, b) => a.at - b.at);
  }

  out.tempo = parseTempo(raw.tempo, `${where}.tempo`, r);
  out.root = parseRoot(raw.root, `${where}.root`, r);
  out.normalize = parseNormalize(raw.normalize, `${where}.normalize`, r);
  out.effects = parseEffects(raw.effects, "sample", `${where}.effects`, problems);
  out.automation = parseSampleAutomation(raw.automation, `${where}.automation`, r);
  out.frozen =r.bool(raw.frozen, `${where}.frozen`, false);
  out.cuts = parseTimes(raw.cuts, `${where}.cuts`, r, SAMPLE_LIMITS.cuts);
  out.deleted = parseTimes(raw.deleted, `${where}.deleted`, r, SAMPLE_LIMITS.cuts);
  r.list(raw.closedGaps, `${where}.closedGaps`).forEach((g, i) => {
    if (Array.isArray(g) && g.length === 2 && isFiniteNumber(g[0]) && isFiniteNumber(g[1]) && g[0] >= 0 && g[1] > 0) out.closedGaps.push([g[0], g[1]]);
    else r.problem(`${where}.closedGaps[${i}]`, "must be [sourceStart, length] with start ≥ 0 and length > 0; dropped.");
  });
  out.stinger = r.bool(raw.stinger, `${where}.stinger`, false);
  out.snapToZero = r.bool(raw.snapToZero, `${where}.snapToZero`, defaultSnapToZero(kind));
  const source = r.optStr(raw.source, `${where}.source`);
  if (source) out.source = source;
  if (raw.sourceVersion !== undefined) {
    if (Number.isInteger(raw.sourceVersion) && (raw.sourceVersion as number) >= 1) out.sourceVersion = raw.sourceVersion as number;
    else r.problem(`${where}.sourceVersion`, "must be a version number ≥ 1; dropped.");
  }
  const lipsync = parseLipsync(raw.lipsync, `${where}.lipsync`, r);
  if (lipsync) out.lipsync = lipsync;
  if (raw.vo !== undefined && raw.vo !== null) {
    const vo = raw.vo;
    if (isRecord(vo) && isLineKey(vo.key) && typeof vo.textHash === "string" && /^[0-9a-f]{16}$/.test(vo.textHash)) {
      out.vo = { key: vo.key, textHash: vo.textHash };
    } else r.problem(`${where}.vo`, "must be { key, textHash } with a line key and 16 hex digits; dropped.");
  }
  const ranges = parseRanges(raw.ranges, `${where}.ranges`, r, problems);
  if (ranges) out.ranges = ranges;
  return out;
}

/** ADR 0362 item 4: `ranges`, `{ trim?, pickup?, tail? }` each `{ colour?, note? }`; empty ones are left out. */
function parseRanges(raw: unknown, where: string, r: LenientReader, problems: string[]): SampleRanges | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    r.problem(where, "must be an object; dropped.");
    return null;
  }
  const out: SampleRanges = {};
  for (const [key, value] of Object.entries(raw)) {
    const w = `${where}.${key}`;
    if (!(RESERVED_RANGES as readonly string[]).includes(key)) { r.problem(w, "not a reserved range (trim, pickup or tail); dropped."); continue; }
    if (!isRecord(value)) { r.problem(w, "must be { colour, note }; dropped."); continue; }
    const look: RangeLook = {};
    readColourNote(value, w, look, problems);
    if (look.colour || look.note) out[key as ReservedRange] = look;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * ADR 0354 §7: a `lipsync` block, `{ set, keys: [[seconds, viseme], …] }`. Keys with a bad time or viseme are dropped,
 * keys out of time order sorted, a key at the same time as the one before it dropped, each with a problem; null when
 * absent or nothing is left.
 */
function parseLipsync(raw: unknown, where: string, r: LenientReader): SampleEdits["lipsync"] | null {
  const o = r.record(raw, where);
  if (!o) return null;
  const set = r.pick(o.set, `${where}.set`, ["rhubarb", "custom"] as const, "rhubarb");
  const keys: [number, string][] = [];
  let over = false;
  r.list(o.keys, `${where}.keys`).forEach((k, i) => {
    const w = `${where}.keys[${i}]`;
    if (keys.length >= SAMPLE_LIMITS.lipsyncKeys) {
      if (!over) r.problem(w, `at most ${SAMPLE_LIMITS.lipsyncKeys} keys; the rest are dropped.`);
      over = true;
      return;
    }
    if (!Array.isArray(k) || k.length !== 2 || !isFiniteNumber(k[0]) || k[0] < 0 || typeof k[1] !== "string") return void r.problem(w, "must be [seconds ≥ 0, viseme]; dropped.");
    const v = k[1];
    const ok = set === "rhubarb" ? RHUBARB_VISEMES.includes(v) : v !== "" && v.length <= SAMPLE_LIMITS.visemeName;
    if (!ok) return void r.problem(w, set === "rhubarb" ? `"${v}" isn't a Rhubarb viseme (A–H, X); dropped.` : `"${v}" must be 1..${SAMPLE_LIMITS.visemeName} characters; dropped.`);
    keys.push([k[0], v]);
  });
  if (keys.some((k, i) => i > 0 && keys[i - 1][0] > k[0])) {
    r.problem(`${where}.keys`, "keys were not in time order; sorted.");
    keys.sort((a, b) => a[0] - b[0]);
  }
  const unique = keys.filter((k, i) => i === 0 || keys[i - 1][0] !== k[0]);
  if (unique.length < keys.length) r.problem(`${where}.keys`, "keys at the same time as the one before them were dropped.");
  if (unique.length === 0) {
    r.problem(where, "has no keys; dropped.");
    return null;
  }
  return { set, keys: unique };
}

/**
 * The edits a sidecar gives a sample: its `sample` block when it has one, else the legacy `loopStart`/`loopEnd` as one
 * loop (both must be set; a loop with one end from the file can't be expressed without reading the file), else the
 * defaults.
 */
export function sampleEditsFromSidecar(sidecar: { sample: SampleEdits | null; loopStart: number | null; loopEnd: number | null }): SampleEdits {
  if (sidecar.sample) return sidecar.sample;
  const out = defaultSampleEdits();
  if (sidecar.loopStart !== null && sidecar.loopEnd !== null && sidecar.loopEnd > sidecar.loopStart) {
    out.kind = "loop";
    out.loops.push({
      id: "l1", start: sidecar.loopStart, end: sidecar.loopEnd, direction: "forward", crossfadeMs: 0, count: 0,
      active: "always", exit: "finish", exitFadeMs: 40, reentry: "ignore", file: null,
    });
  }
  return out;
}

// --- write -----------------------------------------------------------------------------------------------------------

function loopToJson(l: SampleLoop): JsonRecord {
  const out: JsonRecord = { id: l.id, start: l.start, end: l.end, direction: l.direction, crossfadeMs: l.crossfadeMs, count: l.count, ...loopBehaviourToJson(l) };
  if (l.note !== undefined) out.note = l.note;
  out.file = l.file ? { ...l.file } : null;
  return out;
}

function markerToJson(m: SampleMarker): JsonRecord {
  const out: JsonRecord = { id: m.id, type: m.type, name: m.name, at: m.at };
  if (m.end !== undefined) out.end = m.end;
  if (m.color !== undefined) out.color = m.color;
  if (m.note !== undefined) out.note = m.note;
  out.file = m.file ? { ...m.file } : null;
  return out;
}

/** The `sample` block as JSON: fields in the ADR 0342 order, those equal to their defaults left out. */
export function sampleEditsToJson(e: SampleEdits): JsonRecord {
  const out: JsonRecord = {};
  if (e.kind !== "oneshot") out.kind = e.kind;
  if (e.trim) out.trim = [e.trim[0], e.trim[1]];
  if (e.loops.length) out.loops = e.loops.map(loopToJson);
  if (e.markers.length) out.markers = e.markers.map(markerToJson);
  if (e.tempo) out.tempo = { bpm: e.tempo.bpm, meter: e.tempo.meter, map: e.tempo.map.map((m) => ({ ...m })), source: e.tempo.source };
  if (e.root) out.root = { ...e.root };
  const n = e.normalize;
  if (n.mode !== "off" || n.target !== DEFAULT_LOUDNESS_TARGET || n.gainDb !== 0) out.normalize = { mode: n.mode, target: n.target, gainDb: n.gainDb };
  if (e.effects.length) out.effects = effectsToJson(e.effects);
  if (e.automation.length) {
    out.automation = e.automation.map((a) => {
      const json: JsonRecord = { id: a.id, target: a.target, input: a.input, curve: curveToJson(a.curve) };
      if (a.bypass) json.bypass = true;
      return json;
    });
  }
  if (e.frozen) out.frozen = true;
  if (e.cuts.length) out.cuts = [...e.cuts];
  if (e.deleted.length) out.deleted = [...e.deleted];
  if (e.closedGaps.length) out.closedGaps = e.closedGaps.map((g) => [g[0], g[1]]);
  if (e.stinger) out.stinger = true;
  if (e.snapToZero !== defaultSnapToZero(e.kind)) out.snapToZero = e.snapToZero;
  if (e.source !== undefined) out.source = e.source;
  if (e.sourceVersion !== undefined) out.sourceVersion = e.sourceVersion;
  if (e.lipsync) out.lipsync = { set: e.lipsync.set, keys: e.lipsync.keys.map((k) => [k[0], k[1]]) };
  if (e.vo) out.vo = { key: e.vo.key, textHash: e.vo.textHash };
  if (e.ranges) {
    const ranges: JsonRecord = {};
    for (const k of RESERVED_RANGES) {
      const look = e.ranges[k];
      if (look && (look.colour || look.note)) ranges[k] = colourNoteJson(look);
    }
    if (Object.keys(ranges).length) out.ranges = ranges;
  }
  return out;
}

// --- derived samples -------------------------------------------------------------------------------------------------

function parseLineage(raw: unknown, where: string, r: LenientReader, source: string): SampleLineage {
  const o = r.record(raw, where);
  if (!o) {
    if (raw === undefined) r.problem(where, "missing; reading it as a duplicate of its source.");
    return { kind: "duplicate", parent: source, mode: "pin" };
  }
  const kind = r.pick(o.kind, `${where}.kind`, LINEAGE_KINDS, "duplicate");
  const out: SampleLineage = {
    kind,
    parent: r.str(o.parent, `${where}.parent`, source) || source,
    mode: r.pick(o.mode, `${where}.mode`, ["follow", "pin"] as const, kind === "fork" ? "follow" : "pin"),
  };
  if (o.baseline !== undefined) out.baseline = parseSampleEdits(o.baseline, `${where}.baseline`, r.problems);
  const hash = r.optStr(o.pinnedHash, `${where}.pinnedHash`);
  if (hash) out.pinnedHash = hash;
  if (kind === "fork" && out.mode === "follow" && !out.baseline) r.problem(where, "a following fork needs a baseline; its own edits are used for every field.");
  return out;
}

/** `*.sample.json`, leniently. A wrong or missing `format` is a problem but the rest is still read. */
export function parseDerivedSample(raw: unknown, path = "sample"): { sample: DerivedSampleAsset; problems: string[] } {
  const problems: string[] = [];
  const r = new LenientReader(problems);
  const o: JsonRecord = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) r.problem(path, "a derived sample must be a JSON object.");
  else if (raw.format !== SAMPLE_FORMAT) r.problem(path, `format: expected "${SAMPLE_FORMAT}"${raw.format === undefined ? "" : `, found ${JSON.stringify(raw.format)}`}; reading it anyway.`);
  const source = r.str(o.source, `${path}.source`, "");
  if (source === "") r.problem(`${path}.source`, "names no audio file; it plays nothing.");
  let range: [number, number] | null = null;
  if (o.range !== undefined && o.range !== null) {
    const g = o.range;
    if (Array.isArray(g) && g.length === 2 && isFiniteNumber(g[0]) && isFiniteNumber(g[1]) && g[0] >= 0 && g[1] > g[0]) range = [g[0], g[1]];
    else r.problem(`${path}.range`, "must be [start, end] seconds with 0 ≤ start < end, or null; using the whole source.");
  }
  const lineage = parseLineage(o.lineage, `${path}.lineage`, r, source);
  if (lineage.kind === "snippet" && !range) r.problem(`${path}.range`, "a snippet needs a range; it plays the whole source.");
  const sample = o.sample === undefined ? defaultSampleEdits() : parseSampleEdits(o.sample, `${path}.sample`, problems);
  return { sample: { format: SAMPLE_FORMAT, source, range, lineage, sample }, problems };
}

/** `*.sample.json` content, in the ADR 0342 order. */
export function derivedSampleToJson(a: DerivedSampleAsset): JsonRecord {
  const lineage: JsonRecord = { kind: a.lineage.kind, parent: a.lineage.parent, mode: a.lineage.mode };
  if (a.lineage.baseline) lineage.baseline = sampleEditsToJson(a.lineage.baseline);
  if (a.lineage.pinnedHash) lineage.pinnedHash = a.lineage.pinnedHash;
  return { format: SAMPLE_FORMAT, source: a.source, range: a.range ? [a.range[0], a.range[1]] : null, lineage, sample: sampleEditsToJson(a.sample) };
}

// --- forks -----------------------------------------------------------------------------------------------------------


const EDIT_FIELDS = ["kind", "trim", "loops", "markers", "tempo", "root", "normalize", "effects", "automation", "frozen", "cuts", "deleted", "closedGaps", "stinger", "snapToZero", "source", "sourceVersion", "lipsync", "vo", "ranges"] as const satisfies readonly (keyof SampleEdits)[];

/**
 * The edits a derived sample plays with. A following fork reads each top-level field that still equals its `baseline`
 * live from the parent (`parentEdits`), and keeps its own value for a field it changed. A pinned fork, a snippet and a
 * duplicate play their own block (a pin's block is the parent's resolved block frozen at pin time).
 */
export function resolveSampleEdits(derived: DerivedSampleAsset, parentEdits: SampleEdits): SampleEdits {
  const { lineage, sample } = derived;
  if (lineage.kind !== "fork" || lineage.mode !== "follow" || !lineage.baseline) return sample;
  const baseline = lineage.baseline;
  const out = { ...sample } as Record<string, unknown>;
  for (const f of EDIT_FIELDS) {
    if (deepEqual(sample[f], baseline[f])) {
      if (parentEdits[f] === undefined) delete out[f];
      else out[f] = parentEdits[f];
    }
  }
  return out as unknown as SampleEdits;
}

/** FNV-1a over a string's UTF-16 units, 32 bits, from `seed`. */
function fnv1a(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A stable hash of a resolved sample block (64 bits as 16 hex digits, from its canonical JSON): a pinned fork stores it
 * at pin time, and "parent changed" compares it with the parent's current one. Equal edits hash equal whatever their
 * key order in the file.
 */
export function sampleEditsHash(edits: SampleEdits): string {
  const text = JSON.stringify(sampleEditsToJson(edits));
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return hex(fnv1a(text, 0x811c9dc5)) + hex(fnv1a(text, 0x050c5d1f));
}

/** True when a pinned fork's parent changed since the pin (no stored hash counts as unchanged). */
export function parentChangedSincePin(derived: DerivedSampleAsset, parentEdits: SampleEdits): boolean {
  const { lineage } = derived;
  if (lineage.kind !== "fork" || lineage.mode !== "pin" || !lineage.pinnedHash) return false;
  return lineage.pinnedHash !== sampleEditsHash(parentEdits);
}

/**
 * A fork of `parent` (an audio file or a derived sample) playing `source`, from the parent's resolved edits: following
 * (keeps them as the baseline) or pinned (keeps their hash).
 */
export function forkSample(parent: string, source: string, parentEdits: SampleEdits, mode: "follow" | "pin"): DerivedSampleAsset {
  const copy = parseSampleEdits(sampleEditsToJson(parentEdits), "fork", []);
  const lineage: SampleLineage = mode === "follow"
    ? { kind: "fork", parent, mode, baseline: parseSampleEdits(sampleEditsToJson(parentEdits), "baseline", []) }
    : { kind: "fork", parent, mode, pinnedHash: sampleEditsHash(parentEdits) };
  return { format: SAMPLE_FORMAT, source, range: null, lineage, sample: copy };
}
