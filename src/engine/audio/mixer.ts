/**
 * The mixer's model (ADR 0097, amended by 0171 and 0172): a bus tree with volume, mute and solo, snapshots and
 * ducking. It is pure state plus per-frame maths; a backend (ADR 0098) turns the resolved state into sound (Babylon
 * audio buses, or the core's mix graph). Game code reaches it through `Audio.bus(name)`.
 *
 * **Gain lanes (ADR 0172 §1.3; design `architecture.md` §4.5).** A bus's gain is the product of seven lanes:
 * `authored` (the project's volume x authored mute), `runtime` (the script `volume`, its fade, x script mute),
 * `snapshot`, `monitor` (monitor mute x the solo gate), `dip` (the structural dip), all written here on main, and
 * `duck` and `automation`, owned by the core. Main keeps one `Ramp` record per lane it writes and evaluates them at
 * the **heard clock** (`setClock`; without one, the mixer's own clock advances by `update`'s `dt`), for the getters
 * and the audibility estimate. A fade is one ramp record, not one step per display frame.
 *
 * Until the core backend writes lanes itself (task Mx2), backends read `resolve`/`resolveAll`: one composed gain per
 * bus, the same number as before the split for the same inputs, re-sent on every frame a ramp moves.
 */
import { defaultAudioSettings, MASTER, type AudioSettings, type BusEffect, type BusSettings } from "./settings";
import { LoudnessView, EMPTY_BUS_LOUDNESS, type BusLoudness, type LoudnessSource } from "./loudnessTypes";

/** What a backend applies for one bus. */
export interface ResolvedBus {
  name: string;
  parent: string | null;
  /** This bus's own gain: the product of its main-side lanes, the duck and (Babylon) automation; 0 when muted or silenced by another bus's solo. */
  gain: number;
  /** `gain` times every ancestor's: the level a sound that can't go through the node graph is scaled by. */
  effectiveGain: number;
  effects: BusEffect[];
  /** Low-pass cutoff a snapshot is applying (Hz), or null. */
  snapshotLowpass: number | null;
}

/** Shortest ramp main asks of the core for a set, a toggle or a 0-second fade (the wire's `BUS_MIN_RAMP_MS`, §4.1). */
export const BUS_MIN_RAMP_MS = 5;

/** Lane ids, the wire's `LANE_*` constants (api-and-models §4.1). */
export const Lane = { authored: 0, runtime: 1, snapshot: 2, monitor: 3, dip: 4, duck: 5, automation: 6 } as const;
export type LaneId = (typeof Lane)[keyof typeof Lane];

export type RampLaw = "linear";

/**
 * One lane's ramp on the heard clock: `from` at `start`, `to` at `start + seconds`, linear between (§3.1). `seconds`
 * 0 is an asap write: main reads `to` at once and the lane writer ramps it over `BUS_MIN_RAMP_MS` (never an unramped
 * step). `seq` grows on every write, so a writer can tell which lanes moved since it last looked.
 */
export interface Ramp {
  from: number;
  to: number;
  /** Heard seconds (`Audio.time`'s base). */
  start: number;
  seconds: number;
  law: RampLaw;
  seq: number;
}

/** A ramp's value at heard time `now`. */
export function rampAt(r: Ramp, now: number): number {
  if (!(r.seconds > 0) || now >= r.start + r.seconds) return r.to;
  if (now <= r.start) return r.from;
  return r.from + (r.to - r.from) * ((now - r.start) / r.seconds);
}

/** Whether `r` changes value somewhere in (`a`, `b`]: a frame that spans any of it must re-send the mix. */
function rampMoves(r: Ramp, a: number, b: number): boolean {
  return r.from !== r.to && r.seconds > 0 && r.start < b && r.start + r.seconds > a;
}

