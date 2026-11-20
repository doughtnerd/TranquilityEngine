// ADR 0171 amended by 0172 (M5a, task Pf2; api-and-models §5.5, §5.6, §7 `voiceTableModel.ts`): the profiler's voice
// table at the cursor, a pure model. `reconstructVoices` takes `ProfileSource.seek`'s answer (the keyframe at or before
// t and the EVENT records after it, `reader.ts`) and replays the voice events over the keyframe's rows; the reason (the
// capture's word and its text, ADR 0260) and the thief of a steal come from the events (§5.6), and every name is the
// capture's at t (`CaptureNames`). `voiceTable` filters by name and caps the rows rendered at
// `MAX_VOICE_ROWS` while counting the rest. The same replay gives the event instances (`eventRows`).
//
// What a replay can know. A row born from a keyframe has every field. A row born from a voiceStart event after it has
// what the event carries (clip, bus, gain); its priority, pitch and audibility are null until the next keyframe, and its
// playhead is the STATUS's (the last STATUS at or before t carries up to 256 round-robin playheads). A seek with no
// keyframe at or before t (`fromKeyframe` false) replays only the last second's events, so voices started earlier are
// missing and the view says so. A voice that stopped is gone from the table (voiceStop is the free).
import { reasonText, type CaptureKeyframeVoice, type CaptureNames, type CaptureSeekState, type CaptureVoiceReason, type CaptureVoiceState } from "../../runtime/capture/reader";

/** The most voice rows rendered (as the live debug table); the rest are counted. */
export const MAX_VOICE_ROWS = 64;

/** One voice at the cursor. */
export interface VoiceRow {
  id: number;
  clip: number;
  clipName: string;
  /** The bus's slot (a keyframe row and a voiceStart both carry the slot only). */
  slot: number;
  busName: string;
  /** The keyframe's state, or the one the voice events after it moved the voice to. */
  state: CaptureVoiceState;
  /** Null for a voice born from an event after the keyframe. */
  priority: number | null;
  /** Why the voice is in its state, as the capture's word (null for none). */
  reason: CaptureVoiceReason | null;
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

/** A row's derived texts: the names at the cursor's instant (ADR 0260) and the reason in words. */
function makeRow(names: CaptureNames, t: number, v: Omit<VoiceRow, "clipName" | "busName" | "reasonText">): VoiceRow {
  return { ...v, clipName: names.clip(v.clip, t), busName: names.bus(v.slot, t), reasonText: reasonText(v.reason) };
}

function fromKeyframeVoice(names: CaptureNames, t: number, v: CaptureKeyframeVoice): VoiceRow {
  return makeRow(names, t, { ...v, thief: null, fromKeyframe: true });
}

/** Rewrites a row's state and reason (and its derived texts), keeping everything else. */
function withState(names: CaptureNames, t: number, r: VoiceRow, state: CaptureVoiceState, reason: CaptureVoiceReason | null, thief: number | null): VoiceRow {
  return makeRow(names, t, { ...r, state, reason, thief });
}

/** What `reconstructVoices` returns: every voice at the cursor (unfiltered, uncapped), in the keyframe's order then birth order. */
export interface VoiceReplay {
  rows: VoiceRow[];
  /** A keyframe was the base: the table is complete. Otherwise only the last second's starts are in it. */
  fromKeyframe: boolean;
}

/** The voice table at `state`'s instant: the keyframe's voices with the voice events after it applied, in seq order; names as at that instant. */
export function reconstructVoices(state: CaptureSeekState, names: CaptureNames): VoiceReplay {
  const t = state.seconds;
  const rows = new Map<number, VoiceRow>();
  for (const v of state.keyframe?.voices ?? []) rows.set(v.id, fromKeyframeVoice(names, t, v));
  for (const rec of state.records) {
    if (rec.kind !== "event") continue;
    const e = rec.event;
    switch (e.type) {
      case "voiceStart":
        rows.set(e.voice, makeRow(names, t, {
          id: e.voice, clip: e.clip, slot: e.slot, state: "playing", priority: null, reason: null, gain: e.gain,
          pitch: null, audibility: null, playheadFrames: 0, thief: null, fromKeyframe: false,
        }));
        break;
      case "voiceStop":
        rows.delete(e.voice);
        break;
      case "voiceSteal": {
        const victim = rows.get(e.voice);
        if (victim) rows.set(victim.id, withState(names, t, victim, "stolen", e.reason, e.thief));
        break;
      }
      case "voiceVirtual": {
        const v = rows.get(e.voice);
        if (v) rows.set(v.id, withState(names, t, v, "virtual", e.reason, null));
        break;
      }
      case "voiceReal": {
        const v = rows.get(e.voice);
        if (v) rows.set(v.id, withState(names, t, v, "playing", e.reason, null));
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
    const s = kept[i]!.state;
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
}

/** The event instances at `state`'s instant, filtered by event name. eventStart's args are read as `id, asset`, eventStop's as `id`. */
export function eventRows(state: CaptureSeekState, names: CaptureNames, filter = ""): EventRow[] {
  const rows = new Map<number, EventRow>();
  const make = (id: number, asset: number, voices: number): EventRow => ({ id, asset, name: names.event(asset, state.seconds), voices });
  for (const e of state.keyframe?.events ?? []) rows.set(e.id, make(e.id, e.asset, e.voices));
  for (const rec of state.records) {
    if (rec.kind !== "event") continue;
    const e = rec.event;
    if (e.type === "eventStart") rows.set(e.instance, make(e.instance, e.asset, 0));
    else if (e.type === "eventStop") rows.delete(e.instance);
  }
  const match = nameFilter(filter);
  return [...rows.values()].filter((r) => match(r.name)).sort((x, y) => x.id - y.id);
}
