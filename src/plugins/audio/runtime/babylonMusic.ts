/**
 * The Babylon fallback's `MusicBackend` (api-and-models §8, B1; ADR 0166 M4a). Decoded members start through
 * `StaticSound.play({ waitTime })` from `Audio.time` (the context's clock, no latency correction); streamed members play as
 * flat HTML5 audio from a timer, unaligned. There is no gate and no priming: `primedState` always answers ready, and
 * `primeGroup` only warms the decoded buffers and warns. Group events are queued as voices start and end and delivered by
 * `pump` (the backend's `update`).
 */
import type { AudioVoice, MusicAdmitResult, MusicBackend, MusicBackendDebug, MusicGroupEvent, MusicGroupRequest, MusicGroupStamp, MusicLifecycleEvent, MusicPrimedState, PlayRequest } from "./backend";
import { MUSIC_LATE_SECONDS, warnFlatStream, type BabylonVoice, type VoiceMusic } from "./babylonVoice";
import { warnOnce } from "./core/handle";

/** What the music backend asks of the Babylon backend. */
export interface MusicHost {
  /** `dispose` has run: groups are refused. */
  isDisposed(): boolean;
  /** The heard clock (the context's time). */
  time(): number;
  /** The context's sample rate (seconds to frames). */
  sampleRate(): number;
  /** Start the engine and decode `urls` ahead of a stamp. */
  warm(urls: readonly string[]): void;
  /** A voice for a member, null once disposed. */
  play(req: PlayRequest, music: VoiceMusic): BabylonVoice | null;
}

/** One admitted group on the fallback: its request, and once stamped its voices (null where a member couldn't start). */
interface MusicGroup {
  req: MusicGroupRequest;
  voices: (BabylonVoice | null)[] | null;
  at: number;
  /** The `start` event went out. */
  started: boolean;
}

export class BabylonMusic implements MusicBackend {
  readonly caps = { primes: false, stampedFades: true, heardClock: false, rhythm: false } as const;
  onGroupEvent: ((e: MusicGroupEvent) => void) | null = null;
  /** ADR 0248: never called: the fallback has no rebuild, crash, abandon or STATUS-driven hidden tick to report. */
  onLifecycle: ((e: MusicLifecycleEvent) => void) | null = null;
  /** No prime is ever timed here; the core's seed. */
  readonly primeEmaMs = 40;
  /** No music ring pool on the fallback (streamed stems play as HTML5 audio): the planner skips its pool check. */
  readonly ringPool = 0;
  private readonly groups = new Map<number, MusicGroup>();
  private readonly queue: MusicGroupEvent[] = [];

  constructor(private readonly host: MusicHost) {}

  admitGroup(req: MusicGroupRequest): MusicAdmitResult {
    if (this.host.isDisposed()) return { ok: false, reason: "neverFits", permanent: true };
    this.groups.set(req.group, { req, voices: null, at: 0, started: false });
    this.warm(req);
    return { ok: true };
  }

  primeGroup(req: MusicGroupRequest): void {
    if (!this.groups.has(req.group)) this.groups.set(req.group, { req, voices: null, at: 0, started: false });
    for (const m of req.members) if (m.play.stream) warnFlatStream(m.play.path);
    warnOnce("babylon-music-drift", "interactive music on the Babylon audio fallback can't prime or gate streamed stems; they start separately and may drift apart. Turn off \"stream\" on stems for aligned playback there (api-and-models §8).");
    this.warm(req);
  }

  /** Start the engine and decode the group's non-streamed clips ahead of the stamp, so the stamp only has to make the sounds. */
  private warm(req: MusicGroupRequest): void {
    this.host.warm(req.members.filter((m) => !m.play.stream).map((m) => m.play.url));
  }

  primedState(group: number): MusicPrimedState | null {
    const g = this.groups.get(group);
    if (!g) return null;
    const n = g.req.members.length;
    return { group, primed: n, of: n, ready: true };
  }

