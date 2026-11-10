import { Audio, GameBehavior, Input, Time, behavior, field, type AudioHandle } from "myco";
import { generateClips, releaseClips, type ClipSet } from "../clips";
import { Hud, type Sample } from "../hud";

/**
 * The audio core's stress test (ADR 0157, architecture 6.4 and 6.5). One node drives everything the scene's sources don't:
 *
 * - **Storm:** about 200 one-shot starts a second (50 on the low preset) from `scripts/clips.ts`' generated clips: short
 *   "hits" at pitch 0.5 to 16 in a shuffled order that never repeats a clip until the deck is spent (cache-cold reads), and
 *   long quiet "beds" that keep thousands of voices alive. A quarter are spatial. Everything plays on the 27 leaf buses.
 *   The first seconds start beds faster to fill the logical voices, then the rates settle.
 * - **Churn:** bus volumes fade every 0.2 s, a leaf bus mutes now and then, and a snapshot comes and goes.
 * - **Readout and soak:** `hud.ts`. `Audio.debug()` counters on screen; `?soak=30` or the K key runs the 30-minute soak
 *   with a summary every minute and a report to copy at the end.
 *
 * The scene adds 24 moving spatial emitters (the HRTF voices) and 8 looping streams. Keys (click the game view first):
 * 1 pause or resume the storm, 2 cycle its rate (x1, x0.5, x0.25), 3 toggle the churn, 4 toggle a snapshot, H hide the
 * readout, K start or stop the soak. URL flags: `profile=low|default|high`, `soak=<minutes>`, `clipMB`, `rate`, `seed`,
 * `churn=0`, `logical`. Without `profile` it follows `audio.voices.mixed` in project.json (read back from the core's cap).
 */
@behavior("stress.Stress")
export class Stress extends GameBehavior {
  @field(String) pauseKey = "1";
  @field(String) rateKey = "2";
  @field(String) churnKey = "3";
  @field(String) snapshotKey = "4";
  @field(String) hudKey = "h";
  @field(String) soakKey = "k";

  private readonly flags = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  private hud: Hud | null = null;
  private phase: "locked" | "generating" | "warming" | "running" = "locked";
  private clips: ClipSet | null = null;
  private gen: ReturnType<typeof generateClips> | null = null;
  private warm: AudioHandle[] = [];
  private warmNext = 0;
  private warmStart = 0;
  private rand: () => number = Math.random;
  private deck: string[] = [];
  private deckAt = 0;

  // The storm's numbers, set from the profile when generation starts.
  private profile: "low" | "default" | "high" = "high";
  private totalRate = 200;
  private bedRate = 40;
  private hitRate = 160;
  private prefillRate = 0;
  private prefillUntil = 0;
  private rateScale = 1;
  private paused = false;
  private churning = true;
  private snapshotOn = false;

  private stormTime = 0;
  private hitBudget = 0;
  private bedBudget = 0;
  private started = 0;
  private startedPlaying = 0;
  private churnClock = 0;
  private muteClock = 0;
  private snapshotClock = 0;
  private muted: { bus: string; until: number } | null = null;
  private sampleClock = 0;
  private lastFrameMs = 0;

  start(): void {
    this.rand = seeded(Number(this.flags.get("seed") ?? 1) | 0 || 1);
    this.hud = new Hud(this.flags);
    this.lastFrameMs = performance.now();
    (globalThis as unknown as { __stress: unknown }).__stress = this.hud.api(() => this.info());
  }

  onDestroy(): void {
    this.hud?.dispose();
    this.hud = null;
    if (this.clips) releaseClips(this.clips);
    this.clips = null;
    (globalThis as unknown as { __stress?: unknown }).__stress = undefined;
  }

