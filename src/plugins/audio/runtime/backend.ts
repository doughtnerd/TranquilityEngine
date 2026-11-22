/**
 * The internal audio backend interface (ADR 0098) and the `audio.backend` selector (K3). `AudioSource` and
 * `Audio` talk to this, never to a library. Not part of the public API.
 *
 * Lives in the audio plugin (ADR 0157 §6); the engine imports the mixer from `engine/audio/mixer`.
 */
import type { Vec3Like } from "../../../engine/core/math";
import type { Effect } from "../../../engine/audio/effects/types";
import { mixer, type Mixer, type MixOpTarget, type ResolvedBus } from "../../../engine/audio/mixer";
import type { MixOp, OpClass } from "../../../engine/audio/mixOps";
import type { AudioSettings } from "../../../engine/audio/settings";
import { onAudioConfigured } from "../../../engine/core/audioConfigure";
import type { AutomationSink, ParamRef } from "./automation";
import type { Curve } from "../../../engine/core/curve";
import type { AudioLatency, MusicEventHandle } from "../../../engine/audio/musicTypes";
import type { AudioMarkerEvent, AudioMarkerType } from "../../../engine/audio/markerTypes";
import type { ProfileSink } from "./mix/profileSink";
import type { KeyframePayload } from "./capture/format";
import type { AudioDebugInfo, AudioMixCaps, MusicBackendDebug } from "./debugTypes";
import { PendingCoreBackend } from "./pendingBackend";
import { onAudioSessionReleased } from "./audioSession";

// The debug shape moved to `debugTypes.ts` (ADR 0179); every name stays importable from here.
export type { AudioBedDebug, AudioCpuDebug, AudioDebugInfo, AudioM3Counters, AudioMemoryDebug, AudioMixCaps, AudioMixDebug, AudioMixSlotDebug, AudioOcclusionDebug, AudioRecorderDebug, AudioVoiceM3Debug, AudioZoneDebug, MusicBackendDebug, MusicDebugPending, MusicDebugRow, MusicDebugState, MusicDebugTotals } from "./debugTypes";
export { zeroCounters } from "./debugTypes";

export type Rolloff = "linear" | "inverse" | "exponential";

/** Why a sound isn't audible right now; null while it is (api-and-models §1). */
export type AudioReason = "virtual" | "stolen" | "busMuted" | "locked" | "failed" | "waitingForData";
/** `Audio.status` (§1). */
export type AudioStatus = "locked" | "running" | "failed";
/** `audio.background` (§2): what the host does when the page is hidden. */
export type AudioBackground = "mute" | "pause" | "play";

/** One sound started with `Audio.playOneShot` (§1). A value, safe to keep: once the voice ends or its slot is reused, every call is a no-op. */
export interface AudioHandle {
  /** True from the call to `playOneShot` until the sound ends or is stopped. Virtual, bus-muted, locked and waiting-for-data sounds are playing (they exist and keep time). Stolen and failed sounds are not. Natural ends are seen up to one frame late. */
  readonly playing: boolean;
  /** Why it isn't audible (while `playing`) or why it ended early ("stolen", "failed"); null when audible, or finished or stopped normally. */
  readonly reason: AudioReason | null;
  /** Stop now, or fade to silence over `fadeSeconds` (default 0) and stop. A second call is a no-op. */
  stop(fadeSeconds?: number): void;
  /** Ease this sound's own gain multiplier to `to` (linear, 0..4) over `seconds` (0 = at once). */
  fade(to: number, seconds: number): void;
  /** ADR 0162 §1.1: the panner the sound uses ("flat", "equalPower", "hrtf", "bed" or "ambisonic"), read from the main-thread mirror; null once it has ended. */
  readonly panner: AudioPanner | null;
  /** ADR 0162 §1.1: the smoothed dry occlusion gain (1 open, lower as walls muffle it), read from the main-thread mirror. */
  readonly occlusion: number;
}

/**
 * ADR 0162 (contract K0): which panner a voice is using. "flat" for a non-spatial voice, "equalPower" and "hrtf" as in
 * 0157, "bed" for a distant voice mixed into its bus's ambisonic bed, "ambisonic" for an ambisonic clip (api-and-models §1.1).
 */
export type AudioPanner = "flat" | "equalPower" | "hrtf" | "bed" | "ambisonic";

/**
 * ADR 0162 §1.1 (K0): a send's level against distance (0158 `Curve`): x is the distance as a fraction of
 * minDistance..maxDistance (clamped 0..1), y multiplies the send.
 */
export type SendCurve = Curve;
/** ADR 0162 §1.1 (K0): the default send curve, full send up close, half at `maxDistance`. D5 exports it publicly. */
export const DEFAULT_SEND_CURVE: SendCurve = [[0, 1], [1, 0.5]];

/**
 * The recorder's copy of a STATUS block (architecture §2.1, §4.2), called in `CoreLink.handleMessage` between the decode
 * and the RECYCLE: `data` is the pooled buffer, valid only during the call; `byteLength` the block's bytes. Must not
 * allocate (ground rules). Rc2 fills it from `capture/recorder.ts`.
 */
export type RecorderTap = (data: ArrayBuffer, byteLength: number, view?: DataView) => void;

// --- ADR 0166 interactive music (M4): the backend seam (§4.6, C10; contract Q0) ------------------------------------

/**
 * What a backend can do for music (§4.6, C10). The player branches on this record, never on the backend type. The core:
 * all true. The Babylon fallback: `stampedFades` for decoded clips only, no priming, `currentTime` clock, no rhythm.
 */
