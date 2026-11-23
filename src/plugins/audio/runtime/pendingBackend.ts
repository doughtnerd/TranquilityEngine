// The pending backend (architecture §2.1, §3.1): the stand-in `audioBackend()` returns while `audio.backend` is "core" and the
// core is still loading. A third adapter of the `AudioBackend` seam (ADR 0098, 0179): the required members only, no
// capabilities. Split out of `backend.ts` by ADR 0179 so that file reads as the seam.
import type { Vec3Like } from "../../../engine/core/math";
import type { Attenuation, AudioBackend, AudioBackground, AudioDebugInfo, AudioReason, AudioStatus, AudioVoice, ListenerPose, PlayRequest, ShapedFade, ShapedParams, VoiceSpatialOptions } from "./backend";
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
  /** ADR 0264: the latest stamped ramps asked for while waiting (a ramp replaces the one before it, as on a voice). */
  private shapedFade: ShapedFade | null = null;
  private shapedParams: ShapedParams | null = null;
  /** ADR 0264: where the sound is to start, from a `seek` while waiting (an event's `startOffset`, `AudioSource.seek`). */
  private seekTo: number | null = null;
  /** ADR 0158 §4: the loop region the playlist runtime asked for while waiting (the latest call wins). */
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
    if (this.seekTo !== null) voice.seek(this.seekTo);
    if (this.fadeTo !== null) voice.fade(this.fadeTo, 0);
    if (this.shapedFade) voice.fadeShaped(this.shapedFade);
    if (this.shapedParams) voice.paramsShaped(this.shapedParams);
    if (this.paused) voice.pause();
    // The request's `group` went with `play`. The loop region is a state set, so the playlist runtime's re-send that
    // follows repeats it harmlessly.
    if (this.loop) voice.setLoop(this.loop.start, this.loop.end, this.loop.looping);
    // ADR 0162 (K4): the M3 values given while waiting.
    if (this.spatialOptions) voice.setSpatialOptions(this.spatialOptions);
    if (this.velocity) voice.setVelocity(this.velocity);
    if (this.occlusionValue) voice.setOcclusion(this.occlusionValue.gain, this.occlusionValue.lpHz);
    if (this.dopplerRate !== null) voice.setDopplerRate(this.dopplerRate);
    this.seekTo = null;
    this.shapedFade = null;
    this.shapedParams = null;
    this.loop = null;
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
    else {
      this.fadeTo = to;
      this.shapedFade = null; // the later ramp of the `fade` gain wins
    }
  }
  /** ADR 0264: recorded while waiting and forwarded at the hand-over, where the real voice stamps it (late: at once). */
  fadeShaped(f: ShapedFade): void {
    if (this.inner) this.inner.fadeShaped(f);
    else {
      this.shapedFade = { ...f };
      this.fadeTo = null;
    }
  }
  /** ADR 0264: recorded while waiting (the latest wins) and forwarded at the hand-over. */
  paramsShaped(r: ShapedParams): void {
    if (this.inner) this.inner.paramsShaped(r);
    else this.shapedParams = { ...r };
  }
  /** ADR 0264: recorded while waiting (the latest wins), so the real voice starts where it was asked to. */
  seek(seconds: number): void {
    if (this.inner) this.inner.seek(seconds);
    else this.seekTo = seconds;
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
  /** Recorded while waiting (the latest call wins), forwarded at the hand-over. */
  setLoop(start: number, end: number, looping: boolean): void {
    if (this.inner) this.inner.setLoop(start, end, looping);
    else this.loop = { start, end, looping };
  }
  setVelocity(v: Vec3Like): void {
    if (this.inner) this.inner.setVelocity(v);
    else this.velocity = { x: v.x, y: v.y, z: v.z };
  }
  setOcclusion(gain: number, lpHz: number): void {
    if (this.inner) this.inner.setOcclusion(gain, lpHz);
    else this.occlusionValue = { gain, lpHz };
  }
  setDopplerRate(factor: number): void {
    if (this.inner) this.inner.setDopplerRate(factor);
    else this.dopplerRate = factor;
  }
  /** Merged while waiting (omitted fields keep earlier values), as on a playing voice. */
  setSpatialOptions(o: VoiceSpatialOptions): void {
    if (this.inner) this.inner.setSpatialOptions(o);
    else this.spatialOptions = { ...this.spatialOptions, ...o };
  }
  pause(at?: number): void {
    if (this.inner) this.inner.pause(at);
    else this.paused = true;
  }
  resume(at?: number): void {
    if (this.inner) this.inner.resume(at);
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
