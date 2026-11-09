/**
 * The mixer's model (ADR 0097): a bus tree with volume, mute and solo, snapshots and ducking. It is
 * pure state plus per-frame maths; a backend (ADR 0098) turns the resolved state into sound
 * (Web Audio nodes for Howler). Game code reaches it through `Audio.bus(name)`.
 */
import { defaultAudioSettings, MASTER, type AudioSettings, type BusEffect, type BusSettings } from "./settings";

/** What a backend applies for one bus. */
export interface ResolvedBus {
  name: string;
  parent: string | null;
  /** This bus's own gain: volume × snapshot × ducking, 0 when muted or silenced by another bus's solo. */
  gain: number;
  /** `gain` times every ancestor's: the level a sound that can't go through the node graph is scaled by. */
  effectiveGain: number;
  effects: BusEffect[];
  /** Low-pass cutoff a snapshot is applying (Hz), or null. */
  snapshotLowpass: number | null;
}

interface BusState {
  settings: BusSettings;
  volume: number;
  mute: boolean;
  solo: boolean;
  snap: number; snapFrom: number; snapTo: number;
  lp: number; lpFrom: number; lpTo: number;
  duck: number;
  voices: number;
  /** Newest peak (max of L and R, linear), from the backend's status (A2.3). */
  peak: number;
}

const OFF_HZ = 24000;

/** A bus, as game code sees it: `Audio.bus("Music").volume = 0.5`. Unknown names give an inert bus. */
export class Bus {
  /** @internal */
  constructor(private mixer: Mixer, readonly name: string) {}
  private get s(): BusState | undefined { return this.mixer._state(this.name); }
  /** Whether the project has a bus with this name. */
  get exists(): boolean { return this.s !== undefined; }
  /** Linear gain, 0..2 (1 = as authored). */
  get volume(): number { return this.s?.volume ?? 0; }
  set volume(v: number) { const s = this.s; if (s) { s.volume = Math.min(2, Math.max(0, Number.isFinite(v) ? v : 0)); this.mixer._dirty(); } }
  get mute(): boolean { return this.s?.mute ?? false; }
  set mute(m: boolean) { const s = this.s; if (s) { s.mute = m; this.mixer._dirty(); } }
  /** While any bus is soloed, only soloed buses (and the buses they feed and pass through) are heard. */
  get solo(): boolean { return this.s?.solo ?? false; }
  set solo(m: boolean) { const s = this.s; if (s) { s.solo = m; this.mixer._dirty(); } }
  /** Sounds playing on this bus right now. */
  get activeVoices(): number { return this.s?.voices ?? 0; }
  /** The newest peak level on this bus (max of L and R, linear, decayed for display); 0 while the audio is locked. Declared by A1.6 (K10); 0 until A2.3 feeds it. */
  get peak(): number { return this.s?.peak ?? 0; }
  /** The level reaching the speakers from this bus (all gains up the tree multiplied). */
  get effectiveGain(): number { return this.mixer.resolve(this.name)?.effectiveGain ?? 0; }
  /** Ease the volume to `v` over `seconds`. */
  fadeTo(v: number, seconds: number): void { this.mixer._fade(this.name, v, seconds); }
}

export class Mixer {
  private buses = new Map<string, BusState>();
  private order: string[] = [];
  private settings: AudioSettings = defaultAudioSettings();
  private listeners = new Set<() => void>();
  private changed = true;
  private snapshotName: string | null = null;
  private snapFade = 0;
  private fades = new Map<string, { from: number; to: number; t: number; dur: number }>();
  private warned = new Set<string>();

  constructor(settings: AudioSettings = defaultAudioSettings()) { this.configure(settings); }

  /** Replace the bus tree (project load). Script-set volumes reset to the project's. */
  configure(settings: AudioSettings): void {
    this.settings = settings;
    this.buses.clear();
    this.fades.clear();
    this.snapshotName = null;
    this.order = settings.buses.map((b) => b.name);
    for (const b of settings.buses) {
      this.buses.set(b.name, { settings: b, volume: b.volume, mute: b.mute, solo: false, snap: 1, snapFrom: 1, snapTo: 1, lp: OFF_HZ, lpFrom: OFF_HZ, lpTo: OFF_HZ, duck: 1, voices: 0, peak: 0 });
    }
    this._dirty();
  }

  /** The project's audio settings this mixer was configured with (the backend selector, K3, reads `backend` from it). */
  get audioSettings(): AudioSettings { return this.settings; }
  get busNames(): readonly string[] { return this.order; }
  get currentSnapshot(): string | null { return this.snapshotName; }
  get snapshotNames(): string[] { return this.settings.snapshots.map((s) => s.name); }

  /** @internal */
  _state(name: string): BusState | undefined { return this.buses.get(name); }
  /** @internal */
  _dirty(): void { this.changed = true; }
  /** @internal A2.3: the backend reports a bus's peak. */
  _setPeak(name: string, peak: number): void { const s = this.buses.get(name); if (s) s.peak = peak; }

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
  voiceEnded(name: string): void { const s = this.buses.get(name); if (s && s.voices > 0) s.voices--; }

