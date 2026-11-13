// ADR 0171 amended by 0172 (M5a, task Pf2; api-and-models §5.5, §5.6, §7 `voiceTableModel.ts`): the profiler's voice
// table at the cursor, a pure model. `reconstructVoices` takes `ProfileSource.seek`'s answer (the keyframe at or before
// t and the EVENT records after it, `reader.ts`) and replays the voice events over the keyframe's rows; the reason text
// and the thief of a steal come from the events (§5.6). `voiceTable` filters by name and caps the rows rendered at
// `MAX_VOICE_ROWS` while counting the rest. The same replay gives the event instances (`eventRows`).
//
// What a replay can know. A row born from a keyframe has every field. A row born from a voiceStart event after it has
// what the event carries (clip, bus, gain); its priority, pitch and audibility are null until the next keyframe, and its
// playhead is the STATUS's (the last STATUS at or before t carries up to 256 round-robin playheads). A seek with no
// keyframe at or before t (`fromKeyframe` false) replays only the last second's events, so voices started earlier are
// missing and the view says so. A voice that stopped is gone from the table (voiceStop is the free).
import { EventKind, type KeyframeVoice } from "../../runtime/capture/format";
import type { CaptureOpenSummary, CaptureSeekState } from "../../runtime/capture/reader";

/** The most voice rows rendered (as the live debug table); the rest are counted. */
export const MAX_VOICE_ROWS = 64;

/** The `state` byte of a keyframe voice (§5.5). */
export const VoiceStateName = ["playing", "virtual", "stolen", "waitingForData", "busMuted", "locked"] as const;
export type VoiceStateText = (typeof VoiceStateName)[number];
const STATE_PLAYING = 0;
const STATE_VIRTUAL = 1;
const STATE_STOLEN = 2;

/** Names by id, from META and every NAMES record (`CaptureOpenSummary.names`). */
export interface NameLookup {
  clip(id: number): string | undefined;
  /** By bus slot. */
  bus(slot: number): string | undefined;
  event(id: number): string | undefined;
}

export function nameLookup(names: CaptureOpenSummary["names"]): NameLookup {
  const clips = new Map(names.clips);
  const buses = new Map(names.buses);
  const events = new Map(names.events);
  return { clip: (id) => clips.get(id), bus: (slot) => buses.get(slot), event: (id) => events.get(id) };
}

/** One voice at the cursor. */
export interface VoiceRow {
  id: number;
  clip: number;
  clipName: string;
  /** The bus's slot (`busRef & 0xff`; a keyframe row has the slot only). */
  slot: number;
  busName: string;
  /** 0 playing, 1 virtual, 2 stolen, 3 waitingForData, 4 busMuted, 5 locked. */
  state: number;
  stateName: VoiceStateText;
  /** Null for a voice born from an event after the keyframe. */
  priority: number | null;
  /** §5.6's reason code for the state (0 none). */
  reason: number;
  reasonText: string;
  gain: number;
  /** Playback rate; null as for `priority`. */
  pitch: number | null;
  /** 0..1; null as for `priority`. */
  audibility: number | null;
  playheadFrames: number;
  /** The voice that stole this one, when the steal event is in the replayed span. */
  thief: number | null;
  /** Whether this row came from the keyframe (every field recorded) or from a voiceStart after it. */
  fromKeyframe: boolean;
}

/** §5.6's reason texts for the state a row is in. */
export function reasonText(state: number, reason: number): string {
  if (reason === 0) return "";
  const table: readonly (string | undefined)[] =
    state === STATE_STOLEN ? [undefined, "bus max voices", "global limit", "priority"]
    : state === STATE_VIRTUAL ? [undefined, "demoted by the cap", "below audibility", "paused", "world inaudible"]
    : state === STATE_PLAYING ? [undefined, "promoted", "cap raised"]
    : state === 3 ? [undefined, "clip loading", "stream priming"]
    : [];
  return table[reason] ?? `reason ${reason}`;
}

