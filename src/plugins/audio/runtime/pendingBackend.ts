// The pending backend (architecture §2.1, §3.1): the stand-in `audioBackend()` returns while `audio.backend` is "core" and the
// core is still loading. A third adapter of the `AudioBackend` seam (ADR 0098, 0179): the required members only, no
// capabilities. Split out of `backend.ts` by ADR 0179 so that file reads as the seam.
import type { Vec3Like } from "../../../engine/core/math";
import type { Attenuation, AudioBackend, AudioBackground, AudioDebugInfo, AudioReason, AudioStatus, AudioVoice, ListenerPose, PlayRequest, VoiceSpatialOptions } from "./backend";
import { zeroCounters } from "./debugTypes";

/** D5, as the core's locked queue: at most this many one-shots wait, and none older than `ONE_SHOT_WINDOW_MS`. */
const MAX_PENDING_ONE_SHOTS = 32;
const ONE_SHOT_WINDOW_MS = 1000;
/** Ids for voices that haven't reached a real backend yet (above the core's 16-bit slot ids' generations in use). */
let nextPendingId = 0x7fff_0000;

/**
 * A voice played while the core was loading (architecture §2.1, §3.1): `reason` "locked", `playing` true. It keeps
 * the request and every setter's latest value, then starts on the real backend at the hand-over and forwards to it.
 * Holders (an `AudioSource`, a music player, an `AudioHandle`) keep the same object throughout.
 */
class PendingVoice implements AudioVoice {
  private inner: AudioVoice | null = null;
  private stopped = false;
  private dropped = false;
  private failed = false;
  private paused = false;
  private fadeTo: number | null = null;
  /** ADR 0158 §4: the loop region the event runtime asked for while waiting (the latest call wins). */
  private loop: { start: number; end: number; looping: boolean } | null = null;
  /** ADR 0162 (K4): main's latest M3 values while waiting, applied at the hand-over where the real voice takes them. */
  private velocity: Vec3Like | null = null;
  private occlusionValue: { gain: number; lpHz: number } | null = null;
  private dopplerRate: number | null = null;
  private spatialOptions: VoiceSpatialOptions | null = null;
  private readonly localId = nextPendingId++;
  readonly queuedAt = performance.now();

  constructor(private readonly req: PlayRequest) {}

  get live(): boolean {
    return !this.stopped && !this.dropped && this.inner === null;
  }
  get oneShot(): boolean {
    return !!this.req.oneShot && !this.req.loop;
  }
  get id(): number {
    return this.inner?.id ?? this.localId;
  }
  get playing(): boolean {
    if (this.inner) return this.inner.playing;
    return this.live;
  }
  get alive(): boolean {
    if (this.inner) return this.inner.alive ?? this.inner.playing;
    return this.live;
  }
  get reason(): AudioReason | null {
    if (this.inner) return this.inner.reason;
    if (this.failed) return "failed";
    return this.stopped || this.dropped ? null : "locked";
  }

  /** Starts on `target` with the latest values; null from `target` ends it "failed". */
  attach(target: AudioBackend): void {
    const voice = target.play({ ...this.req });
    if (!voice) {
      this.stopped = true;
      this.failed = true;
      return;
    }
    this.inner = voice;
    if (this.fadeTo !== null) voice.fade(this.fadeTo, 0);
    if (this.paused) voice.pause();
    // The request's `group` went with `play`. A loop region is applied here only where the voice takes it itself (the
    // Babylon fallback; a state set, so the event runtime's re-send that follows repeats it harmlessly); a core voice
    // gets it from that re-send through the core's automation, by id.
    if (this.loop && voice.setLoop) voice.setLoop(this.loop.start, this.loop.end, this.loop.looping);
    this.loop = null;
    // ADR 0162 (K4): the M3 values given while waiting, where the voice takes them.
    if (this.spatialOptions && voice.setSpatialOptions) voice.setSpatialOptions(this.spatialOptions);
    if (this.velocity && voice.setVelocity) voice.setVelocity(this.velocity);
    if (this.occlusionValue && voice.setOcclusion) voice.setOcclusion(this.occlusionValue.gain, this.occlusionValue.lpHz);
    if (this.dopplerRate !== null && voice.setDopplerRate) voice.setDopplerRate(this.dopplerRate);
    this.spatialOptions = null;
    this.velocity = null;
    this.occlusionValue = null;
    this.dopplerRate = null;
  }
  /** Left out at the hand-over (D5: an old or surplus one-shot). */
  drop(): void {
    this.dropped = true;
  }