  update(): void {
    const hud = this.hud;
    if (!hud) return;
    const now = performance.now();
    hud.frame(now - this.lastFrameMs);
    this.lastFrameMs = now;
    const dt = Math.min(0.25, Time.unscaledDeltaTime);

    if (Input.getKeyDown(this.hudKey)) hud.toggle();
    if (Input.getKeyDown(this.soakKey)) hud.toggleSoak();
    if (Input.getKeyDown(this.pauseKey)) this.paused = !this.paused;
    if (Input.getKeyDown(this.rateKey)) this.rateScale = this.rateScale === 1 ? 0.5 : this.rateScale === 0.5 ? 0.25 : 1;
    if (Input.getKeyDown(this.churnKey)) this.churning = !this.churning;
    if (Input.getKeyDown(this.snapshotKey)) this.setSnapshot(!this.snapshotOn);

    switch (this.phase) {
      case "locked":
        // Until the first click unlocks the context, plays would queue. The scene's looping sources wait the same way.
        if (Audio.status === "running") this.beginGeneration();
        break;
      case "generating":
        if (this.gen?.step(8)) {
          this.phase = "warming";
          this.warmStart = now;
        }
        break;
      case "warming":
        this.warmUp(now);
        break;
      case "running":
        this.stormTime += dt;
        if (!this.paused) this.storm(dt);
        if (this.churning) this.churn(dt);
        break;
    }
    this.sampleClock -= dt;
    if (this.sampleClock <= 0) {
      this.sampleClock = 0.5;
      hud.sample(this.sampleNow(), this.info());
    }
  }

  private beginGeneration(): void {
    // The profile: a flag, else the preset the core runs (its starting cap is voices.mixed).
    const mixed = Audio.debug().counters.mixedCap;
    const flag = this.flags.get("profile");
    this.profile = flag === "low" || flag === "default" || flag === "high" ? flag : mixed <= 64 ? "low" : mixed <= 128 ? "default" : "high";
    const low = this.profile === "low";
    const logical = Number(this.flags.get("logical") ?? (low ? 1024 : 4096));
    const clipMB = Number(this.flags.get("clipMB") ?? (low ? 24 : 64));
    this.totalRate = Number(this.flags.get("rate") ?? (low ? 50 : 200));
    this.churning = this.flags.get("churn") !== "0";
    this.gen = generateClips(clipMB);
    this.clips = this.gen.set;
    this.phase = "generating";
    // Beds live meanBedSeconds x E[1/pitch] (1.08 for pitch 0.5..2): the rate that holds the target live count.
    const target = logical * 0.95;
    const lifetime = this.gen.set.meanBedSeconds * 1.08;
    this.bedRate = Math.min(this.totalRate * 0.5, target / lifetime);
    this.hitRate = this.totalRate - this.bedRate;
    this.prefillUntil = 12;
    this.prefillRate = (target * 0.75) / this.prefillUntil;
    this.hud?.setPlan({ profile: this.profile, logical, clipMB, totalRate: this.totalRate, bedRate: this.bedRate, hitRate: this.hitRate });
  }

  /** Plays every clip once, silently and at pitch 16, so the core has fetched and decoded all of them before the storm starts. */
  private warmUp(now: number): void {
    const clips = this.clips!;
    const all = [...clips.beds, ...clips.hits];
    for (let i = 0; i < 24 && this.warmNext < all.length; i++) {
      this.warm.push(Audio.playOneShot(all[this.warmNext++]!, { volume: 0.001, pitch: 16, bus: "Bus00" }));
    }
    const done = this.warmNext >= all.length && this.warm.every((h) => !h.playing);
    this.hud?.setLoading(this.warmNext / all.length);
    if (done || now - this.warmStart > 120_000) {
      this.warm = [];
      this.phase = "running";
      this.stormTime = 0;
      this.hud?.stormStarted(this.sampleNow());
    }
  }

  private storm(dt: number): void {
    const prefill = this.stormTime < this.prefillUntil ? this.prefillRate : 0;
    this.bedBudget += (this.bedRate * this.rateScale + prefill) * dt;
    this.hitBudget += this.hitRate * this.rateScale * dt;
    const beds = this.clips!.beds;
    for (; this.bedBudget >= 1; this.bedBudget--) {
      const path = beds[Math.floor(this.rand() * beds.length)]!;
      this.play(path, { volume: logUniform(this.rand, 0.01, 0.1), pitch: logUniform(this.rand, 0.5, 2), priority: Math.floor(this.rand() * 128) }, 0.4);
    }
    for (; this.hitBudget >= 1; this.hitBudget--) {
      this.play(this.nextHit(), { volume: 0.04 + 0.3 * this.rand() ** 2, pitch: logUniform(this.rand, 0.5, 16), priority: Math.floor(this.rand() * 256) }, 0.25);
    }
  }

