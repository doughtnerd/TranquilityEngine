// What the Take screen's Inspector and Mixer strip show (ADR 0348 "the inspector's authored-versus-live values from the
// replaying runtime"): an instance's parameters at the playhead as the take recorded them beside what the replaying
// instance reports now (its handle's `getParameter`), and each bus's authored level beside its live one (`Audio.bus`:
// authored volume × script volume × ducking) with its peak, or beside the level the take recorded at the playhead while
// the replay isn't playing (owner's defect list: the Mixer panel shows the bus levels at the playhead). Pure: the panels
// pass the readings in.
import { gainToDb } from "../../../engine/audio/project/gain";
import type { Take } from "../../../engine/audio/take/reader";
import { formatDb } from "../../components/faderModel";
import type { TakeInstance } from "./takeTimeline";

/** An instance's parameters at take time `t`: those it started with, then its PARAM records up to `t`. */
export function instanceParametersAt(take: Take, instance: TakeInstance, t: number): Record<string, number> {
  const out: Record<string, number> = { ...instance.parameters };
  const end = Math.min(t, instance.end ?? Infinity);
  for (const q of take.requestsBetween(instance.start, end + 1e-9)) if (q.kind === "param" && q.instance === instance.instance) out[q.name] = q.value;
  return out;
}

export interface ParameterRow {
  readonly name: string;
  /** As the take recorded it at the playhead. */
  readonly recorded: number | null;
  /** As the replaying instance reports it (null: not replaying, or the runtime doesn't know the name). */
  readonly live: number | string | null;
  /** The live value differs from the recorded one (a curve or a clamp in the current project). */
  readonly differs: boolean;
}

/** The rows of the authored-versus-live table: every recorded parameter, each with its live value when there is one. */
export function parameterRows(recorded: Readonly<Record<string, number>>, live: ((name: string) => number | string | undefined) | null): ParameterRow[] {
  return Object.keys(recorded)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const r = recorded[name]!;
      const l = live?.(name);
      const value = l === undefined ? null : l;
      return { name, recorded: r, live: value, differs: typeof value === "number" && Math.abs(value - r) > 1e-6 };
    });
}

/** A bus as `Audio.bus(name)` reads it (linear gains). */
export interface BusReading {
  readonly name: string;
  readonly authored: number;
  /** The script volume (what MIX requests set). */
  readonly runtime: number;
  readonly duck: number;
  readonly peak: number;
}

export interface BusStrip {
  readonly name: string;
  readonly authoredDb: number;
  readonly liveDb: number;
  readonly peakDb: number | null;
  /** "−6.0 dB · live −12.0 dB" (live only when it differs). */
  readonly text: string;
}

/**
 * A bus's strip: authored and live levels in dB, its peak. `liveWord` names where the live level comes from in the text
 * ("live" for the runtime now, "take" for the take's recording at the playhead).
 */
export function busStrip(r: BusReading, liveWord = "live"): BusStrip {
  const authoredDb = gainToDb(r.authored);
  const liveDb = gainToDb(r.authored * r.runtime * r.duck);
  const peakDb = r.peak > 0 ? gainToDb(r.peak) : null;
  const differs = Math.abs(liveDb - authoredDb) >= 0.05;
  return { name: r.name, authoredDb, liveDb, peakDb, text: differs ? `${formatDb(authoredDb)} dB · ${liveWord} ${formatDb(liveDb)} dB` : `${formatDb(authoredDb)} dB` };
}

/** A bus's gains as one source has them, linear: the script volume, the ducking and the peak. */
export interface BusGains {
  readonly runtime: number;
  readonly duck: number;
  readonly peak: number;
}

/** One bus for the Mixer strip: its authored level, what the runtime reports now and what the take recorded at the playhead (null: unknown). */
export interface StripSource {
  readonly name: string;
  readonly authored: number;
  readonly live: BusGains | null;
  readonly recorded: BusGains | null;
}

