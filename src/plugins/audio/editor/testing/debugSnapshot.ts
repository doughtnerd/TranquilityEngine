// Test support for the Audio Debug monitor (ADR 0220): typed `Audio.debug()` snapshots for its tests to feed it, so they
// build `AudioDebugSnapshot`s without casts. Only tests and stories import this (ADR 0219 counts stories as tests).
import type { AudioDebugInfo, MusicDebugRow, MusicDebugTotals } from "../../runtime/backend";
import { zeroCounters } from "../../runtime/debugTypes";
import { AudioDebugMonitor, type AudioDebugSnapshot, type AudioDebugView, type Row, type Section } from "../audioDebugMonitor";

type Voice = AudioDebugInfo["voices"][number];
type EventRow = NonNullable<AudioDebugSnapshot["events"]>[number];

/** A running core at 48 kHz with nothing playing, at audio time `time`; `over` replaces fields, `counters` merges. */
export function snapshot(over: Omit<Partial<AudioDebugSnapshot>, "counters"> & { counters?: Partial<AudioDebugInfo["counters"]> } = {}): AudioDebugSnapshot {
  const { counters, ...rest } = over;
  return { status: "running", sampleRate: 48_000, time: 0, background: "pause", buses: [], voices: [], core: {}, ...rest, counters: { ...zeroCounters(), ...counters } };
}

/** A playing voice; `over` replaces fields. */
export const voice = (id: number, over: Partial<Voice> = {}): Voice => ({
  id, clip: `c${id}`, bus: "SFX", world: null, state: "playing", priority: 128, gain: 1, pitch: 1, audibility: 1, playheadSeconds: null, owner: null, ...over,
});

/** An event instance row as `Audio.debug().events` lists it. */
export const eventRow = (id: number, over: Partial<EventRow> = {}): EventRow => ({ id, asset: `e${id}.audioevent.json`, world: 0, voices: 1, parameters: {}, lateStarts: 0, ...over });

/** A playing music instance row; `over` replaces fields. */
export const musicRow = (over: Partial<MusicDebugRow> = {}): MusicDebugRow => ({
  id: 1, asset: "music/town.event.json", state: "playing", segment: "verse", pass: 1, bar: 1, beat: 1, tick: 0, tempo: 120, beatsPerBar: 4, time: 0,
  pending: null, groups: [], stems: [], primeLastMs: 0, primeEmaMs: 0, leadMs: 0, replans: {}, refusals: {}, lateGroups: 0, groupsHeld: 0, groupTimeouts: 0,
  lastSlipFrames: 0, recoveries: {}, missedBeats: 0, stingers: { played: 0, late: 0, skipped: 0, dropped: 0 }, ...over,
});

/** Engine-wide music totals at zero with an eight-ring pool; `over` replaces fields. */
export const musicTotals = (over: Partial<MusicDebugTotals> = {}): MusicDebugTotals => ({
  poolUsed: 0, poolSize: 8, poolHighWater: 0, musicRingRefused: 0, streamStartsLate: 0, groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0, maxSlipFrames: 0,
  splitQuanta: 0, voiceSplits: 0, curvePoolFull: 0, groupTableFull: 0, encodedOverBudget: 0, replans: {}, refusals: {}, recoveries: {},
  stingers: { played: 0, late: 0, skipped: 0, dropped: 0 }, ...over,
});

/** A fresh monitor fed `samples` in order, and its view of the last. */
export function viewAfter(...samples: AudioDebugSnapshot[]): AudioDebugView {
  const m = new AudioDebugMonitor();
  for (const s of samples) m.observe(s);
  return m.view()!;
}

/** The section with `id`; fails the test when it is missing. */
export function sectionOf(view: AudioDebugView, id: Section["id"]): Section {
  const s = view.sections.find((x) => x.id === id);
  if (!s) throw new Error(`no section ${id}`);
  return s;
}

/** The row with `id` in a list of rows; fails the test when it is missing. */
export function rowOf(rows: readonly Row[], id: string): Row {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

/** The value cell (text, tip, health) of a label/value row in a section. */
export const valueOf = (view: AudioDebugView, section: Section["id"], row: string) => rowOf(sectionOf(view, section).rows, row).cells[1]!;