export interface MusicBackendCaps {
  /** Streamed stems can be primed and started together by a gate (the core's music pool and group table). */
  readonly primes: boolean;
  /** Fades and stops can be stamped at a frame with a law (in-voice records, M4-0). */
  readonly stampedFades: boolean;
  /** `timeAt` maps `performance.now()` to the heard clock (the core's `ClockMap`); false: `currentTime` only. */
  readonly heardClock: boolean;
  /** Rhythm mode (numeric `latencyHint`, latency read-back, stamped recovery) is available. */
  readonly rhythm: boolean;
}

/** A fade law (§3.1, the `shape` word's `law`, §4.2). Laws run at control rate. */
export type FadeLaw = "linear" | "sCurve" | "equalPowerIn" | "equalPowerOut";

/**
 * A shaped, optionally stamped fade of one voice's `fade` ramp (§4.2; R5: crossfades run on `fade`, not `gain`). With
 * `stopAtEnd` it is a stamped STOP with a shape. Ranges: `to` 0..4 linear, `seconds` >= 0, `startPhase` 0..1.
 */
export interface ShapedFade {
  to: number;
  seconds: number;
  law: FadeLaw;
  /** u0: the ramp starts at `law(u0)` and runs the remaining `1 - u0` over `seconds` (REPLAY of a fade under way). Default 0. */
  startPhase?: number;
  /** Heard time (seconds) it starts at; past, non-finite or omitted: as soon as possible. */
  at?: number;
  /** Stop the voice when the fade ends (a FADE with `stopAtEnd`, or a shaped STOP). */
  stopAtEnd?: boolean;
}

/** One stem of a group (§4.6 `primeGroup` members, C8). Streamed members take a music ring; decoded ones play from the arena. */
export interface MusicGroupMember {
  /** The stem's track name, for debug rows. */
  stem: string;
  /** How the member plays: path, url, bus, volume, `stream`, `priority`, `world`, `group` (the event instance). `at` is ignored: the group's stamp sets it. */
  play: PlayRequest;
  /** File frame the member starts at (entry - pre-entry, a loop or seek offset). */
  startFrame: number;
  /** Loop the region `loopStartFrame..loopEndFrame` (file frames; end exclusive, 0 = the file's end). */
  loop: boolean;
  loopStartFrame?: number;
  loopEndFrame?: number;
  /** PLAY's `fadeZero` (§4.1): start with the `fade` ramp at 0, for a stamped fade-in. */
  fadeZero?: boolean;
}

/** A group: the stems of one segment, started together by the core's gate (§4.1, architecture §4.3). */
export interface MusicGroupRequest {
  /** The music instance (event instance id); the worker's encoded cache is per instance (R16). */
  instance: number;
  /** 1..1023, from main's counter that skips live ids (§3.2). */
  group: number;
  /** At most 64 on the wire, 32 in the core's table. */
  members: MusicGroupMember[];
}

/** The answer to `admitGroup` (architecture §4.2). A permanent refusal never fits this preset; a temporary one retries. */
export type MusicAdmitResult =
  | { ok: true }
  | { ok: false; reason: "poolFull" | "neverFits" | "groupTableFull" | "noMusicRings"; permanent: boolean };

/** `primedState`: a group's members primed in their current epoch (STATUS `musicRings`, R7), decoded members counting as primed. */
export interface MusicPrimedState {
  group: number;
  primed: number;
  of: number;
  /** Every member primed (`primed === of`). */
  ready: boolean;
}

/** A group's stamp (§4.1): its members start at `at` (heard seconds), with their first in-voice records. */
export interface MusicGroupStamp {
  group: number;
  /** Heard time the members start at (the stamp's frame). */
  at: number;
  /** Shaped fades for members, by index in the request's `members`, applied in-voice at their own `at` (or the stamp). */
  fades?: { member: number; fade: ShapedFade }[];
}

/** Group and member events from the core (STATUS `groupStarts`, starved, ended and error reports; §4.4, C4). */
export type MusicGroupEvent =
  | { kind: "start" | "resume" | "abandon"; group: number; late: boolean; slipFrames: number; startFrame: number }
  | { kind: "starve" | "end"; group: number; member: number }
  | { kind: "error"; group: number; member: number; message: string }
  | { kind: "refused"; group: number; member: number; reason: "musicFull" };

/**
 * ADR 0248: what happened to the backend that music must react to, reported up the seam (`MusicBackend.onLifecycle`).
 * The backend reports; the music side alone decides what to re-plan (`music/background.ts`).
 * - `rebuild`: a hard rebuild began (`active` true) or ended or failed (false). Rhythm mode holds beat callbacks meanwhile.
 * - `recover`: every live group died with its core (a rebuild, a worker crash, a new rate): re-plan at the heard position.
 * - `hidden`: the page became hidden (true) or visible; reported only where music keeps ticking while hidden.
 * - `hiddenTick`: a STATUS block arrived while hidden (no frame step runs): tick the players now. The backend flushes
 *   their batch after the call returns.
 */
export type MusicLifecycleEvent =
  | { readonly kind: "rebuild"; readonly active: boolean }
  | { readonly kind: "recover"; readonly cause: "rebuild" | "crash" | "rate" }
  | { readonly kind: "hidden"; readonly hidden: boolean }
  | { readonly kind: "hiddenTick" };

/**
 * The backend's music operations (§4.6, C10). Absent on a backend without music: the player then plays nothing and
 * warns once. The core implements this in `core/musicOps.ts` (Q2 wires it, P1 fills it); the fallback in B1.
 */
