// ADR 0260 (extends 0227; api-and-models §5.2, §5.3 NAMES, §6.3): what a capture calls a clip, a bus slot, an event asset,
// a parameter, a snapshot or a target at an instant. Pure data and lookups; runs in the capture Worker and in the editor.
//
// **The log.** The reader (`CaptureDecoder`) keeps every name it reads, in record order, as `[id, name, seconds]`: META's
// names at the take's start (seconds `-Infinity`), then each NAMES record at its axis time. The summary carries that log
// (`CaptureOpenSummary.names`, structured-cloneable), so a live view's grows with each appended segment.
//
// **Over time.** An id in the clip, event, parameter, snapshot and target tables names one thing for the whole capture. A
// bus id is a slot (§6.3), and a slot's name changes: the capture writes a NAMES record each time a slot takes a new name (a
// bus added or recycled into it, a rename; `capture.ts`), so the slot's name at `t` is its last record at or before `t`. A
// removed bus keeps its slot and its name until the slot is recycled (a tombstone, ADR 0171 §17). Before an id's first
// record it reads as that first name (a name is never recorded before its first use, so nothing else could have held it).
//
// **One fallback.** An id with no name reads as its table's word and the id ("clip 3", "bus 3"), and the final output's
// slot (`LOUD_OUTPUT_TAP`) reads "Master" when no bus is named there. No view words a missing name itself.
import { LOUD_OUTPUT_TAP } from "../wire.generated";
import type { NameTable } from "./format";

/** One name read: the id, the name, and the axis seconds from which it holds (`-Infinity` for META's). */
export type CaptureNameEntry = readonly [id: number, name: string, seconds: number];

/** Every name a capture holds, per table, in record order. */
export type CaptureNameLog = Readonly<Record<NameTable, readonly CaptureNameEntry[]>>;

/** The word an unnamed id of each table reads as. */
const WORD: Readonly<Record<NameTable, string>> = { clips: "clip", buses: "bus", events: "event", parameters: "parameter", snapshots: "snapshot", targets: "target" };

/** The name the final output's slot reads as when no bus is named there. */
export const OUTPUT_NAME = "Master";

/** The lookups over one log (`captureNames`). */
export class CaptureNames {
  /** Per table: id to its names, ascending by seconds. */
  private readonly byId = new Map<NameTable, Map<number, CaptureNameEntry[]>>();

  constructor(log: CaptureNameLog) {
    for (const table of Object.keys(WORD) as NameTable[]) {
      const ids = new Map<number, CaptureNameEntry[]>();
      for (const e of log[table] ?? []) {
        const list = ids.get(e[0]);
        if (list) list.push(e);
        else ids.set(e[0], [e]);
      }
      for (const list of ids.values()) if (list.length > 1) list.sort((a, b) => a[2] - b[2]);
      this.byId.set(table, ids);
    }
  }

  /** The name `id` holds at axis time `t` (default: its latest), or undefined when the capture never named it. */
  find(table: NameTable, id: number, t = Infinity): string | undefined {
    const list = this.byId.get(table)?.get(id);
    if (!list) return undefined;
    let at = 0;
    for (let i = 1; i < list.length && list[i]![2] <= t; i++) at = i;
    return list[at]![1];
  }

  /** The name `id` holds at `t`, or the table's fallback ("clip 3"; "Master" for the output's slot). */
  name(table: NameTable, id: number, t = Infinity): string {
    const found = this.find(table, id, t);
    if (found !== undefined) return found;
    if (table === "buses" && id === LOUD_OUTPUT_TAP) return OUTPUT_NAME;
    return `${WORD[table]} ${id}`;
  }

  clip(id: number, t?: number): string {
    return this.name("clips", id, t);
  }

  bus(slot: number, t?: number): string {
    return this.name("buses", slot, t);
  }

  event(id: number, t?: number): string {
    return this.name("events", id, t);
  }

  parameter(id: number, t?: number): string {
    return this.name("parameters", id, t);
  }

  snapshot(id: number, t?: number): string {
    return this.name("snapshots", id, t);
  }

  /** Every bus slot named at `t`, ascending by slot. */
  busSlots(t = Infinity): [slot: number, name: string][] {
    const out: [number, string][] = [];
    for (const slot of this.byId.get("buses")!.keys()) out.push([slot, this.find("buses", slot, t)!]);
    return out.sort((a, b) => a[0] - b[0]);
  }

  /** The bus slot named `name` at `t`, or undefined. */
  slotOf(name: string, t = Infinity): number | undefined {
    for (const [slot, n] of this.busSlots(t)) if (n === name) return slot;
    return undefined;
  }
}

const memo = new WeakMap<CaptureNameLog, CaptureNames>();

/** The lookups over a summary's log, built once per log (a live summary's log is a new one after each append). */
export function captureNames(summary: { readonly names: CaptureNameLog }): CaptureNames {
  let n = memo.get(summary.names);
  if (!n) memo.set(summary.names, (n = new CaptureNames(summary.names)));
  return n;
}
