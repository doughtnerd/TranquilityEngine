// The core's `AudioBackend` (ADR 0157 K3; api-and-models §3 "Mixer counting", §6 "AudioBackend changes"; architecture
// §3.2): plays through the voice table and the command writer, reads the core through the status mirror, loads
// clips through the clip registry (K9), and keeps time with the clock map. `service.ts` registers a factory for it
// (`registerCoreBackend`) once the core has loaded.
//
// Frame flow (`update(dt)`, called by the audio system once per frame): clock.beginFrame, mirror.beginFrame, free ended
// voices, apply clip events to the registry, start voices that were waiting for the unlock, move spatial voices, run
// the voice selection (A3.1, `selection.ts`: SET_MIXED for changes, steals over a bus's `maxVoices`), drain the table's
// STOP and FADE commands into the writer, flush the batch at `clock.nextFirstFrame()`. Everything the mirror does
// happens in `onmessage`, separately.
//
// Selection (A3.1): a new voice's PLAY carries the `mixed` bit `Selection.admit` decides (room under the cap); each
// frame `Selection.run` promotes and demotes with hysteresis and dwell, and the core fades 5 ms either way. Spatial
// voices get their listener-space direction and distance gain here (A1.5's models, through `ListenerBasis`, which
// allocates nothing). Only mixed voices get SET_PARAMS for gain and direction; virtual ones keep fresh values in the
// table for their audibility, and SET_MIXED carries them on a promote.
//
// HRTF (H3): after selection, `HrtfPick` flags the top `voices.hrtf` mixed spatial voices by audibility (1.2x
// hysteresis) with panner kind 1, sent as SET_PARAMS `flags`; the core crossfades 45 ms either way. The first flag
// starts the lazy HRIR fetch (`hrir.ts`); `audio.spatial: "equalPower"` or `voices.hrtf: 0` never flags or fetches.
//
// A1.6 added `volume, pitch, priority, oneShot, at, attenuation, position` to `PlayRequest` and `id, reason, fade,
// setPriority, stop(fadeSeconds)` to `AudioVoice` (§6). `CorePlayRequest` and `CoreVoice` keep only what the core adds.
import type { Vec3Like } from "../../../../engine/core/math";
import { mixer as defaultMixer, type Mixer, type ResolvedBus } from "../../../../engine/audio/mixer";
import type { BusEffect } from "../../../../engine/audio/settings";
import { Assets } from "../../../../engine/scene/Assets";
import type { Attenuation, AudioBackend, AudioBackground, AudioStatus, AudioVoice, ListenerPose, PlayRequest } from "../backend";
import {
  BUS_LP_OFF_HZ,
  BUS_ROOT,
  PLAY_FLAGS_LOOP,
  PLAY_FLAGS_MIXED,
  PLAY_FLAGS_SPATIAL,
  readStatus,
  SET_PARAMS_MASK_BUS,
  SET_PARAMS_MASK_DIR,
  SET_PARAMS_MASK_GAIN,
  SET_PARAMS_MASK_PITCH,
  type BusConfigBuses,
  type BusConfigBusesEffects,
  type BusMixBuses,
} from "../wire.generated";
import { AudioHandle, type AudioReason } from "./handle";
import { limiterLatencyFrames } from "./limiterLatency";
import { ClockMap } from "./clock";
import { CommandWriter, type PlayArgs } from "./commandWriter";
import { createHrirLoader, type HrirLoader } from "./hrir";
import { createClipRegistry, type ClipInfo, type ClipRegistry } from "./clipRegistry";
import { DEFAULT_CLIP_CEILING_MB, type AudioHost, type CoreLink, type HostHealth } from "./context";
import { PlayheadTracker, Replayer } from "./replay";
import { buildDebugInfo, type AudioDebugInfo } from "./debug";
import { BackgroundController } from "./background";
import { browserHostClock, type HostClock } from "./hostClock";
import { StatusMirror } from "./mirror";
import { DistanceEffect } from "./spatial";
import { StatusReader } from "./statusReader";
import { UnlockQueue } from "./unlockQueue";
import { connectVoiceTable, VoiceFlag, VoiceReason, VoiceRolloff, VoiceState, VoiceTable } from "./voiceTable";
import { effectiveMixedCap, ListenerBasis, Selection, type SelectionSink } from "./selection";
import { HrtfPick, type HrtfSink } from "./hrtfPick";

/** `PlayRequest` plus the core's World key. */
export interface CorePlayRequest extends PlayRequest {
  /** The World key of the playing World (0 or omitted: none). */
  world?: number;
}

/** One voice as `AudioVoice`, with §6's optional members required, plus the handle. */
export interface CoreVoice extends AudioVoice {
  readonly id: number;
  readonly reason: AudioReason | null;
  readonly handle: AudioHandle;
  fade(to: number, seconds: number): void;
  setPriority(priority: number): void;
  stop(fadeSeconds?: number): void;
}

/** What the backend needs of the host (an `AudioHost`, or a fake in tests). */
export interface CoreBackendHost {
  readonly link: Pick<CoreLink, "batchPool" | "nextSeq" | "post" | "onStatus"> & { statusDecoder: CoreLink["statusDecoder"] };
  readonly status: "locked" | "running" | "failed";
  /**
   * `maxMixed` is `voices.mixed` (selection's configured cap; absent: every logical voice may be mixed).
   * `limiterLookaheadMs` sets the core's output latency the clock map allows for (absent: the 1.5 ms default).
   */
  readonly preset: { readonly maxLogical: number; readonly maxMixed?: number; readonly limiterLookaheadMs?: number };
  /** Worlds holding a share (an idle host has none). */
  readonly worldCount: number;
  readonly sampleRate: number;
  addLifecycleListener: AudioHost["addLifecycleListener"];
  /** Architecture §8 health counters (traps, recoveries, rebuilds) of the host, for `Audio.debug()` (A3.4a). */
  readonly health?: HostHealth;
}

