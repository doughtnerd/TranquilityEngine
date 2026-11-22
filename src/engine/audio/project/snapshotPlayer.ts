/**
 * Internal (ADR 0330 "Snapshots blend"): which snapshots are on, and how far each has faded, over time. The mixer
 * (`mixer.ts`) owns one and evaluates it on the main thread; the blend itself is `resolveSnapshots` (`snapshots.ts`),
 * the model the Studio uses too.
 *
 * - **Start kinds.** `base` is on from the start and can't be stopped; `conditions` follows its conditions, evaluated
 *   when one of the parameters they read changes (`setParameter`); `code` starts and stops from game code
 *   (`Audio.snapshot(name).start()` / `.stop()`) and the shorthands; `never` only from an audition (it starts like `code`).
 * - **Fades.** Each snapshot's weight ramps linearly 0 → 1 over its fade in and 1 → 0 over its fade out, so its offsets
 *   (`dB × weight`) ramp linearly in dB. A fade interrupted part-way turns round from where it is, over the same share of
 *   its time (half-way in, stopped: half the fade-out). A start or stop can pass its own fade (the shorthands' seconds).
 * - **Hold.** A snapshot stays on at least `holdMs` from its start: a stop before then fades out when the hold ends.
 * - **Order.** "Started last" is the order of starts (a restart counts), which the blend's equal-priority rule reads.
 *
 * Times are seconds on the mixer's heard clock. Pure; no plugin, no DOM.
 */
import type { ParameterDef } from "../parameters";
import { resolveSnapshots, startHolds, startParameters, valueOf, type ActiveSnapshot, type ResolvedMix } from "./snapshots";
import type { Snapshot } from "./types";

/** One active snapshot's state. */
interface Entry {
  snapshot: Snapshot;
  /** Start order (grows on every start and restart). */
  order: number;
  /** Heard time of the (re)start: the hold counts from it. */
  startedAt: number;
  /** The weight ramp in: `from` at `startedAt` to 1 over `inSeconds`. */
  inFrom: number;
  inSeconds: number;
  /** Heard time the fade out begins (null: not stopping), at least `startedAt + hold`. */
  stopAt: number | null;
  outSeconds: number;
  /** Started by code (an API call or a shorthand), not by its base kind or its conditions. */
  byCode: boolean;
}

const seconds = (ms: number): number => Math.max(0, ms) / 1000;
const finiteOr = (v: number | undefined, fallback: number): number => (v !== undefined && Number.isFinite(v) && v >= 0 ? v : fallback);

export class SnapshotPlayer {
  private defs: Snapshot[] = [];
  private params: readonly ParameterDef[] = [];
  private values: Record<string, number> = {};
  private readonly entries = new Map<string, Entry>();
  private order = 0;

  /**
   * A new mix (a Play): every entry goes; `base` snapshots and `conditions` ones whose conditions hold now are on at full
   * weight at once (no fade at load), with parameter values from `values` (labels as their index) or the defaults.
   */
  configure(snapshots: readonly Snapshot[], parameters: readonly ParameterDef[], values: Readonly<Record<string, number>> = {}, now = 0): void {
    this.defs = snapshots.map((s) => s);
    this.params = parameters;
    this.values = { ...values };
    this.entries.clear();
    for (const s of this.defs) if (startHolds(s.start, this.params, this.values)) this.enter(s, now, 0, false);
  }

  /** The snapshot definitions. */
  get snapshots(): readonly Snapshot[] { return this.defs; }

  /**
   * The definitions changed while playing (a live edit): entries keep their fade state under their new definition (a
   * renamed one is matched by `renames`, old → new), a removed one leaves at once, a `base` one starts (fading in), one
   * that stopped being `base` stops, and `conditions` ones are evaluated again. Returns whether anything turned on or off.
   */
  setSnapshots(snapshots: readonly Snapshot[], parameters: readonly ParameterDef[], now: number, renames: ReadonlyMap<string, string> = new Map()): boolean {
    this.defs = snapshots.map((s) => s);
    this.params = parameters;
    let changed = false;
    for (const [name, e] of [...this.entries]) {
      const to = renames.get(name) ?? name;
      const def = this.defs.find((s) => s.name === to);
      this.entries.delete(name);
      if (!def) { changed = true; continue; }
      e.snapshot = def;
      this.entries.set(to, e);
    }
    for (const s of this.defs) changed = this.follow(s, now) || changed;
    return changed;
  }

  /** A global parameter changed (labels as their name or index): the `conditions` snapshots that read it follow. Returns whether one turned on or off. */
  setParameter(name: string, value: number | string, now: number): boolean {
    const def = this.params.find((p) => p.name === name);
    const v = valueOf(def, value);
    if (!Number.isFinite(v) || this.values[name] === v) return false;
    this.values[name] = v;
    let changed = false;
    for (const s of this.defs) if (startParameters(s.start).includes(name)) changed = this.follow(s, now) || changed;
    return changed;
  }

  /** A parameter's value as the conditions read it, or undefined. */
  parameter(name: string): number | undefined { return this.values[name]; }

  /** A `base` or `conditions` snapshot's own rule, applied now: on when it holds, off (fading) when it doesn't. */
  private follow(s: Snapshot, now: number): boolean {
    if (s.start.kind !== "base" && s.start.kind !== "conditions") return false;
    const e = this.entries.get(s.name);
    const want = startHolds(s.start, this.params, this.values);
    if (want && (!e || e.stopAt !== null)) return this.start(s.name, now, undefined, false);
    if (!want && e && e.stopAt === null && !e.byCode) return this.release(e, now, undefined);
    return false;
  }