export interface MusicBackend {
  readonly caps: MusicBackendCaps;
  /** Check the pool and the group table for this group; nothing is opened. */
  admitGroup(req: MusicGroupRequest): MusicAdmitResult;
  /**
   * Prime an admitted group: post `primeGroup` to the worker (breadth-first, §4.6). With `retarget`, open members restart
   * at their new start frames under new epochs. `protect` is the instance's protected paths (playing, primed, candidate
   * successors) for the worker's encoded cache (C8).
   */
  primeGroup(req: MusicGroupRequest, options?: { retarget?: boolean; protect?: readonly string[] }): void;
  /** The group's primed state from the last STATUS; null for an unknown group. */
  primedState(group: number): MusicPrimedState | null;
  /** Stamp a primed group: PLAY every member gated, at the stamp's frame, in one BATCH. One voice per member, null where it couldn't start. */
  stampGroup(stamp: MusicGroupStamp): (AudioVoice | null)[];
  /** Cancel a group: close its streams, stop any member already playing, free its id. Unknown ids are ignored. */
  cancelGroup(group: number): void;
  /** The instance ended: the worker drops its encoded bytes (R16). */
  releaseInstance(instance: number): void;
  /** Tell the worker which paths of an instance are protected from eviction (on each planner change of candidates, C8). */
  protect(instance: number, paths: readonly string[]): void;
  /** The music ring pool's size (`preset.maxMusicRings` on the core); 0 on a backend without priming. */
  readonly ringPool: number;
  /** Group and member events, delivered in `update()` after the status mirror is read. */
  onGroupEvent: ((e: MusicGroupEvent) => void) | null;
  /** ADR 0248: rebuilds, recoveries and the hidden tick, as they happen (a backend without them never calls it). */
  onLifecycle: ((e: MusicLifecycleEvent) => void) | null;
  /** Milliseconds: the page-wide prime estimator Ê (architecture §4.2), seeded at 40 on a new context. */
  readonly primeEmaMs: number;
  /** ADR 0249: the pool, the live groups and the backend's own group counters, for `Audio.debug()`. Allocates; debug only. */
  debugView(): MusicBackendDebug;
}

/**
 * ADR 0329: the sample markers a playlist handle reports as they pass (ADR 0328 marker types), and what `onMarker` and the
 * component hook `onAudioMarker` pass. Declared in the engine (`engine/audio/markerTypes.ts`) so `LifecycleHooks` can
 * name it; these are the same types.
 */
export type { AudioMarkerEvent, AudioMarkerType } from "../../../engine/audio/markerTypes";

/**
 * ADR 0329: a playing playlist (or sample), what `Audio.play` returns. ADR 0158 §5's members keep their meaning across all
 * of the instance's voices; ADR 0166 §1.2 adds `music`, `onMusic` and `trigger` (declared in `MusicEventHandle`); ADR 0329
 * adds `onMarker`.
 */
export interface AudioPlaylistHandle extends AudioHandle, MusicEventHandle {
  /** Set one of the playlist's own parameters (labelled ones by label). Unknown names warn once. */
  setParameter(name: string, value: number | string): void;
  /** One of the playlist's parameters, else a global one; undefined if neither. */
  getParameter(name: string): number | string | undefined;
  /** Where a spatial playlist plays; set it to move it. Null for a flat one. */
  position: Vec3Like | null;
  /**
   * Key-off: held loops end by their exit settings, a Blend's envelope releases, a continuous Queue stops picking; the
   * instance ends when its voices do (an `untilStopped` playlist too). A no-op without any of those.
   */
  release(): void;
  /**
   * Call `fn` each time a Cue, Exit or Hit marker of a playing sample, or a sequence's `cue` or `exit` marker, passes.
   * Returns an unsubscribe function. Markers are found on main from the planned playhead or voice position and reported on
   * the first frame whose heard clock has passed them (`e.time` is the exact heard time).
   */
  onMarker(type: AudioMarkerType, fn: (e: AudioMarkerEvent) => void): () => void;
}

/**
 * The handle's name before playlists (ADR 0158 §5).
 * @deprecated ADR 0329: use `AudioPlaylistHandle`; this alias stays for one release.
 */
export type AudioEventHandle = AudioPlaylistHandle;

export interface Attenuation {
  minDistance: number;
  maxDistance: number;
  rolloff: Rolloff;
}

export interface PlayRequest {
  /** The name of the node that plays it, for debug tools only (Audio Debug's Source column); absent for one-shots and events. */
  owner?: string;
  /** Asset path (no `asset:` prefix). */
  path: string;
  url: string;
  loop: boolean;
  /** Import setting: stream rather than decode up front. On the core a streamed clip is a full voice (spatial, buses, effects); the Babylon fallback plays it as HTML5 audio, flat and unpitched. */
  stream: boolean;
  /** Mixer bus name (already resolved to an existing bus). */
  bus: string;
  /** Linear gain, default 1. */
  volume?: number;
  /** Ratio, default 1. */
  pitch?: number;
  /** 0..255, default 128. */
  priority?: number;
  /** A fire-and-forget `playOneShot` sound (the locked queue may drop these, D5). */
  oneShot?: boolean;
  /** The playing World's key on the core (0 or omitted: none); only the core uses it (A3.4b, architecture §3.9). */
  world?: number;
  /** Start at this audio-clock time (seconds, `Audio.time`'s base). Past, non-finite or omitted: as soon as possible. */
  at?: number;
  attenuation?: Attenuation;
  position?: Vec3Like;
  /** ADR 0158: the event instance this voice belongs to (1..1024; 0 or omitted: none). The core carries it in PLAY's `group`. */
  group?: number;
  /**
   * Seconds into the source the voice starts at (ADR 0329 and 0334: audition from a point, seek). 0, negative,
   * non-finite or omitted: the start. A looping voice wraps it into the clip; past the end of a non-looping clip it ends
   * at once. Clip voices start there sample-exactly; a stream voice seeks its stream before its first chunk.
   */
  offset?: number;

