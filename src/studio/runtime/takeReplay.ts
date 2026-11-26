// Take replay (ADR 0348 "Replay"): re-issue what a game asked of audio, at the times it asked, against the *current*
// project, so edits are heard in context. Two parts:
//
// - `TakeReplay`, the scheduling model: a clock-driven playhead over a `Take` (play, pause, seek, a loop range, rate 1)
//   that hands each request to a `ReplayTarget` when the playhead passes it (PLAY, STOP, RELEASE, PARAM, MIX, TRIGGER;
//   MARK is only drawn), moves the listener and every emitter each frame along the recorded poses (interpolated), and on
//   a seek stops everything and starts the instances alive at the seek time from the nearest keyframe and the requests
//   after it (parameters from the keyframe), each part-way, as far in as it had played (the play's `offset`). Edits
//   made while replaying reach instances started
//   afterwards (the engine's hot-reload rule); `restartInstances` restarts the ones playing so they pick up the edit.
// - `studioReplayTarget`, the thin runtime adapter: the Studio host's public `Audio` API (`Audio.play` handles whose
//   `position` follows their emitter, `Audio.setParameter`, `Audio.bus(name).volume`/`fadeTo`, `Audio.snapshot`,
//   `Audio.clearSnapshot`, `Audio.volume`) plus the World-side pieces (`takeWorld.ts`: the listener entity, the seed).
//
// Pure apart from the adapter's calls; the clock and the target are injected, so the model is tested with a fake clock.
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { lastAtOrBefore } from "../../engine/core/sortedSearch";
import type { Take } from "../../engine/audio/take/reader";
import type { TakeKeyframe, TakePlayOptions, TakeRequest } from "../../engine/audio/take/types";
import type { StudioAudioHost } from "./studioAudioHost";

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Where the listener or an emitter is (and faces) at a time. */
export interface ReplayPose {
  readonly position: Vec3;
  readonly forward?: Vec3;
}

/** A playing instance as the target hands it back (an `AudioPlaylistHandle` in the Studio). */
export interface ReplayHandle {
  readonly playing: boolean;
  position: Vec3 | null;
  stop(fadeSeconds?: number): void;
  release(): void;
  setParameter(name: string, value: number): void;
  getParameter?(name: string): number | string | undefined;
  trigger(name: string): unknown;
  /** ADR 0386: the handle requests a take records, re-issued as the game made them. */
  pause?(): void;
  resume?(): void;
  fade?(to: number, seconds: number): void;
}

export interface ReplayPlayOptions extends TakePlayOptions {
  /** The emitter's position at the start (absent: a flat play). */
  readonly position?: Vec3;
  /** Seconds the instance had played when a seek, pause or restart starts it again (absent: from its start). */
  readonly offset?: number;
}

/** A line or say the target started (an `AudioLineHandle` in the Studio): which line it picked. */
export interface ReplayLineHandle extends ReplayHandle {
  /** The line key ("" while a queued say hasn't decided). */
  readonly key: string;
  readonly state: "queued" | "playing" | "ended";
}

/** A say's options on replay: the play options, the recorded arguments, channel and `whenBusy`. */
export interface ReplaySayOptions extends ReplayPlayOptions {
  readonly args: Readonly<Record<string, string>>;
  readonly channel?: string;
  readonly whenBusy?: "queue" | "interrupt" | "drop";
}

/** ADR 0355 §6: a say whose replay picked differently from the recording ("picked X, recorded Y"). */
export interface PickDifference {
  /** The take's instance id. */
  readonly instance: number;
  readonly event: string;
  /** Take seconds. */
  readonly t: number;
  /** What the replay picked (null: nothing). */
  readonly picked: string | null;
  /** What the game picked (null: nothing). */
  readonly recorded: string | null;
}