  /**
   * Start `name` (fading in over `fadeSeconds`, else its own fade in). An entry fading out turns round; one already on
   * stays as it is. Returns whether it changed.
   */
  start(name: string, now: number, fadeSeconds?: number, byCode = true): boolean {
    const s = this.defs.find((d) => d.name === name);
    if (!s) return false;
    const e = this.entries.get(name);
    if (e && e.stopAt === null) {
      if (byCode) e.byCode = true;
      return false;
    }
    const full = finiteOr(fadeSeconds, seconds(s.fadeInMs));
    const w = e ? this.weightOf(e, now) : 0;
    this.enter(s, now, full * (1 - w), byCode, w);
    return true;
  }

  private enter(s: Snapshot, now: number, inSeconds: number, byCode: boolean, from = 1): void {
    this.entries.set(s.name, {
      snapshot: s, order: ++this.order, startedAt: now, inFrom: inSeconds > 0 ? from : 1, inSeconds,
      stopAt: null, outSeconds: 0, byCode,
    });
  }

  /** Stop `name` (fading out over `fadeSeconds`, else its own fade out, once its hold is over). A `base` snapshot can't stop. Returns whether it changed. */
  stop(name: string, now: number, fadeSeconds?: number): boolean {
    const e = this.entries.get(name);
    if (!e || e.stopAt !== null || e.snapshot.start.kind === "base") return false;
    // A conditions snapshot a script also started stays while its conditions hold.
    if (e.snapshot.start.kind === "conditions" && startHolds(e.snapshot.start, this.params, this.values)) {
      e.byCode = false;
      return false;
    }
    return this.release(e, now, fadeSeconds);
  }

  private release(e: Entry, now: number, fadeSeconds: number | undefined): boolean {
    const at = Math.max(now, e.startedAt + seconds(e.snapshot.holdMs));
    const w = this.inWeight(e, at);
    e.stopAt = at;
    e.outSeconds = finiteOr(fadeSeconds, seconds(e.snapshot.fadeOutMs)) * w;
    e.byCode = false;
    return true;
  }

  /** Stop every snapshot code started (`clearSnapshot`), but `except`. Returns whether any stopped. */
  stopCode(now: number, fadeSeconds?: number, except?: string): boolean {
    let changed = false;
    for (const e of [...this.entries.values()]) if (e.byCode && e.stopAt === null && e.snapshot.name !== except) changed = this.stop(e.snapshot.name, now, fadeSeconds) || changed;
    return changed;
  }

  /** Whether `name` is on at `now` (fading in, on, held, or fading out). */
  isActive(name: string, now: number): boolean {
    const e = this.entries.get(name);
    if (!e) return false;
    return e.stopAt === null || this.weightOf(e, now) > 0;
  }

  /** The snapshot code started last that isn't stopping, or null (`currentSnapshot`). */
  latestCode(): string | null {
    let best: Entry | null = null;
    for (const e of this.entries.values()) if (e.byCode && e.stopAt === null && (!best || e.order > best.order)) best = e;
    return best?.snapshot.name ?? null;
  }

  private inWeight(e: Entry, t: number): number {
    if (!(e.inSeconds > 0) || t >= e.startedAt + e.inSeconds) return 1;
    if (t <= e.startedAt) return e.inFrom;
    return e.inFrom + (1 - e.inFrom) * ((t - e.startedAt) / e.inSeconds);
  }

  private weightOf(e: Entry, t: number): number {
    const w = this.inWeight(e, Math.min(t, e.stopAt ?? t));
    if (e.stopAt === null || t < e.stopAt) return w;
    if (!(e.outSeconds > 0)) return 0;
    return Math.max(0, w * (1 - (t - e.stopAt) / e.outSeconds));
  }

  /** The snapshots on at `t`, oldest start first, with their weights (`resolveSnapshots`' input). */
  activeAt(t: number): ActiveSnapshot[] {
    const out: { snapshot: Snapshot; weight: number; order: number }[] = [];
    for (const e of this.entries.values()) {
      const weight = this.weightOf(e, t);
      if (weight > 0) out.push({ snapshot: e.snapshot, weight, order: e.order });
    }
    return out.sort((a, b) => a.order - b.order).map(({ snapshot, weight }) => ({ snapshot, weight }));
  }

  /** The blended mix at `t`; `base` gives an effect parameter's base value, so a fading override blends from it. */
  resolveAt(t: number, base?: (bus: string, effectId: string, param: string) => number | undefined): ResolvedMix {
    return resolveSnapshots(this.activeAt(t), base);
  }

  /** Move every time by `dt` seconds (the mixer's clock was swapped): each fade keeps its remaining length. */
  shift(dt: number): void {
    if (!Number.isFinite(dt) || dt === 0) return;
    for (const e of this.entries.values()) {
      e.startedAt += dt;
      if (e.stopAt !== null) e.stopAt += dt;
    }
  }

  /** Drop the entries whose fade out ended by `now`. */
  prune(now: number): void {
    for (const [name, e] of this.entries) if (e.stopAt !== null && now >= e.stopAt + e.outSeconds) this.entries.delete(name);
  }

  /**
   * The next time after `now` a weight's ramp starts, ends or turns (a fade's end, a held stop's fade-out start), or
   * Infinity when every weight is settled: between two such times every weight is linear in time.
   */
  nextBreak(now: number): number {
    let next = Number.POSITIVE_INFINITY;
    const consider = (t: number) => { if (t > now && t < next) next = t; };
    for (const e of this.entries.values()) {
      if (e.inSeconds > 0) consider(e.startedAt + e.inSeconds);
      if (e.stopAt !== null) { consider(e.stopAt); consider(e.stopAt + e.outSeconds); }
    }
    return next;
  }
}