  // ADR 0162 (contract K0). Every field is optional and means "as 0157/0158" when omitted, so a backend that predates
  // the feature ignores it. Ranges are api-and-models §1.2, §1.3 and §2.5; callers clamp before they get here.
  /** §1.2: spatial voices only; walls between source and listener muffle it. Omitted: true for a positioned voice. */
  occlusion?: boolean;
  /** §1.2/§1.3: 0..5, scales the Doppler shift; 0 off. Omitted: 0 (the caller applies the source or one-shot default). */
  dopplerLevel?: number;
  /** §1.2: 0..2, the voice's send to the zones that hold it, taken before the distance gain (R11). Omitted: 1. */
  reverbSend?: number;
  /** §1.2: the send against distance. Omitted: `DEFAULT_SEND_CURVE`. */
  reverbSendCurve?: SendCurve;
  /** §1.6, §2.4: the clip is ambisonic (its sidecar says so); spatial fields, occlusion and Doppler are ignored. */
  ambisonic?: boolean;
  /** §1.2 `ambisonicYaw` / §1.3 `yaw`: degrees, -180..180, positive to the right (clockwise seen from above, ADR 0164). */
  yaw?: number;
  /** §1.3, §2.5 `filter`: per-voice low-pass and high-pass, Hz (10..24000; lowpass ≥ 20000 and highpass ≤ 20 are off). */
  filter?: { lowpass?: number; highpass?: number };
  /** §2.5 `sends`: one aux send to a bus by name, 0..2, post the voice's bus-chain gain. */
  aux?: { bus: string; level: number };

  // ADR 0166 (contract Q0). Optional; a backend without music ignores it.
  /** §4.1 `fadeZero`: the voice starts with its `fade` ramp at 0, silent until a stamped fade opens it. */
  fadeZero?: boolean;
  /**
   * C14 (R4a): play only the span `[startFrame, endFrame)` of the file (frames at the file's own rate), decoded as its
   * own clip (a loop tail). Decoded clips only; a backend without span clips (`holdSpan` absent) ignores it.
   */
  span?: { startFrame: number; endFrame: number };
}

/**
 * C14 (R4a): a reference to a decoded span clip, taken ahead of its plays so the span is resident when a voice is
 * stamped on it (`AudioClipCache.holdSpan`). A refused span (bad range, over 30 s, over the clip ceiling) reads `failed`.
 */
export interface ClipSpanHold {
  readonly state: "loading" | "ready" | "failed";
  /** Why it failed (`refusedSpan`, `refusedCeiling`, `fetch`, `decode`, ...), null otherwise. */
  readonly failure: string | null;
  /** Drop the reference (once; later calls do nothing). Voices playing the span keep their own. */
  release(): void;
}

/**
 * ADR 0162 §1.2 (K4): the per-voice options a Play edit changes on a playing voice (`AudioSource.apply`). Omitted fields
 * are kept. Ranges as `PlayRequest`'s; callers clamp.
 */
export interface VoiceSpatialOptions {
  occlusion?: boolean;
  dopplerLevel?: number;
  reverbSend?: number;
  reverbSendCurve?: SendCurve;
  /** Degrees, -180..180, positive to the right (ambisonic clips). */
  yaw?: number;
}

/**
 * ADR 0166 §4.6 (G-1): a stamped ramp of a voice's own gain and/or low-pass, with a law (`AudioVoice.paramsShaped`).
 * `gain` multiplies the voice's dry gain (not the `fade` ramp); `lowpassHz` is a cutoff; `at` the heard time it starts
 * (omitted: as soon as possible).
 */
export interface ShapedParams {
  gain?: number;
  lowpassHz?: number;
  seconds: number;
  law?: FadeLaw;
  at?: number;
}

/**
 * One playing sound. ADR 0264: every adapter's voice has every member below; how a weak backend does a member is the
 * adapter's business (the Babylon fallback runs a stamped ramp as timer steps, the pending voice records the latest call
 * and forwards it at the hand-over), so callers state one intent and never probe a member. The members fall in groups
 * by what they do:
 *
 * - **Plain controls:** volume, pitch, attenuation, position, bus, priority, pause and resume, `fade`, `stop`.
 * - **Playback position:** `seek` and `setLoop`.
 * - **Main's spatial results and options (ADR 0162 K0, K4):** `setVelocity`, `setOcclusion`, `setDopplerRate`,
 *   `setSpatialOptions`.
 * - **Stamped ramps (ADR 0166 §4.2, G-1):** `fadeShaped` and `paramsShaped`, each starting at a heard time.
 *
 * Only reads stay optional: `alive`, `panner` and `occlusion` (a backend without them answers through the defaults).
 */
export interface AudioVoice {
  readonly playing: boolean;
  /**
   * E3.10: false once the voice has been freed. A stopped voice fading out is not `playing` but is still alive; the event
   * runtime keeps an instance's group until every voice that carried it is gone. Absent: same as `playing`.
   */
  readonly alive?: boolean;
  readonly id: number;
  /** Why it isn't audible, or why it ended early (§1); null otherwise. */
  readonly reason: AudioReason | null;
  /** Ease the voice's own gain to `to` (linear, 0..4) over `seconds`. */
  fade(to: number, seconds: number): void;
  setPriority(priority: number): void;
  setVolume(v: number): void;
  setPitch(rate: number): void;
  setAttenuation(a: Attenuation): void;
  setPosition(p: Vec3Like): void;
  /** Move to another bus while playing. */
  setBus(bus: string): void;
  pause(): void;
  resume(): void;
  /** Stop now, or fade to silence over `fadeSeconds` (default 0) and stop. */
  stop(fadeSeconds?: number): void;