  fade(to: number, seconds: number): void {
    if (this.inner) this.inner.fade(to, seconds);
    else this.fadeTo = to;
  }
  setPriority(priority: number): void {
    if (this.inner) this.inner.setPriority(priority);
    else this.req.priority = priority;
  }
  setVolume(v: number): void {
    if (this.inner) this.inner.setVolume(v);
    else this.req.volume = v;
  }
  setPitch(rate: number): void {
    if (this.inner) this.inner.setPitch(rate);
    else this.req.pitch = rate;
  }
  setAttenuation(a: Attenuation): void {
    if (this.inner) this.inner.setAttenuation(a);
    else this.req.attenuation = { minDistance: a.minDistance, maxDistance: a.maxDistance, rolloff: a.rolloff };
  }
  setPosition(p: Vec3Like): void {
    if (this.inner) this.inner.setPosition(p);
    else this.req.position = { x: p.x, y: p.y, z: p.z };
  }
  setBus(bus: string): void {
    if (this.inner) this.inner.setBus(bus);
    else this.req.bus = bus;
  }
  /** Recorded while waiting (so the event runtime's `TsAutomation` doesn't warn that part of a clip can't loop), forwarded after. */
  setLoop(start: number, end: number, looping: boolean): void {
    if (this.inner) this.inner.setLoop?.(start, end, looping);
    else this.loop = { start, end, looping };
  }
  setVelocity(v: Vec3Like): void {
    if (this.inner) this.inner.setVelocity?.(v);
    else this.velocity = { x: v.x, y: v.y, z: v.z };
  }
  setOcclusion(gain: number, lpHz: number): void {
    if (this.inner) this.inner.setOcclusion?.(gain, lpHz);
    else this.occlusionValue = { gain, lpHz };
  }
  setDopplerRate(factor: number): void {
    if (this.inner) this.inner.setDopplerRate?.(factor);
    else this.dopplerRate = factor;
  }
  /** Merged while waiting (omitted fields keep earlier values), as on a playing voice. */
  setSpatialOptions(o: VoiceSpatialOptions): void {
    if (this.inner) this.inner.setSpatialOptions?.(o);
    else this.spatialOptions = { ...this.spatialOptions, ...o };
  }
  pause(): void {
    if (this.inner) this.inner.pause();
    else this.paused = true;
  }
  resume(): void {
    if (this.inner) this.inner.resume();
    else this.paused = false;
  }
  stop(fadeSeconds?: number): void {
    if (this.inner) this.inner.stop(fadeSeconds);
    else this.stopped = true;
  }
}

/**
 * The backend while `audio.backend` is "core" and the core is still loading: no library, no context of its own,
 * `status` "locked". Plays become `PendingVoice`s; `handOver` starts the live ones on the backend the load settled
 * on (the core, or "babylon" after a real failure) and passes on the master volume, mute, listener and background.
 */
export class PendingCoreBackend implements AudioBackend {
  readonly name = "pending";
  readonly status: AudioStatus = "locked";
  readonly time = 0;
  masterVolume = 1;
  muted = false;
  private readonly voices: PendingVoice[] = [];
  private listener: ListenerPose | null = null;
  private background: AudioBackground | null = null;

  play(req: PlayRequest): AudioVoice | null {
    const voice = new PendingVoice({ ...req });
    this.voices.push(voice);
    return voice;
  }
  setListener(pose: ListenerPose): void {
    const copy = (p: Vec3Like): Vec3Like => ({ x: p.x, y: p.y, z: p.z });
    this.listener = { position: copy(pose.position), forward: copy(pose.forward), up: copy(pose.up) };
  }
  applyMix(): void {}
  configureBuses(): void {}
  setBackground(mode: AudioBackground): void {
    this.background = mode;
  }
  update(): void {
    // Forget voices stopped before the hand-over, so a long load doesn't grow the list.
    if (this.voices.length > 0 && !this.voices[0]!.live) {
      let w = 0;
      for (const v of this.voices) if (v.live) this.voices[w++] = v;
      this.voices.length = w;
    }
  }
  debug(): AudioDebugInfo {
    const live = this.voices.filter((v) => v.live);
    return {
      status: "locked", sampleRate: 0, time: 0, background: this.background ?? "mute",
      counters: { ...zeroCounters(), logicalVoices: live.length, queuedPlays: live.length },
      buses: [], voices: [], core: { backend: "pending", state: "loading" },
    };
  }
  handOver(target: AudioBackend): void {
    target.masterVolume = this.masterVolume;
    target.muted = this.muted;
    if (this.background !== null) target.setBackground(this.background);
    if (this.listener) target.setListener(this.listener);
    const now = performance.now();
    const live = this.voices.filter((v) => v.live);
    this.voices.length = 0;
    const fresh = (v: PendingVoice) => !v.oneShot || now - v.queuedAt <= ONE_SHOT_WINDOW_MS;
    // Oldest first: the surplus over the cap is the oldest one-shots.
    let surplus = live.filter((v) => v.oneShot && fresh(v)).length - MAX_PENDING_ONE_SHOTS;
    for (const v of live) {
      if (!fresh(v) || (v.oneShot && surplus-- > 0)) v.drop();
      else v.attach(target);
    }
  }
  dispose(): void {
    for (const v of this.voices) v.stop();
    this.voices.length = 0;
  }
}