/**
 * B6: where a `stream: true` play goes (B3 implements it on the decoder worker's streams and the core's stream
 * voices). A request the seam takes is never decoded whole; `open` returns its voice, or null when it cannot start.
 */
export interface CoreStreamSeam {
  open(req: CorePlayRequest): CoreVoice | null;
}

/** What `createCoreBackend` takes beyond the host (tests inject fakes). */
export interface CoreBackendDeps {
  /** Streamed plays (the `stream` import setting). Absent (before B3): such a clip is decoded whole, with one warning per asset. */
  streams?: CoreStreamSeam;
  /** The registry for clips; defaults to one wired to the host (CoreLink, `fetch`, the decoder worker). */
  clips?: ClipRegistry;
  clock?: HostClock;
  mixer?: Mixer;
  /** The table; defaults to one of `host.preset.maxLogical` slots. */
  table?: VoiceTable;
  /** The HRTF table loader (H2); defaults to one on `clips` at the host rate. Tests inject a fake. */
  hrir?: HrirLoader;
}

const DIR_EPSILON = 0.005;
const GAIN_EPSILON = 0.001;
const MAX_PITCH = 16;
const MIN_PITCH = 0.0625;
const MAX_BUS = 32;
const ROLLOFF_NAMES = ["linear", "inverse", "exponential"] as const;
/** Architecture §4.7: promote and demote fade 5 ms; a voice stolen while on the core fades out as long. */
const STEAL_FADE_SECONDS = 0.005;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Maps a `BusEffect` to its wire record (§4.2 BUS_CONFIG: q in dB, p unused = 0). */
function wireEffect(e: BusEffect): BusConfigBusesEffects {
  const p = [0, 0, 0, 0, 0, 0, 0];
  switch (e.type) {
    case "lowpass":
      p[0] = e.frequency;
      p[1] = e.q;
      return { type: 0, p };
    case "highpass":
      p[0] = e.frequency;
      p[1] = e.q;
      return { type: 1, p };
    case "compressor":
      p[0] = e.threshold;
      p[1] = e.knee;
      p[2] = e.ratio;
      p[3] = e.attack;
      p[4] = e.release;
      return { type: 2, p };
    case "reverb":
      p[0] = e.send;
      return { type: 3, p };
  }
}

export class CoreBackend implements AudioBackend {
  readonly name = "core";
  readonly table: VoiceTable;
  readonly mirror: StatusMirror;
  readonly writer: CommandWriter;
  readonly clockMap: ClockMap;
  readonly clips: ClipRegistry;
  readonly mixer: Mixer;
  /** The per-frame voice selection (A3.1). */
  readonly selection: Selection;
  /** Where each voice is in its clip (A3.4a), for a hard rebuild's replay. */
  readonly playheads: PlayheadTracker;
  /** The hard rebuild's replay (A3.4a; `replay.ts`). */
  readonly replayer: Replayer;
  /** H3: which voices the core pans with HRTF. */
  readonly hrtf: HrtfPick;
  private readonly hrtfSink: HrtfSink;

  private readonly clock: HostClock;
  private readonly reader = new StatusReader();
  private readonly cleanups: (() => void)[] = [];
  private names: string[] = [];
  private readonly busIndexByName = new Map<string, number>();
  /** D5: voices played while locked. One-shots are capped (32 for 1 s); owned and looping voices wait. */
  readonly lockedQueue = new UnlockQueue<number>({
    onDrop: (id) => {
      if (this.table.isLive(id) && this.table.state[id & 0xffff] === VoiceState.LOCKED) this.table.free(id, VoiceReason.NONE);
    },
  });
  private spatialCount = 0;
  private readonly spatialDirty: Uint8Array;
  private listenerDirty = true;
  private readonly listenerPos: [number, number, number] = [0, 0, 0];
  private readonly listenerFwd: [number, number, number] = [0, 0, -1];
  private readonly listenerUp: [number, number, number] = [0, 1, 0];
  private readonly distance = new DistanceEffect();
  private readonly basis = new ListenerBasis();
  private readonly selectionSink: SelectionSink;
  private readonly playArgs: PlayArgs = { voiceId: 0, clip: 0, bus: 0, flags: 0, group: 0, gain: 1, pitch: 1, dirX: 0, dirY: 0, dirZ: -1, lpHz: BUS_LP_OFF_HZ, score: 0, startOffsetFrames: 0 };
  private readonly mixPool: BusMixBuses[] = [];
  private readonly mixView: BusMixBuses[] = [];
  private idlePending = false;
  private master = 1;
  private isMuted = false;
  private disposed = false;
  private readonly hrir: HrirLoader;
  private readonly clipSink: { event(id: number, code: number): void };
  private readonly streams: CoreStreamSeam | undefined;
  private readonly streamWarned = new Set<string>();

