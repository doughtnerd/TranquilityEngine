// ADR 0171 amended by 0172 (M5, task Ld4; api-and-models §1.1, §3.2, architecture §4.4): the loudness hub.
// `feed(status)` runs in the STATUS handler after the mirror and the recorder and writes each metered bus's stable
// `BusLoudness` in place (through Ld3's `LoudnessStats`, `mix/loudnessStats.ts`); the hub registers on the mixer as
// its `LoudnessSource` (`attach`, Mx1's `setLoudnessSource`); `Audio.loudnessTarget` names the target in force.
//
// Wiring the coordinator owns (single-writer files): `configure` on project load and on a live edit of the buses'
// `meter`, `loudnessTargets` or `loudnessResetOnPlay` (the same list `LOUD_CONFIG` carries); `feed` in the STATUS
// handler; `epoch` on an EPOCH; `play` at the editor's Play; the suspension and taint inputs from the Mixer panel
// (`noteMonitorMute`, `noteMonitorSolo`, `setCompare`, `setMonitorActive`) and from the backend (`setMasterNotUnity`,
// `setMuted`).
//
// Rules, ADR 0172 §1.9 and owner decision 5:
// - `tainted` comes from monitor controls and Compare only: a monitor mute of X taints X, its ancestors and master; a
//   monitor solo and Compare taint every meter. MASTER not 1, script and authored mutes and the hidden-tab mute do
//   NOT taint.
// - Those four, and any monitor control or Compare, put `target.state` at `"suspended"` (the editor shows "paused").
//   Suspended wins over `"waiting"`: a check that is not running has no verdict to wait for.
// - Zero allocation per STATUS block: every `BusLoudness`, `LoudnessStats` and target reading is built in
//   `configure`; `feed` only writes into them.
import { type BusLoudness, type LoudnessResetWhat, type LoudnessSource, type LoudnessTargetReading, type LoudnessTargetState } from "../../../../engine/audio/loudnessTypes";
import type { LoudnessTarget } from "../../../../engine/audio/settings";
import { DEFAULT_LOUDNESS_TARGETS } from "../../../../engine/audio/mixOps";
import { LOUD_FLAG_NEW_BLOCKS_MASK, LOUD_FLAG_RESET, LOUD_OUTPUT_TAP, type StatusBlock } from "../wire.generated";
import { LoudnessFeedControl, LoudnessStats } from "./loudnessStats";
import { NULL_PROFILE_SINK } from "./profileSink";
import { taps } from "./profileTaps";

/** One bus as the hub needs it. `slot` is the bus's core slot (the `LOUD_CONFIG` item); the root's is unused (it reads `LOUD_OUTPUT_TAP`). */
export interface LoudnessBusInfo {
  name: string;
  /** Parent bus name; null for the root. */
  parent: string | null;
  slot: number;
  /** `meter: "loudness"` in the project. The root is always metered and ignores this. */
  metered: boolean;
}

export interface LoudnessHubConfig {
  /** False on the Babylon fallback (`mixCaps.loudness`): no meter exists, every bus reads the inert object. */
  available: boolean;
  /** The root bus's name (reads the final output). */
  root: string;
  buses: readonly LoudnessBusInfo[];
  /** `audio.loudnessTargets` (default `DEFAULT_LOUDNESS_TARGETS`); the first is the default target. */
  targets?: readonly LoudnessTarget[];
  /** `audio.loudnessResetOnPlay` (default true). */
  resetOnPlay?: boolean;
}

/** The conditions that suspend the target check without tainting. */
export type LoudnessSuspension = "monitor" | "compare" | "masterNotUnity" | "mutes";

/** The true-peak gate sits this far below the selected ceiling (`LOUD_CONFIG.tpGateDbfs`, api §4.2). */
export const TP_GATE_BELOW_CEILING_DB = 6;

class TargetReading implements LoudnessTargetReading {
  name = "";
  integrated = 0;
  tolerance = 0;
  truePeak = 0;
  deviation = Number.NEGATIVE_INFINITY;
  state: LoudnessTargetState = "waiting";
  peakOver = false;
}

/** One metered bus (or the output): the stable `BusLoudness` a script may keep. */
class Meter implements BusLoudness {
  readonly stats = new LoudnessStats();
  /** The pause bookkeeping and the first-take rule, shared with the profiler's model (`loudnessTrackModel.ts`). */
  readonly feed = new LoudnessFeedControl(this.stats);
  private readonly reading = new TargetReading();
  hasTarget = false;
  /** Cumulative `gatedQuanta` last seen; -1 before the first feed. */
  gatedSeen = -1;
  /** A true-peak quantum was gated off since the last peak reset. */
  gatedSincePeakReset = false;
  slot = 0;