/** The main-side lanes of one bus, for the lane writer (Mx2) and the editor's views. Read-only to them. */
export interface BusLanes {
  /** Core index (§6.3); the bus's list index until the slot table (Sm1) assigns it. */
  readonly slot: number;
  /** `authoredVolume`. */
  readonly authored: Readonly<Ramp>;
  readonly authoredMute: boolean;
  /** Script `volume` and its fade. */
  readonly runtime: Readonly<Ramp>;
  readonly runtimeMute: boolean;
  readonly runtimeSolo: boolean;
  readonly snapshot: Readonly<Ramp>;
  /** The snapshot's low-pass cutoff, Hz (`OFF_HZ`: none), ramped with it. */
  readonly snapshotLowpass: Readonly<Ramp>;
  readonly monitorMute: boolean;
  readonly monitorSolo: boolean;
  readonly dip: Readonly<Ramp>;
  /** The duck lane's value: STATUS's `busDuck` on the core backend (the duck source), main's presence computation on the Babylon fallback. */
  readonly duck: number;
}

interface BusState {
  settings: BusSettings;
  slot: number;
  authored: Ramp;
  authoredMute: boolean;
  runtime: Ramp;
  mute: boolean;
  solo: boolean;
  snapshot: Ramp;
  lp: Ramp;
  monitorMute: boolean;
  monitorSolo: boolean;
  dip: Ramp;
  duck: number;
  voices: number;
  /** Newest peak (max of L and R, linear), from the backend's status (A2.3). */
  peak: number;
  /** ADR 0158: bus automation from the TypeScript evaluator (the Babylon fallback only); 1 and OFF_HZ otherwise. */
  autoGain: number;
  autoLp: number;
  /** ADR 0158 §3 (M2 F2): bus automation the audio core applies itself, kept only so `effectiveGain` reports it; never sent to a backend. */
  viewGain: number;
  /** §1.1: allocated once per bus, a view over the registered loudness source. */
  loudness: BusLoudness;
}

const OFF_HZ = 24000;

/** The heard clock the mixer evaluates ramps on: seconds, `Audio.time`'s base. */
export type MixerClock = () => number;

/** ADR 0172 §1.1 (Dp1): where the duck lane is read from when the core computes it: a bus's gain (1 = not ducked). */
export type DuckSource = (bus: string) => number;

/** Monitor controls (§6.6): the Mixer panel's mute and solo, never saved, never set through `apply`. */
export interface MonitorControls {
  mute?: boolean;
  solo?: boolean;
}

import type { MixOp, ApplyResult } from "./mixOps"; // K0: api-and-models §6.2
/** What `mixer.apply` delegates to: the backend's `applyOp` (K0 declares it on `AudioBackend`, optional). */
export interface MixOpTarget { applyOp?(op: MixOp): ApplyResult }