  // --- Playback position ---
  /**
   * Move to `seconds` of the sound (B3b). A loop wraps the time, otherwise it clamps to the end. The core fades the old
   * audio out over 5 ms and the new in, and flushes a stream (it reads "waitingForData" until decoded from there); the
   * Babylon fallback restarts the sound at the offset; a voice that hasn't started yet starts there.
   */
  seek(seconds: number): void;
  /**
   * ADR 0158 §4: loop `start..end` seconds of the clip (`end` 0 is its end), or with `looping` false play on past the loop
   * to the clip's end. The core sends it through its automation sink (stamped behind the voice's PLAY); the fallback sets
   * its sound's loop points.
   */
  setLoop(start: number, end: number, looping: boolean): void;

  // --- Main's spatial results and options (ADR 0162, contract K0) ---
  /** §3.2: the source's velocity, world units per second (Doppler, debug). */
  setVelocity(v: Vec3Like): void;
  /**
   * §8, K4: main's smoothed occlusion result for this voice. `gain` is the dry gain (1 open); `lpHz` the cutoff it asks
   * for (≥ 20000 off). The core routes both into the per-voice filter (`voiceFx`); the Babylon fallback applies the gain
   * only, through its volume, and drops the cutoff.
   */
  setOcclusion(gain: number, lpHz: number): void;
  /** §8, K4: main's clamped Doppler factor (1 none). The core folds it into pitch; Babylon into `playbackRate` (decoded clips only). */
  setDopplerRate(factor: number): void;
  /**
   * §1.2, K4: Play edits of the source's M3 options (`VoiceSpatialOptions`). The Babylon fallback keeps `occlusion` and
   * `dopplerLevel` (its passes read them) and has no sends or ambisonic rotation to change.
   */
  setSpatialOptions(o: VoiceSpatialOptions): void;
  /**
   * §1.1, D5: the panner the voice uses and its smoothed dry occlusion gain (1 open), read from the main-thread tables
   * (the public handle's `panner` and `occlusion`). Absent on a backend without them: the handle reads null and 1.
   */
  readonly panner?: AudioPanner | null;
  readonly occlusion?: number;

  // --- Stamped ramps (ADR 0166 §4.2, G-1) ---
  /**
   * A shaped fade of the voice's `fade` ramp starting at heard time `f.at`; with `stopAtEnd` the voice stops when it ends
   * (a shaped STOP). Sample-exact on the core (`MusicBackendCaps.stampedFades`); timer steps on the Babylon fallback.
   */
  fadeShaped(f: ShapedFade): void;
  /** A stamped ramp of the voice's own gain and/or low-pass (`ShapedParams`); the Babylon fallback drops the low-pass. */
  paramsShaped(r: ShapedParams): void;
}

/**
 * ADR 0162 (contract K0, C9): main's side of zone impulse-response preparation. K4 constructs it in `coreBackend.ts`;
 * C2b implements it in `core/zoneIr.ts` over the decoder worker. The kernel itself goes from the worker straight to
 * the worklet (main never holds kernels or time-domain IRs); main hears only that it was prepared or failed.
 */
export interface ZoneIrService {
  /**
   * Ask for kernel `kernelId` from an IR asset (`assetUrl`) or a built-in preset (`preset`, R10) at `contextRate`, cut to
   * `maxFrames`. Returns the request's token. A request for a kernel already prepared at this rate is answered at once.
   */
  prepare(request: { kernelId: number; assetUrl?: string; preset?: string; contextRate: number; maxFrames: number }): number;
  /** Forget kernel `kernelId`: the worker drops its kept bytes and the core may reuse the slot. Unknown ids are ignored. */
  release(kernelId: number): void;
  /** Called when a kernel reached the worklet (`irPrepared`). */
  onPrepared: ((e: { token: number; kernelId: number; frames: number; truncated: boolean; prepareMs: number }) => void) | null;
  /** Called when preparing failed (`irFailed`): the zone reads "IR failed: <message>". */
  onFailed: ((e: { token: number; kernelId: number; code: number; message: string }) => void) | null;
  /** A rate change or hard rebuild: re-prepare every kernel still held from the worker's kept bytes. */
  reprepareAll?(contextRate: number): void;
  dispose?(): void;
}

export interface ListenerPose {
  position: Vec3Like;
  forward: Vec3Like;
  up: Vec3Like;
}

// --- The seam (ADR 0098, narrowed into capabilities by ADR 0179) ------------------------------------------------------
//
// Every backend implements the required members. What only some backends can do is grouped into capability objects: a
// caller reads one once (`const clock = backend.clock; if (clock) ...`) and gets every member of it, so there is no probing
// of single optional members. A capability is either there whole or absent. On the core every capability getter returns
// the backend itself (its own members are the capability's), so a capability costs no object and no allocation; the
// Babylon fallback has `clipCache`, `music`, `mix` and `capture` and no `clock` or `automation`.

/**
 * The backend's decoded-clip cache (ADR 0158, ADR 0166 G-1, P8, C14): what is known of a loaded clip, dropping an edited
 * file, and holding a span for loop tails. Core: all of it. Babylon fallback: durations only (facts unknown, nothing to
 * invalidate, no span clips).
 */