  constructor(
    readonly host: CoreBackendHost,
    deps: CoreBackendDeps & { clock: HostClock; clips: ClipRegistry },
  ) {
    this.mixer = deps.mixer ?? defaultMixer;
    this.clock = deps.clock;
    this.clips = deps.clips;
    this.streams = deps.streams;
    this.hrir = deps.hrir ?? createHrirLoader({ clips: deps.clips, sampleRate: host.sampleRate });
    this.table = deps.table ?? new VoiceTable(host.preset.maxLogical);
    this.spatialDirty = new Uint8Array(this.table.capacity);
    this.selection = new Selection(this.table);
    this.hrtf = new HrtfPick(this.table);
    this.hrtfSink = { setPanner: (i, on) => this.sendPanner(i, on) };
    this.basis.set(this.listenerPos, this.listenerFwd, this.listenerUp);
    this.selectionSink = {
      setMixed: (i, mixed) => this.sendMixed(i, mixed),
      steal: (i) => this.stealSlot(i),
      setScore: (i, score) => this.sendScore(i, score),
    };
    this.mirror = new StatusMirror(this.table);
    this.writer = new CommandWriter(host.link, host.sampleRate);
    this.clockMap = new ClockMap(this.clock, host.sampleRate, limiterLatencyFrames(host.sampleRate, host.preset.limiterLookaheadMs));
    this.playheads = new PlayheadTracker(this.table, this.clips, host.sampleRate);
    this.replayer = new Replayer(this, host.link);
    for (let i = 0; i < MAX_BUS; i++) this.mixPool.push({ gain: 1, lpHz: BUS_LP_OFF_HZ });
    this.clipSink = { event: (id, code) => this.clips.applyClipEvent(id, code) };

    // STATUS: decode into one block, apply in onmessage.
    host.link.statusDecoder = (buffer) => this.reader.read(buffer);
    this.cleanups.push(this.mirror.attach(host.link));
    // Voice ends free the slot's clip reference and the bus count (api §3 "Mixer counting").
    this.table.onFree = (id, bus) => this.onFree(id, bus);
    this.cleanups.push(connectVoiceTable(this.table, host));
    this.cleanups.push(
      host.addLifecycleListener({
        onBusRemap: () => this.configureBuses(this.mixer),
        onIdle: () => {
          this.idlePending = true;
        },
        onClose: () => this.dispose(),
        onRebuildStart: () => this.beginRecovery(),
        onContextReplaced: (rate) => this.contextReplaced(rate),
        onRebuilt: () => this.endRecovery(),
        onRecoveryFailed: () => this.recoveryFailed(),
      }),
    );
    this.cleanups.push(this.mixer.onChange(() => this.applyMix(this.mixer.resolveAll())));
    this.configureBuses(this.mixer);
  }

  /** §1 `Audio.time`. */
  get time(): number {
    return this.clockMap.audioTime();
  }

  /** §1 `Audio.status`. */
  get status(): AudioStatus {
    return this.host.status;
  }

  private background: AudioBackground = "mute";

  /** §6 `setBackground`: what the host does when the page is hidden (`background.ts` applies it at the next hide). */
  setBackground(mode: AudioBackground): void {
    this.background = mode;
  }

  /** @internal The mode last set. */
  get backgroundMode(): AudioBackground {
    return this.background;
  }

  // --- Background hooks (A3.4b; `background.ts` is the `BackgroundTarget` caller) ---

  private hiddenMuteOn = false;
  private hidden = false;

  /** @internal MASTER is held at 0 by the hidden-page policy (a rebuild's replayed MASTER keeps it so). */
  get hiddenMuted(): boolean {
    return this.hiddenMuteOn;
  }
  /** @internal The background controller, when `createCoreBackend` made one (its counters feed `debug()`). */
  health: { readonly backgroundEnters: number; readonly interruptions: number } | null = null;

  /** @internal Runs `fn` when the backend is disposed. */
  addCleanup(fn: () => void): void {
    this.cleanups.push(fn);
  }

  /** @internal STATUS blocks applied so far (the heartbeat the stall check watches). */
  get statusBlocks(): number {
    return this.mirror.blocks;
  }

  /** @internal Whether the page is hidden (for `debug()`). */
  get pageHidden(): boolean {
    return this.hidden;
  }

