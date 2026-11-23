// The Profiler's memory track (ADR 0351 §6, §8: "the Profiler's measured peak memory from a take or capture is the real
// number"): the clip arena over time from the STATUS records (`arenaUsedKB`, every capture of the core has it) and the
// memory the loaded packages hold from the `PKG` events (each `loaded` adds what the package holds, its `unload` takes
// it away; captures from before the events carried memory show the marks without the line), with a mark at each load,
// failure and unload and the peaks. Pure.
import type { CaptureEventAt, CaptureNames } from "../../../plugins/audio/runtime/capture/reader";

/** A line on the viewport axis (seconds), bytes. */
export interface MemorySeries {
  readonly times: ArrayLike<number>;
  readonly values: ArrayLike<number>;
}

export interface MemoryMark {
  /** Viewport seconds. */
  readonly time: number;
  readonly kind: "loaded" | "unload" | "failed";
  readonly text: string;
}

export interface MemoryData {
  /** The clip arena in use, bytes (empty without STATUS). */
  readonly arena: MemorySeries;
  /** The loaded packages' memory, bytes, as a step line (empty when no event carried memory). */
  readonly packages: MemorySeries;
  readonly marks: readonly MemoryMark[];
  readonly peakArena: number;
  readonly peakPackages: number;
  /** Packages whose events didn't say what they held (an older capture). */
  readonly unknownPackages: readonly string[];
}

const KB = 1024;

/**
 * The memory track's data: `arenaKB` the STATUS column on `times` (viewport seconds), `events` the capture's EVENTs (only
 * `audioPackage` ones are read), `origin` the capture's start (events are on its clock). Null when the capture holds
 * neither a used arena nor a package event (no track).
 */
export function buildMemory(times: ArrayLike<number>, arenaKB: ArrayLike<number> | null, events: readonly CaptureEventAt[], names: Pick<CaptureNames, "parameter">, origin: number): MemoryData | null {
  const arena: number[] = [];
  let peakArena = 0;
  if (arenaKB) {
    for (let i = 0; i < arenaKB.length; i++) {
      const b = arenaKB[i]! * KB;
      arena.push(b);
      if (b > peakArena) peakArena = b;
    }
  }
  const pt: number[] = [];
  const pv: number[] = [];
  const marks: MemoryMark[] = [];
  const held = new Map<string, number>();
  const unknown = new Set<string>();
  let total = 0;
  let peakPackages = 0;
  let sawMemory = false;
  for (const { seconds, event: e } of events) {
    if (e.type !== "audioPackage" || e.event === null || e.event === "loadStart") continue;
    const time = seconds - origin;
    const name = names.parameter(e.name, seconds);
    if (e.memoryBytes !== null) sawMemory = true;
    if (e.event === "failed") {
      marks.push({ time, kind: "failed", text: `${name} failed to load` });
      continue;
    }
    if (e.event === "loaded") {
      if (e.memoryBytes === null) unknown.add(name);
      const m = e.memoryBytes ?? 0;
      total += m - (held.get(name) ?? 0);
      held.set(name, m);
      marks.push({ time, kind: "loaded", text: `${name} loaded${e.memoryBytes !== null ? ` · ${Math.round(m / KB)} KB` : ""}` });
    } else {
      total -= held.get(name) ?? 0;
      held.delete(name);
      marks.push({ time, kind: "unload", text: `${name} unloaded` });
    }
    pt.push(time);
    pv.push(total);
    if (total > peakPackages) peakPackages = total;
  }
  if (peakArena === 0 && marks.length === 0) return null;
  return {
    arena: { times: Float64Array.from(arenaKB ? Array.from(times) : []), values: Float64Array.from(arena) },
    packages: sawMemory ? { times: Float64Array.from(pt), values: Float64Array.from(pv) } : { times: new Float64Array(0), values: new Float64Array(0) },
    marks,
    peakArena,
    peakPackages,
    unknownPackages: [...unknown],
  };
}

/** The value of a step line at `t` (the last point at or before it; 0 before the first). */
export function memoryAt(s: MemorySeries, t: number): number {
  let v = 0;
  for (let i = 0; i < s.times.length && s.times[i]! <= t; i++) v = s.values[i]!;
  return v;
}

/** The track's readout at the cursor ("arena 3.2 MB · packages 1.1 MB"). */
export function memoryText(m: MemoryData, t: number, format: (bytes: number) => string): string {
  const parts: string[] = [];
  if (m.arena.times.length > 0) parts.push(`arena ${format(memoryAt(m.arena, t))}`);
  if (m.packages.times.length > 0) parts.push(`packages ${format(memoryAt(m.packages, t))}`);
  return parts.join(" · ") || `${m.marks.length} package event${m.marks.length === 1 ? "" : "s"}`;
}
