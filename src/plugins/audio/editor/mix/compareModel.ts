// "Compare with Play start" (ADR 0171 §6.6 and architecture §3.8, ADR 0172 decisions 5 and 9; task Mp1b): pure, no Preact.
//
// When Play begins the panel hands the model the project's `audio` section (`begin`); the model keeps a `structuredClone`.
// Toggling Compare on swaps the **saved** mix (that clone) in for the **edited** one: `diffOps(edited, saved)` applied live
// through the injected `apply` (origin "compare"), then `flushNow()` once, a MARKER, and the loudness hub told
// (`setCompare(true)`: taints every meter and suspends the target check). Toggling off applies `diffOps(saved, edited)`,
// where `edited` is the clone taken at the moment Compare turned on, so the edited mix comes back exactly (the diff of the
// result against the edited settings is empty for every live key; keys with no live path are in `restartRequired` and were
// never swapped).
//
// What it never does: commit, write the project, or touch the undo history (no section edit, no `recordMixOps`). The
// project's `audio` section stays the edited mix the whole time; Compare only changes what the running Engine plays.
// While it is active the faders are locked (`locked`): an edit in that window would be applied on top of the saved mix and
// the way back would then erase it.
//
// Across Play (§3.8): a new Play builds a new Engine from the project, i.e. from the edited mix, so a Compare in force
// simply ends (`begin` tells the hub `setCompare(false)`, applies nothing, writes no marker) and the snapshot is replaced by
// the new Play's start. Stop drops the snapshot (`end`), and Compare with it. Taint marks follow the meters' rule: they stay
// until a reset (`noteReset`) or a Play that resets (`notePlay`).
import { diffOps, type ApplyResult, type MixOp } from "../../../../engine/audio/mixOps";
import type { AudioSettings } from "../../../../engine/audio/settings";
import type { LoudnessResetWhat } from "../../../../engine/audio/loudnessTypes";

/** What the model calls: injected, so tests need neither a Mixer nor a hub. */
export interface CompareHost {
  /** `mixer.apply(op)`; `origin` is "compare" so a recorder can label the MIXOP record. Never an undo entry, never saved. */
  apply(op: MixOp, origin: "compare"): ApplyResult;
  /** The mixer's asap post: called once after the ops of a swap. */
  flushNow?(): void;
  /** The capture's MARKER (§5.3): one per swap. */
  marker?(text: string): void;
  /** `LoudnessHub.setCompare(on)`. */
  setCompare?(on: boolean): void;
}

export interface CompareOptions {
  readonly host: CompareHost;
  /** The project's current (edited) `audio` section, read at the moment of each toggle. */
  readonly current: () => AudioSettings;
}

export interface CompareSwap {
  /** Compare is on after this toggle. */
  readonly active: boolean;
  /** The ops applied, in order, and the mixer's answer to each. */
  readonly ops: readonly MixOp[];
  readonly results: readonly ApplyResult[];
  /** Ops the mixer refused or could not apply live (`ok` false). */
  readonly failed: number;
  /** Top-level keys with no live path (`diffOps`): they differ but were not swapped. */
  readonly restartRequired: readonly string[];
}

export interface CompareModel {
  /** Play started: keep a clone of `audio` as the saved mix; an active Compare ends without applying anything. */
  begin(audio: AudioSettings): void;
  /** Stop: drop the snapshot; an active Compare ends. */
  end(): void;
  /** A snapshot exists (Play is running). */
  readonly available: boolean;
  /** The saved and the edited mix differ in a way a swap would change (live ops) or report (restart-required keys). */
  differs(): boolean;
  /** Compare is showing the saved mix. */
  readonly active: boolean;
  /** Faders and edits are locked meanwhile. */
  readonly locked: boolean;
  /** Swap; null when there is no Play snapshot (nothing happens). */
  toggle(): CompareSwap | null;
  /** Compare has tainted every meter since the last reset (true while any meter still carries the mark). */
  readonly tainted: boolean;
  /** Whether `bus`'s meter still carries Compare's mark (a per-bus reset clears that meter only). */
  taintedFor(bus: string): boolean;
  /** A meter was reset (`bus` omitted: all): `"all"` and `"integrated"` clear the mark for every meter; `"maxPeak"` doesn't. */
  noteReset(what: LoudnessResetWhat, bus?: string): void;
  /** Play started; with `loudnessResetOnPlay` the meters reset and the mark clears. Call after `begin`. */
  notePlay(resetOnPlay: boolean): void;
}

const clone = <T>(v: T): T => structuredClone(v);

export function createCompareModel(options: CompareOptions): CompareModel {
  const host = options.host;
  let saved: AudioSettings | null = null;
  /** The edited mix, cloned when Compare turned on. */
  let edited: AudioSettings | null = null;
  let active = false;
  // Compare taints every meter; a per-bus reset of one meter keeps the mark on the others.
  const cleared = new Set<string>();
  let everTainted = false;

  const swap = (from: AudioSettings, to: AudioSettings, on: boolean, text: string): CompareSwap => {
    const { ops, restartRequired } = diffOps(from, to);
    if (on) host.setCompare?.(true);
    const results: ApplyResult[] = [];
    for (const op of ops) results.push(host.apply(op, "compare"));
    host.flushNow?.();
    host.marker?.(text);
    if (!on) host.setCompare?.(false);
    return { active: on, ops, results, failed: results.filter((r) => !r.ok).length, restartRequired };
  };

  const model: CompareModel = {
    begin(audio) {
      if (active) { active = false; edited = null; host.setCompare?.(false); }
      saved = clone(audio);
    },
    end() {
      if (active) { active = false; host.setCompare?.(false); }
      edited = null;
      saved = null;
    },
    get available() { return saved !== null; },
    differs() {
      if (!saved) return false;
      const base = active && edited ? edited : options.current();
      const d = diffOps(base, saved);
      return d.ops.length > 0 || d.restartRequired.length > 0;
    },
    get active() { return active; },
    get locked() { return active; },
    toggle() {
      if (!saved) return null;
      if (!active) {
        edited = clone(options.current());
        active = true;
        everTainted = true;
        cleared.clear();
        return swap(edited, saved, true, "Compare: saved mix (Play start)");
      }
      const back = edited ?? clone(options.current());
      active = false;
      edited = null;
      return swap(saved, back, false, "Compare: edited mix");
    },
    get tainted() { return everTainted; },
    taintedFor: (bus) => everTainted && !cleared.has(bus),
    noteReset(what, bus) {
      if (what === "maxPeak") return;
      if (bus === undefined) { everTainted = false; cleared.clear(); } else cleared.add(bus);
    },
    notePlay(resetOnPlay) {
      if (resetOnPlay) { everTainted = false; cleared.clear(); }
    },
  };
  return model;
}