  constructor(readonly name: string, private readonly hub: LoudnessHub) {}

  get momentary(): number { return this.stats.momentary; }
  get shortTerm(): number { return this.stats.shortTerm; }
  get integrated(): number { return this.stats.integrated; }
  get lra(): number { return this.stats.lra; }
  get maxTruePeak(): number { return this.stats.maxTruePeak; }
  get truePeakBound(): "exact" | "lowerBound" {
    if (!this.gatedSincePeakReset) return "exact";
    return this.hasTarget && !(this.stats.maxTruePeak < this.reading.truePeak) ? "exact" : "lowerBound";
  }
  get maxMomentary(): number { return this.stats.maxMomentary; }
  get elapsed(): number { return this.stats.elapsed; }
  get metered(): boolean { return true; }
  get paused(): boolean { return this.stats.paused; }
  get pausedBy(): "script" | "ladder" | null { return this.feed.ladderPaused ? "ladder" : this.feed.scriptPaused ? "script" : null; }
  get incomplete(): boolean { return this.stats.incomplete; }
  get tainted(): boolean { return this.stats.tainted; }
  get target(): LoudnessTargetReading | null { return this.hasTarget ? this.reading : null; }

  reset(what: LoudnessResetWhat = "all"): void {
    const sink = taps.sink;
    if (sink !== NULL_PROFILE_SINK) sink.loudnessControl("reset", this.name);
    this.clear(what);
  }
  /** A reset without the profiler's tap (the editor's Play resets every meter itself, not a script or the panel). */
  clear(what: LoudnessResetWhat): void {
    this.stats.reset(what);
    if (what === "maxPeak" || what === "all") this.gatedSincePeakReset = false;
    this.refresh();
  }
  pause(): void {
    const sink = taps.sink;
    if (sink !== NULL_PROFILE_SINK) sink.loudnessControl("pause", this.name);
    this.feed.setScriptPaused(true);
  }
  resume(): void {
    const sink = taps.sink;
    if (sink !== NULL_PROFILE_SINK) sink.loudnessControl("resume", this.name);
    this.feed.setScriptPaused(false);
  }

  setTarget(t: LoudnessTarget | null): void {
    this.hasTarget = t !== null;
    if (t) {
      this.reading.name = t.name;
      this.reading.integrated = t.integrated;
      this.reading.tolerance = t.tolerance;
      this.reading.truePeak = t.truePeak;
    }
    this.refresh();
  }

  /** Rewrites the target reading from the stats and the hub's suspension; allocates nothing. */
  refresh(): void {
    if (!this.hasTarget) return;
    const r = this.reading;
    const i = this.stats.integrated;
    r.deviation = i > Number.NEGATIVE_INFINITY ? i - r.integrated : Number.NEGATIVE_INFINITY;
    r.peakOver = this.stats.maxTruePeak > r.truePeak;
    if (this.hub.isSuspended) r.state = "suspended";
    else if (r.deviation === Number.NEGATIVE_INFINITY) r.state = "waiting";
    else if (r.deviation > r.tolerance) r.state = "high";
    else if (r.deviation < -r.tolerance) r.state = "low";
    else r.state = "ok";
  }
}

export class LoudnessHub implements LoudnessSource {
  private available = false;
  private rootName = "";
  private meters: Meter[] = [];
  private byName = new Map<string, Meter>();
  private parents = new Map<string, string | null>();
  private targets: LoudnessTarget[] = DEFAULT_LOUDNESS_TARGETS.map((t) => ({ ...t }));
  private targetName: string | null = this.targets[0].name;
  private resetOnPlay = true;
  private ladderOn = false;
  /** The ladder's steps as last fed: the loudness step (`loudShed`) and the bed and zone steps (`m3Shed`). */
  private ladderLoud = 0;
  private ladderAudible = 0;
  private readonly suspended: Record<LoudnessSuspension, boolean> = { monitor: false, compare: false, masterNotUnity: false, mutes: false };
  private gateSink: ((tpGateDbfs: number) => void) | null = null;

  /** Registers the hub as the mixer's loudness source (`mixer.setLoudnessSource`). */
  attach(mixer: { setLoudnessSource(source: LoudnessSource | null): void }): void {
    mixer.setLoudnessSource(this);
  }

  /** Where a target change re-sends `LOUD_CONFIG`'s true-peak gate (the selected ceiling minus 6 dB); not a reset. Called with the gate now in force at once. */
  setGateSink(sink: ((tpGateDbfs: number) => void) | null): void {
    this.gateSink = sink;
  }

  /** The `LOUD_CONFIG` gate for the target in force (the first target's when none is selected). */
  get tpGateDbfs(): number {
    const t = this.currentTarget();
    return (t ? t.truePeak : -1) - TP_GATE_BELOW_CEILING_DB;
  }

