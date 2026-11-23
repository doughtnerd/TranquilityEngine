// What the Take screen's Inspector and Mixer strip show (ADR 0348 "the inspector's authored-versus-live values from the
// replaying runtime"): an instance's parameters at the playhead as the take recorded them beside what the replaying
// instance reports now (its handle's `getParameter`), and each bus's authored level beside its live one (`Audio.bus`:
// authored volume × script volume × ducking) with its peak. Pure: the panels pass the readings in.
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

/** A bus's strip: authored and live levels in dB, its peak. */
export function busStrip(r: BusReading): BusStrip {
  const authoredDb = gainToDb(r.authored);
  const liveDb = gainToDb(r.authored * r.runtime * r.duck);
  const peakDb = r.peak > 0 ? gainToDb(r.peak) : null;
  const differs = Math.abs(liveDb - authoredDb) >= 0.05;
  return { name: r.name, authoredDb, liveDb, peakDb, text: differs ? `${formatDb(authoredDb)} dB · live ${formatDb(liveDb)} dB` : `${formatDb(authoredDb)} dB` };
}

/** A value for the table: numbers to two places, labels as they are, "—" for none. */
export function valueText(v: number | string | null): string {
  if (v === null) return "—";
  if (typeof v === "string") return v;
  return String(Math.round(v * 100) / 100).replace(/^-/, "−");
}
