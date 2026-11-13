// Mx1 (ADR 0172 §1.3; design api-and-models §1.1, §1.4, §3.1; architecture §4.5): the mixer's main-side lanes.
// Acceptance: "fade, snapshot and presence-duck curves equal today's at the heard clock to the ramp's exactness;
// `configure` still clears script state". Timing is on the heard clock (frames / sample rate), never wall-clock.
//
// L-Mx1b fills every `it.skip` below. "Today's" curves come from `TodayMixer`, a frozen copy of the pre-M5 mixer's
// fade, snapshot and ducking maths (`git show 770bcf1:src/engine/audio/mixer.ts`, lines 155-219 and 258-268),
// written into this file (the leaf owns only this file).
import { describe, expect, it, vi } from "vitest";
import { Lane, Mixer } from "./mixer";
import type { MixOp } from "./mixOps";
import { EMPTY_BUS_LOUDNESS, type BusLoudness } from "./loudnessTypes";
import { defaultAudioSettings, MASTER, type AudioSettings, type BusSettings, type DuckingRule, type SnapshotSettings } from "./settings";

const SR = 48000;
/** Samples per display frame (60 Hz). Every frame passes `DT` to `update`, and the heard clock advances by the same amount. */
const FRAME = 800;
const DT = FRAME / SR;
/** The "no low-pass" cutoff, Hz, as today's mixer writes it. */
const OFF_HZ = 24000;
const NAMES = [MASTER, "Music", "SFX", "Voice"];

/** Today's (pre-M5) fade, snapshot and presence-duck maths, frozen from `770bcf1:src/engine/audio/mixer.ts`. */
interface TodayBus { volume: number; snap: number; snapFrom: number; snapTo: number; lp: number; lpFrom: number; lpTo: number; duck: number; voices: number }

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

class TodayMixer {
  private buses = new Map<string, TodayBus>();
  private fades = new Map<string, { from: number; to: number; t: number; dur: number }>();
  private snapFade = 0;

  constructor(names: readonly string[], private rules: readonly DuckingRule[]) {
    for (const n of names) this.buses.set(n, { volume: 1, snap: 1, snapFrom: 1, snapTo: 1, lp: OFF_HZ, lpFrom: OFF_HZ, lpTo: OFF_HZ, duck: 1, voices: 0 });
  }
  private st(n: string): TodayBus {
    const s = this.buses.get(n);
    if (!s) throw new Error(`no bus ${n}`);
    return s;
  }
  /** `_fade`: a ramp on the volume (a 0-second fade sets it at once). */
  fade(name: string, to: number, dur: number): void {
    const s = this.st(name);
    if (dur <= 0) { s.volume = to; this.fades.delete(name); return; }
    this.fades.set(name, { from: s.volume, to: Math.min(2, Math.max(0, to)), t: 0, dur });
  }
  snapshot(snap: SnapshotSettings, seconds: number): void {
    this.snapFade = seconds;
    for (const [bus, s] of this.buses) this.retarget(s, snap.volumes[bus] ?? 1, snap.lowpass[bus] ?? OFF_HZ, seconds);
  }
  clearSnapshot(seconds: number): void {
    this.snapFade = seconds;
    for (const s of this.buses.values()) this.retarget(s, 1, OFF_HZ, seconds);
  }
  private retarget(s: TodayBus, gain: number, lp: number, seconds: number): void {
    s.snapFrom = s.snap; s.snapTo = gain; s.lpFrom = s.lp; s.lpTo = lp;
    if (seconds <= 0) { s.snap = gain; s.lp = lp; }
  }
  voiceStarted(name: string): void { this.st(name).voices++; }
  voiceEnded(name: string): void { const s = this.st(name); if (s.voices > 0) s.voices--; }
  /** `update`'s three loops: fades, snapshot transitions, ducking. */
  update(dt: number): void {
    if (dt <= 0) return;
    for (const [name, f] of this.fades) {
      f.t = Math.min(f.dur, f.t + dt);
      this.st(name).volume = f.from + (f.to - f.from) * (f.t / f.dur);
      if (f.t >= f.dur) this.fades.delete(name);
    }
    for (const s of this.buses.values()) {
      if (s.snap !== s.snapTo || s.lp !== s.lpTo) {
        const step = this.snapFade > 0 ? Math.min(1, dt / this.snapFade) : 1;
        s.snap = approach(s.snap, s.snapFrom, s.snapTo, step);
        s.lp = approach(s.lp, s.lpFrom, s.lpTo, step);
      }
    }
    for (const [name, s] of this.buses) {
      let goal = 1, time = 0.5;
      for (const r of this.rules) {
        if (r.target !== name || (this.buses.get(r.trigger)?.voices ?? 0) === 0) continue;
        if (r.amount < goal) { goal = r.amount; time = r.attack; }
      }
      if (goal === 1) time = this.rules.filter((r) => r.target === name).reduce((m, r) => Math.max(m, r.release), 0);
      if (s.duck !== goal) {
        const step = time > 0 ? Math.min(1, dt / time) : 1;
        s.duck = approach(s.duck, s.duck, goal, step, true);
      }
    }
  }
  volume(n: string): number { return this.st(n).volume; }
  snap(n: string): number { return this.st(n).snap; }
  lp(n: string): number { return this.st(n).lp; }
  duck(n: string): number { return this.st(n).duck; }
  /** Today's gain: volume x snapshot x duck (no mute). */
  gain(n: string): number { const s = this.st(n); return s.volume * s.snap * s.duck; }
}