/** The ending reasons of a voiceStop (§5.6); the row is gone then, so this serves the event lists. */
export function stopReasonText(reason: number): string {
  return [undefined, "ended", "stopped", "faded", "world released", "failed"][reason] ?? (reason === 0 ? "" : `reason ${reason}`);
}

function labelClip(names: NameLookup, id: number): string {
  return names.clip(id) ?? `clip ${id}`;
}
function labelBus(names: NameLookup, slot: number): string {
  return names.bus(slot) ?? `bus ${slot}`;
}

function makeRow(names: NameLookup, v: { id: number; clip: number; slot: number; state: number; priority: number | null; reason: number; gain: number; pitch: number | null; audibility: number | null; playheadFrames: number; thief: number | null; fromKeyframe: boolean }): VoiceRow {
  return {
    ...v,
    clipName: labelClip(names, v.clip),
    busName: labelBus(names, v.slot),
    stateName: VoiceStateName[v.state] ?? VoiceStateName[STATE_PLAYING],
    reasonText: reasonText(v.state, v.reason),
  };
}

function fromKeyframeVoice(names: NameLookup, v: KeyframeVoice): VoiceRow {
  return makeRow(names, {
    id: v.id, clip: v.clip, slot: v.slot, state: v.state, priority: v.priority, reason: v.reason, gain: v.gain,
    pitch: v.pitch / 4096, audibility: v.audibility / 65536, playheadFrames: v.playheadFrames, thief: null, fromKeyframe: true,
  });
}

/** Rewrites a row's state and reason (and its derived texts), keeping everything else. */
function withState(names: NameLookup, r: VoiceRow, state: number, reason: number, thief: number | null): VoiceRow {
  return makeRow(names, { ...r, state, reason, thief });
}

/** What `reconstructVoices` returns: every voice at the cursor (unfiltered, uncapped), in the keyframe's order then birth order. */
export interface VoiceReplay {
  rows: VoiceRow[];
  /** A keyframe was the base: the table is complete. Otherwise only the last second's starts are in it. */
  fromKeyframe: boolean;
}

/** The voice table at `state`'s instant: the keyframe's voices with the voice events after it applied, in seq order. */
export function reconstructVoices(state: CaptureSeekState, names: NameLookup): VoiceReplay {
  const rows = new Map<number, VoiceRow>();
  for (const v of state.keyframe?.voices ?? []) rows.set(v.id, fromKeyframeVoice(names, v));
  for (const rec of state.records) {
    if (rec.kind !== "event") continue;
    const p = rec.payload;
    const a = p.args;
    switch (p.kind) {
      case EventKind.voiceStart:
        // args: id, clip, busRef (gen << 8 | slot), flags, atFrameLo; f32 gain
        rows.set(a[0]!, makeRow(names, {
          id: a[0]!, clip: a[1]!, slot: (a[2]! & 0xff), state: STATE_PLAYING, priority: null, reason: 0, gain: p.f32 ?? 1,
          pitch: null, audibility: null, playheadFrames: 0, thief: null, fromKeyframe: false,
        }));
        break;
      case EventKind.voiceStop:
        rows.delete(a[0]!);
        break;
      case EventKind.voiceSteal: {
        const victim = rows.get(a[0]!);
        if (victim) rows.set(victim.id, withState(names, victim, STATE_STOLEN, p.reason, a[1]!));
        break;
      }
      case EventKind.voiceVirtual: {
        const v = rows.get(a[0]!);
        if (v) rows.set(v.id, withState(names, v, STATE_VIRTUAL, p.reason, null));
        break;
      }
      case EventKind.voiceReal: {
        const v = rows.get(a[0]!);
        if (v) rows.set(v.id, withState(names, v, STATE_PLAYING, p.reason, null));
        break;
      }
      default:
        break; // refused and queued voices are not rows; every other kind is not a voice event
    }
  }
  const heads = state.status?.playheads;
  if (heads && heads.length) {
    for (const h of heads) {
      const r = rows.get(h.id);
      if (r) r.playheadFrames = h.clipFrame;
    }
  }
  return { rows: [...rows.values()], fromKeyframe: state.keyframe !== null };
}