  /** @internal §3.8: while hidden no frame frees ended voices, so STATUS handling does (and frees what already ended). */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.mirror.freeEndedInMessage = hidden;
    if (hidden && !this.disposed) this.table.freeEnded();
  }

  /** @internal §3.8: MASTER to 0 (or back) over `rampMs`, flushed now since no frame will. `Audio.muted` and the volume are kept. */
  hiddenMute(on: boolean, rampMs: number): void {
    if (this.disposed) return;
    this.hiddenMuteOn = on;
    this.writer.master(this.master, this.isMuted || on, Math.max(1, Math.round((rampMs / 1000) * this.host.sampleRate)));
    this.writer.flush(this.clockMap.nextFirstFrame());
  }

  /** @internal §3.8: the next frame re-anchors the clock map. */
  reanchor(): void {
    this.clockMap.reanchor();
  }

  /** The bus names by index (root first), as last configured. */
  get busNames(): readonly string[] {
    return this.names;
  }

  /** Starts a clip. Returns null only when the backend can't play at all (the host failed). */
  play(req: CorePlayRequest): CoreVoice | null {
    if (this.disposed || this.host.status === "failed") return null;
    if (req.stream) {
      // The `stream` import setting (B6): a streamed clip is never decoded whole when the core can stream it.
      if (this.streams) return this.streams.open(req);
      if (!this.streamWarned.has(req.path)) {
        this.streamWarned.add(req.path);
        console.warn(`[myco] "${req.path}" is set to stream, which this audio core can't do yet; it loads whole.`);
      }
    }
    const world = req.world ?? 0;
    const clip = this.clips.acquire(req.path, world);
    const bus = this.busIndex(req.bus);
    const priority = req.priority ?? 128;
    // A3.4a: while a hard rebuild runs, new plays wait in the locked queue and start once the new core is up.
    const running = this.host.status === "running" && !this.recovering;
    const id = this.table.allocate(bus, priority, world, running ? VoiceState.WAITING_FOR_DATA : VoiceState.LOCKED);
    if (id === 0) {
      this.clips.release(clip);
      return null;
    }
    const t = this.table;
    const i = id & 0xffff;
    t.clip[i] = clip;
    t.volume[i] = req.volume !== undefined && Number.isFinite(req.volume) ? Math.max(0, req.volume) : 1;
    t.pitch[i] = req.pitch !== undefined && Number.isFinite(req.pitch) ? clamp(req.pitch, MIN_PITCH, MAX_PITCH) : 1;
    t.flags[i] = (req.loop ? VoiceFlag.LOOP : 0) | (req.oneShot ? VoiceFlag.ONE_SHOT : 0);
    t.lpHz[i] = BUS_LP_OFF_HZ;
    t.dirX[i] = 0;
    t.dirY[i] = 0;
    t.dirZ[i] = -1;
    if (req.attenuation) this.applyAttenuation(i, req.attenuation);
    if (req.position) this.applyPosition(i, req.position);
    this.refreshGain(i);
    // `at` is ignored while locked (API §1); the stamp-or-asap choice is made when the PLAY is sent (`sendPlay`).
    t.startFrame[i] = running ? this.clockMap.frameOfTime(req.at) : 0;
    this.mixer.voiceStarted(this.names[bus] ?? "");
    if (running) this.launch(id);
    else if (req.oneShot && !req.loop) this.lockedQueue.pushOneShot(id, performance.now());
    else this.lockedQueue.pushOwned(id);
    return new Voice(this, id);
  }

  setListener(pose: ListenerPose): void {
    const p = pose.position;
    const f = pose.forward;
    const u = pose.up;
    const pos = this.listenerPos;
    const fwd = this.listenerFwd;
    const up = this.listenerUp;
    if (pos[0] !== p.x || pos[1] !== p.y || pos[2] !== p.z || fwd[0] !== f.x || fwd[1] !== f.y || fwd[2] !== f.z || up[0] !== u.x || up[1] !== u.y || up[2] !== u.z) {
      pos[0] = p.x;
      pos[1] = p.y;
      pos[2] = p.z;
      fwd[0] = f.x;
      fwd[1] = f.y;
      fwd[2] = f.z;
      up[0] = u.x;
      up[1] = u.y;
      up[2] = u.z;
      this.listenerDirty = true;
      this.basis.set(pos, fwd, up);
    }
  }

  /** BUS_MIX from the resolved buses: each bus's own gain (the core multiplies down the tree) and snapshot low-pass. */
  applyMix(buses: readonly ResolvedBus[]): void {
    if (this.disposed) return;
    const view = this.mixView;
    view.length = 0;
    const n = Math.min(buses.length, MAX_BUS);
    const busGain = this.selection.busGain;
    for (let b = 0; b < n; b++) {
      const item = this.mixPool[b]!;
      item.gain = buses[b]!.gain;
      item.lpHz = buses[b]!.snapshotLowpass ?? BUS_LP_OFF_HZ;
      view.push(item);
      // Selection's audibility uses the effective gain down the tree (A3.1).
      const g = buses[b]!.effectiveGain;
      busGain[b] = Number.isFinite(g) && g > 0 ? g : 0;
    }
    this.writer.busMix(view, this.clockMap.rampFrames());
  }

  /** Rebuilds the core's bus tree: BUS_CONFIG, the table's per-bus limits, and BUS_MIX. */
  configureBuses(mixer: Mixer): void {
    const settings = mixer.audioSettings.buses;
    this.names = settings.map((b) => b.name);
    this.busIndexByName.clear();
    this.names.forEach((n, i) => this.busIndexByName.set(n, i));
    this.writer.busConfig(this.busConfigWire(mixer));
    // The mixer's counts restart at 0 when it is reconfigured; the table knows every live voice (virtual and locked
    // included), so ducking keeps counting them across a remap. Peaks reported for the old indices are dropped.
    this.names.forEach((n, i) => mixer._setVoiceCount(n, this.table.busLive[i]!));
    this.mirror.resetPeaks();
    this.table.setBusLimits(settings.map((b) => b.maxVoices ?? 0));
    // A remap (A0.8) has already moved the table's voices to the new tree's indices; the core's
    // voices still carry the old ones, so each voice on the core is re-routed (after BUS_CONFIG, in
    // the same batch).
    const t = this.table;
    for (let i = 0; i < t.capacity; i++) {
      if (!this.onCore(i)) continue;
      this.writer.setParams(((t.gen[i]! << 16) | i) >>> 0, SET_PARAMS_MASK_BUS, 0, 0, 0, 0, 0, 0, 0, t.bus[i]!);
    }
    this.applyMix(mixer.resolveAll());
  }

  /** BUS_CONFIG's buses for the tree last configured, root first (also the hard rebuild's replay, A3.4a). */
  busConfigWire(mixer: Mixer = this.mixer): BusConfigBuses[] {
    return mixer.audioSettings.buses.map((b) => ({
      parent: b.parent === undefined ? BUS_ROOT : (this.busIndexByName.get(b.parent) ?? 0),
      effects: b.effects.map(wireEffect),
    }));
  }

  get masterVolume(): number {
    return this.master;
  }

  set masterVolume(v: number) {
    this.master = clamp(Number.isFinite(v) ? v : 1, 0, 1);
    this.writer.master(this.master, this.isMuted || this.hiddenMuteOn, this.clockMap.rampFrames());
  }

  get muted(): boolean {
    return this.isMuted;
  }

  set muted(m: boolean) {
    this.isMuted = m;
    this.writer.master(this.master, m || this.hiddenMuteOn, this.clockMap.rampFrames());
  }

  /** The per-frame step; see the header. */
  update(dt: number): void {
    void dt;
    if (this.disposed) return;
    const clockMap = this.clockMap;
    clockMap.beginFrame();
    // A3.4c: after a context swap, the old core's last STATUS is in the old context's frames: wait for the new one's.
    if (this.mirror.blocks > this.staleBlocks) clockMap.noteStatus(this.mirror.frameAudio, this.mirror.frameDateMs);
    this.mirror.beginFrame();
    this.publishPeaks();
    this.table.freeEnded();
    this.mirror.drainClipEvents(this.clipSink);
    this.replayer.flush();
    if (this.lockedQueue.size > 0 && this.host.status === "running" && !this.recovering) this.unlock();
    if (this.spatialCount > 0) this.moveSpatial();
    this.select();
    this.pickHrtf();
    if (this.idlePending) this.checkIdle();
    this.table.drainCommands(this.writer);
    // A3.4a: during a rebuild (or after recovery gave up) no core keeps what is sent; the replay re-derives it all.
    if (this.recovering || this.host.status === "failed") this.writer.clear();
    else if (this.writer.pending > 0) this.writer.flush(clockMap.nextFirstFrame());
  }

  // --- The hard rebuild (A3.4a; `recovery.ts` drives the host, `replay.ts` restores the voices) ---

  private recovering = false;

  /** True between the old core's loss and the new core's first STATUS. */
  get isRecovering(): boolean {
    return this.recovering;
  }

  /** `onRebuildStart`: the old core is gone; voices keep their handles and state, new plays queue. */
  private beginRecovery(): void {
    if (this.disposed) return;
    this.recovering = true;
    this.replayer.begin();
  }

  /** STATUS blocks that came from a context since replaced: the clock map's fallback ignores them (A3.4c). */
  private staleBlocks = 0;

  /**
   * `onContextReplaced` (A3.4c, architecture §3.7): the rebuild made a new context at `rate`, whose frames start at 0.
   * The voices' playheads and the trap frame are carried in `Audio.time` seconds (`Replayer.newContext`); the clock
   * map takes the new rate and the limiter latency at it, and keeps `Audio.time` continuous (`ClockMap.rebase`); the
   * writer converts seconds at the new rate; the HRIR is resampled for it from the original asset. Clips keep their
   * own rate (the registry re-decodes them at it; the core's resampler absorbs the difference).
   */
  private contextReplaced(rate: number): void {
    if (this.disposed) return;
    const clock = this.clockMap;
    this.replayer.newContext(clock.sampleRate, clock.timeOffset);
    // The old clock's newest estimate (its last frame's offset, extrapolated with the page clock) and its frame's time.
    clock.rebase(rate, limiterLatencyFrames(rate, this.host.preset.limiterLookaheadMs), clock.carryPoint());
    this.writer.sampleRate = rate;
    this.hrir.retarget?.(rate);
    this.staleBlocks = this.mirror.blocks;
  }

  /** `onRebuilt`: the new core answered: RESET 0, buses, MASTER, the clips again, then the voices as their clips return. */
  private endRecovery(): void {
    if (this.disposed) return;
    this.recovering = false;
    this.mirror.resetPeaks();
    this.replayer.restore();
  }

  /** `onRecoveryFailed`: the host is Failed and silent for the session: every voice ends with reason "failed". */
  private recoveryFailed(): void {
    if (this.disposed) return;
    this.recovering = false;
    this.lockedQueue.clear();
    const t = this.table;
    for (let i = 0; i < t.capacity; i++) {
      if (t.state[i] !== VoiceState.FREE) t.free(((t.gen[i]! << 16) | i) >>> 0, VoiceReason.FAILED);
    }
    this.writer.clear();
  }

  /** `Bus.peak` (A2.3): the newest STATUS peaks (already decayed in the core) by bus name; 0 while locked and past the 32 the core reports. */
  private publishPeaks(): void {
    const m = this.mirror;
    const running = this.host.status === "running";
    const names = this.names;
    for (let b = 0; b < names.length; b++) {
      const peak = running && b < m.peakCount ? Math.max(m.peakL[b]!, m.peakR[b]!) : 0;
      this.mixer._setPeak(names[b]!, peak);
    }
  }

  /**
   * The mixed cap selection uses (architecture §6.3): `min(voices.mixed, mixedCap)`, where `mixedCap` is STATUS's: the
   * core's adaptive cap (A3.3), through the mirror. Before the first STATUS it is `voices.mixed`. `Audio.debug()`
   * reports this value as `counters.mixedCap`.
   */
  mixedCap(): number {
    const configured = this.host.preset.maxMixed ?? this.table.capacity;
    return effectiveMixedCap(configured, this.mirror.mixedCap);
  }

  /**
   * Architecture §3.9: World `key`'s voices are audible, or forced virtual (in time, silent) while it doesn't have the
   * view. Takes effect at the next frame's selection. Key 0 (no World) is always audible.
   */
  setWorldAudible(key: number, audible: boolean): void {
    this.selection.setWorldAudible(key, audible);
  }

  /** True once the core reported hrtfReady for the HRIR table (spatial voices stay equal-power until then). */
  get hrtfReady(): boolean {
    return this.hrir.ready;
  }

  /** H3, STATUS `hrtfLoadFailure` with main's part: 2 when the core found the table invalid, 1 when the fetch failed, else 0. */
  get hrtfLoadFailure(): number {
    return this.mirror.hrtfLoadFailure || (this.hrir.failed ? 1 : 0);
  }

  /** H3: the panner kind the core holds for slot `i` (0 equal-power, 1 HRTF), which a rebuild's replayed PLAY carries. */
  hrtfPanner(i: number): number {
    return this.hrtf.panner(i);
  }

  /** `Audio.debug()` (K10): delegates to `debug.ts`. */
  debug(): AudioDebugInfo {
    return buildDebugInfo(this);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lockedQueue.clear();
    for (const c of this.cleanups.splice(0)) c();
    this.table.onFree = null;
    this.host.link.statusDecoder = readStatus;
    this.writer.clear();
  }

  // --- Voice operations (`Voice` calls these) ---

  /** @internal */
  _setVolume(id: number, v: number): void {
    const i = this.slot(id);
    if (i < 0 || !Number.isFinite(v)) return;
    this.table.volume[i] = Math.max(0, v);
    this.refreshGain(i);
    this.sendGain(id, i);
  }

  /** @internal */
  _setPitch(id: number, rate: number): void {
    const i = this.slot(id);
    if (i < 0 || !Number.isFinite(rate)) return;
    this.table.pitch[i] = clamp(rate, MIN_PITCH, MAX_PITCH);
    if (this.onCore(i)) this.playheads.retime(i, this.clockMap.framesNow());
    if (this.onCore(i)) this.writer.setParams(id, SET_PARAMS_MASK_PITCH, 0, this.table.pitch[i]!, 0, 0, 0, 0, this.clockMap.rampFrames());
  }

  /** @internal */
  _setPriority(id: number, priority: number): void {
    const i = this.slot(id);
    if (i < 0 || !Number.isFinite(priority)) return;
    this.table.priority[i] = clamp(Math.round(priority), 0, 255);
    this.refreshGain(i);
  }

  /** @internal */
  _setAttenuation(id: number, a: Attenuation): void {
    const i = this.slot(id);
    if (i < 0) return;
    this.applyAttenuation(i, a);
    this.spatialDirty[i] = 1;
  }

  /** @internal */
  _setPosition(id: number, p: Vec3Like): void {
    const i = this.slot(id);
    if (i < 0) return;
    this.applyPosition(i, p);
    this.spatialDirty[i] = 1;
  }

  /** @internal */
  _setBus(id: number, bus: string): void {
    const i = this.slot(id);
    if (i < 0) return;
    const t = this.table;
    const old = t.bus[i]!;
    const next = this.busIndex(bus);
    if (old === next) return;
    t.bus[i] = next;
    if (t.busLive[old]! > 0) t.busLive[old]!--;
    t.busLive[next]!++;
    this.mixer.voiceEnded(this.names[old] ?? "");
    this.mixer.voiceStarted(this.names[next] ?? "");
    if (this.onCore(i)) this.writer.setParams(id, SET_PARAMS_MASK_BUS, 0, 0, 0, 0, 0, 0, 0, next);
  }

  /** @internal */
  _setPaused(id: number, paused: boolean): void {
    const i = this.slot(id);
    if (i < 0) return;
    const t = this.table;
    t.flags[i] = paused ? t.flags[i]! | VoiceFlag.PAUSED : t.flags[i]! & ~VoiceFlag.PAUSED;
    if (this.onCore(i)) this.playheads.retime(i, this.clockMap.framesNow());
    if (this.onCore(i)) this.writer.setPaused(id, paused);
  }

  // --- Internals ---

  private slot(id: number): number {
    return this.table.isLive(id) ? id & 0xffff : -1;
  }

  private onCore(i: number): boolean {
    const s = this.table.state[i]!;
    return s === VoiceState.PLAYING || s === VoiceState.VIRTUAL;
  }

  private busIndex(name: string): number {
    return this.busIndexByName.get(name) ?? 0;
  }

  private applyAttenuation(i: number, a: Attenuation): void {
    this.table.minDist[i] = a.minDistance;
    this.table.maxDist[i] = a.maxDistance;
    this.table.rolloff[i] = a.rolloff === "linear" ? VoiceRolloff.LINEAR : a.rolloff === "exponential" ? VoiceRolloff.EXPONENTIAL : VoiceRolloff.INVERSE;
  }

  private applyPosition(i: number, p: Vec3Like): void {
    const t = this.table;
    t.posX[i] = p.x;
    t.posY[i] = p.y;
    t.posZ[i] = p.z;
    if ((t.flags[i]! & VoiceFlag.SPATIAL) === 0) {
      t.flags[i]! |= VoiceFlag.SPATIAL;
      this.spatialCount++;
    }
  }

  /** `gain` = volume times the distance gain (spatial), and the direction for a spatial voice; audibility from both and priority. */
  private refreshGain(i: number): void {
    const t = this.table;
    let gain = t.volume[i]!;
    if ((t.flags[i]! & VoiceFlag.SPATIAL) !== 0) {
      const basis = this.basis;
      basis.locate(t.posX[i]!, t.posY[i]!, t.posZ[i]!);
      const d = this.distance;
      d.model = ROLLOFF_NAMES[t.rolloff[i]!] ?? "inverse";
      d.refDistance = t.minDist[i]!;
      d.maxDistance = t.maxDist[i]!;
      gain *= Math.max(0, d.gain(basis.distance));
      t.dirX[i] = basis.dirX;
      t.dirY[i] = basis.dirY;
      t.dirZ[i] = basis.dirZ;
    }
    t.gain[i] = gain;
    this.selection.audibilityOf(i);
  }

  private sendGain(id: number, i: number): void {
    // Only a mixed voice is heard; a virtual one gets its gain with SET_MIXED when it is promoted (A3.1).
    if (this.table.state[i] === VoiceState.PLAYING) this.writer.setParams(id, SET_PARAMS_MASK_GAIN | SET_PARAMS_MASK_DIR, this.table.gain[i]!, 0, this.table.dirX[i]!, this.table.dirY[i]!, this.table.dirZ[i]!, 0, this.clockMap.rampFrames());
  }

  /** The voice's clip decides what happens next: play now, wait for the data, or fail. */
  private launch(id: number): void {
    const t = this.table;
    const i = id & 0xffff;
    const clip = t.clip[i]!;
    const state = this.clips.state(clip);
    if (state === "ready") {
      // A3.1: mixed when there is room under the cap; otherwise virtual, and this frame's selection may promote it.
      const mixed = this.selection.admit(i, this.mixedCap());
      t.state[i] = mixed ? VoiceState.PLAYING : VoiceState.VIRTUAL;
      t.reason[i] = mixed ? VoiceReason.NONE : VoiceReason.VIRTUAL;
      this.sendPlay(id, i);
    } else if (state === "failed") {
      t.free(id, VoiceReason.FAILED);
    } else {
      t.state[i] = VoiceState.WAITING_FOR_DATA;
      t.reason[i] = VoiceReason.WAITING_FOR_DATA;
      this.clips.onResident(clip, (info: ClipInfo) => {
        if (!t.isLive(id) || t.state[i] !== VoiceState.WAITING_FOR_DATA) return;
        if (info.state === "ready") this.launch(id);
        else t.free(id, VoiceReason.FAILED);
      });
    }
  }

  private sendPlay(id: number, i: number): void {
    const t = this.table;
    const a = this.playArgs;
    a.voiceId = id;
    a.clip = t.clip[i]!;
    a.bus = t.bus[i]!;
    const f = t.flags[i]!;
    a.flags = (t.state[i] === VoiceState.PLAYING ? PLAY_FLAGS_MIXED : 0) | (f & VoiceFlag.LOOP ? PLAY_FLAGS_LOOP : 0) | (f & VoiceFlag.SPATIAL ? PLAY_FLAGS_SPATIAL : 0);
    a.gain = t.gain[i]!;
    a.pitch = t.pitch[i]!;
    a.dirX = t.dirX[i]!;
    a.dirY = t.dirY[i]!;
    a.dirZ = t.dirZ[i]!;
    a.lpHz = BUS_LP_OFF_HZ;
    a.score = t.audibility[i]!;
    this.selection.noteScoreSent(i, a.score);
    const start = t.startFrame[i]!;
    // A3.2: stamped at its frame while that is ahead of F_now; past (or asap) goes asap (§1 `at`, `lookahead.ts`).
    const stamp = this.clockMap.stampFor(start);
    this.writer.play(a, stamp);
    this.playheads.start(i, stamp ?? this.clockMap.framesNow(), a.startOffsetFrames);
    // A3.7: paused before it reached the core (locked, or its clip loading): it waits there, paused, until resumed.
    if (f & VoiceFlag.PAUSED) this.writer.setPaused(id, true);
    if (start > 0) t.startFrame[i] = 0;
    this.spatialDirty[i] = 0;
  }

  /** The context started running: voices that waited for it start now. */
  private unlock(): void {
    this.lockedQueue.drain(performance.now(), (id) => {
      const i = id & 0xffff;
      if (this.table.isLive(id) && this.table.state[i] === VoiceState.LOCKED) {
        this.table.startFrame[i] = 0;
        this.refreshGain(i);
        this.launch(id);
      }
    });
  }

  /** Spatial voices whose source or the listener moved: new gain and direction when they changed beyond epsilon. */
  private moveSpatial(): void {
    const t = this.table;
    const all = this.listenerDirty;
    this.listenerDirty = false;
    const ramp = this.clockMap.rampFrames();
    for (let i = 0; i < t.capacity; i++) {
      if ((t.flags[i]! & VoiceFlag.SPATIAL) === 0 || t.state[i] === VoiceState.FREE) continue;
      if (!all && this.spatialDirty[i] === 0) continue;
      if (!this.onCore(i)) continue;
      this.spatialDirty[i] = 0;
      if (t.state[i] === VoiceState.VIRTUAL) {
        // Virtual (A3.1): fresh gain and direction for its audibility; nothing is sent until it is promoted.
        this.refreshGain(i);
        continue;
      }
      const g = t.gain[i]!;
      const x = t.dirX[i]!;
      const y = t.dirY[i]!;
      const z = t.dirZ[i]!;
      this.refreshGain(i);
      if (Math.abs(t.gain[i]! - g) > GAIN_EPSILON || Math.abs(t.dirX[i]! - x) > DIR_EPSILON || Math.abs(t.dirY[i]! - y) > DIR_EPSILON || Math.abs(t.dirZ[i]! - z) > DIR_EPSILON) {
        const id = ((t.gen[i]! << 16) | i) >>> 0;
        this.writer.setParams(id, SET_PARAMS_MASK_GAIN | SET_PARAMS_MASK_DIR, t.gain[i]!, 0, t.dirX[i]!, t.dirY[i]!, t.dirZ[i]!, 0, ramp);
      } else {
        t.gain[i] = g;
        t.dirX[i] = x;
        t.dirY[i] = y;
        t.dirZ[i] = z;
      }
    }
  }

  /** A3.1: the frame's selection over every logical voice, at the current mixed cap. */
  private select(): void {
    if (this.table.liveCount === 0) return;
    this.selection.run(this.mixedCap(), this.selectionSink);
  }

  /** SET_MIXED for slot `i` (selection's change); a promote carries the voice's current gain, direction and `lpHz`. */
  private sendMixed(i: number, mixed: boolean): void {
    const t = this.table;
    const id = ((t.gen[i]! << 16) | i) >>> 0;
    if (mixed) this.spatialDirty[i] = 0;
    this.writer.setMixed(id, mixed, t.gain[i]!, t.dirX[i]!, t.dirY[i]!, t.dirZ[i]!, t.lpHz[i]!);
  }

  /**
   * H3: the HRTF assignment after selection: the top `voices.hrtf` mixed spatial voices by audibility (`hrtfPick.ts`),
   * while `audio.spatial` is `"hrtf"` and the table hasn't failed to load. The first voice flagged starts the HRIR
   * fetch (lazy, architecture §2.4); until the core has it, flagged voices pan equal-power, then crossfade.
   */
  private pickHrtf(): void {
    const settings = this.mixer.audioSettings;
    const limit = settings.spatial === "hrtf" && this.hrtfLoadFailure === 0 ? settings.voices.hrtf : 0;
    if (limit <= 0 || this.spatialCount === 0) {
      if (this.hrtf.count > 0) this.hrtf.clear(this.hrtfSink);
      return;
    }
    if (this.hrtf.run(limit, this.hrtfSink) > 0) this.hrir.ensure();
  }

  /** H3: SET_PARAMS `flags` for slot `i`'s panner kind. */
  private sendPanner(i: number, hrtf: boolean): void {
    const t = this.table;
    this.writer.setPanner(((t.gen[i]! << 16) | i) >>> 0, hrtf ? 1 : 0);
  }

  /** A3.3: selection re-sends slot `i`'s score (its audibility moved), the core's key for its own lowest-score demote. */
  private sendScore(i: number, score: number): void {
    const t = this.table;
    this.writer.setScore(((t.gen[i]! << 16) | i) >>> 0, score);
  }

  /** Selection stole slot `i` (its bus is past `maxVoices`): free it as STOLEN; `onFree` stops it on the core. */
  private stealSlot(i: number): void {
    const t = this.table;
    t.stolenCount++;
    t.free(((t.gen[i]! << 16) | i) >>> 0, VoiceReason.STOLEN);
  }

  /** `onIdle`: RESET 0 once no voice is live and no clip is resident (the registry unloads one frame after the World left). */
  private checkIdle(): void {
    if (this.host.worldCount > 0) {
      this.idlePending = false;
      return;
    }
    if (this.table.liveCount > 0 || this.clips.residentIds().length > 0) return;
    this.idlePending = false;
    this.writer.reset(false);
  }

  private onFree(id: number, bus: number): void {
    const i = id & 0xffff;
    const t = this.table;
    // Freed while still on the core (a steal: allocation's, or selection's past a bus's `maxVoices`): stop it there,
    // or it would sound on until a PLAY reuses the slot (the new voice may be waiting for its clip). The state is
    // still the old one here; natural ends (ENDING) are already gone from the core.
    const s = t.state[i]!;
    if (s === VoiceState.PLAYING || s === VoiceState.VIRTUAL || s === VoiceState.STOPPING) this.writer.stop(id, STEAL_FADE_SECONDS);
    this.clips.release(t.clip[i]!);
    this.hrtf.forget(i);
    this.mixer.voiceEnded(this.names[bus] ?? "");
    if ((t.flags[i]! & VoiceFlag.SPATIAL) !== 0) this.spatialCount--;
    t.flags[i] = 0;
    this.spatialDirty[i] = 0;
  }
}