export interface AudioClipCache {
  /** A loaded clip's length in seconds at pitch 1, or null while it isn't known (still loading, streaming). */
  clipDuration(path: string): number | null;
  /** A loaded clip's facts, or undefined while unknown (not loaded, failed, or a backend that doesn't keep them). `gapless`: its length is exact. */
  clipFacts(path: string): { frames: number; rate: number; channels: number; gapless: boolean } | undefined;
  /** The asset file at `path` was edited: drop what is cached of it (decoded clips, the worker's encoded music bytes). */
  invalidateClip(path: string): void;
  /**
   * C14 (R4a): hold the decoded span `[startFrame, endFrame)` of the asset at `path` (frames at its own rate) so a play
   * with `PlayRequest.span` finds it resident. Null: this backend has no span clips (no loop tails).
   */
  holdSpan(path: string, startFrame: number, endFrame: number): ClipSpanHold | null;
}

/**
 * The heard clock (ADR 0158, ADR 0166 §1.3, §6, G-1, Rh1): exact stamping, the frame clock, input timestamps and latency.
 * The core has it; the Babylon fallback doesn't (callers then use `time`, an estimated lookahead and zero latency).
 */
export interface AudioClock {
  /**
   * §6 step 0 (R17): advance the heard-clock map and read the status mirror for this display frame. Idempotent per frame
   * (`ClockMap.beginFrame` does nothing the second time at the same `rafTime`), so `update` may call it again.
   */
  beginFrame(): void;
  /** The earliest audio-clock time (`time`'s base) a play with `at` lands on exactly, for gapless chains; null while unknown (callers treat it as no clock). */
  horizon(): number | null;
  /** The clock's frame-interval average Δ̄, seconds; null while unknown (callers estimate it). */
  frameInterval(): number | null;
  /** §1.3 `Audio.timeAt`: the raw heard time (seconds) of a `performance.now()` instant (ms). Calibration is never applied (R18). */
  timeAt(performanceTime: number): number;
  /** §1.3 `Audio.latency`, seconds. */
  latency(): AudioLatency;
  /**
   * ADR 0224: how the core's frames map to the heard clock, read afresh each call (a context rebuild may change the rate):
   * frame f is heard when `Audio.time` = f / `sampleRate` + `timeOffset`. `carryPending` is true from a context swap until
   * the new context's clock gave its first estimate (`timeOffset` is not known yet). Null when the backend has no frame
   * map (a fake without one); callers then assume 48 kHz and the event's own times.
   */
  frameMap(): AudioFrameMap | null;
}

/** ADR 0224: a snapshot of the core's frame-to-heard-time map (`AudioClock.frameMap`). */
export interface AudioFrameMap {
  readonly sampleRate: number;
  readonly timeOffset: number;
  readonly carryPending: boolean;
}

/**
 * The live mix (ADR 0171 amended by 0172 §1.3, §6, ADR 0175): what the backend can do for the mix, where `mixer.apply`
 * sends a checked edit, and the fader's preview flush. Core and Babylon fallback both have it; the pending backend doesn't.
 */
export interface AudioLiveMix {
  /** §1.3: what this backend can do for the mix (Dbg1 tests the flags per backend). */
  readonly mixCaps: AudioMixCaps;
  /** §6.2, ADR 0175: where `mixer.apply` sends a checked live edit (the Mixer refuses, classifies and checks the bus rules first). */
  readonly mixOpTarget: MixOpTarget;
  /** §6.6: post the pending batch now (the fader's preview path, at most one post per `FADER_COALESCE_MS`). A no-op where there is no batch. */
  flushNow(): void;
}

/**
 * The capture's sources (ADR 0171 §5.5, §5.6, architecture §2.1): the event taps, the KEYFRAME and the STATUS tap. Core and
 * Babylon fallback both have it. What a capture records is `AudioLiveMix.mixCaps.capture`: on a `"mainSideOnly"` backend
 * (no STATUS blocks) `recorderTap` is never called.
 */
export interface AudioCaptureSource {
  /** Architecture §2.1: the recorder's STATUS tap, null when no recorder runs (Rc2 sets it through `capture.ts`). */
  recorderTap: RecorderTap | null;
  /** §5.6: the capture's event taps (Rc3); null restores the null object. */
  setProfileSink(sink: ProfileSink | null): void;
  /**
   * §5.5 (G7b): the backend's main-side state at this instant, for the capture's KEYFRAME. ADR 0249: the row composer above
   * the seam (`audioRows.ts` `KeyframeRows`, which `capture.ts` hands the recorder) adds the event and music sections.
   * `nameId` interns a clip, snapshot or event-asset name into the capture's NAMES tables (`EventSink.name`), `noName` is the
   * id for none. The payload and its rows may be reused by the next call.
   */
  keyframe(nameId: (table: "clips" | "snapshots" | "events", name: string) => number, noName?: number): BackendKeyframe;
}

/**
 * ADR 0249: what a backend's keyframe reports: its voices, buses, meters and mix section, and how many of its voices each
 * event instance has (event id to count, stolen voices left out), which keeps an instance's event row while its last voice
 * is still listed (E3.9). The event and music rows come from above the seam.
 */
export interface BackendKeyframe extends Omit<KeyframePayload, "events" | "music"> {
  readonly eventVoices: ReadonlyMap<number, number>;
}

/**
 * ADR 0248: the output device the backend plays to, for what is kept per device (`Audio.calibration`, Rh2). Core and
 * Babylon fallback both have it. The backend only reports; the layer above (`music/calibration.ts`) decides what to load.
 */
export interface AudioOutputDevice {
  /** The sink the context outputs to ("" for the default device or where unsupported); null before there is a context. */
  readonly outputSink: string | null;
  /**
   * Set by the layer above when the selector installs the backend. The backend calls it with the sink it now has once
   * its context exists (`"opened"`, only if that happens after the install) and on each device event (`"changed"`).
   */
  onOutputDevice: ((sink: string, change: "opened" | "changed") => void) | null;
}