  /** The next hit from a shuffled deck: every clip once before any repeats. */
  private nextHit(): string {
    if (this.deckAt >= this.deck.length) {
      this.deck = [...this.clips!.hits];
      for (let i = this.deck.length - 1; i > 0; i--) {
        const j = Math.floor(this.rand() * (i + 1));
        [this.deck[i], this.deck[j]] = [this.deck[j]!, this.deck[i]!];
      }
      this.deckAt = 0;
    }
    return this.deck[this.deckAt++]!;
  }

  private play(path: string, o: { volume: number; pitch: number; priority: number }, spatialShare: number): void {
    const bus = leaf(Math.floor(this.rand() * LEAVES));
    const opts: Parameters<typeof Audio.playOneShot>[1] = { ...o, bus };
    if (this.rand() < spatialShare) {
      const a = this.rand() * Math.PI * 2;
      // Close enough (and a little louder) that they rank among the mixed voices: only mixed spatial voices can get HRTF.
      const r = 1.5 + this.rand() * 12.5;
      Object.assign(opts, { position: { x: Math.cos(a) * r, y: this.rand() * 6, z: Math.sin(a) * r }, minDistance: 3, maxDistance: 40, volume: o.volume * 2.5 });
    }
    this.started++;
    if (Audio.playOneShot(path, opts).playing) this.startedPlaying++;
  }

  private churn(dt: number): void {
    this.churnClock -= dt;
    if (this.churnClock <= 0) {
      this.churnClock = 0.2;
      const name = this.rand() < 0.2 ? `Mix${Math.floor(this.rand() * 4)}` : leaf(Math.floor(this.rand() * LEAVES));
      Audio.bus(name).fadeTo(0.3 + this.rand() * 0.9, 0.25);
    }
    this.muteClock -= dt;
    if (this.muted && this.stormTime >= this.muted.until) {
      Audio.bus(this.muted.bus).mute = false;
      this.muted = null;
    }
    if (this.muteClock <= 0) {
      this.muteClock = 1.5;
      if (!this.muted) {
        const bus = leaf(Math.floor(this.rand() * LEAVES));
        Audio.bus(bus).mute = true;
        this.muted = { bus, until: this.stormTime + 0.75 };
      }
    }
    this.snapshotClock -= dt;
    if (this.snapshotClock <= 0) {
      this.snapshotClock = 9;
      this.setSnapshot(!this.snapshotOn);
    }
  }

  private setSnapshot(on: boolean): void {
    this.snapshotOn = on;
    if (on) Audio.snapshot(this.rand() < 0.5 ? "Muffled" : "Quiet", 1.5);
    else Audio.clearSnapshot(1.5);
  }

  private info() {
    return { phase: this.phase, stormSeconds: this.stormTime, started: this.started, startedPlaying: this.startedPlaying, paused: this.paused, rateScale: this.rateScale, churning: this.churning, clipMB: (this.clips?.bytes ?? 0) / 1048576, clipCount: (this.clips?.hits.length ?? 0) + (this.clips?.beds.length ?? 0) };
  }

  private sampleNow(): Sample {
    const d = Audio.debug();
    const c = d.counters;
    const core = d.core as Record<string, number>;
    return {
      status: d.status,
      underruns: c.underruns,
      lateCommands: c.lateCommands,
      logicalVoices: c.logicalVoices,
      mixedVoices: c.mixedVoices,
      mixedCap: c.mixedCap,
      workUnits: c.workUnits,
      workUnitsMax: c.workUnitsMax,
      hrtfVoices: c.hrtfVoices,
      droppedPlays: c.droppedPlays,
      minSlackFrames: c.minSlackFrames,
      streams: core.streams ?? 0,
      streamStarves: core.streamStarves ?? 0,
      streamErrors: core.streamErrors ?? 0,
      traps: c.traps,
      rebuilds: core.rebuilds ?? 0,
      baseLatencyMs: (core.baseLatency ?? 0) * 1000,
      outputLatencyMs: (core.outputLatency ?? 0) * 1000,
      sampleRate: d.sampleRate,
    };
  }
}

const LEAVES = 27;
const leaf = (i: number): string => `Bus${String(i % LEAVES).padStart(2, "0")}`;
const logUniform = (r: () => number, lo: number, hi: number): number => lo * Math.pow(hi / lo, r());

function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
