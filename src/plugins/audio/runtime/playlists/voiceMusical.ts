/**
 * A playing sample voice's heard position (ADR 0343): the music runtime's pass walk (`music/anchors.ts`, ADR 0285) keyed
 * on a playlist voice instead of a music segment. The voice plays its file from `from` at its pitch, looping its loop
 * region while the loop is on; when the loop turns off (a release, a parameter) the anchor moves to where the voice is
 * then, with the region gone.
 *
 * - `VoiceClock`: heard time ↔ file position, and the heard time of the next file position a query names.
 * - `VoiceMusical`: the musical clock of a Clip playlist (`MusicalSource`): beats and bars of the sample's tempo map,
 *   Exit markers, else the loop's next wrap, else the sample's end.
 * - `VoiceMarkers`: Cue, Exit and Hit markers as the voice passes them (`onMarker`), found on main from the voice's
 *   planned position: delivered on the first frame whose heard clock has passed them (one frame of accuracy).
 */
import { secondsToTicks, ticksToPosition, ticksToSeconds, spanAtTicks, type SegmentGrid } from "../../../../engine/audio/musicGrid";
import { MUSIC_TICKS_PER_BEAT } from "../../../../engine/audio/musicPosition";
import type { GridSpec, MusicSeekResult } from "../../../../engine/audio/musicTypes";
import type { AudioMarkerEvent } from "../backend";
import { nextGridHeardOn, nextHeardOn, ticksAtOn, type LoopAnchor, type NextPoint } from "../music/anchors";
import type { SegmentLoops } from "../music/anchors";
import type { MusicalBoundary, MusicalPosition, MusicalSource } from "./musical";
import type { PVoice } from "./nodes";
import { tempoGrid, type FactMarker, type SampleFacts } from "./sampleFacts";

/** The clip rate the walk rounds to when the file's is unknown (the music runtime's fallback). */
const RATE = 48_000;
const EPS = 1e-9;

let plainGrid: SegmentGrid | null = null;
/** A grid for a sample without a tempo (the walk counts in ticks; beats are never asked of it). */
const defaultGrid = (): SegmentGrid => (plainGrid ??= tempoGrid({ bpm: 120, meter: "4/4" }, undefined, "default"));

export class VoiceClock {
  private anchor: LoopAnchor;
  private looping: boolean;
  private pitch: number;
  readonly grid: SegmentGrid;

  constructor(readonly voice: PVoice, readonly facts: SampleFacts, readonly from: number) {
    this.grid = facts.grid ?? defaultGrid();
    this.looping = !!voice.loop?.looping;
    this.pitch = voice.base.pitch > 0 ? voice.base.pitch : 1;
    this.anchor = this.make(from, voice.start ?? 0);
  }

  private loops(): SegmentLoops {
    const l = this.voice.loop;
    const end = l && l.end > 0 ? l.end : this.facts.end ?? 0;
    const regions = l && this.looping && end > l.start + EPS ? [{ index: 0, from: l.start, to: end, count: 0 }] : [];
    return { grid: this.grid, regions, exit: Number.POSITIVE_INFINITY, rate: RATE };
  }

  private make(file: number, time: number): LoopAnchor {
    return { loops: this.loops(), ticks: secondsToTicks(this.grid, file), time, pass: 1, rate: RATE };
  }

  /** Heard `t` in the anchor's 1:1 time (the walk knows no pitch). */
  private scaled(t: number): number { return this.anchor.time + (t - this.anchor.time) * this.pitch; }
  private unscaled(t: number): number { return this.anchor.time + (t - this.anchor.time) / this.pitch; }

  /** Re-anchors at `now` when the loop turned on or off, or the pitch moved, since the last question. */
  private sync(now: number): void {
    const looping = !!this.voice.loop?.looping;
    const pitch = this.voice.base.pitch > 0 ? this.voice.base.pitch : 1;
    if (looping === this.looping && Math.abs(pitch - this.pitch) < 1e-6) return;
    const at = Math.max(now, this.anchor.time);
    const file = ticksToSeconds(this.grid, ticksAtOn(this.anchor, this.scaled(at)));
    this.looping = looping;
    this.pitch = pitch;
    this.anchor = this.make(file, at);
  }

  /** File seconds heard at `time` (NaN before the voice is known). */
  fileAt(time: number, now: number): number {
    this.sync(now);
    return ticksToSeconds(this.grid, ticksAtOn(this.anchor, this.scaled(Math.max(time, this.anchor.time))));
  }

  /** The heard time of the first file position `next` names at or after the one heard at `after`; NaN when none. */
  nextHeard(after: number, next: NextPoint, now: number, strict = false): number {
    this.sync(now);
    const h = nextHeardOn(this.anchor, this.scaled(Math.max(after, this.anchor.time)), next, strict).at;
    return Number.isFinite(h) ? this.unscaled(h) : Number.NaN;
  }

  /** The heard time of the next grid point of `spec` at or after `after`; NaN when none. */
  nextGrid(after: number, spec: GridSpec, now: number): number {
    this.sync(now);
    const h = nextGridHeardOn(this.anchor, this.scaled(Math.max(after, this.anchor.time)), spec).at;
    return Number.isFinite(h) ? this.unscaled(h) : Number.NaN;
  }