  stampGroup(stamp: MusicGroupStamp): (AudioVoice | null)[] {
    const g = this.groups.get(stamp.group);
    if (!g) return [];
    if (g.voices) return g.voices;
    g.at = stamp.at;
    const voices = g.req.members.map((m, k) => {
      const v = this.host.play(
        { ...m.play, loop: m.loop, at: stamp.at },
        {
          startFrame: m.startFrame,
          loopStartFrame: m.loopStartFrame ?? 0,
          loopEndFrame: m.loopEndFrame ?? 0,
          fadeZero: m.fadeZero === true,
          onEnd: (voice) => this.memberEnded(stamp.group, k, voice),
        },
      );
      return v;
    });
    g.voices = voices;
    for (const f of stamp.fades ?? []) {
      const fade = f.fade.at === undefined ? { ...f.fade, at: stamp.at } : f.fade;
      voices[f.member]?.fadeShaped(fade);
    }
    return voices;
  }

  cancelGroup(group: number): void {
    const g = this.groups.get(group);
    if (!g) return;
    this.groups.delete(group);
    for (const v of g.voices ?? []) v?.stop();
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.group === group) this.queue.splice(i, 1);
  }

  releaseInstance(instance: number): void {
    void instance; // no worker cache here
  }

  /**
   * ADR 0249: no ring pool, no group table and no core counters here (zeros); the live groups, every member counted primed
   * (nothing is primed on the fallback), `stamped` until the `start` went out, then `playing`.
   */
  debugView(): MusicBackendDebug {
    const groups: MusicBackendDebug["groups"] = [];
    for (const [id, g] of this.groups) {
      const n = g.req.members.length;
      groups.push({ id, state: g.started ? "playing" : g.voices ? "stamped" : "admitted", primed: n, of: n });
    }
    return {
      poolUsed: 0, poolSize: 0, poolHighWater: 0, musicRingRefused: 0, groupTableFull: 0, encodedOverBudget: 0,
      streamStartsLate: 0, groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0, maxSlipFrames: 0, splitQuanta: 0, voiceSplits: 0, curvePoolFull: 0,
      groups,
    };
  }

  protect(instance: number, paths: readonly string[]): void {
    void instance;
    void paths;
  }

  private memberEnded(group: number, member: number, voice: BabylonVoice): void {
    const g = this.groups.get(group);
    if (!g?.voices) return;
    this.queue.push(voice.reason === "failed" ? { kind: "error", group, member, message: `could not load "${g.req.members[member]?.play.path ?? ""}"` } : { kind: "end", group, member });
  }

  /** Deliver this frame's events: each group's `start` once its members are on (or failed), then the members' ends and errors. */
  pump(): void {
    if (this.groups.size === 0) return;
    const now = this.host.time();
    for (const [id, g] of this.groups) {
      if (!g.voices || g.started || now < g.at) continue;
      const live = g.voices.filter((v): v is BabylonVoice => v !== null);
      if (live.some((v) => !v.ended && v.startedAt === null)) continue;
      const startedAt = live.reduce((t, v) => (v.startedAt !== null ? Math.max(t, v.startedAt) : t), g.at);
      g.started = true;
      if (!live.some((v) => v.startedAt !== null)) continue; // every member failed: their errors tell it
      const slip = startedAt - g.at;
      const late = slip > MUSIC_LATE_SECONDS;
      this.queue.unshift({ kind: "start", group: id, late, slipFrames: late ? Math.round(slip * this.host.sampleRate()) : 0, startFrame: g.req.members[0]?.startFrame ?? 0 });
    }
    const out = this.queue.splice(0);
    const sink = this.onGroupEvent;
    for (const e of out) {
      if (sink) sink(e);
      if (e.kind === "end" || e.kind === "error") {
        const g = this.groups.get(e.group);
        if (g?.voices?.every((v) => v === null || v.ended)) this.groups.delete(e.group);
      }
    }
  }
}