/** A bus, as game code sees it: `Audio.bus("Music").volume = 0.5`. Unknown names give an inert bus. */
export class Bus {
  /** @internal */
  constructor(private mixer: Mixer, readonly name: string) {}
  private get s(): BusState | undefined { return this.mixer._state(this.name); }
  /** Whether the project has a bus with this name. */
  get exists(): boolean { return this.s !== undefined; }
  /**
   * Runtime multiplier, linear 0..2, default 1, set by scripts. Acts on top of `authoredVolume`; never written to
   * project.json. Authored 2 x runtime 2 = 4 is legal; the master limiter catches it. A fade in progress reads its
   * current value on the heard clock.
   */
  get volume(): number { const s = this.s; return s ? rampAt(s.runtime, this.mixer.time) : 0; }
  set volume(v: number) { this.mixer._setRuntime(this.name, v, 0); }
  /** The project's value (`audio.buses[i].volume`), read-only to scripts; the editor changes it through `mixer.apply`. */
  get authoredVolume(): number { const s = this.s; return s ? rampAt(s.authored, this.mixer.time) : 0; }
  /** Runtime switch set by scripts, default false; effective mute = authored mute OR this OR a monitor control. */
  get mute(): boolean { return this.s?.mute ?? false; }
  set mute(m: boolean) { const s = this.s; if (s && s.mute !== !!m) { s.mute = !!m; this.mixer._dirty(); } }
  /** While any bus is soloed, only soloed buses (and the buses they feed and pass through) are heard. Default false. */
  get solo(): boolean { return this.s?.solo ?? false; }
  set solo(m: boolean) { const s = this.s; if (s && s.solo !== !!m) { s.solo = !!m; this.mixer._dirty(); } }
  /** The project's mute (`audio.buses[i].mute`), read-only to scripts. */
  get authoredMute(): boolean { return this.s?.authoredMute ?? false; }
  /** Sounds playing on this bus right now. */
  get activeVoices(): number { return this.s?.voices ?? 0; }
  /** The newest peak level on this bus (max of L and R, linear, decayed for display); 0 while the audio is locked. Declared by A1.6 (K10); fed by the core backend from STATUS (0 on the Babylon backend). */
  get peak(): number { return this.s?.peak ?? 0; }
  /** Product of every gain up the tree, all seven lanes: the level reaching the speakers from this bus. */
  get effectiveGain(): number { return (this.mixer.resolve(this.name)?.effectiveGain ?? 0) * this.mixer._viewChain(this.name); }
  /** The duck lane's gain, 1 = not ducked, 0..1. On the core backend, STATUS's `busDuck` (a block old, ADR 0172 §1.1); on the Babylon fallback, main's presence-duck computation. */
  get duckGain(): number { const s = this.s; return s ? this.mixer._duckOf(this.name, s) : 1; }
  /** Ease `volume` to `v` over `seconds` (0 jumps over `BUS_MIN_RAMP_MS`, never an unramped step). One ramp record, not one per display frame. */
  fadeTo(v: number, seconds: number): void { this.mixer._setRuntime(this.name, v, seconds); }
  /** Loudness readings and controls; a stable object allocated once per bus, like `peak`. */
  get loudness(): BusLoudness { return this.s?.loudness ?? EMPTY_BUS_LOUDNESS; }
}

export class Mixer {
  private buses = new Map<string, BusState>();
  private order: string[] = [];
  private settings: AudioSettings = defaultAudioSettings();
  private listeners = new Set<() => void>();
  private changed = true;
  private snapshotName: string | null = null;
  private warned = new Set<string>();
  private clock: MixerClock | null = null;
  /**
   * Dp1 (Mx2's timing note): the heard time a stamped ramp written now starts at on the backend (the lane writer's stamp,
   * *F*_now + L, in heard seconds; NaN when unknown). Used only with `clock`.
   */
  private stampClock: MixerClock | null = null;
  /** Dp1: the core's duck lane (STATUS); null keeps main's presence computation (the Babylon fallback). */
  private duckSource: DuckSource | null = null;
  /** The mixer's own clock (no `setClock`): advanced by `update`'s `dt`. */
  private ownTime = 0;
  /** Heard time at the last `update`: ramps moving since then re-send the mix. */
  private lastUpdate = 0;
  private seq = 0;
  private loudnessSource: LoudnessSource | null = null;
  private opTarget: MixOpTarget | null = null;

  constructor(settings: AudioSettings = defaultAudioSettings()) { this.configure(settings); }

  /** Replace the bus tree (project load). Every script value (volume, fades, mute, solo, the snapshot) and every monitor control resets; authored values come from `settings`. */
  configure(settings: AudioSettings): void {
    this.settings = settings;
    this.buses.clear();
    this.snapshotName = null;
    this.order = settings.buses.map((b) => b.name);
    const now = this.time;
    this.lastUpdate = now;
    settings.buses.forEach((b, i) => {
      const name = b.name;
      this.buses.set(name, {
        settings: b, slot: i,
        authored: this.ramp(b.volume, b.volume, now, 0), authoredMute: b.mute,
        runtime: this.ramp(1, 1, now, 0), mute: false, solo: false,
        snapshot: this.ramp(1, 1, now, 0), lp: this.ramp(OFF_HZ, OFF_HZ, now, 0),
        monitorMute: false, monitorSolo: false,
        dip: this.ramp(1, 1, now, 0),
        duck: 1, voices: 0, peak: 0, autoGain: 1, autoLp: OFF_HZ, viewGain: 1,
        loudness: new LoudnessView(() => this.loudnessSource?.busLoudness(name) ?? null),
      });
    });
    this._dirty();
  }