/** A mixer on the heard clock: `run(n)` advances n display frames, each moving the clock by one frame. */
function rig(settings: AudioSettings) {
  const m = new Mixer(settings);
  let frame = 0;
  m.setClock(() => frame / SR);
  const run = (n = 1, dt = DT) => { for (let i = 0; i < n; i++) { frame += FRAME; m.update(dt); } };
  return { m, run, frame: () => frame };
}

function bus(name: string, over: Partial<BusSettings> = {}): BusSettings {
  return { name, ...(name === MASTER ? {} : { parent: MASTER }), volume: 1, mute: false, effects: [], ...over };
}
function settings(buses: BusSettings[], extra: Partial<AudioSettings> = {}): AudioSettings {
  return { ...defaultAudioSettings(), buses, ...extra };
}
const TREE = (): BusSettings[] => [bus(MASTER), bus("Music"), bus("SFX"), bus("Voice")];

/** A ducking rule. `mode` is the field the mixer reads (not yet in `DuckingRule`); absent means presence. */
function rule(over: Partial<DuckingRule> & { mode?: string } = {}): DuckingRule {
  return { target: "Music", trigger: "SFX", amount: 0.4, attack: 0.1, release: 0.5, ...over } as DuckingRule;
}

const PAUSED: SnapshotSettings = { name: "Paused", volumes: { Music: 0.3 }, lowpass: { Music: 800 } };

function fakeLoudness(momentary: number): BusLoudness {
  return { ...EMPTY_BUS_LOUDNESS, momentary, metered: true };
}

