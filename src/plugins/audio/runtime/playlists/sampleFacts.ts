/**
 * What the playlist runtime reads of a sample's edits (ADR 0342: its sidecar's, or a derived sample's resolved block,
 * `sampleEdits`) beyond the clip resolver's plan
 * (`samplePlan`): its loops with their ids (clip overrides name them), its markers (Cue, Exit, Hit), its playable end and
 * its musical grid (`sample.tempo`, tempo map included) compiled with the music grid maths (`engine/audio/musicGrid.ts`),
 * so a sample's beats and bars are the same numbers a music segment's are.
 *
 * Cached per parsed sidecar block (a sidecar edit is a new object, so an edit is picked up) and per known file length.
 */
import { compileTempoMap, type SegmentGrid } from "../../../../engine/audio/musicGrid";
import type { TempoMarker as GridTempoMarker } from "../../../../engine/audio/musicGrid";
import { meterParts } from "../../../../engine/audio/meter";
import { MUSIC_TICKS_PER_BEAT } from "../../../../engine/audio/musicPosition";
import type { SampleEdits, SampleLoop, SampleMarker, SampleTempo } from "../../../../engine/audio/sample/types";
import type { LoopBehaviour } from "../../../../engine/audio/playlist/types";
import { sampleEdits } from "../clipResolver";
import { warnOnce } from "../core/handle";
import { playlistHost } from "./host";

/** A sample loop as a playing voice uses it: its region (seconds in the file) and behaviour. `start == end`: a hold point. */
export interface FactLoop {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly behaviour: LoopBehaviour;
}

/** One marker a playlist reports (`AudioPlaylistHandle.onMarker`) or waits for (Exit, Hit). Notes are left out. */
export interface FactMarker {
  readonly id: string;
  readonly type: "cue" | "exit" | "hit";
  readonly name: string;
  readonly at: number;
}

export interface SampleFacts {
  readonly path: string;
  /** Where the playable region starts (the trim's start, else 0). */
  readonly from: number;
  /** Where it ends (the trim's end, else the file's length); null while the file's length is unknown. */
  readonly end: number | null;
  /** Loops in file order (the first is the one clips map passes of). */
  readonly loops: readonly FactLoop[];
  readonly markers: readonly FactMarker[];
  /** ADR 0350 pre-entry: the first Entry marker's time (file seconds), null without one. Not reported to the game. */
  readonly entry: number | null;
  /** The sample's musical grid (file seconds, bar 1 beat 1 at the file's start), null without a tempo. */
  readonly grid: SegmentGrid | null;
}

const cache = new WeakMap<SampleEdits, { length: number | null; facts: SampleFacts }>();
const none = new Map<string, { length: number | null; facts: SampleFacts }>();

/** `path`'s facts now. */
export function sampleFacts(path: string): SampleFacts {
  let edits: SampleEdits | null = null;
  try { edits = sampleEdits(path); } catch { edits = null; }
  const length = playlistHost().clipLength(path);
  const hit = edits ? cache.get(edits) : none.get(path);
  if (hit && hit.length === length) return hit.facts;
  const facts = compile(path, edits, length);
  if (edits) cache.set(edits, { length, facts });
  else none.set(path, { length, facts });
  return facts;
}

function compile(path: string, edits: SampleEdits | null, length: number | null): SampleFacts {
  const trim = edits?.trim ?? null;
  const from = trim ? trim[0] : 0;
  const end = trim ? (length !== null ? Math.min(trim[1], length) : trim[1]) : length;
  const loops: FactLoop[] = (edits?.loops ?? []).filter((l) => l.end >= l.start).map(toLoop);
  const markers: FactMarker[] = [];
  let entry: number | null = null;
  for (const m of edits?.markers ?? []) {
    if (m.type === "entry") entry = entry === null ? m.at : Math.min(entry, m.at);
    else if (m.type !== "note") markers.push(toMarker(m));
  }
  markers.sort((a, b) => a.at - b.at);
  const endSeconds = end ?? undefined;
  const grid = edits?.tempo ? tempoGrid(edits.tempo, endSeconds, path) : null;
  return { path, from, end, loops, markers, entry, grid };
}

const toLoop = (l: SampleLoop): FactLoop => ({
  id: l.id, start: l.start, end: l.end,
  behaviour: { active: l.active, exit: l.exit, exitFadeMs: l.exitFadeMs, reentry: l.reentry, ...(l.binding ? { binding: l.binding } : {}) },
});

const toMarker = (m: SampleMarker): FactMarker => ({ id: m.id, type: m.type as FactMarker["type"], name: m.name, at: m.at });

/**
 * A tempo `{ bpm, meter }` and its changes at file seconds as a music grid: each change lands on the beat nearest its
 * time (a tempo marker sits on a beat; one that doesn't is moved with one warning), a metre change on the next bar line.
 */
export function tempoGrid(tempo: Pick<SampleTempo, "bpm" | "meter"> & { map?: SampleTempo["map"] }, endSeconds: number | undefined, where: string): SegmentGrid {
  const { beatsPerBar: bpb0, beatUnit: unit0 } = meterParts(tempo.meter);
  const markers: GridTempoMarker[] = [{ at: "1:1:0", bpm: tempo.bpm, beatsPerBar: bpb0, beatUnit: unit0 }];
  let prevSec = 0, prevBpm = tempo.bpm, bar = 1, beat = 1, bpb = bpb0;
  for (const m of tempo.map ?? []) {
    const { beatsPerBar: mb, beatUnit: mu } = meterParts(m.meter);
    if (!(m.at > 0)) {
      // A change at the start replaces the base tempo.
      markers[0] = { at: "1:1:0", bpm: m.bpm, beatsPerBar: mb, beatUnit: mu };
      prevBpm = m.bpm; bpb = mb;
      continue;
    }
    const exact = ((m.at - prevSec) * prevBpm) / 60;
    let beats = Math.round(exact);
    if (Math.abs(exact - beats) > 1e-3) warnOnce(`sample:tempo:${where}:${m.at}`, `[myco] ${where}: the tempo change at ${m.at}s isn't on a beat; it is moved to the nearest one.`);
    if (beats < 1) continue;
    // Walk the beats in the current metre.
    let b = beat - 1 + beats;
    bar += Math.floor(b / bpb);
    beat = (b % bpb) + 1;
    const meterChanges = mb !== bpb || mu !== markers[markers.length - 1]!.beatUnit;
    if (meterChanges && beat !== 1) {
      // A metre change sits on beat 1: on to the next bar line.
      beats += bpb - (beat - 1);
      b = 0;
      bar += 1;
      beat = 1;
    }
    prevSec += (beats * 60) / prevBpm;
    prevBpm = m.bpm;
    bpb = mb;
    markers.push({ at: `${bar}:${beat}:0`, bpm: m.bpm, beatsPerBar: mb, beatUnit: mu });
  }
  const problems: string[] = [];
  const map = compileTempoMap(markers, 0, problems);
  for (const p of problems) warnOnce(`sample:tempo:${where}:${p}`, `[myco] ${where}: tempo ${p}`);
  return Object.assign(map, {
    cueNames: [] as string[], cueTicks: new Float64Array(0), endSeconds: endSeconds ?? Number.NaN,
    entryTicks: 0, exitTicks: Number.NaN,
  });
}

/** Seconds per beat at file seconds `s` of `grid`. */
export function secondsPerBeatAt(grid: SegmentGrid, s: number): number {
  let i = 0;
  for (let k = 1; k < grid.count; k++) if (grid.startSeconds[k]! <= s) i = k;
  return MUSIC_TICKS_PER_BEAT / grid.ticksPerSecond[i]!;
}