  /** The project's audio settings this mixer was configured with (the backend selector, K3, reads `backend` from it). */
  get audioSettings(): AudioSettings { return this.settings; }
  get busNames(): readonly string[] { return this.order; }
  get currentSnapshot(): string | null { return this.snapshotName; }
  get snapshotNames(): string[] { return this.settings.snapshots.map((s) => s.name); }

  /** The heard clock ramps are evaluated on: the registered clock, else the mixer's own (`update`'s `dt` summed). */
  get time(): number {
    if (!this.clock) return this.ownTime;
    const t = this.clock();
    return Number.isFinite(t) ? t : this.ownTime;
  }
  /**
   * Evaluate ramps on `clock` (the backend's heard clock, `Audio.time`'s base), or on the mixer's own `dt` clock with
   * null. Ramps keep their records: a running fade continues from where it reads on the new clock. `stamp` (with a
   * clock) gives the heard time a ramp written now starts at on the backend: a ramp with a length starts there, so a
   * getter during a fade reads the value being heard (the core starts it at its stamp, not at the call).
   */
  setClock(clock: MixerClock | null, stamp: MixerClock | null = null): void {
    this.stampClock = clock ? stamp : null;
    const now = this.time;
    // Re-anchor every running ramp so it keeps its remaining length on the new clock.
    const next = clock ? clock() : this.ownTime;
    const at = Number.isFinite(next) ? next : now;
    for (const s of this.buses.values()) for (const r of [s.authored, s.runtime, s.snapshot, s.lp, s.dip]) rebase(r, now, at);
    this.clock = clock;
    this.lastUpdate = at;
    if (!clock) this.ownTime = at;
  }

  /** Register (or with null, remove) where `Bus.loudness` reads from: the loudness hub (Ld4). */
  setLoudnessSource(source: LoudnessSource | null): void { this.loudnessSource = source; }

  /**
   * @internal Dp1 (ADR 0172 §1.1): the core computes presence ducks; `source` reads its duck lane per bus (STATUS's
   * `busDuck`). While set, main stops computing presence ducks and every duck read (`Bus.duckGain`, `resolve`, the lanes)
   * is the source's; null (the Babylon fallback) computes them on main again, from 1.
   */
  _setDuckSource(source: DuckSource | null): void {
    if (source === this.duckSource) return;
    this.duckSource = source;
    for (const s of this.buses.values()) s.duck = 1;
    this._dirty();
  }
  /** @internal The duck lane of bus `name` (state `s`): the source's, else main's. */
  _duckOf(name: string, s: BusState): number {
    if (!this.duckSource) return s.duck;
    const g = this.duckSource(name);
    return Number.isFinite(g) ? Math.min(1, Math.max(0, g)) : 1;
  }

  /** @internal Register what `apply` delegates to: the backend (K0 wires it). */
  _setOpTarget(target: MixOpTarget | null): void { this.opTarget = target; }

  /**
   * Apply an edit while the project plays (§6): the editor's live path. Unlike `configure` it keeps every script value.
   * Delegates to the backend's `applyOp`; Ma1 fills the main-side model (authored values, slot table, lane records).
   */
  apply(op: MixOp): ApplyResult {
    const r = this.opTarget?.applyOp?.(op);
    return r ?? { ok: false, class: "none", restartRequired: "no live audio backend" };
  }

  /** §6.6: the Mixer panel's monitor mute and solo for `bus` (the `monitor` lane), never saved, never through `apply`. */
  setMonitor(bus: string, controls: MonitorControls): void {
    const s = this.buses.get(bus);
    if (!s) return;
    let moved = false;
    if (controls.mute !== undefined && s.monitorMute !== controls.mute) { s.monitorMute = controls.mute; moved = true; }
    if (controls.solo !== undefined && s.monitorSolo !== controls.solo) { s.monitorSolo = controls.solo; moved = true; }
    if (moved) this._dirty();
  }
  /** Whether any monitor control is on (meters are tainted, targets suspended, §1.1). */
  get monitorActive(): boolean { for (const s of this.buses.values()) if (s.monitorMute || s.monitorSolo) return true; return false; }