describe("Mixer lanes on the heard clock (Mx1)", () => {
  describe("fadeTo: one ramp on the runtime lane", () => {
    it("a fade read every frame equals today's per-frame fade (authored 1), frame by frame, to 1e-12", () => {
      const { m, run } = rig(settings(TREE()));
      const today = new TodayMixer(NAMES, []);
      const music = m.bus("Music");
      music.fadeTo(0.5, 1);
      today.fade("Music", 0.5, 1);
      const seq = m._lanes("Music")!.runtime.seq;
      for (let f = 0; f < 90; f++) {
        run();
        today.update(DT);
        expect(music.volume).toBeCloseTo(today.volume("Music"), 12);
        // One stamped ramp for the whole fade, not one write per display frame.
        expect(m._lanes("Music")!.runtime.seq).toBe(seq);
      }
      expect(music.volume).toBeCloseTo(0.5, 12);
    });

    it("with authored volume 0.8, fadeTo(0.5, 1) plays 0.4 at the end and authoredVolume still reads 0.8", () => {
      const { m, run } = rig(settings([bus(MASTER), bus("Music", { volume: 0.8 })]));
      const music = m.bus("Music");
      music.fadeTo(0.5, 1);
      run(60);
      expect(music.authoredVolume).toBe(0.8);
      expect(music.volume).toBeCloseTo(0.5, 12);
      expect(m.laneGain("Music", Lane.authored)).toBeCloseTo(0.8, 12);
      expect(m.resolve("Music")!.gain).toBeCloseTo(0.4, 12);
      expect(music.effectiveGain).toBeCloseTo(0.4, 12);
    });

    it("a registered heard clock drives the fade: reading at frame f gives from + (to - from) * (f / sr - start) / seconds", () => {
      const { m, run, frame } = rig(settings(TREE()));
      run(6); // the fade starts at frame 4800 (0.1 s), not at 0
      const music = m.bus("Music");
      const start = frame() / SR;
      music.fadeTo(0.5, 1);
      for (let i = 0; i < 80; i++) {
        run(1, 0); // the dt passed is ignored: the heard clock alone moves the ramp
        const elapsed = Math.min(1, (frame() / SR - start) / 1); // after the end it holds `to`
        expect(music.volume).toBeCloseTo(1 + (0.5 - 1) * elapsed, 12);
      }
    });

    it("fadeTo(v, 0) reads v at once and writes one ramp record of 0 seconds (the writer applies BUS_MIN_RAMP_MS)", () => {
      const { m, run } = rig(settings(TREE()));
      run(3);
      const music = m.bus("Music");
      const before = m._lanes("Music")!.runtime.seq;
      music.fadeTo(0.3, 0);
      expect(music.volume).toBe(0.3);
      const r = m._lanes("Music")!.runtime;
      expect(r.seconds).toBe(0);
      expect(r.to).toBe(0.3);
      // `seq` is mixer-wide: the write stamps a new record, once.
      const written = r.seq;
      expect(written).toBeGreaterThan(before);
      run(5);
      expect(music.volume).toBe(0.3);
      expect(m._lanes("Music")!.runtime.seq).toBe(written);
    });

    it("a retarget mid-fade starts from the current value (no jump)", () => {
      const { m, run } = rig(settings(TREE()));
      const music = m.bus("Music");
      music.fadeTo(0, 1);
      run(30); // 0.5 s in
      expect(music.volume).toBeCloseTo(0.5, 12);
      music.fadeTo(1, 1);
      expect(music.volume).toBeCloseTo(0.5, 12); // no step at the retarget
      run(1);
      expect(music.volume).toBeCloseTo(0.5 + 0.5 * (FRAME / SR), 12);
      run(29);
      expect(music.volume).toBeCloseTo(0.75, 9);
    });

    it("the volume setter cancels a running fade", () => {
      const { m, run } = rig(settings(TREE()));
      const music = m.bus("Music");
      music.fadeTo(0, 1);
      run(12);
      music.volume = 0.3;
      expect(music.volume).toBe(0.3);
      run(60);
      expect(music.volume).toBe(0.3);
    });

    it("values clamp to 0..2; a non-finite volume reads 0", () => {
      const { m, run } = rig(settings(TREE()));
      const music = m.bus("Music");
      music.volume = 3;
      expect(music.volume).toBe(2);
      music.volume = -1;
      expect(music.volume).toBe(0);
      music.volume = Number.NaN;
      expect(music.volume).toBe(0);
      music.volume = 1.5;
      music.volume = Number.POSITIVE_INFINITY;
      expect(music.volume).toBe(0);
      music.fadeTo(5, 0);
      expect(music.volume).toBe(2);
      music.fadeTo(-1, 0.5);
      run(30);
      expect(music.volume).toBe(0);
      music.fadeTo(Number.NaN, 0);
      expect(music.volume).toBe(0);
    });

    it("onChange fires every frame the ramp moves, once on the frame it ends, then stops", () => {
      const { m, run } = rig(settings(TREE()));
      m.update(0); // flush the change configure left behind before listening
      let fires = 0;
      m.onChange(() => fires++);
      m.bus("Music").fadeTo(0.5, 0.1); // six frames, ending on frame 6
      run(6);
      expect(fires).toBe(6);
      run(10);
      expect(fires).toBe(6);
    });
  });

  describe("snapshots: ramps on the snapshot lane", () => {
    it("snapshot(name, s) gain and low-pass curves equal today's frame by frame, to 1e-9", () => {
      const { m, run } = rig(settings(TREE(), { snapshots: [PAUSED] }));
      const today = new TodayMixer(NAMES, []);
      run(6);
      m.snapshot("Paused", 0.5);
      today.snapshot(PAUSED, 0.5);
      for (let f = 0; f < 60; f++) {
        run();
        today.update(DT);
        for (const n of NAMES) {
          expect(m.laneGain(n, Lane.snapshot)).toBeCloseTo(today.snap(n), 9);
          expect(m.resolve(n)!.snapshotLowpass ?? OFF_HZ).toBeCloseTo(today.lp(n), 9);
        }
      }
      expect(m.currentSnapshot).toBe("Paused");
    });

    it("a snapshot interrupted mid-transition by clearSnapshot equals today's curve", () => {
      const { m, run } = rig(settings(TREE(), { snapshots: [PAUSED] }));
      const today = new TodayMixer(NAMES, []);
      m.snapshot("Paused", 1);
      today.snapshot(PAUSED, 1);
      for (let f = 0; f < 30; f++) { run(); today.update(DT); }
      m.clearSnapshot(0.25);
      today.clearSnapshot(0.25);
      for (let f = 0; f < 60; f++) {
        run();
        today.update(DT);
        for (const n of NAMES) {
          expect(m.laneGain(n, Lane.snapshot)).toBeCloseTo(today.snap(n), 9);
          expect(m.resolve(n)!.snapshotLowpass ?? OFF_HZ).toBeCloseTo(today.lp(n), 9);
        }
      }
      expect(m.currentSnapshot).toBeNull();
      expect(m.laneGain("Music", Lane.snapshot)).toBe(1);
      expect(m.resolve("Music")!.snapshotLowpass).toBeNull();
    });

    it("snapshot(name, 0) jumps at once", () => {
      const { m, run } = rig(settings(TREE(), { snapshots: [PAUSED] }));
      m.snapshot("Paused", 0);
      expect(m.laneGain("Music", Lane.snapshot)).toBe(0.3);
      expect(m.resolve("Music")!.snapshotLowpass).toBe(800);
      run(1);
      expect(m.laneGain("Music", Lane.snapshot)).toBe(0.3);
      m.clearSnapshot(0);
      expect(m.laneGain("Music", Lane.snapshot)).toBe(1);
      expect(m.resolve("Music")!.snapshotLowpass).toBeNull();
    });
  });

  describe("presence ducking (main-side until Dp1)", () => {
    it("duck curve during attack and release equals today's frame by frame; duckGain reads it", () => {
      const rules = [rule({ target: "Music", trigger: "SFX", amount: 0.3, attack: 0.1, release: 0.5 })];
      const { m, run } = rig(settings(TREE(), { ducking: rules }));
      const today = new TodayMixer(NAMES, rules);
      m.voiceStarted("SFX");
      today.voiceStarted("SFX");
      for (let f = 0; f < 30; f++) {
        run();
        today.update(DT);
        expect(m.bus("Music").duckGain).toBeCloseTo(today.duck("Music"), 12);
      }
      m.voiceEnded("SFX");
      today.voiceEnded("SFX");
      for (let f = 0; f < 60; f++) {
        run();
        today.update(DT);
        expect(m.bus("Music").duckGain).toBeCloseTo(today.duck("Music"), 12);
      }
      expect(m.bus("SFX").duckGain).toBe(1);
    });

    it("two rules on one target head for the lowest amount", () => {
      const rules = [
        rule({ target: "Music", trigger: "SFX", amount: 0.6, attack: 0.1, release: 0.5 }),
        rule({ target: "Music", trigger: "Voice", amount: 0.3, attack: 0.2, release: 0.5 }),
      ];
      const { m, run } = rig(settings(TREE(), { ducking: rules }));
      const today = new TodayMixer(NAMES, rules);
      m.voiceStarted("SFX");
      m.voiceStarted("Voice");
      today.voiceStarted("SFX");
      today.voiceStarted("Voice");
      run(1);
      today.update(DT);
      // The lowest rule (0.3) with its own attack (0.2 s) sets the first step.
      expect(m.bus("Music").duckGain).toBeCloseTo(1 + (0.3 - 1) * (DT / 0.2), 12);
      expect(m.bus("Music").duckGain).toBeCloseTo(today.duck("Music"), 12);
      for (let f = 0; f < 300; f++) {
        run();
        today.update(DT);
        expect(m.bus("Music").duckGain).toBeCloseTo(today.duck("Music"), 12);
      }
      expect(m.bus("Music").duckGain).toBeCloseTo(0.3, 9);
    });

    it("a rule with mode 'level' is not computed on main", () => {
      const rules = [rule({ mode: "level", target: "Music", trigger: "SFX", amount: 0.1, attack: 0.05, release: 0.9 })];
      const { m, run } = rig(settings(TREE(), { ducking: rules }));
      m.voiceStarted("SFX");
      run(60);
      expect(m.bus("Music").duckGain).toBe(1);
      m.voiceEnded("SFX");
      run(60);
      expect(m.bus("Music").duckGain).toBe(1);
    });
  });

  describe("composition", () => {
    it("resolve().gain = authored x runtime x snapshot x dip x duck x automation, and equals today's for today's inputs", () => {
      const rules = [rule({ target: "Music", trigger: "SFX", amount: 0.5, attack: 0 })];
      const { m, run } = rig(settings([bus(MASTER), bus("Music", { volume: 0.8 }), bus("SFX"), bus("Voice")], { snapshots: [PAUSED], ducking: rules }));
      m.bus("Music").volume = 0.4;
      m.snapshot("Paused", 0);
      m._setDip("Music", 0.5, 0);
      m._setAutomation("Music", 0.25, OFF_HZ);
      m.voiceStarted("SFX");
      run(1);
      expect(m.laneGain("Music", Lane.authored)).toBe(0.8);
      expect(m.laneGain("Music", Lane.runtime)).toBe(0.4);
      expect(m.laneGain("Music", Lane.snapshot)).toBe(0.3);
      expect(m.laneGain("Music", Lane.dip)).toBe(0.5);
      expect(m.laneGain("Music", Lane.duck)).toBe(0.5);
      expect(m.laneGain("Music", Lane.automation)).toBe(0.25);
      expect(m.resolve("Music")!.gain).toBeCloseTo(0.8 * 0.4 * 0.3 * 0.5 * 0.5 * 0.25, 12);

      // Today's inputs (authored 1, no dip, no automation): resolve's gain is today's volume x snapshot x duck.
      const second = rig(settings(TREE(), { snapshots: [PAUSED], ducking: rules }));
      const today = new TodayMixer(NAMES, rules);
      second.m.bus("Music").volume = 0.4;
      today.fade("Music", 0.4, 0);
      second.m.snapshot("Paused", 0);
      today.snapshot(PAUSED, 0);
      second.m.voiceStarted("SFX");
      today.voiceStarted("SFX");
      for (let f = 0; f < 90; f++) {
        second.run();
        today.update(DT);
        for (const n of NAMES) expect(second.m.resolve(n)!.gain).toBeCloseTo(today.gain(n), 12);
      }
    });

    it("authored mute, script mute and monitor mute each give 0; script mute starts false even when authored mute is true", () => {
      const { m } = rig(settings([bus(MASTER), bus("Music", { mute: true }), bus("SFX"), bus("Voice")]));
      expect(m.bus("Music").authoredMute).toBe(true);
      expect(m.bus("Music").mute).toBe(false);
      expect(m.resolve("Music")!.gain).toBe(0);
      expect(m.laneGain("Music", Lane.authored)).toBe(0);

      expect(m.bus("SFX").mute).toBe(false);
      expect(m.resolve("SFX")!.gain).toBe(1);
      m.bus("SFX").mute = true;
      expect(m.resolve("SFX")!.gain).toBe(0);
      expect(m.laneGain("SFX", Lane.runtime)).toBe(0);

      expect(m.resolve("Voice")!.gain).toBe(1);
      m.setMonitor("Voice", { mute: true });
      expect(m.resolve("Voice")!.gain).toBe(0);
      expect(m.laneGain("Voice", Lane.monitor)).toBe(0);
      expect(m.monitorActive).toBe(true);
    });

    it("monitor solo gates like script solo (the solo rule over the tree)", () => {
      const monitored = rig(settings(TREE())).m;
      const scripted = rig(settings(TREE())).m;
      monitored.setMonitor("Music", { solo: true });
      scripted.bus("Music").solo = true;
      for (const n of NAMES) {
        expect(monitored.resolve(n)!.gain).toBe(scripted.resolve(n)!.gain);
        expect(monitored.resolve(n)!.effectiveGain).toBe(scripted.resolve(n)!.effectiveGain);
      }
      expect(monitored.resolve("Music")!.gain).toBe(1);
      expect(monitored.resolve(MASTER)!.gain).toBe(1);
      expect(monitored.resolve("SFX")!.gain).toBe(0);
      expect(monitored.laneGain("SFX", Lane.monitor)).toBe(0);
      expect(monitored.laneGain("Music", Lane.monitor)).toBe(1);
      expect(monitored.monitorActive).toBe(true);
    });

    it("laneGain reports each lane", () => {
      const { m, run } = rig(settings([bus(MASTER), bus("Music", { volume: 0.8 }), bus("SFX"), bus("Voice")], { snapshots: [PAUSED] }));
      m.bus("Music").volume = 0.5;
      m.snapshot("Paused", 0);
      m._setDip("Music", 0.7, 0);
      m._setAutomation("Music", 0.9, OFF_HZ);
      m.setMonitor("Music", { solo: true });
      run(1);
      expect(m.laneGain("Music", Lane.authored)).toBe(0.8);
      expect(m.laneGain("Music", Lane.runtime)).toBe(0.5);
      expect(m.laneGain("Music", Lane.snapshot)).toBe(0.3);
      expect(m.laneGain("Music", Lane.monitor)).toBe(1);
      expect(m.laneGain("SFX", Lane.monitor)).toBe(0);
      expect(m.laneGain("Music", Lane.dip)).toBe(0.7);
      expect(m.laneGain("Music", Lane.duck)).toBe(1);
      expect(m.laneGain("Music", Lane.automation)).toBe(0.9);
      m.bus("Music").mute = true;
      expect(m.laneGain("Music", Lane.runtime)).toBe(0);
      expect(m.laneGain("Music", Lane.authored)).toBe(0.8);
    });
  });

  describe("configure", () => {
    it("clears script volume, fades, mute, solo, the snapshot and monitor controls; authored values come from the settings", () => {
      const { m, run } = rig(settings(TREE(), { snapshots: [PAUSED] }));
      const music = m.bus("Music");
      music.volume = 0.5;
      music.fadeTo(0.2, 1);
      run(10);
      music.mute = true;
      m.bus("SFX").solo = true;
      m.snapshot("Paused", 0);
      m.setMonitor("Voice", { mute: true, solo: true });

      m.configure(settings([bus(MASTER), bus("Music", { volume: 0.7, mute: true }), bus("SFX"), bus("Voice")], { snapshots: [PAUSED] }));
      expect(music.volume).toBe(1);
      expect(music.mute).toBe(false);
      expect(music.authoredVolume).toBe(0.7);
      expect(music.authoredMute).toBe(true);
      expect(m.bus("SFX").solo).toBe(false);
      expect(m.currentSnapshot).toBeNull();
      expect(m.laneGain("Music", Lane.snapshot)).toBe(1);
      expect(m.monitorActive).toBe(false);
      expect(m.laneGain("Voice", Lane.monitor)).toBe(1);
      expect(m.resolve("Music")!.gain).toBe(0); // the authored mute, from the settings
      run(30);
      expect(music.volume).toBe(1); // the cleared fade does not resume
    });
  });

  describe("loudness and apply", () => {
    it("Bus.loudness is the same object every read, inert before a source registers, and forwards once one does", () => {
      const m = new Mixer(settings(TREE()));
      const music = m.bus("Music");
      const first = music.loudness;
      expect(music.loudness).toBe(first);
      expect(first.metered).toBe(false);
      expect(first.momentary).toBe(-Infinity);
      expect(first.target).toBeNull();

      let current = fakeLoudness(-14);
      m.setLoudnessSource({ busLoudness: (name) => (name === "Music" ? current : null) });
      expect(music.loudness).toBe(first);
      expect(music.loudness.metered).toBe(true);
      expect(music.loudness.momentary).toBe(-14);
      expect(m.bus("SFX").loudness.metered).toBe(false);

      current = fakeLoudness(-9); // the source replaces its object; the view follows
      expect(music.loudness.momentary).toBe(-9);
    });

    it("a missing bus's loudness is EMPTY_BUS_LOUDNESS; controls are no-ops", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const m = new Mixer(settings(TREE()));
      m.setLoudnessSource({ busLoudness: () => fakeLoudness(-10) });
      const missing = m.bus("Nope");
      expect(missing.exists).toBe(false);
      expect(missing.loudness).toBe(EMPTY_BUS_LOUDNESS);
      expect(() => {
        missing.loudness.reset();
        missing.loudness.reset("all");
        missing.loudness.pause();
        missing.loudness.resume();
        missing.volume = 0.5;
        missing.fadeTo(0.2, 1);
        missing.mute = true;
        missing.solo = true;
      }).not.toThrow();
      expect(missing.loudness).toBe(EMPTY_BUS_LOUDNESS);
      expect(missing.loudness.momentary).toBe(-Infinity);
      expect(missing.loudness.metered).toBe(false);
      expect(() => m.bus("Music").loudness.reset()).not.toThrow();
      warn.mockRestore();
    });

    it("apply delegates to the registered target's applyOp and keeps script state", () => {
      const { m, run } = rig(settings(TREE()));
      const music = m.bus("Music");
      const op: MixOp = { op: "setBus", bus: "Music", key: "volume", value: 0.6 };
      expect(m.apply(op).ok).toBe(false); // no backend yet

      music.volume = 0.5;
      music.fadeTo(0.2, 1);
      run(12);
      const before = music.volume;
      const seen: MixOp[] = [];
      m._setOpTarget({ applyOp: (o) => { seen.push(o); return { ok: true, class: "direct" }; } });
      expect(m.apply(op)).toEqual({ ok: true, class: "direct" });
      expect(seen).toEqual([op]);
      expect(music.volume).toBe(before); // the apply kept the running fade
      run(48);
      expect(music.volume).toBeCloseTo(0.2, 9);
    });
  });
});