/** One voice; every call checks the id is still live. */
class Voice implements CoreVoice {
  readonly handle: AudioHandle;

  constructor(
    private readonly backend: CoreBackend,
    readonly id: number,
  ) {
    this.handle = new AudioHandle(backend.table, id);
  }

  get playing(): boolean {
    return this.handle.playing;
  }

  get reason(): AudioReason | null {
    return this.handle.reason;
  }

  setVolume(v: number): void {
    this.backend._setVolume(this.id, v);
  }

  setPitch(rate: number): void {
    this.backend._setPitch(this.id, rate);
  }

  setAttenuation(a: Attenuation): void {
    this.backend._setAttenuation(this.id, a);
  }

  setPosition(p: Vec3Like): void {
    this.backend._setPosition(this.id, p);
  }

  setBus(bus: string): void {
    this.backend._setBus(this.id, bus);
  }

  setPriority(priority: number): void {
    this.backend._setPriority(this.id, priority);
  }

  pause(): void {
    this.backend._setPaused(this.id, true);
  }

  resume(): void {
    this.backend._setPaused(this.id, false);
  }

  fade(to: number, seconds: number): void {
    this.handle.fade(to, seconds);
  }

  stop(fadeSeconds = 0): void {
    this.handle.stop(fadeSeconds);
  }
}