  /** @internal */
  _state(name: string): BusState | undefined { return this.buses.get(name); }
  /** @internal The main-side lanes of `name`, for the lane writer (Mx2). */
  _lanes(name: string): BusLanes | undefined {
    const s = this.buses.get(name);
    if (!s) return undefined;
    return {
      slot: s.slot, authored: s.authored, authoredMute: s.authoredMute, runtime: s.runtime, runtimeMute: s.mute, runtimeSolo: s.solo,
      snapshot: s.snapshot, snapshotLowpass: s.lp, monitorMute: s.monitorMute, monitorSolo: s.monitorSolo, dip: s.dip, duck: this._duckOf(name, s),
    };
  }
  /** @internal One lane's gain for `name` at the heard clock (`automation`: main's Babylon-fallback estimate times the core's view). */
  laneGain(name: string, lane: LaneId): number {
    const s = this.buses.get(name);
    if (!s) return 0;
    const now = this.time;
    switch (lane) {
      case Lane.authored: return s.authoredMute ? 0 : rampAt(s.authored, now);
      case Lane.runtime: return s.mute ? 0 : rampAt(s.runtime, now);
      case Lane.snapshot: return rampAt(s.snapshot, now);
      case Lane.monitor: return s.monitorMute || (this.anySolo() && !this.audibleUnderSolo(name)) ? 0 : 1;
      case Lane.dip: return rampAt(s.dip, now);
      case Lane.duck: return this._duckOf(name, s);
      default: return s.autoGain * s.viewGain;
    }
  }
  /** @internal The structural dip (§6.5, the slot table's): ease `name`'s dip lane to `to` over `seconds`. */
  _setDip(name: string, to: number, seconds: number): void {
    const s = this.buses.get(name);
    if (s) this.retarget(s.dip, Math.min(1, Math.max(0, to)), seconds);
  }
  /** @internal */
  _dirty(): void { this.changed = true; }
  /** @internal A2.3: the backend reports a bus's peak. */
  _setPeak(name: string, peak: number): void { const s = this.buses.get(name); if (s) s.peak = peak; }
  /**
   * @internal ADR 0158: bus automation computed on main, used only where the backend can't run it itself (the
   * TypeScript evaluator on the Babylon fallback). The core applies BUS_AUTOMATE in the audio thread and never calls this.
   */
  _setAutomation(name: string, gain: number, lowpass: number): void {
    const s = this.buses.get(name);
    if (!s || (s.autoGain === gain && s.autoLp === lowpass)) return;
    s.autoGain = gain;
    s.autoLp = lowpass;
    this._dirty();
  }
  /**
   * @internal ADR 0158 §3 (M2 F2): bus automation the core applies in the audio thread, as main estimates it. It only
   * shows in `Bus.effectiveGain` (multiplied with snapshots, ducking and parents); `resolve` leaves it out, since the
   * core applies it itself and a backend must not apply it twice. No change notification: nothing is re-applied.
   */
  _setAutomationView(name: string, gain: number): void {
    const s = this.buses.get(name);
    if (s) s.viewGain = gain;
  }
  /** @internal The view gains of `name` and its ancestors, multiplied. */
  _viewChain(name: string): number {
    let g = 1;
    for (const n of this.chain(name)) g *= this.buses.get(n)?.viewGain ?? 1;
    return g;
  }
  /** @internal A2.3: the core backend resets a bus's live-voice count to the core mirror's (after a bus remap, which reconfigures the mixer and zeroes counts). */
  _setVoiceCount(name: string, n: number): void { const s = this.buses.get(name); if (s) s.voices = Math.max(0, n | 0); }