// --- the name filter ---------------------------------------------------------------------------------------------------

/** The filter as a predicate: a trimmed, case-insensitive substring over the names given; an empty filter matches everything. */
export function nameFilter(text: string): (...names: (string | undefined)[]) => boolean {
  const needle = text.trim().toLowerCase();
  if (needle === "") return () => true;
  return (...names) => names.some((n) => n !== undefined && n.toLowerCase().includes(needle));
}

// --- the table ---------------------------------------------------------------------------------------------------------

export interface VoiceTable {
  /** At most `max` rows, most audible first (ties by priority, then id), after the filter. */
  rows: VoiceRow[];
  /** Rows after the filter (shown and not shown). */
  matched: number;
  /** Rows before the filter. */
  total: number;
  /** Matching rows left out of `rows`. */
  hidden: number;
  /** The hidden rows by state name. */
  hiddenByState: Record<string, number>;
  fromKeyframe: boolean;
}

/** An unrecorded audibility sorts as audible: a voice that just started has not been measured yet. */
const audibilityKey = (r: VoiceRow): number => r.audibility ?? 1;
const priorityKey = (r: VoiceRow): number => r.priority ?? -1;

/** Filters by clip name or bus name, orders as the live debug table does and caps at `max` rows while counting the rest. */
export function voiceTable(replay: VoiceReplay, filter = "", max = MAX_VOICE_ROWS): VoiceTable {
  const match = nameFilter(filter);
  const kept = replay.rows.filter((r) => match(r.clipName, r.busName));
  kept.sort((a, b) => audibilityKey(b) - audibilityKey(a) || priorityKey(b) - priorityKey(a) || a.id - b.id);
  const hiddenByState: Record<string, number> = {};
  for (let i = max; i < kept.length; i++) {
    const s = kept[i]!.stateName;
    hiddenByState[s] = (hiddenByState[s] ?? 0) + 1;
  }
  return {
    rows: kept.slice(0, max), matched: kept.length, total: replay.rows.length, hidden: Math.max(0, kept.length - max), hiddenByState,
    fromKeyframe: replay.fromKeyframe,
  };
}

// --- event instances ---------------------------------------------------------------------------------------------------

/** One event instance at the cursor (the keyframe's, with eventStart and eventStop applied). */
export interface EventRow {
  id: number;
  asset: number;
  name: string;
  /** Voices the keyframe counted for it (0 for one started after the keyframe: the stream does not carry a count). */
  voices: number;
  state: number;
}

/** The event instances at `state`'s instant, filtered by event name. eventStart's args are read as `id, asset`, eventStop's as `id`. */
export function eventRows(state: CaptureSeekState, names: NameLookup, filter = ""): EventRow[] {
  const rows = new Map<number, EventRow>();
  const make = (id: number, asset: number, voices: number, st: number): EventRow => ({ id, asset, name: names.event(asset) ?? `event ${asset}`, voices, state: st });
  for (const e of state.keyframe?.events ?? []) rows.set(e.id, make(e.id, e.asset, e.voices, e.state));
  for (const rec of state.records) {
    if (rec.kind !== "event") continue;
    const p = rec.payload;
    if (p.kind === EventKind.eventStart) rows.set(p.args[0]!, make(p.args[0]!, p.args[1]!, 0, 0));
    else if (p.kind === EventKind.eventStop) rows.delete(p.args[0]!);
  }
  const match = nameFilter(filter);
  return [...rows.values()].filter((r) => match(r.name)).sort((x, y) => x.id - y.id);
}