  /**
   * Project load or a live edit of the metered set, the targets or the option. Meters that stay keep their state
   * (and their object); new ones start empty; removed ones stop reading (the inert object). The selected target
   * stays when the new list still has it, else falls back to the first. `available: false` is the Babylon shape.
   */
  configure(cfg: LoudnessHubConfig): void {
    this.available = cfg.available;
    this.rootName = cfg.root;
    this.resetOnPlay = cfg.resetOnPlay ?? true;
    this.targets = (cfg.targets && cfg.targets.length > 0 ? cfg.targets : DEFAULT_LOUDNESS_TARGETS).map((t) => ({ ...t }));
    if (this.targetName === null || !this.targets.some((t) => t.name === this.targetName)) this.targetName = this.targets[0].name;
    this.parents.clear();
    for (const b of cfg.buses) this.parents.set(b.name, b.parent);

    const next: Meter[] = [];
    if (cfg.available) {
      const want: LoudnessBusInfo[] = [];
      for (const b of cfg.buses) if (b.name === cfg.root || b.metered) want.push(b);
      if (!want.some((b) => b.name === cfg.root)) want.unshift({ name: cfg.root, parent: null, slot: LOUD_OUTPUT_TAP, metered: true });
      for (const b of want) {
        let m = this.byName.get(b.name);
        if (!m || !this.meters.includes(m)) m = new Meter(b.name, this);
        m.slot = b.name === cfg.root ? LOUD_OUTPUT_TAP : b.slot;
        next.push(m);
      }
    }
    this.meters = next;
    this.byName = new Map(next.map((m) => [m.name, m]));
    this.applyTarget();
  }

  /** The `LoudnessSource` the mixer reads: the live object, or null (inert) for an unmetered or missing bus and on the Babylon shape. */
  busLoudness(bus: string): BusLoudness | null {
    return this.byName.get(bus) ?? null;
  }