/** A strip and whether its levels are the take's recording at the playhead (else the runtime's now). */
export interface MixerStripRow extends BusStrip {
  readonly recorded: boolean;
}

/**
 * The Mixer strip's rows. `atPlayhead` (a take is open and its replay isn't playing, or there is no runtime to read): each
 * bus as the take recorded it at the playhead, so a scrub moves the levels. Otherwise, or for a bus the take has no
 * reading of, what the runtime reports now; with neither, the authored level alone.
 */
export function mixerStripRows(buses: readonly StripSource[], atPlayhead: boolean): MixerStripRow[] {
  return buses.map((b) => {
    const recorded = atPlayhead && b.recorded !== null;
    const g = (recorded ? b.recorded : b.live) ?? { runtime: 1, duck: 1, peak: 0 };
    return { ...busStrip({ name: b.name, authored: b.authored, runtime: g.runtime, duck: g.duck, peak: g.peak }, recorded ? "take" : "live"), recorded };
  });
}

/** A value for the table: numbers to two places, labels as they are, "—" for none. */
export function valueText(v: number | string | null): string {
  if (v === null) return "—";
  if (typeof v === "string") return v;
  return String(Math.round(v * 100) / 100).replace(/^-/, "−");
}

/** An instance sounding at the playhead (ADR 0408: the Inspector's "Playing now"). */
export interface PlayingNow {
  readonly key: string;
  readonly label: string;
  readonly path: string;
  /** Its emitter's name (the take's META names them), or null for a 2D play or an unnamed emitter. */
  readonly emitter: string | null;
  /** Seconds since it started. */
  readonly playingFor: number;
  /** Its held part has ended (RELEASE) and it is playing its tail. */
  readonly releasing: boolean;
}

/** What the Inspector says of the take at the playhead with nothing selected. */
export interface PlayheadSummary {
  /** Sounding now, the latest started first. */
  readonly playing: readonly PlayingNow[];
  /** Instances started up to the playhead, of `total` in the take. */
  readonly started: number;
  readonly total: number;
  /** The last marker at or before the playhead, and the next after it. */
  readonly lastMark: { readonly t: number; readonly text: string } | null;
  readonly nextMark: { readonly t: number; readonly text: string } | null;
  /** The playhead as the time of day it was in the game (META's start plus the playhead), or null when unknown. */
  readonly wallClock: Date | null;
}

/** The take at take time `t`: what sounds, how far along it is, the markers either side and the time of day. */
export function playheadSummary(
  timeline: { readonly lanes: readonly { readonly label: string; readonly instances: readonly TakeInstance[] }[]; readonly marks: readonly { readonly t: number; readonly text: string }[] },
  meta: { readonly started: string; readonly emitters: Readonly<Record<number, string>> },
  t: number,
): PlayheadSummary {
  const playing: PlayingNow[] = [];
  let started = 0;
  let total = 0;
  for (const lane of timeline.lanes) {
    for (const i of lane.instances) {
      total++;
      if (i.start > t) continue;
      started++;
      if (i.end !== null && i.end <= t) continue; // stopped (null: it sounded to the take's end)
      playing.push({
        key: i.key,
        label: lane.label,
        path: i.path,
        emitter: i.emitter === null ? null : (meta.emitters[i.emitter] ?? null),
        playingFor: t - i.start,
        releasing: i.release !== null && i.release <= t,
      });
    }
  }
  playing.sort((a, b) => a.playingFor - b.playingFor || a.label.localeCompare(b.label));
  let lastMark: PlayheadSummary["lastMark"] = null;
  let nextMark: PlayheadSummary["nextMark"] = null;
  for (const m of timeline.marks) {
    if (m.t <= t) lastMark = m;
    else if (!nextMark || m.t < nextMark.t) nextMark = m;
  }
  const startedMs = Date.parse(meta.started);
  const wallClock = Number.isFinite(startedMs) && startedMs > 0 ? new Date(startedMs + t * 1000) : null;
  return { playing, started, total, lastMark, nextMark, wallClock };
}