/** What replay plays through: the Studio's runtime (`studioReplayTarget`), or a test's recorder. */
export interface ReplayTarget {
  /** Start a playlist, event or sample; null when the runtime can't play now. */
  play(path: string, options: ReplayPlayOptions): ReplayHandle | null;
  setGlobal(name: string, value: number): void;
  /** A script bus volume (linear runtime multiplier): set at once (`seconds` 0) or faded. */
  busVolume(bus: string, value: number, seconds: number): void;
  snapshot(name: string, seconds: number): void;
  clearSnapshot(seconds: number): void;
  /** The master volume, read (to put it back) and set. */
  masterVolume(value?: number): number;
  /** Put the listener at `pose`. */
  listener(pose: ReplayPose): void;
  /** Start the picks' generator from `seed`; false when the runtime can't (replay then says so). */
  seed(seed: number): boolean;
  /** ADR 0354 §10: play a voice-over line by key against the current tables (`Audio.line`); null when it can't. */
  line?(key: string, options: ReplayPlayOptions): ReplayLineHandle | null;
  /** ADR 0355 §6: say a dialogue event with the recorded arguments (`Audio.say`): it decides again against the current data. */
  say?(event: string, options: ReplaySayOptions): ReplayLineHandle | null;
  /** ADR 0354 §10: the recorded audio and subtitle languages. */
  language?(audio: string, subtitles: string | null): void;
  /** The replay closed: let go of what it made (the listener entity). */
  dispose?(): void;
}

/** Seconds, monotonic (`performance.now() / 1000` in the Studio). */
export interface ReplayClock {
  now(): number;
}

/** A part of the take played over and over. */
export interface LoopRange {
  readonly from: number;
  readonly to: number;
}

/** An instance the replay has started (or reconstructed on a seek), as the screens read it. */
export interface ReplayInstance {
  /** The take's instance id. */
  readonly instance: number;
  readonly path: string;
  readonly emitter: number | null;
  /** When the game started it, take seconds. */
  readonly started: number;
  readonly options: TakePlayOptions;
  /** Its parameters as the take has them now. */
  readonly parameters: Readonly<Record<string, number>>;
  readonly released: boolean;
  /** Null when the runtime refused it. */
  readonly handle: ReplayHandle | null;
}

/** Shortest loop range, seconds. */
export const MIN_LOOP = 0.05;
/** The fade of stops a seek, pause or restart makes, seconds. */
export const REPLAY_STOP_FADE = 0.05;
/** The pose rate the recorder writes (30 Hz, changes only). */
const POSE_FRAME = 1 / 30;

export const UNSEEDED_NOTE = "The Studio's audio runtime couldn't be reseeded from this take (it isn't running): random picks may differ from the game's.";

type Play = Extract<TakeRequest, { kind: "play" }>;
type Pose = Extract<TakeRequest, { kind: "pose" }>;
/** ADR 0386: a handle's pause, resume or fade. */
type HandleOp = Extract<TakeRequest, { kind: "pause" | "resume" | "fade" }>;

/** A fade gain ramp (linear) the handle was given: from `from` at `start` to `to` over `seconds`. */
interface FadeRamp {
  from: number;
  to: number;
  start: number;
  seconds: number;
}

/** The fade gain at `t` (1 without a fade). */
const fadeGainAt = (f: FadeRamp | null, t: number): number =>
  f === null ? 1 : f.seconds <= 0 || t >= f.start + f.seconds ? f.to : f.from + (f.to - f.from) * Math.max(0, (t - f.start) / f.seconds);

interface PoseTrack {
  readonly times: Float64Array;
  readonly poses: readonly Pose[];
}

interface Live {
  instance: number;
  path: string;
  emitter: number | null;
  started: number;
  options: TakePlayOptions;
  parameters: Record<string, number>;
  released: boolean;
  /** ADR 0386: paused since `pausedAt`, after `pausedFor` seconds paused before (the play position stood still then). */
  paused: boolean;
  pausedAt: number;
  pausedFor: number;
  /** ADR 0386: the last fade the game gave its handle, or null. */
  fade: FadeRamp | null;
  handle: ReplayHandle | null;
}

/** A started instance's state before its handle requests: playing, unpaused, at fade gain 1. */
const FRESH = { paused: false, pausedAt: 0, pausedFor: 0, fade: null } as const;

/** A recorded pick's line key; null for none. */
const pickedKey = (p: { key: string } | { none: string } | null): string | null => (p !== null && "key" in p ? p.key : null);

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpVec = (a: Vec3, b: Vec3, k: number): Vec3 => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), z: lerp(a.z, b.z, k) });
const normal = (v: Vec3): Vec3 => {
  const n = Math.hypot(v.x, v.y, v.z);
  return n > 1e-9 ? { x: v.x / n, y: v.y / n, z: v.z / n } : v;
};