export interface AudioBackend {
  readonly name: string;
  /** Start a clip. Null if the backend can't (not ready, unknown clip). */
  play(req: PlayRequest): AudioVoice | null;
  setListener(pose: ListenerPose): void;
  /** Re-apply the mixer's resolved state to the backend's buses. */
  applyMix(buses: readonly ResolvedBus[]): void;
  /** Rebuild the bus graph after the project's buses changed. */
  configureBuses(mixer: Mixer): void;
  masterVolume: number;
  muted: boolean;
  readonly status: AudioStatus;
  /** The heard audio clock, seconds. */
  readonly time: number;
  debug(): AudioDebugInfo;
  setBackground(mode: AudioBackground): void;
  /**
   * ADR 0270: the backend's own part of the frame, run last by the frame step (`audioFrame.ts` `runAudioFrame`, after main's
   * passes and the music plan). Absent: the backend has none. The core has none: its frame is the frame step's stages
   * (`StagedFrameHost`). Callers drive a frame through `runAudioFrame`, never through this.
   */
  update?(dt: number): void;
  /** Stop every voice and let go of the library (`setAudioBackend` calls it on the backend it replaces). */
  dispose(): void;

  // Capabilities (ADR 0179). Absent: the backend can't do that; callers take the fallback each one names.
  /** ADR 0158, 0166: the decoded-clip cache. Absent: durations and facts unknown, nothing to drop, no loop tails. */
  readonly clipCache?: AudioClipCache;
  /** ADR 0158, 0166: the heard clock. Absent: `time` is the only clock, no exact stamps, zero latency. */
  readonly clock?: AudioClock;
  /** ADR 0166 §4.6, C10: the music operations. Absent: no music (the player plays nothing and warns once). */
  readonly music?: MusicBackend;
  /**
   * ADR 0158: the backend's own automation (the core's tables). Absent: the playlist runtime evaluates automation on main
   * with `TsAutomation` once per frame and drives voices through their setters.
   */
  readonly automation?: AutomationSink;
  /** ADR 0171, 0175: the live mix. Absent (the pending backend): `mixer.apply` has no target and edits wait. */
  readonly mix?: AudioLiveMix;
  /** ADR 0171: the capture's sources. Absent (the pending backend): `Audio.capture` isn't available yet. */
  readonly capture?: AudioCaptureSource;
  /** ADR 0248: the output device. Absent (the pending backend, a fake): nothing is kept per device. */
  readonly device?: AudioOutputDevice;
  /**
   * ADR 0331: instance submixes (the core's). Absent: instance effects map onto each voice (filters and gain) and the
   * other effect types are skipped with one warning.
   */
  readonly submixes?: AudioSubmixes;
}

/**
 * ADR 0331: the instance submix pool. A submix runs an instance's insert chain on the mix of its voices on one bus and
 * feeds that bus.
 */
export interface AudioSubmixes {
  /**
   * Gives instance `group` (its voices' `PlayRequest.group`) a submix feeding `bus` that runs `effects` (the catalogue's;
   * one already held is reconfigured). Call before the instance's first play. False when the pool is full: the
   * instance plays without its chain (the refusal is warned once and marked in a capture). `where` names the instance.
   */
  open(group: number, bus: string, effects: readonly Effect[], where: string): boolean;
  /** Frees instance `group`'s submix once its voices have ended (its group is given back). */
  close(group: number): void;
  /**
   * ADR 0331 instance automation (ABI 4.8): replaces instance `group`'s submix parameter automation (empty: none).
   * Nothing when the instance holds no submix. Absent on a backend without the core's submix automation.
   */
  automate?(group: number, lanes: readonly SubmixLane[]): void;
}

/**
 * One automated parameter of an instance submix's chain (ABI 4.8): effect `effect` (its id, one of the effects given to
 * `open`), catalogue parameter index `param` (`fxParamSlot`), read from `input` (a global parameter, one of the
 * instance's local ones, or its group's `sequenceTime`) through curve id `curve` (defined through the automation sink;
 * with `log`, a curve of log2 of the value).
 */
export interface SubmixLane {
  effect: string;
  param: number;
  log: boolean;
  input: ParamRef;
  curve: number;
}

let backend: AudioBackend | null = null;
let factory: (() => AudioBackend) | null = null;
let coreFactory: (() => AudioBackend) | null = null;
let warnedCore = false;
let coreUnavailableReason: string | null = null;

/** Register how the `"babylon"` backend is made (`BabylonBackend` does this on import, from `AudioSource.ts`). */
export function registerDefaultBackend(make: () => AudioBackend): void {
  factory = make;
}

/**
 * @internal The core's backend factory, registered by `core/service.ts` once the core has loaded (A0.3, A1.4). Returns an
 * undo. Sound played while the core was still loading (the pending backend) moves onto the core now.
 */
export function registerCoreBackend(make: () => AudioBackend): () => void {
  coreFactory = make;
  settlePending();
  return () => { if (coreFactory === make) coreFactory = null; };
}

/**
 * @internal A0.6's fallback trigger: the probe (or a failed core load) says why the core can't run here. The
 * next `audioBackend()` that wanted the core logs one warning carrying `reason`, then uses "babylon" (§2.1 fallback
 * rule). Only the first reason is kept, so one failure gives one warning. Sound played while the core was loading
 * moves onto "babylon" now.
 */
export function noteCoreUnavailable(reason: string): void {
  coreUnavailableReason ??= reason;
  settlePending();
}

/** @internal Why the core couldn't run here (the probe's refusal, or the load or start failure), or null when nothing said so yet. `Audio.debug().coreUnavailable` (ADR 0327). */
export function coreUnavailable(): string | null {
  return coreUnavailableReason;
}

