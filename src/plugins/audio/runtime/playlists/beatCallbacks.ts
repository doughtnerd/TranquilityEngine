/**
 * Beat and bar callbacks of a playing playlist (D20 gap; ADR 0343 "Components keep onMusicBeat/onMusicBar"): the
 * music runtime's dispatch rule (ADR 0166 architecture §4.5) over the playlist's musical clock (`MusicalSource`: a
 * Sequence with a tempo, or a Clip whose sample has one) instead of a music player's runs.
 *
 * - Once per frame (the instance's update), each subscribed kind fires the boundaries heard before `now + window` (one
 *   frame) past its cursor: one call for the latest, with `missed` = the others (coalesced after a gap).
 * - A kind subscribed from the start (a hook on the playing `AudioSource`'s node, a listener added as it plays) hears the
 *   playlist's first downbeat. A kind that becomes subscribed later (a listener added, a component gaining the hook)
 *   owes nothing heard before then: its cursor is seated there. So does a kind whose playing entry loses its tempo and
 *   gets one back.
 * - The cursor is the heard time of the last boundary consumed, so a loop wrap or a seek on the playhead (a new heard
 *   time later on) continues without doubling or skipping.
 * - Component hooks hear an event before the handle's listeners (as the music runtime's dispatch). `e` is reused per
 *   kind: read it during the call.
 *
 * `cue` has no playlist meaning here: a playlist's cues are markers (`onMarker`, `onAudioMarker`).
 */
import type { MusicEvent, MusicEventHandle, MusicKind } from "../../../../engine/audio/musicTypes";
import type { MusicalSource } from "./musical";

type Listener = (e: MusicEvent) => void;
/** The kinds a playlist fires. */
export type PlaylistBeatKind = "beat" | "bar";

/** At most this many boundaries are walked in one call (a hidden tab for hours): the rest coalesce without a walk. */
const MAX_WALK = 4096;
/** A boundary is looked for this far past the cursor, so the one consumed isn't found again. */
const STEP = 1e-6;

interface KindState {
  listeners: readonly Listener[];
  /** Heard time of the last boundary consumed; NaN: not seated. */
  cursor: number;
  /** Where the next seat starts (the clock when the kind was subscribed); Infinity: at the frame's `now`. */
  seatFrom: number;
  readonly event: MusicEvent;
}

export class PlaylistBeats {
  private readonly kinds: Record<PlaylistBeatKind, KindState>;

  /**
   * `clock`: the playback's clock; what it reads now is where a kind subscribed from the start seats. `heard` turns a
   * time on it into the heard time events carry (ADR 0362 §1: a paused playback's clock runs behind `Audio.time`).
   */
  constructor(handle: MusicEventHandle, private readonly clock: () => number, private readonly heard: (t: number) => number = (t) => t) {
    const kind = (): KindState => ({
      listeners: [], cursor: Number.NaN, seatFrom: clock(),
      event: { handle, segment: "", bar: 1, beat: 1, tempo: 0, beatsPerBar: 0, time: 0, heardIn: 0, missed: 0 },
    });
    this.kinds = { beat: kind(), bar: kind() };
  }

  /** Adds a listener (`handle.onMusic`); the returned function removes it. A `cue` listener never hears anything. */
  on(kind: MusicKind, fn: Listener): () => void {
    if (kind !== "beat" && kind !== "bar") return () => {};
    const k = this.kinds[kind];
    if (Number.isNaN(k.cursor) && k.listeners.length === 0) k.seatFrom = Math.min(k.seatFrom, this.clock());
    k.listeners = [...k.listeners, fn];
    return () => { k.listeners = k.listeners.filter((l) => l !== fn); };
  }

  /** Whether any listener is subscribed. */
  get listening(): boolean { return this.kinds.beat.listeners.length > 0 || this.kinds.bar.listeners.length > 0; }

  /**
   * One frame: fires each subscribed kind's boundaries heard before `now + window`. `hooks` says which kinds component
   * hooks want and `deliver` gives them the event (before the listeners).
   */
  dispatch(source: MusicalSource | null, now: number, window: number, hooks: Readonly<Record<PlaylistBeatKind, boolean>>, deliver: (kind: PlaylistBeatKind, e: MusicEvent) => void): void {
    for (const kind of ["beat", "bar"] as const) {
      const k = this.kinds[kind];
      const hook = hooks[kind];
      if (!hook && k.listeners.length === 0) { k.cursor = Number.NaN; k.seatFrom = Number.POSITIVE_INFINITY; continue; }
      if (!source?.hasGrid) { k.cursor = Number.NaN; continue; }
      if (Number.isNaN(k.cursor)) { k.cursor = Math.min(k.seatFrom, now) - STEP; k.seatFrom = Number.POSITIVE_INFINITY; }
      const until = now + Math.max(0, window);
      let count = 0, last = Number.NaN, t = k.cursor;
      while (count < MAX_WALK) {
        const b = source.nextBoundary(kind, t + STEP);
        if (b === null || b >= until) break;
        last = b;
        t = b;
        count++;
      }
      if (count === 0) continue;
      k.cursor = count >= MAX_WALK ? now : last;
      const p = source.positionAt(last + STEP);
      const e = k.event;
      e.segment = source.label;
      e.bar = p?.bar ?? 1;
      e.beat = kind === "bar" ? 1 : p?.beat ?? 1;
      e.tempo = p?.tempo ?? 0;
      e.beatsPerBar = p?.beatsPerBar ?? 0;
      e.time = this.heard(last);
      e.heardIn = last - now;
      e.missed = count - 1;
      if (hook) deliver(kind, e);
      const ls = k.listeners;
      for (let i = 0; i < ls.length; i++) {
        const fn = ls[i]!;
        // One unsubscribed during this event (by itself or an earlier listener) isn't called.
        if (k.listeners !== ls && !k.listeners.includes(fn)) continue;
        try { fn(e); } catch (err) { console.error(`[myco] Playlist onMusic("${kind}") listener threw:`, err); }
      }
    }
  }
}
