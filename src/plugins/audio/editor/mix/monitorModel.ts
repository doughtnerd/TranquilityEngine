// The Mixer panel's monitor mute and solo (ADR 0171 §6.6, ADR 0172 decisions 5 and 9; task Mp1b / L-Mp1ba): pure, no Preact.
//
// Monitor controls are monitoring only: they live in the mixer's `monitor` lane (`mixer.setMonitor`), are never saved and
// never in the project, so the model has no `commit` and never writes anything. It owns:
//
//   - state: per-bus monitor mute and solo (the panel's buttons);
//   - derived: which buses are audible (`audible`), which meters are tainted and why (`taint`), whether any control is on
//     (`active`, which suspends the loudness target check);
//   - effects: each change is **injected calls** on a `MonitorHost` (the mixer's `setMonitor` and the loudness hub's
//     `noteMonitorMute`, `noteMonitorSolo`, `setMonitorActive`), made synchronously and in a fixed order: `setMonitor`, then the
//     taint note, then `setMonitorActive` when the active flag flipped. The calls are the model's only output.
//
// Taint rules (R20, §6.6; the spec table in the test copies them one row per rule):
//   - turning a bus's mute ON taints that bus, every ancestor and the root (master); unmuting does not clear anything;
//   - turning a bus's solo ON taints every meter; solo OFF does not clear anything;
//   - a mark stays until the meter is reset (`reset("all")` or `reset("integrated")`; `"maxPeak"` leaves it), and Play with
//     `loudnessResetOnPlay` resets all: the panel tells the model through `noteReset`;
//   - an unmetered bus has no meter, so it carries no mark (the hub treats it as a no-op too);
//   - any monitor control on suspends the target check (`active`); it does not taint by itself.
// Solo semantics are the mixer's (`Mixer.audibleUnderSolo`): with any solo on, a bus is audible when it is soloed, lies under a
// soloed bus (a descendant) or on the way to one (an ancestor); several solos union. A monitor mute silences its bus and
// everything below it (the gain multiplies up the tree) and wins over a solo on the same bus.
import type { LoudnessResetWhat } from "../../../../engine/audio/loudnessTypes";

/** One bus of the tree, as `AudioSettings.buses` gives it. */
export interface MonitorBus {
  readonly name: string;
  /** The parent's name, or null/absent for the root (master). */
  readonly parent?: string | null;
}

/** What the model calls: injected, so tests need neither a Mixer nor a hub. Every member is optional (no Play Engine yet). */
export interface MonitorHost {
  /** `mixer.setMonitor(bus, controls)`: the monitor lane; never saved, never through `apply`. */
  setMonitor?(bus: string, controls: { mute?: boolean; solo?: boolean }): void;
  /** `LoudnessHub.noteMonitorMute(bus)`: a mute turned on. */
  noteMonitorMute?(bus: string): void;
  /** `LoudnessHub.noteMonitorSolo()`: a solo turned on. */
  noteMonitorSolo?(): void;
  /** `LoudnessHub.setMonitorActive(on)`: any control is on; only called when the flag changes. */
  setMonitorActive?(on: boolean): void;
}

export interface MonitorOptions {
  readonly host: MonitorHost;
  /** Names of the buses that have a loudness meter; default every bus. Only these carry taint marks. */
  readonly metered?: Iterable<string>;
}

/** Why a meter is tainted. */
export type TaintReason =
  /** A monitor mute of this very bus. */
  | { readonly kind: "mute"; readonly bus: string }
  /** A monitor mute of a descendant (`bus`) of this meter's bus. */
  | { readonly kind: "mute-below"; readonly bus: string }
  /** A monitor solo (of `bus`) taints every meter. */
  | { readonly kind: "solo"; readonly bus: string };

export interface MonitorModel {
  /** Replace the tree (a bus added, removed or renamed); controls on vanished buses are dropped silently (no calls). */
  setBuses(buses: readonly MonitorBus[], metered?: Iterable<string>): void;
  /** Set a bus's monitor mute; false for an unknown bus. A no-change set makes no calls. */
  setMute(bus: string, on: boolean): boolean;
  toggleMute(bus: string): boolean;
  /** Set a bus's monitor solo; false for an unknown bus. A no-change set makes no calls. */
  setSolo(bus: string, on: boolean): boolean;
  toggleSolo(bus: string): boolean;
  /** Turn every mute and solo off (one `setMonitor` per bus that had one on, then `setMonitorActive(false)`). Taint stays. */
  clearAll(): void;
  isMuted(bus: string): boolean;
  isSoloed(bus: string): boolean;
  /** Any monitor mute or solo is on (the target check is suspended). */
  readonly active: boolean;
  /** Whether `bus` is heard under the current monitor mutes and solos (ignores authored and script state). */
  audible(bus: string): boolean;
  /** Why `bus`'s meter is tainted, oldest first; empty when it isn't (or isn't metered). */
  taint(bus: string): readonly TaintReason[];
  /** Names of the tainted meters, in tree order. */
  taintedMeters(): readonly string[];
  /** A meter was reset (`bus` omitted: every meter): `"all"` and `"integrated"` clear its marks, `"maxPeak"` doesn't. */
  noteReset(what: LoudnessResetWhat, bus?: string): void;
  /** Play started: with `loudnessResetOnPlay` every meter resets (marks clear). Monitor state itself belongs to the Engine and is untouched. */
  notePlay(resetOnPlay: boolean): void;
}