/**
 * The factory `service.ts` registers with `registerCoreBackend`: wires the registry to the host (its messages go
 * through `CoreLink.post` with the link's `seq`, clips are fetched from the project's asset URLs and decoded on the
 * decoder worker) and the clock to the context.
 */
export function createCoreBackend(host: AudioHost, deps: CoreBackendDeps = {}): CoreBackend {
  const settings = (deps.mixer ?? defaultMixer).audioSettings;
  const link = host.link;
  const clips =
    deps.clips ??
    createClipRegistry({
      // `seq` is per sender on one port: the registry shares the link's counter.
      send: (message) => link.post(message),
      nextSeq: () => link.nextSeq(),
      fetchBytes: async (path) => {
        const response = await fetch(Assets.url(path));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      },
      clipFormat: settings.clipFormat === "f32" ? 0 : 1,
      ceilingBytes: (settings.clipMemoryMB ?? DEFAULT_CLIP_CEILING_MB) * (1 << 20),
    });
  const backendHost: CoreBackendHost = {
    link,
    get status() {
      return host.status;
    },
    get preset() {
      return host.preset;
    },
    get worldCount() {
      return host.worldCount;
    },
    // The current context's (a rebuild into a new context changes it, A3.4c).
    get sampleRate() {
      return host.context.sampleRate;
    },
    addLifecycleListener: (listener) => host.addLifecycleListener(listener),
    health: host.health,
  };
  const backend = new CoreBackend(backendHost, { ...deps, clips, clock: deps.clock ?? browserHostClock(() => host.context) });
  attachBackground(backend, host);
  return backend;
}

/** A3.4b: the visibility, device-event and stall controller (`background.ts`) for a backend on the page's host. */
function attachBackground(backend: CoreBackend, host: AudioHost): void {
  const controller = new BackgroundController({ host, target: backend });
  backend.health = controller.counters;
  backend.addCleanup(() => controller.dispose());
  controller.start();
}