  /** Heard time the voice reaches its file end (one-shot), NaN when it loops or the end is unknown. */
  endTime(now: number): number {
    this.sync(now);
    if (this.looping || this.facts.end === null) return Number.NaN;
    const file = this.fileAt(this.anchor.time, now);
    return this.anchor.time + (this.facts.end - file) / this.pitch;
  }

  get alive(): boolean { return !this.voice.leaving && this.voice.voice.playing; }
}

/** First of `points` (file seconds, sorted) at or after `file` (strictly after when `strict`). */
function firstAtOrAfter(points: readonly number[], file: number, strict: boolean): number {
  for (const p of points) if (strict ? p > file + EPS : p >= file - EPS) return p;
  return Number.NaN;
}

/** A Clip playlist's musical clock. */
export class VoiceMusical implements MusicalSource {
  private readonly exits: number[];
  constructor(private readonly clock: VoiceClock, private readonly now: () => number) {
    this.exits = clock.facts.markers.filter((m) => m.type === "exit").map((m) => m.at);
  }

  get label(): string { return this.clock.facts.path; }
  get hasGrid(): boolean { return this.clock.facts.grid !== null; }

  nextBoundary(kind: MusicalBoundary, from: number): number | null {
    if (!this.clock.alive) return null;
    const now = this.now();
    if (kind !== "exit") {
      if (!this.hasGrid) return null;
      const t = this.clock.nextGrid(from, kind, now);
      return Number.isFinite(t) ? t : null;
    }
    if (this.exits.length > 0) {
      const t = this.clock.nextHeard(from, (_g, file, strict) => firstAtOrAfter(this.exits, file, strict), now);
      if (Number.isFinite(t)) return t;
    }
    const loop = this.clock.voice.loop;
    if (loop && loop.looping) {
      // The loop's next wrap: its start, heard one pass on.
      const t = this.clock.nextHeard(from, (_g, file) => (file <= loop.start + EPS ? loop.start : Number.NaN), now);
      if (Number.isFinite(t) && t > from - EPS) return t;
    }
    const end = this.clock.endTime(now);
    return Number.isFinite(end) && end >= from - EPS ? end : null;
  }

  secondsPerBeat(): number | null {
    if (!this.hasGrid || !this.clock.alive) return null;
    const g = this.clock.grid;
    const file = this.clock.fileAt(this.now(), this.now());
    const span = spanAtTicks(g, Math.max(0, secondsToTicks(g, Number.isFinite(file) ? file : 0)));
    return MUSIC_TICKS_PER_BEAT / g.ticksPerSecond[span]! / (this.clock.voice.base.pitch || 1);
  }

  positionAt(time: number): MusicalPosition | null {
    if (!this.hasGrid || !this.clock.alive) return null;
    const g = this.clock.grid;
    const file = this.clock.fileAt(time, this.now());
    if (!Number.isFinite(file)) return null;
    return positionOn(g, file);
  }

  nextGrid(spec: GridSpec, from: number): { time: number; bar: number; beat: number } | null {
    if (!this.hasGrid || !this.clock.alive) return null;
    const t = this.clock.nextGrid(from, spec, this.now());
    if (!Number.isFinite(t)) return null;
    const p = this.positionAt(t + 1e-9);
    return p ? { time: t, bar: p.bar, beat: p.beat } : null;
  }

  seek(): MusicSeekResult {
    return { ok: false, reason: "invalid", permanent: true };
  }
}

/** The musical position at file (or sequence) seconds `s` of `grid`. */
export function positionOn(g: SegmentGrid, s: number): MusicalPosition | null {
  const raw = Math.max(0, secondsToTicks(g, s));
  const exact = Math.abs(raw - Math.round(raw)) < 1e-6 ? Math.round(raw) : raw;
  const whole = Math.floor(exact);
  const pos = ticksToPosition(g, whole);
  if (!pos) return null;
  const span = spanAtTicks(g, whole);
  return {
    bar: pos.bar, beat: pos.beat, beatFraction: (pos.tick + (exact - whole)) / MUSIC_TICKS_PER_BEAT,
    tempo: g.bpm[span] ?? 0, beatsPerBar: g.beatsPerBar[span] ?? 0, beatUnit: g.beatUnit[span] ?? 0,
  };
}

/** Delivers a voice's sample markers as it passes them. */
export class VoiceMarkers {
  private cursor: number;
  private readonly points: number[];
  constructor(private readonly clock: VoiceClock, private readonly markers: readonly FactMarker[], private readonly emit: (e: AudioMarkerEvent) => void) {
    this.cursor = clock.voice.start ?? Number.NEGATIVE_INFINITY;
    this.points = markers.map((m) => m.at);
  }

  /** Reports every marker heard up to `now`; false once the voice has gone (drop the tracker). */
  update(now: number): boolean {
    if (!this.clock.alive) return false;
    for (let guard = 0; guard < 64; guard++) {
      const strict = guard > 0 || this.cursor > (this.clock.voice.start ?? -Infinity);
      const t = this.clock.nextHeard(this.cursor, (_g, file, s) => firstAtOrAfter(this.points, file, s), now, strict);
      if (!Number.isFinite(t) || t > now) return true;
      const file = this.clock.fileAt(t, now);
      for (const m of this.markers) {
        if (Math.abs(m.at - file) <= 1e-6) this.emit({ type: m.type, name: m.name, sample: this.clock.facts.path, time: t });
      }
      this.cursor = t;
    }
    return true;
  }
}