const toggled = (set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> => {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
};

export class TakeReplay {
  /** The playhead, take seconds. */
  readonly time = signal(0);
  readonly playing = signal(false);
  readonly loop = signal<LoopRange | null>(null);
  /** What the replay can't do faithfully right now (an unseeded runtime), or null. */
  readonly note = signal<string | null>(null);
  /**
   * ADR 0355 §6, the Take toolbar's **Replay recorded picks**: false (default) re-decides each say against the current
   * project, with the generator restarted from its recorded state; true plays the recorded lines by key instead.
   */
  readonly replayRecordedPicks = signal(false);
  /** ADR 0355 §6: the says whose replay picked differently from the recording, by take instance. */
  readonly pickDifferences = signal<ReadonlyMap<number, PickDifference>>(new Map());
  /** Lines and says replay started, by take instance (their stops and state changes reach them here). */
  private readonly lines = new Map<number, { handle: ReplayLineHandle | null; event: string | null }>();
  private readonly version = signal(0);
  /** The instances started and not stopped, by start time. */
  readonly instances: ReadonlySignal<readonly ReplayInstance[]> = computed(() => {
    void this.version.value;
    return [...this.live.values()].sort((a, b) => a.started - b.started || a.instance - b.instance).map((l) => ({ ...l, parameters: { ...l.parameters } }));
  });

  private readonly live = new Map<number, Live>();
  private readonly tracks = new Map<number, PoseTrack>();
  private readonly plays = new Map<number, Play[]>();
  private readonly releases = new Map<number, number[]>();
  /** ADR 0386: each instance's pauses, resumes and fades, in take order. */
  private readonly handleOps = new Map<number, HandleOp[]>();
  private readonly mixBuses = new Set<string>();
  private readonly hasSnapshots: boolean;
  private readonly hasMaster: boolean;
  private masterBefore: number | null = null;
  private globals: Record<string, number> = {};
  /** Requests before this take time have been issued. */
  private cursor = 0;
  private anchor = { clock: 0, time: 0 };
  private disposed = false;

  constructor(readonly take: Take, private readonly target: ReplayTarget, private readonly clock: ReplayClock) {
    const poses = new Map<number, Pose[]>();
    let snapshots = false;
    let master = false;
    for (const q of take.requests) {
      if (q.kind === "pose") {
        let list = poses.get(q.emitter);
        if (!list) poses.set(q.emitter, (list = []));
        list.push(q);
      } else if (q.kind === "play") {
        let list = this.plays.get(q.instance);
        if (!list) this.plays.set(q.instance, (list = []));
        list.push(q);
      } else if (q.kind === "release") {
        let list = this.releases.get(q.instance);
        if (!list) this.releases.set(q.instance, (list = []));
        list.push(q.t);
      } else if (q.kind === "pause" || q.kind === "resume" || q.kind === "fade") {
        let list = this.handleOps.get(q.instance);
        if (!list) this.handleOps.set(q.instance, (list = []));
        list.push(q);
      } else if (q.kind === "mix") {
        if (q.op === "busVolume" || q.op === "busFade") this.mixBuses.add(q.target);
        else if (q.op === "masterVolume") master = true;
        else snapshots = true;
      }
    }
    for (const [emitter, list] of poses) this.tracks.set(emitter, { times: Float64Array.from(list, (p) => p.t), poses: list });
    this.hasSnapshots = snapshots;
    this.hasMaster = master;
  }

  get duration(): number {
    return this.take.duration;
  }

  /** The global parameters as the take has set them up to the playhead (after a seek: from its keyframe on). */
  get globalValues(): Readonly<Record<string, number>> {
    return { ...this.globals };
  }

  /** The instance the take calls `instance`, while it is started. */
  instance(instance: number): ReplayInstance | null {
    return this.instances.peek().find((i) => i.instance === instance) ?? null;
  }

  /**
   * Where `emitter` is at take time `t`: the recorded poses interpolated. Poses are written at 30 Hz when they change,
   * so across a longer gap the emitter stood still: it holds the earlier pose until one frame before the next. Held
   * before the first pose and after the last; null for an emitter the take never posed.
   */
  poseAt(emitter: number, t: number): ReplayPose | null {
    const track = this.tracks.get(emitter);
    if (!track || track.poses.length === 0) return null;
    const i = lastAtOrBefore(track.times, t);
    if (i < 0) return poseOf(track.poses[0]!);
    if (i >= track.poses.length - 1) return poseOf(track.poses[i]!);
    const a = track.poses[i]!, b = track.poses[i + 1]!;
    const gap = b.t - a.t;
    const start = gap > POSE_FRAME * 1.5 ? b.t - POSE_FRAME : a.t;
    if (t <= start) return poseOf(a);
    const k = Math.min(1, (t - start) / Math.max(1e-9, b.t - start));
    const forward = a.forward && b.forward ? normal(lerpVec(a.forward, b.forward, k)) : (b.forward ?? a.forward);
    return { position: lerpVec(a.position, b.position, k), ...(forward ? { forward } : {}) };
  }

  /** Start playing from the playhead (from the start, or the loop's, when it is at the end). */
  play(): void {
    if (this.disposed || this.playing.peek()) return;
    const loop = this.loop.peek();
    let t = this.time.peek();
    if (t >= this.duration - 1e-6 || (loop && (t < loop.from || t >= loop.to))) t = loop ? loop.from : 0;
    this.reconstruct(t);
    this.anchor = { clock: this.clock.now(), time: t };
    this.time.value = t;
    this.playing.value = true;
  }

  /** Stop playing; the playhead stays. Sounds stop (with a short fade). */
  pause(): void {
    if (!this.playing.peek()) return;
    this.advance();
    this.playing.value = false;
    this.stopAll();
  }

  toggle(): void {
    if (this.playing.peek()) this.pause();
    else this.play();
  }

  /** Move the playhead to `t` (clamped to the take). While playing, the instances alive there start again. */
  seek(t: number): void {
    if (this.disposed) return;
    const at = Math.min(this.duration, Math.max(0, Number.isFinite(t) ? t : 0));
    this.time.value = at;
    if (this.playing.peek()) {
      this.reconstruct(at);
      this.anchor = { clock: this.clock.now(), time: at };
    } else {
      this.stopAll();
      this.cursor = at;
    }
    this.placeEmitters(at);
  }

  /** Play `range` over and over (null: play to the end and stop). A range shorter than `MIN_LOOP` is refused. */
  setLoop(range: LoopRange | null): boolean {
    if (range) {
      const from = Math.max(0, Math.min(range.from, range.to));
      const to = Math.min(this.duration, Math.max(range.from, range.to));
      if (!(to - from >= MIN_LOOP)) return false;
      this.loop.value = { from, to };
      const t = this.time.peek();
      if (this.playing.peek() && (t < from || t >= to)) this.seek(from);
    } else this.loop.value = null;
    return true;
  }

  /** Paths muted on the Take screen's lanes (their instances don't sound; the take keeps them). */
  readonly muted = signal<ReadonlySet<string>>(new Set());
  /** Paths soloed: while any is, only soloed paths sound. */
  readonly soloed = signal<ReadonlySet<string>>(new Set());

  /** Whether instances of `path` sound under the lanes' mute and solo. */
  audible(path: string): boolean {
    const solo = this.soloed.peek();
    return !this.muted.peek().has(path) && (solo.size === 0 || solo.has(path));
  }

  /** Mute or unmute a path's lane; its playing instances stop or start at once (spec 4.5.4 "one lane per sequence with mute/solo"). */
  setMuted(path: string, on: boolean): void {
    this.muted.value = toggled(this.muted.peek(), path, on);
    this.applyAudible();
  }

  /** Solo or unsolo a path's lane. */
  setSoloed(path: string, on: boolean): void {
    this.soloed.value = toggled(this.soloed.peek(), path, on);
    this.applyAudible();
  }

  /** While playing: stop the instances that went silent, start (from where they are) the ones that became audible. */
  private applyAudible(): void {
    if (!this.playing.peek()) return;
    const t = this.time.peek();
    let changed = false;
    for (const l of this.live.values()) {
      const on = this.audible(l.path);
      if (!on && l.handle) {
        l.handle.stop(REPLAY_STOP_FADE);
        l.handle = null;
        changed = true;
      } else if (on && !l.handle?.playing) {
        l.handle = this.start(l, t);
        changed = true;
      }
    }
    if (changed) this.version.value++;
  }

  /** Restart the instances playing now with the current project (an edit reaches them); returns how many. */
  restartInstances(): number {
    let n = 0;
    const t = this.time.peek();
    for (const l of this.live.values()) {
      if (!l.handle?.playing) continue;
      l.handle.stop(REPLAY_STOP_FADE);
      l.handle = this.start(l, t);
      n++;
    }
    if (n > 0) this.version.value++;
    return n;
  }

  /** Each frame: move the playhead by the clock, issue what it passed, move the listener and emitters. */
  tick(): void {
    if (this.disposed) return;
    if (this.playing.peek()) this.advance();
    this.placeEmitters(this.time.peek());
  }

  /** Close: stop everything and put back what the take changed in the mix. */
  dispose(): void {
    if (this.disposed) return;
    this.stopAll();
    this.playing.value = false;
    for (const bus of this.mixBuses) this.target.busVolume(bus, 1, 0);
    if (this.hasSnapshots) this.target.clearSnapshot(0);
    if (this.masterBefore !== null) this.target.masterVolume(this.masterBefore);
    this.target.dispose?.();
    this.disposed = true;
  }

  // --- the clock ------------------------------------------------------------------------------------------------------

  private advance(): void {
    const now = this.clock.now();
    let t = this.anchor.time + Math.max(0, now - this.anchor.clock);
    for (let guard = 0; guard < 64; guard++) {
      const loop = this.loop.peek();
      const end = loop ? loop.to : this.duration;
      if (t < end) break;
      this.dispatch(end);
      if (!loop) {
        this.time.value = this.duration;
        this.playing.value = false;
        this.stopAll();
        return;
      }
      const len = loop.to - loop.from;
      const over = (t - end) % len;
      this.reconstruct(loop.from);
      this.anchor = { clock: now - over, time: loop.from };
      t = loop.from + over;
    }
    this.dispatch(t);
    this.time.value = t;
  }

  /** Issue the requests in `[cursor, to)`. */
  private dispatch(to: number): void {
    if (to <= this.cursor) return;
    let changed = false;
    for (const q of this.take.requestsBetween(this.cursor, to)) changed = this.apply(q) || changed;
    this.cursor = to;
    if (changed) this.version.value++;
  }

  /** One request, as the game made it; true when the started instances changed. */
  private apply(q: TakeRequest): boolean {
    switch (q.kind) {
      case "play": {
        const old = this.live.get(q.instance);
        if (old && Math.abs(old.started - q.t) < 1e-9 && old.path === q.path) return false; // started by the keyframe already
        old?.handle?.stop(0);
        const l: Live = { instance: q.instance, path: q.path, emitter: q.emitter, started: q.t, options: q.options, parameters: { ...q.options.parameters }, released: false, ...FRESH, handle: null };
        l.handle = this.start(l, q.t);
        this.live.set(q.instance, l);
        return true;
      }
      case "line":
        this.lines.set(q.instance, { handle: this.target.line?.(q.key, { ...q.options }) ?? null, event: null });
        return false;
      case "language":
        this.target.language?.(q.audio, q.subtitles);
        return false;
      case "say":
        this.say(q);
        return false;
      case "sayState": {
        const l = this.lines.get(q.instance);
        if (!l || l.event === null || this.replayRecordedPicks.value) return false;
        // A queued say decided when it started: compare that pick (the replayed one may still wait: then nothing yet).
        if (q.state === "playing" && l.handle && l.handle.key !== "") this.notePick(q.instance, l.event, q.t, l.handle.key, pickedKey(q.picked));
        return false;
      }
      case "stop": {
        const line = this.lines.get(q.instance);
        if (line) {
          line.handle?.stop(q.fade);
          this.lines.delete(q.instance);
          return false;
        }
        const l = this.live.get(q.instance);
        if (!l) return false;
        l.handle?.stop(q.fade);
        this.live.delete(q.instance);
        return true;
      }
      case "release": {
        const l = this.live.get(q.instance);
        if (!l || l.released) return false;
        l.released = true;
        l.handle?.release();
        return true;
      }
      case "pause":
      case "resume":
      case "fade": {
        const l = this.live.get(q.instance);
        if (!l || !handleOp(l, q)) return false;
        if (q.kind === "pause") l.handle?.pause?.();
        else if (q.kind === "resume") l.handle?.resume?.();
        else l.handle?.fade?.(q.to, q.seconds);
        return true;
      }
      case "param": {
        if (q.instance === null) {
          this.globals[q.name] = q.value;
          this.target.setGlobal(q.name, q.value);
          return false;
        }
        const l = this.live.get(q.instance);
        if (!l) return false;
        l.parameters[q.name] = q.value;
        l.handle?.setParameter(q.name, q.value);
        return true;
      }
      case "mix":
        this.mix(q.op, q.target, q.value, q.seconds);
        return false;
      case "trigger":
        this.live.get(q.instance)?.handle?.trigger(q.name);
        return false;
      default:
        return false; // marks are drawn; poses are read each frame
    }
  }

  /**
   * ADR 0355 §6: a say as the game asked it. By default it is said again with its recorded arguments (every argument's
   * resolved value), the generator restarted from the state it had then, so unchanged data picks the same line; a pick
   * that differs is noted ("picked X, recorded Y"). With **Replay recorded picks** the recorded line plays by key.
   */
  private say(q: Extract<TakeRequest, { kind: "say" }>): void {
    const { channel, whenBusy, ...play } = q.options;
    if (this.replayRecordedPicks.value) {
      const key = pickedKey(q.picked);
      this.lines.set(q.instance, { handle: key !== null && q.state !== "refused" ? this.target.line?.(key, play) ?? null : null, event: q.event });
      return;
    }
    if (q.random !== undefined) this.target.seed(q.random);
    const args: Record<string, string> = {};
    // A value recorded as `*` matched only wildcards (a value that wasn't a label): left out, it reads its default instead.
    for (const [k, v] of Object.entries(q.args)) if (v !== "*") args[k] = v;
    const handle = this.target.say?.(q.event, { ...play, args, ...(channel !== undefined ? { channel } : {}), ...(whenBusy !== undefined ? { whenBusy } : {}) }) ?? null;
    this.lines.set(q.instance, { handle, event: q.event });
    if (q.state === "queued") return; // compared when it starts (`sayState`)
    const picked = handle && handle.state !== "ended" && handle.key !== "" ? handle.key : null;
    this.notePick(q.instance, q.event, q.t, picked, pickedKey(q.picked));
  }

  private notePick(instance: number, event: string, t: number, picked: string | null, recorded: string | null): void {
    const before = this.pickDifferences.value;
    if (picked === recorded) {
      if (!before.has(instance)) return;
      const next = new Map(before);
      next.delete(instance);
      this.pickDifferences.value = next;
      return;
    }
    this.pickDifferences.value = new Map(before).set(instance, { instance, event, t, picked, recorded });
  }

  private mix(op: Extract<TakeRequest, { kind: "mix" }>["op"], target: string, value: number, seconds: number): void {
    switch (op) {
      case "busVolume":
        return this.target.busVolume(target, value, 0);
      case "busFade":
        return this.target.busVolume(target, value, Math.max(0, seconds));
      case "snapshotStart":
        return this.target.snapshot(target, Math.max(0, seconds));
      case "snapshotStop":
        return this.target.clearSnapshot(Math.max(0, seconds));
      case "masterVolume":
        if (this.masterBefore === null) this.masterBefore = this.target.masterVolume();
        this.target.masterVolume(value);
    }
  }

  private start(l: Live, t: number): ReplayHandle | null {
    if (!this.audible(l.path)) return null;
    const pose = l.emitter === null ? null : this.poseAt(l.emitter, t);
    // Alive since before `t` (a seek, a resume): it starts as far in as it had played, less the time it stood paused.
    const offset = (l.paused ? l.pausedAt : t) - l.started - l.pausedFor;
    const h = this.target.play(l.path, { ...l.options, parameters: { ...l.parameters }, ...(pose ? { position: pose.position } : {}), ...(offset > 0.01 ? { offset } : {}) });
    if (h && l.released) h.release();
    if (h && l.fade) {
      // ADR 0386: the fade gain where the game's fade had it at `t`, then the rest of that fade.
      h.fade?.(fadeGainAt(l.fade, t), 0);
      const left = l.fade.start + l.fade.seconds - t;
      if (left > 0) h.fade?.(l.fade.to, left);
    }
    if (h && l.paused) h.pause?.();
    return h;
  }

  private stopAll(): void {
    for (const l of this.lines.values()) l.handle?.stop(REPLAY_STOP_FADE);
    this.lines.clear();
    for (const l of this.live.values()) l.handle?.stop(REPLAY_STOP_FADE);
    if (this.live.size > 0) {
      this.live.clear();
      this.version.value++;
    }
  }

  private placeEmitters(t: number): void {
    const ears = this.poseAt(0, t);
    if (ears) this.target.listener(ears);
    for (const l of this.live.values()) {
      if (l.emitter === null || !l.handle?.playing) continue;
      const pose = this.poseAt(l.emitter, t);
      if (pose) l.handle.position = pose.position;
    }
  }

  // --- seeking --------------------------------------------------------------------------------------------------------

  /**
   * Bring the runtime to take time `t`: stop everything, then from the nearest keyframe (its instances and globals) and
   * the requests after it work out what is alive at `t` and its parameters, set the mix as the requests before `t` left
   * it, and start the alive instances. Requests at `t` itself are issued by the next dispatch.
   */
  private reconstruct(t: number): void {
    this.stopAll();
    const seek = this.take.seek(t);
    const kf = seek.keyframe;
    const alive = new Map<number, Live>();
    /** The instances alive at the keyframe: their picks were made before it. */
    const before = new Set<number>();
    const globals: Record<string, number> = { ...(kf?.globals ?? {}) };
    if (kf) {
      for (const k of kf.instances) {
        const play = this.playOf(k.instance, k.started, kf.t);
        const released = (this.releases.get(k.instance) ?? []).some((r) => r >= (play?.t ?? k.started) && r < kf.t);
        alive.set(k.instance, { instance: k.instance, path: k.path, emitter: k.emitter, started: k.started, options: play?.options ?? {}, parameters: { ...k.parameters }, released, ...FRESH, handle: null });
        before.add(k.instance);
      }
    }
    for (const q of seek.requests) {
      if (q.kind === "play") {
        alive.delete(q.instance);
        before.delete(q.instance);
        alive.set(q.instance, { instance: q.instance, path: q.path, emitter: q.emitter, started: q.t, options: q.options, parameters: { ...q.options.parameters }, released: false, ...FRESH, handle: null });
      } else if (q.kind === "stop") alive.delete(q.instance);
      else if (q.kind === "release") {
        const l = alive.get(q.instance);
        if (l) l.released = true;
      } else if (q.kind === "param") {
        if (q.instance === null) globals[q.name] = q.value;
        else {
          const l = alive.get(q.instance);
          if (l) l.parameters[q.name] = q.value;
        }
      }
    }
    // ADR 0386: each alive instance's pauses and fades since it started, up to `t` (those at `t` the next dispatch issues).
    for (const l of alive.values()) for (const q of this.handleOps.get(l.instance) ?? []) if (q.t >= l.started - 1e-9 && q.t < t) handleOp(l, q);
    this.globals = globals;
    for (const [name, value] of Object.entries(globals)) this.target.setGlobal(name, value);
    this.mixAt(t);
    // The keyframe's instances first (the game made their picks before the keyframe), then the World's pick generator
    // restarts from the state the keyframe recorded, then the plays after it pick as the game's did.
    for (const l of alive.values()) {
      if (!before.has(l.instance)) continue;
      l.handle = this.start(l, t);
      this.live.set(l.instance, l);
    }
    const seed = this.seedAt(kf);
    if (seed !== null && !this.target.seed(seed)) this.note.value = UNSEEDED_NOTE;
    for (const l of alive.values()) {
      if (before.has(l.instance)) continue;
      l.handle = this.start(l, t);
      this.live.set(l.instance, l);
    }
    this.cursor = t;
    this.version.value++;
  }

  /**
   * The generator state to restart from at keyframe `kf`: the state it recorded; at the take's start (no keyframe, or the
   * first at 0) META's `seed`, the state when the take began. Null for a take whose picks were unseeded, and for a later
   * keyframe that recorded none (a take from before keyframes carried it): the generator then runs on.
   */
  private seedAt(kf: TakeKeyframe | null): number | null {
    if (this.take.meta.seeded === false) return null;
    if (kf?.random !== undefined) return kf.random;
    return !kf || kf.t <= 0 ? this.take.meta.seed : null;
  }

  /** The PLAY that started keyframe instance `instance` (started at `started`, alive at `kfT`). */
  private playOf(instance: number, started: number, kfT: number): Play | null {
    const list = this.plays.get(instance);
    if (!list) return null;
    let best: Play | null = null;
    for (const p of list) if (p.t <= kfT + 1e-9 && (Math.abs(p.t - started) < 1e-6 || !best || p.t > best.t)) best = p;
    return best;
  }

  /** The mix as the requests before `t` left it: each bus's last volume or fade (what is left of it), the snapshot, master. */
  private mixAt(t: number): void {
    const buses = new Map<string, { value: number; remaining: number }>();
    let snapshot: { name: string; remaining: number } | null = null;
    let master: number | null = null;
    for (const q of this.take.requestsBetween(0, t)) {
      if (q.kind !== "mix") continue;
      const remaining = Math.max(0, q.t + q.seconds - t);
      if (q.op === "busVolume") buses.set(q.target, { value: q.value, remaining: 0 });
      else if (q.op === "busFade") buses.set(q.target, { value: q.value, remaining });
      else if (q.op === "snapshotStart") snapshot = { name: q.target, remaining };
      else if (q.op === "snapshotStop") snapshot = null;
      else master = q.value;
    }
    for (const bus of this.mixBuses) {
      const b = buses.get(bus);
      this.target.busVolume(bus, b ? b.value : 1, b ? b.remaining : 0);
    }
    if (snapshot) this.target.snapshot(snapshot.name, snapshot.remaining);
    else if (this.hasSnapshots) this.target.clearSnapshot(0);
    if (this.hasMaster) {
      if (this.masterBefore === null) this.masterBefore = this.target.masterVolume();
      this.target.masterVolume(master ?? this.masterBefore);
    }
  }
}

/** ADR 0386: `q` applied to `l`'s replay state; false when it changes nothing (a pause while paused, a resume while playing). */
function handleOp(l: Live, q: HandleOp): boolean {
  if (q.kind === "pause") {
    if (l.paused) return false;
    l.paused = true;
    l.pausedAt = q.t;
    return true;
  }
  if (q.kind === "resume") {
    if (!l.paused) return false;
    l.paused = false;
    l.pausedFor += q.t - l.pausedAt;
    return true;
  }
  l.fade = { from: fadeGainAt(l.fade, q.t), to: q.to, start: q.t, seconds: q.seconds };
  return true;
}

function poseOf(p: Pose): ReplayPose {
  return { position: p.position, ...(p.forward ? { forward: p.forward } : {}) };
}

// --- the runtime adapter ------------------------------------------------------------------------------------------------

/** The World-side pieces of replay (`takeWorld.ts`): the listener entity and the seed. */
export interface ReplayWorld {
  listener(pose: ReplayPose): void;
  seed(seed: number): boolean;
  dispose(): void;
}

/** The Studio's runtime as a replay target: its public `Audio` API, and `world` for the listener and the seed. */
export function studioReplayTarget(host: StudioAudioHost, world: ReplayWorld): ReplayTarget {
  const audio = host.audio;
  return {
    play(path, o) {
      const handle = host.audition(path, {
        ...(o.volume !== undefined ? { volume: o.volume } : {}),
        ...(o.pitch !== undefined ? { pitch: o.pitch } : {}),
        ...(o.bus !== undefined ? { bus: o.bus } : {}),
        ...(o.priority !== undefined ? { priority: o.priority } : {}),
        ...(o.parameters ? { parameters: o.parameters } : {}),
        ...(o.position ? { position: o.position } : {}),
        ...(o.offset !== undefined ? { offset: o.offset } : {}),
      }, "layer"); // a take's instances play together, beside whatever previews
      return handle;
    },
    setGlobal: (name, value) => audio.setParameter(name, value),
    busVolume(bus, value, seconds) {
      const b = audio.bus(bus);
      if (!b.exists) return;
      if (seconds > 0) b.fadeTo(value, seconds);
      else b.volume = value;
    },
    snapshot: (name, seconds) => audio.snapshot(name, seconds),
    clearSnapshot: (seconds) => audio.clearSnapshot(seconds),
    masterVolume(value) {
      if (value !== undefined) audio.volume = value;
      return audio.volume;
    },
    listener: (pose) => world.listener(pose),
    seed: (seed) => world.seed(seed),
    dispose: () => world.dispose(),
    line: (key, o) => audio.line(key, lineOptions(o)),
    say: (event, o) => audio.say(event, { ...lineOptions(o), args: { ...o.args }, ...(o.channel !== undefined ? { channel: o.channel } : {}), ...(o.whenBusy !== undefined ? { whenBusy: o.whenBusy } : {}) }),
    language(audioLanguage, subtitles) {
      void audio.setLanguage(audioLanguage).catch(() => undefined);
      audio.subtitleLanguage = subtitles;
    },
  };
}

/** A replayed line's play options (`Audio.line`'s), from the recorded ones. */
function lineOptions(o: ReplayPlayOptions): { volume?: number; pitch?: number; bus?: string; priority?: number; parameters?: Record<string, number>; position?: Vec3 } {
  return {
    ...(o.volume !== undefined ? { volume: o.volume } : {}),
    ...(o.pitch !== undefined ? { pitch: o.pitch } : {}),
    ...(o.bus !== undefined ? { bus: o.bus } : {}),
    ...(o.priority !== undefined ? { priority: o.priority } : {}),
    ...(o.parameters ? { parameters: o.parameters } : {}),
    ...(o.position ? { position: o.position } : {}),
  };
}

/** The page's clock for replay: `performance.now()` in seconds. */
export const performanceClock: ReplayClock = { now: () => performance.now() / 1000 };