/** A released session (ADR 0218) forgets why the core couldn't run: the next project's service load probes again, and warns once. */
onAudioSessionReleased(() => {
  warnedCore = false;
  coreUnavailableReason = null;
});

/**
 * K3: which backend `audio.backend` picks. `"core"` is the core, the default (`defaultBackend()` in the settings; macOS
 * desktop defaults to "babylon" until its gate passes); `"babylon"` is `BabylonBackend` (Babylon's AudioEngineV2), the
 * fallback. The settings parse reports pre-0157 values as problems and uses the default.
 */
export function resolveBackendKind(configured: AudioSettings["backend"]): "babylon" | "core" {
  return configured === "core" ? "core" : "babylon";
}

/** The active backend, created on first use so servers and tests that never play sound don't touch a library. */
export function audioBackend(): AudioBackend {
  // The project left "core" while it was still loading (an editor settings change): its sound goes to "babylon".
  if (backend instanceof PendingCoreBackend && resolveBackendKind(mixer.audioSettings.backend) !== "core") settlePending();
  if (!backend) {
    let make = factory;
    if (resolveBackendKind(mixer.audioSettings.backend) === "core") {
      if (coreFactory) make = coreFactory;
      else if (coreUnavailableReason === null) {
        // §2.1, §3.1: the core loads (through the `myco.audio` World service) while sound is locked. Until it has
        // loaded or failed, plays wait as locked voices, then move to whichever backend the load settles on.
        backend = new PendingCoreBackend();
        applyBackgroundSetting(backend);
        return backend;
      } else if (!warnedCore) {
        // A real failure (probe refusal, load or start failure): one warning, then "babylon" for the page (§2 Fallback).
        warnedCore = true;
        console.warn(`[myco] ${coreUnavailableReason}`);
      }
    }
    if (!make) throw new Error("No audio backend registered.");
    const made = make();
    backend = made;
    install(made);
    mixer.onChange(() => backend?.applyMix(mixer.resolveAll()));
  }
  return backend;
}

// --- Above the seam (ADR 0248): what every installed backend gets once, whichever it is ---------------------------------

const attachHooks: ((b: AudioBackend) => void)[] = [];
const opSentHooks: ((op: MixOp, cls: OpClass) => void)[] = [];

/**
 * ADR 0248: `fn` runs on every backend the selector installs (`audioBackend()`, `setAudioBackend`; never the pending
 * stand-in, whose sound moves to the real backend when the load settles), and at once on the installed one. The layers
 * above the seam register on import (the music side binds its sinks, the calibration follows the output device), so no
 * backend calls up into them.
 */
export function onAudioBackendAttached(fn: (b: AudioBackend) => void): void {
  attachHooks.push(fn);
  if (backend && !(backend instanceof PendingCoreBackend)) fn(backend);
}

/**
 * ADR 0248: `fn` runs after the installed backend's live mix sent an op (`mixer.apply` reached `MixOpTarget.sendOp`), on
 * every backend: the playlist runtime binds bus automation again after a `setAutomation`.
 */
export function onMixOpSent(fn: (op: MixOp, cls: OpClass) => void): void {
  opSentHooks.push(fn);
}

/** The backend's live-mix target as the mixer sees it: the backend's own, then the hooks above the seam. */
function opTargetOf(b: AudioBackend): MixOpTarget | null {
  const inner = b.mix?.mixOpTarget;
  if (!inner) return null;
  return {
    get liveCaps() {
      return inner.liveCaps;
    },
    sendOp(op, cls) {
      const r = inner.sendOp(op, cls);
      for (const fn of opSentHooks) fn(op, cls); // ADR 0334: the class too (the capture writes MIXOP records)
      return r;
    },
    notSent: (r) => inner.notSent?.(r),
  };
}

/** A backend becomes the page's: buses, mix, background mode, the live-mix target (ADR 0171 K0, 0175), then the hooks. */
function install(next: AudioBackend): void {
  next.configureBuses(mixer);
  next.applyMix(mixer.resolveAll());
  applyBackgroundSetting(next);
  mixer._setOpTarget(opTargetOf(next));
  for (const fn of attachHooks) fn(next);
}

let followingBackground = false;

/**
 * A3.4b: `audio.background` reaches the backend (§6 `setBackground`) when it is made and after each Engine's mixer
 * reconfigure, so a project switching mode is picked up at the next hide.
 */
function applyBackgroundSetting(target: AudioBackend): void {
  target.setBackground(mixer.audioSettings.background);
  if (followingBackground) return;
  followingBackground = true;
  onAudioConfigured((settings) => backend?.setBackground(settings.background));
}

/** Swap the backend (a test double). Sounds on the old one are stopped by its `dispose`. */
export function setAudioBackend(next: AudioBackend | null): void {
  backend?.dispose();
  backend = next;
  if (next) install(next);
  else mixer._setOpTarget(null);
}

/** The core load settled (registered, failed, or no longer wanted): the pending backend hands its sound to the real one. */
function settlePending(): void {
  if (!(backend instanceof PendingCoreBackend)) return;
  const pending = backend;
  backend = null;
  pending.handOver(audioBackend());
}

/** @internal Whether `audioBackend()` is the stand-in used while the core loads (the audio system, tests). */
export const isPendingCoreBackend = (b: object | null): boolean => b instanceof PendingCoreBackend;

/** @internal Whether a backend exists yet (the audio system skips work before first sound). */
export const hasAudioBackend = (): boolean => backend !== null;

/** The one mixer lives in `engine/audio/mixer` (ADR 0157 §6); re-exported here for the plugin's backends and tests. */
export { mixer } from "../../../engine/audio/mixer";