  bus(name: string = MASTER): Bus {
    if (!this.buses.has(name) && !this.warned.has(name)) {
      this.warned.add(name);
      console.warn(`[myco] unknown audio bus "${name}". Buses: ${this.order.join(", ")}.`);
    }
    return new Bus(this, name);
  }
  has(name: string): boolean { return this.buses.has(name); }
  /** The bus a sound with this output plays on: itself, else the root (with a warning). */
  resolveOutput(name: string | undefined): string {
    if (!name) return this.order[0] ?? MASTER;
    if (this.buses.has(name)) return name;
    this.bus(name); // warns once
    return this.order[0] ?? MASTER;
  }

  /** @internal Backends call these as sounds start and end, which is what ducking listens to. */
  voiceStarted(name: string): void { const s = this.buses.get(name); if (s) s.voices++; }
  voiceEnded(name: string): void { this.voicesEnded++; const s = this.buses.get(name); if (s && s.voices > 0) s.voices--; }
  /** @internal Voices that have ended (or left a bus) since the page began, whichever backend counted them: the event runtime retires instances when this moves, instead of scanning every frame (ADR 0158 §6). */
  voicesEnded = 0;

  /** Fade to a named snapshot (`seconds` 0 = at once, over `BUS_MIN_RAMP_MS` in the core): one ramp per bus on the snapshot lane. */
  snapshot(name: string, seconds = 0.5): void {
    const snap = this.settings.snapshots.find((s) => s.name === name);
    if (!snap) { console.warn(`[myco] unknown audio snapshot "${name}". Snapshots: ${this.snapshotNames.join(", ") || "none"}.`); return; }
    this.snapshotName = name;
    for (const [bus, s] of this.buses) { this.retarget(s.snapshot, snap.volumes[bus] ?? 1, seconds); this.retarget(s.lp, snap.lowpass[bus] ?? OFF_HZ, seconds); }
  }
  /** Fade back to the plain mix. */
  clearSnapshot(seconds = 0.5): void {
    this.snapshotName = null;
    for (const s of this.buses.values()) { this.retarget(s.snapshot, 1, seconds); this.retarget(s.lp, OFF_HZ, seconds); }
  }

  /** @internal `Bus.volume` (`seconds` 0) and `Bus.fadeTo`: one ramp on the runtime lane, clamped to 0..2. */
  _setRuntime(name: string, v: number, seconds: number): void {
    const s = this.buses.get(name);
    if (s) this.retarget(s.runtime, Math.min(2, Math.max(0, Number.isFinite(v) ? v : 0)), seconds);
  }

  /** A new ramp on `r` from its value now to `to` over `seconds` (non-finite or <= 0: asap). Re-setting a settled lane to its value writes nothing. */
  private retarget(r: Ramp, to: number, seconds: number): void {
    const now = this.time;
    const dur = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    // A ramp with a length starts where the backend stamps it (Dp1): from the lane's value there.
    let start = now;
    if (dur > 0 && this.clock && this.stampClock) {
      const at = this.stampClock();
      if (Number.isFinite(at) && at > now) start = at;
    }
    const from = rampAt(r, start);
    if (from === to && r.to === to) return;
    r.from = from; r.to = to; r.start = start; r.seconds = dur; r.law = "linear"; r.seq = ++this.seq;
    this._dirty();
  }
  private ramp(from: number, to: number, start: number, seconds: number): Ramp {
    return { from, to, start, seconds, law: "linear", seq: ++this.seq };
  }

  /** Advance the clock (when the mixer keeps its own) and ducking by `dt` seconds; tells listeners if anything moved. */
  update(dt: number): void {
    if (dt > 0 && !this.clock) this.ownTime += dt;
    const now = this.time;
    const prev = this.lastUpdate;
    const hdt = now - prev;
    this.lastUpdate = now;
    if (hdt > 0) {
      for (const s of this.buses.values()) {
        if (rampMoves(s.authored, prev, now) || rampMoves(s.runtime, prev, now) || rampMoves(s.snapshot, prev, now) || rampMoves(s.lp, prev, now) || rampMoves(s.dip, prev, now)) {
          this._dirty();
          break;
        }
      }
      if (this.duckSource) this.followDuckSource();
      else this.presenceDuck(hdt);
    }
    if (this.changed) {
      this.changed = false;
      for (const l of this.listeners) l();
    }
  }