  /** Fade to a named snapshot (`seconds` 0 = at once). */
  snapshot(name: string, seconds = 0.5): void {
    const snap = this.settings.snapshots.find((s) => s.name === name);
    if (!snap) { console.warn(`[myco] unknown audio snapshot "${name}". Snapshots: ${this.snapshotNames.join(", ") || "none"}.`); return; }
    this.snapshotName = name;
    this.snapFade = seconds;
    for (const [bus, s] of this.buses) this.retarget(s, snap.volumes[bus] ?? 1, snap.lowpass[bus] ?? OFF_HZ, seconds);
  }
  /** Fade back to the plain mix. */
  clearSnapshot(seconds = 0.5): void {
    this.snapshotName = null;
    this.snapFade = seconds;
    for (const s of this.buses.values()) this.retarget(s, 1, OFF_HZ, seconds);
  }
  private retarget(s: BusState, gain: number, lp: number, seconds: number): void {
    s.snapFrom = s.snap; s.snapTo = gain; s.lpFrom = s.lp; s.lpTo = lp;
    if (seconds <= 0) { s.snap = gain; s.lp = lp; }
    this._dirty();
  }

  /** @internal */
  _fade(name: string, to: number, dur: number): void {
    const s = this.buses.get(name);
    if (!s) return;
    if (dur <= 0) { s.volume = to; this.fades.delete(name); this._dirty(); return; }
    this.fades.set(name, { from: s.volume, to: Math.min(2, Math.max(0, to)), t: 0, dur });
  }

  /** Advance fades, snapshot transitions and ducking by `dt` seconds; tells listeners if anything moved. */
  update(dt: number): void {
    if (dt > 0) {
      for (const [name, f] of this.fades) {
        f.t = Math.min(f.dur, f.t + dt);
        this.buses.get(name)!.volume = f.from + (f.to - f.from) * (f.t / f.dur);
        if (f.t >= f.dur) this.fades.delete(name);
        this._dirty();
      }
      for (const s of this.buses.values()) {
        if (s.snap !== s.snapTo || s.lp !== s.lpTo) {
          const step = this.snapFade > 0 ? Math.min(1, dt / this.snapFade) : 1;
          s.snap = approach(s.snap, s.snapFrom, s.snapTo, step);
          s.lp = approach(s.lp, s.lpFrom, s.lpTo, step);
          this._dirty();
        }
      }
      // Ducking: each bus heads for the lowest multiplier any active rule asks for.
      for (const [name, s] of this.buses) {
        let goal = 1, time = 0.5;
        for (const r of this.settings.ducking) {
          if (r.target !== name || (this.buses.get(r.trigger)?.voices ?? 0) === 0) continue;
          if (r.amount < goal) { goal = r.amount; time = r.attack; }
        }
        if (goal === 1) time = this.settings.ducking.filter((r) => r.target === name).reduce((m, r) => Math.max(m, r.release), 0);
        if (s.duck !== goal) {
          const step = time > 0 ? Math.min(1, dt / time) : 1;
          s.duck = approach(s.duck, s.duck, goal, step, true);
          this._dirty();
        }
      }
    }
    if (this.changed) {
      this.changed = false;
      for (const l of this.listeners) l();
    }
  }

  /** Called after `update` when any bus changed (a backend re-applies the mix). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private anySolo(): boolean { for (const s of this.buses.values()) if (s.solo) return true; return false; }
  private chain(name: string): string[] {
    const out: string[] = [];
    for (let n: string | undefined = name; n !== undefined && out.length < 64; n = this.buses.get(n)?.settings.parent) out.push(n);
    return out;
  }
  /** Whether solo state lets `name` through (it's soloed, under a soloed bus, or on the way to one). */
  private audibleUnderSolo(name: string): boolean {
    if (this.chain(name).some((n) => this.buses.get(n)?.solo)) return true;
    for (const [other, s] of this.buses) if (s.solo && this.chain(other).includes(name)) return true;
    return false;
  }

  resolve(name: string): ResolvedBus | null {
    const s = this.buses.get(name);
    if (!s) return null;
    const solo = this.anySolo();
    const gainOf = (n: string, st: BusState) => (st.mute || (solo && !this.audibleUnderSolo(n)) ? 0 : st.volume * st.snap * st.duck);
    let effective = 1;
    for (const n of this.chain(name)) effective *= gainOf(n, this.buses.get(n)!);
    return {
      name, parent: s.settings.parent ?? null, gain: gainOf(name, s), effectiveGain: effective,
      effects: s.settings.effects, snapshotLowpass: s.lp < OFF_HZ ? s.lp : null,
    };
  }
  resolveAll(): ResolvedBus[] { return this.order.map((n) => this.resolve(n)!); }
}

/** The one mixer: buses are a project setting, and the audio context is shared (ADR 0097). */
export const mixer = new Mixer();

/** Move `cur` one `step` (0..1) of the way from `from` to `to`; `useCur` eases from where it is instead (ducking). */
function approach(cur: number, from: number, to: number, step: number, useCur = false): number {
  if (step >= 1) return to;
  const start = useCur ? cur : from;
  if (useCur) return cur + (to - cur) * step;
  // Linear from the transition's start: progress is recovered from where `cur` is, then advanced.
  const span = to - start;
  if (span === 0) return to;
  const progress = Math.min(1, (cur - start) / span + step);
  return progress >= 1 ? to : start + span * progress;
}