export function createMonitorModel(options: MonitorOptions): MonitorModel {
  const host = options.host;
  let order: string[] = [];
  let parentOf = new Map<string, string | null>();
  let metered = new Set<string>();
  const muted = new Set<string>();
  const soloed = new Set<string>();
  const marks = new Map<string, TaintReason[]>();
  let flagged = false;

  const known = (b: string) => parentOf.has(b);
  const isActive = () => muted.size > 0 || soloed.size > 0;
  /** A bus, its ancestors, root last. Cycle-safe. */
  const chain = (bus: string): string[] => {
    const out: string[] = [];
    for (let n: string | null | undefined = bus; n != null && known(n) && !out.includes(n); n = parentOf.get(n)) out.push(n);
    return out;
  };
  const root = (): string | null => {
    for (const n of order) if (parentOf.get(n) == null || !known(parentOf.get(n)!)) return n;
    return null;
  };
  const mark = (meter: string, reason: TaintReason) => {
    if (!metered.has(meter) || !known(meter)) return;
    const list = marks.get(meter);
    if (!list) { marks.set(meter, [reason]); return; }
    if (!list.some((r) => r.kind === reason.kind && r.bus === reason.bus)) list.push(reason);
  };
  const syncActive = () => {
    const now = isActive();
    if (now !== flagged) { flagged = now; host.setMonitorActive?.(now); }
  };

  const configure = (buses: readonly MonitorBus[], meteredNames?: Iterable<string>) => {
    order = buses.map((b) => b.name);
    parentOf = new Map(buses.map((b) => [b.name, b.parent ?? null]));
    metered = new Set(meteredNames ?? order);
    for (const s of [muted, soloed]) for (const n of [...s]) if (!known(n)) s.delete(n);
    for (const n of [...marks.keys()]) if (!known(n)) marks.delete(n);
  };
  configure([], []);

  const setMute = (bus: string, on: boolean): boolean => {
    if (!known(bus)) return false;
    if (muted.has(bus) === on) return true;
    if (on) muted.add(bus); else muted.delete(bus);
    host.setMonitor?.(bus, { mute: on });
    if (on) {
      const path = chain(bus);
      for (const n of path) mark(n, n === bus ? { kind: "mute", bus } : { kind: "mute-below", bus });
      const r = root();
      if (r !== null && !path.includes(r)) mark(r, { kind: "mute-below", bus });
      host.noteMonitorMute?.(bus);
    }
    syncActive();
    return true;
  };
  const setSolo = (bus: string, on: boolean): boolean => {
    if (!known(bus)) return false;
    if (soloed.has(bus) === on) return true;
    if (on) soloed.add(bus); else soloed.delete(bus);
    host.setMonitor?.(bus, { solo: on });
    if (on) {
      for (const n of order) mark(n, { kind: "solo", bus });
      host.noteMonitorSolo?.();
    }
    syncActive();
    return true;
  };

  return {
    setBuses: configure,
    setMute,
    toggleMute: (bus) => setMute(bus, !muted.has(bus)),
    setSolo,
    toggleSolo: (bus) => setSolo(bus, !soloed.has(bus)),
    clearAll() {
      for (const n of order) {
        const m = muted.delete(n), s = soloed.delete(n);
        if (m || s) host.setMonitor?.(n, { ...(m ? { mute: false } : {}), ...(s ? { solo: false } : {}) });
      }
      syncActive();
    },
    isMuted: (bus) => muted.has(bus),
    isSoloed: (bus) => soloed.has(bus),
    get active() { return isActive(); },
    audible(bus) {
      if (!known(bus)) return false;
      const path = chain(bus);
      if (path.some((n) => muted.has(n))) return false;
      if (soloed.size === 0) return true;
      if (path.some((n) => soloed.has(n))) return true;
      for (const s of soloed) if (chain(s).includes(bus)) return true;
      return false;
    },
    taint: (bus) => marks.get(bus) ?? [],
    taintedMeters: () => order.filter((n) => marks.has(n)),
    noteReset(what, bus) {
      if (what === "maxPeak") return;
      if (bus === undefined) marks.clear(); else marks.delete(bus);
    },
    notePlay(resetOnPlay) {
      if (resetOnPlay) marks.clear();
    },
  };
}