  /** Dp1: the core's duck lane moved (a new STATUS): listeners re-read the mix (selection's audibility uses it). */
  private followDuckSource(): void {
    for (const [name, s] of this.buses) {
      const g = this._duckOf(name, s);
      if (g !== s.duck) {
        s.duck = g;
        this._dirty();
      }
    }
  }

  /**
   * Presence ducking on main, the Babylon fallback's (on the core backend the core computes it, `_setDuckSource`): each bus heads for the
   * lowest multiplier any rule with a playing trigger asks for, easing `dt / attack` (or the longest `release`) of the way.
   */
  private presenceDuck(dt: number): void {
    const rules = this.settings.ducking.filter((r) => (r as { mode?: string }).mode !== "level");
    for (const [name, s] of this.buses) {
      let goal = 1, time = 0.5;
      for (const r of rules) {
        if (r.target !== name || (this.buses.get(r.trigger)?.voices ?? 0) === 0) continue;
        if (r.amount < goal) { goal = r.amount; time = r.attack; }
      }
      if (goal === 1) time = rules.filter((r) => r.target === name).reduce((m, r) => Math.max(m, r.release), 0);
      if (s.duck !== goal) {
        const step = time > 0 ? Math.min(1, dt / time) : 1;
        s.duck = step >= 1 ? goal : s.duck + (goal - s.duck) * step;
        this._dirty();
      }
    }
  }

  /** Called after `update` when any bus changed (a backend re-applies the mix). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private anySolo(): boolean { for (const s of this.buses.values()) if (s.solo || s.monitorSolo) return true; return false; }
  private chain(name: string): string[] {
    const out: string[] = [];
    for (let n: string | undefined = name; n !== undefined && out.length < 64; n = this.buses.get(n)?.settings.parent) out.push(n);
    return out;
  }
  private soloed(n: string): boolean { const s = this.buses.get(n); return !!s && (s.solo || s.monitorSolo); }
  /** Whether solo state (script or monitor) lets `name` through (it's soloed, under a soloed bus, or on the way to one). */
  private audibleUnderSolo(name: string): boolean {
    if (this.chain(name).some((n) => this.soloed(n))) return true;
    for (const other of this.buses.keys()) if (this.soloed(other) && this.chain(other).includes(name)) return true;
    return false;
  }

  resolve(name: string): ResolvedBus | null {
    const s = this.buses.get(name);
    if (!s) return null;
    const now = this.time;
    const solo = this.anySolo();
    const gainOf = (n: string, st: BusState) =>
      st.authoredMute || st.mute || st.monitorMute || (solo && !this.audibleUnderSolo(n))
        ? 0
        : rampAt(st.authored, now) * rampAt(st.runtime, now) * rampAt(st.snapshot, now) * rampAt(st.dip, now) * this._duckOf(n, st) * st.autoGain;
    let effective = 1;
    for (const n of this.chain(name)) effective *= gainOf(n, this.buses.get(n)!);
    const lp = Math.min(rampAt(s.lp, now), s.autoLp);
    return {
      name, parent: s.settings.parent ?? null, gain: gainOf(name, s), effectiveGain: effective,
      effects: s.settings.effects, snapshotLowpass: lp < OFF_HZ ? lp : null,
    };
  }
  resolveAll(): ResolvedBus[] { return this.order.map((n) => this.resolve(n)!); }
}

/** Move `r`'s anchor from clock reading `now` to `at` (a clock swap), keeping its value and remaining length. */
function rebase(r: Ramp, now: number, at: number): void {
  const remaining = r.seconds > 0 ? Math.max(0, r.start + r.seconds - now) : 0;
  r.from = rampAt(r, now);
  r.start = at;
  r.seconds = remaining;
}

/** The one mixer: buses are a project setting, and the audio context is shared (ADR 0097). */
export const mixer = new Mixer();