  /** Ld4: one STATUS block's loudness sections (no allocation per block). */
  feed(status: StatusBlock): void {
    if (status.loudShed !== this.ladderLoud || status.m3Shed !== this.ladderAudible) this.noteLadder(status.loudShed, status.m3Shed);
    if (!this.available) return;
    const shed = status.loudShed !== 0;
    if (shed !== this.ladderOn) this.setLadder(shed);
    const items = status.loudBuses;
    const energies = status.loudEnergies;
    let off = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let count = it.flags & LOUD_FLAG_NEW_BLOCKS_MASK;
      if (off + count > energies.length) count = Math.max(0, energies.length - off);
      const m = this.meterOfSlot(it.slot);
      if (m) {
        // A core-side reset (a rebuild's fresh sequence) restarts the feed like an EPOCH: gated blocks and maxima stay.
        // A new meter's first take is flagged too (its sequence starts at 0, as a fresh feed expects): not a gap.
        m.feed.beginTake((it.flags & LOUD_FLAG_RESET) !== 0);
        m.stats.takeBlock(it.firstSeq, energies, off, count);
        m.stats.notePeak(it.truePeak);
        if (m.gatedSeen >= 0 && it.gatedQuanta > m.gatedSeen) m.gatedSincePeakReset = true;
        m.gatedSeen = it.gatedQuanta;
      }
      off += count;
    }
    for (let i = 0; i < this.meters.length; i++) this.meters[i].refresh();
  }

  /** An EPOCH (a rebuild): feeds reseed, histograms and maxima stay, `incomplete` is set. */
  epoch(): void {
    // A new core starts with no ladder step; the EPOCH record marks the break, so no "restored" is reported for it.
    this.ladderLoud = 0;
    this.ladderAudible = 0;
    for (let i = 0; i < this.meters.length; i++) {
      this.meters[i].stats.epoch();
      this.meters[i].gatedSeen = -1;
      this.meters[i].refresh();
    }
  }

  /** The editor's Play: with `loudnessResetOnPlay` (default true) every meter resets (`"all"`, which also clears both flags). */
  play(): void {
    if (!this.resetOnPlay) return;
    for (let i = 0; i < this.meters.length; i++) this.meters[i].clear("all");
  }

  // ---- suspension and taint (ADR 0172 §1.9, decision 5) ----

  /** True while any condition suspends the target check. */
  get isSuspended(): boolean {
    const s = this.suspended;
    return s.monitor || s.compare || s.masterNotUnity || s.mutes;
  }

  /** A monitor control (mute or solo) is on. Suspends; does not taint by itself (see `noteMonitorMute`, `noteMonitorSolo`). */
  setMonitorActive(on: boolean): void { this.setSuspension("monitor", on); }
  /** Compare is active: suspends, and taints every meter when it turns on. */
  setCompare(on: boolean): void {
    if (on) this.taintAll();
    this.setSuspension("compare", on);
  }
  /** MASTER is not 1: suspends only. */
  setMasterNotUnity(on: boolean): void { this.setSuspension("masterNotUnity", on); }
  /** A script, authored or hidden-tab mute is in force: suspends only. */
  setMuted(on: boolean): void { this.setSuspension("mutes", on); }

  /** A monitor mute of `bus` happened: taints that bus, its ancestors and the output (an unmetered one has no meter to taint). */
  noteMonitorMute(bus: string): void {
    const seen = new Set<string>();
    let b: string | null | undefined = bus;
    while (b != null && !seen.has(b)) {
      seen.add(b);
      this.byName.get(b)?.stats.taint();
      b = this.parents.get(b);
    }
    this.byName.get(this.rootName)?.stats.taint();
    this.refreshAll();
  }

  /** A monitor solo happened: taints every meter. */
  noteMonitorSolo(): void { this.taintAll(); }

  private taintAll(): void {
    for (let i = 0; i < this.meters.length; i++) this.meters[i].stats.taint();
    this.refreshAll();
  }

  private setSuspension(kind: LoudnessSuspension, on: boolean): void {
    if (this.suspended[kind] === on) return; // the backend calls it every frame
    this.suspended[kind] = on;
    this.refreshAll();
  }

  private refreshAll(): void {
    for (let i = 0; i < this.meters.length; i++) this.meters[i].refresh();
  }

  // ---- ladder ----

  /**
   * The profiler's ladder tap (§5.6 kind 17): one `ladder(step, shed)` per step taken or given back, `step` the ladder's
   * depth with that step in force (`loudShed` + `m3Shed`). The loudness step is the first taken and the last given back
   * (R21), so within one block a shed reports it before the bed and zone steps and a give-back after them.
   */
  private noteLadder(loud: number, audible: number): void {
    const sink = taps.sink;
    if (sink !== NULL_PROFILE_SINK) {
      let depth = this.ladderLoud + this.ladderAudible;
      for (let n = this.ladderAudible; n > audible; n--) sink.ladder(depth--, false);
      if (loud < this.ladderLoud) sink.ladder(depth--, false);
      if (loud > this.ladderLoud) sink.ladder(++depth, true);
      for (let n = this.ladderAudible; n < audible; n++) sink.ladder(++depth, true);
    }
    this.ladderLoud = loud;
    this.ladderAudible = audible;
  }

  /** `loudShed` changed: the ladder's loudness step pauses every meter but the output's (master keeps metering, ARCH §4.8). */
  private setLadder(on: boolean): void {
    this.ladderOn = on;
    for (let i = 0; i < this.meters.length; i++) this.meters[i].feed.setLadder(on, this.meters[i].slot === LOUD_OUTPUT_TAP);
  }

  private meterOfSlot(slot: number): Meter | null {
    for (let i = 0; i < this.meters.length; i++) if (this.meters[i].slot === slot) return this.meters[i];
    return null;
  }

  // ---- targets ----

  private currentTarget(): LoudnessTarget | null {
    if (this.targetName === null) return null;
    for (const t of this.targets) if (t.name === this.targetName) return t;
    return null;
  }

  private applyTarget(): void {
    const t = this.currentTarget();
    for (const m of this.meters) m.setTarget(t);
  }

  /** The entry of `audio.loudnessTargets` in force (default the first). */
  get target(): string | null {
    return this.targetName;
  }

  /** An unknown name is ignored with one warning; a change re-sends `LOUD_CONFIG`'s gate and is not a reset. `null` selects the first entry. */
  set target(name: string | null) {
    const t = name === null ? this.targets[0] : this.targets.find((x) => x.name === name);
    if (!t) {
      console.warn(`Audio.loudnessTarget: no loudness target named "${name}"; keeping "${this.targetName}".`);
      return;
    }
    const changed = t.name !== this.targetName;
    this.targetName = t.name;
    this.applyTarget();
    if (changed) {
      const sink = taps.sink;
      if (sink !== NULL_PROFILE_SINK) sink.loudnessControl("target", null);
      this.gateSink?.(this.tpGateDbfs);
    }
  }
}

/** The page's hub (Ld4 wires it to the core backend's STATUS and to the mixer). */
export const loudnessHub = new LoudnessHub();

/** `Audio.loudnessTarget` (§1.1). */
export function loudnessTarget(): string | null {
  return loudnessHub.target;
}

/** `Audio.loudnessTarget = name` (§1.1). */
export function setLoudnessTarget(name: string | null): void {
  loudnessHub.target = name;
}
