/**
 * Audio (ADR 0006, 0074, 0097, 0098). Playback goes through an audio backend (Babylon's AudioEngineV2 by default,
 * the core when `audio.backend` says so; the host unlocks audio after the first user gesture) and the project's mixer buses.
 * Game code never sees the backend library. Only the World that has the view plays sound.
 */
import { mixer } from "../../../engine/audio/mixer";
import "./babylonBackend"; // registers the "babylon" backend: Babylon's AudioEngineV2 (ADR 0098, 0157 K3)
import { Component } from "../../../engine/core/Component";
import { AssetRef, component, field, PlainObject } from "../../../engine/core/registry";
import { Vector3 } from "../../../engine/core/math";
import type { World } from "../../../engine/core/World";
import { _worldServiceOf } from "../../../engine/core/worldServices";
import { AUDIO, type AudioWorldService } from "./core/service";
import { ambisonicImportGain, ambisonicStreamsByDefault } from "./core/clipRegistry";
import { Assets } from "../../../engine/scene/Assets";
import { audioBackend, hasAudioBackend, DEFAULT_SEND_CURVE, type AudioPanner, type AudioVoice, type PlayRequest, type Rolloff, type SendCurve } from "./backend";
import { isAudioEventPath } from "../../../engine/audio/eventFormat";
import { _setEventClipStarter, events, loadAudioEvent, type EventInstance, type EventOptions } from "./events/eventRuntime";
import { setSegmentClipSource } from "./music/segmentRun";
import { noteAssetChanged, setReloadHost } from "./music/reload";


export type { Rolloff } from "./backend";

/** @internal Whether `path`'s sidecar marks it ambisonic (ADR 0162 §2.4): it plays through the listener's rotation, with no position. */
export const isAmbisonicClip = (path: string): boolean => Assets.importSettings(path).ambisonic !== null;

/**
 * @internal Start a clip on the active backend, on `output` (a mixer bus name; empty or unknown: Master). An ambisonic clip
 * (§2.4) is sent with `ambisonic` set, and streams when its sidecar says so or the registry found it longer than 5 s.
 */
export function startClip(path: string, loop: boolean, output: string | undefined, extra?: Partial<PlayRequest>): AudioVoice | null {
  const settings = Assets.importSettings(path);
  const ambisonic = settings.ambisonic !== null;
  return audioBackend().play({
    path, url: Assets.url(path), loop, stream: settings.stream || (ambisonic && ambisonicStreamsByDefault(path)), bus: mixer.resolveOutput(output),
    ...(ambisonic ? { ambisonic: true } : null), ...extra,
  });
}

/**
 * @internal The clip's import volume (ADR 0040), which scales every playback of it. ADR 0162 §2.4: a FuMa clip was scaled
 * down into int16 headroom by the decoder, and its import gain (1 for every other clip) restores the level.
 */
export const clipVolume = (path: string) => Assets.importSettings(path).volume * ambisonicImportGain(path);

// ADR 0158: event clips start like every clip, with the import volume (and the bus resolved as for `output`). M2 F1: in
// parts, so the event runtime reads a clip's import settings once per voice and builds its request in one object.
_setEventClipStarter({
  settings: (path) => {
    // ADR 0162 §2.4: as `clipVolume`; only a FuMa clip (import gain ≠ 1) costs an object.
    const settings = Assets.importSettings(path);
    const gain = ambisonicImportGain(path);
    return gain === 1 ? settings : { volume: settings.volume * gain, stream: settings.stream };
  },
  url: (path) => Assets.url(path),
  bus: (output) => mixer.resolveOutput(output),
  hasBus: (name) => mixer.has(name),
  play: (req) => audioBackend().play(req),
});

// ADR 0166 P6: a music segment run resolves its stems' clips here (the event runtime's starter above is private to it):
// the same URL, import settings (with the FuMa gain) and bus resolution. The clip facts come from the backend
// (`AudioBackend.clipFacts`, G-1); until a clip is loaded the stream-or-decode rule falls back to the import setting `stream`.
setSegmentClipSource({
  url: (path) => Assets.url(path),
  settings: (path) => {
    const settings = Assets.importSettings(path);
    const gain = ambisonicImportGain(path);
    return gain === 1 ? settings : { volume: settings.volume * gain, stream: settings.stream };
  },
  bus: (output) => mixer.resolveOutput(output),
  facts: (path) => audioBackend().clipFacts?.(path),
});

// ADR 0166 P8: the editor saving an asset reaches the music runtime here. `invalidateClip` drops the decoded clips and the
// worker's encoded bytes of the file (only when a backend exists: an edit before any sound needs nothing dropped), and
// `eventRoot` re-reads the saved event asset's music tree; `noteAssetChanged` then marks the playing instances that use
// the path, and each swaps at its next bar (`music/reload.ts`).
setReloadHost({
  invalidateClip: (path) => {
    if (hasAudioBackend()) audioBackend().invalidateClip?.(path);
  },
  eventRoot: (path) => (isAudioEventPath(path) ? loadAudioEvent(path)?.musicRoot ?? null : null),
});
Assets.onChanged((path) => noteAssetChanged(path));

const clamp255 = (p: number): number => (Number.isFinite(p) ? Math.min(255, Math.max(0, Math.round(p))) : 128);
/** Clamps `v` to lo..hi; a non-finite value gives `fallback`. */
const clampOr = (v: number, lo: number, hi: number, fallback: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** Whether the active World has the view: only it plays sound (ADR 0074). */
export const worldPlays = (world: World | null): boolean => !!world?.render;

/** @internal The World's key on the core (its `myco.audio` share, architecture §3.9), or 0 while it has none. A play carries it so selection knows whose voice it is. */
export function worldKeyOf(world: World | null): number {
  if (!world) return 0;
  return (_worldServiceOf(world, AUDIO) as AudioWorldService | null)?.key ?? 0;
}

/**
 * Plays a clip from its node. With `spatial` on it sounds from the node's position, panning and
 * fading with distance from the World's AudioListener (ADR 0074).
 */
@component("engine.AudioSource")
export class AudioSource extends Component {
  /**
   * What to play: a clip (an audio file) or an audio event asset (`*.audioevent.json`, ADR 0158); the Inspector offers both.
   * For an event, `loop`, `spatial` and the distance fields come from the event; `volume` and `pitch` still apply on top.
   * A music event (a segment, playlist or musicSwitch root, ADR 0166) plays the same way, but `pitch` is ignored (one warning).
   */
  @field(AssetRef, { kind: ["audio", "audioEvent"], description: "A sound clip, or an audio event (`*.audioevent.json`) to play as an instance." }) clip = "";
  @field(Number, { description: "Linear gain, 1 is full volume." }) volume = 1;
  @field(Boolean, { description: "Start again when the clip ends." }) loop = false;
  @field(Boolean, { description: "Start playing when the node is enabled in play mode." }) playOnAwake = true;
  /** Playback speed and pitch: 1 is normal, 2 an octave up. */
  @field(Number, { description: "Playback speed and pitch: 1 is normal, 2 an octave up." }) pitch = 1;
  /** Sound from the node's position instead of flat. On the Babylon fallback, clips that stream play flat. */
  @field(Boolean, { description: "Sound from the node's position, panned and faded by distance from the listener, instead of flat." }) spatial = false;
  /** Spatial: full volume inside this distance, in metres. */
  @field(Number, { description: "Spatial: full volume inside this distance, world units." }) minDistance = 1;
  /** Spatial: the distance where the falloff stops, in metres. */
  @field(Number, { description: "Spatial: the distance where the falloff stops, world units." }) maxDistance = 100;
  /** Spatial: how volume falls between `minDistance` and `maxDistance`. */
  @field(String, { choices: ["linear", "inverse", "exponential"], description: "Spatial: how volume falls between minDistance and maxDistance." }) rolloff: Rolloff = "inverse";

  /** The mixer bus this sound plays on (ADR 0097): a bus name from the project's Audio settings. Empty is Master. */
  @field(String, { choices: (s) => s.audio.buses.map((b) => b.name), description: "The mixer bus this sound plays on (a bus from Project Settings > Audio). Empty is Master." }) output = "";
  /** 0..255. Mostly decides who is stolen when a voice limit is hit. */
  @field(Number, { description: "0..255. Mostly decides who is stolen when a voice limit is hit." }) priority = 128;

  // ADR 0162 §1.2 (K4 declares them; the features they drive fill their own files).
  @field(Boolean, { description: "Spatial sources: walls between the source and the listener muffle it. Inert in 2D worlds and without the 3D physics service." }) occlusion = true;
  @field(Number, { description: "Spatial sources: scales the Doppler shift, 0..5; 0 is off." }) dopplerLevel = 1;
  @field(Number, { description: "Spatial sources: how much of the source goes to the reverb zones that hold it, 0..2. Taken before the distance gain." }) reverbSend = 1;
  @field(PlainObject, { hidden: true, description: "The reverb send against distance (x: 0 at minDistance to 1 at maxDistance; y multiplies the send), independent of the dry rolloff. reverbSend × curve is clamped to 4." }) reverbSendCurve: SendCurve = DEFAULT_SEND_CURVE.map((p) => [p[0], p[1]] as [number, number]);
  @field(Number, { description: "Ambisonic clips: turns the recording about the vertical axis, degrees (-180..180), positive to the right (clockwise seen from above), as every turn (ADR 0164)." }) ambisonicYaw = 0;

  private voice: AudioVoice | null = null;
  /** @internal ADR 0162 D2a: the playing voice's id (0 while none), so the occlusion pass can exclude the source's own colliders. */
  get _voiceId(): number {
    return this.voice?.id ?? 0;
  }
  /** ADR 0158: the playing event instance when `clip` is an event. */
  private instance: EventInstance | null = null;
  /** What was last applied to the playing sound, so a frame only touches the backend for changes. */
  private applied = "";
  /** The pitch last given to the playing event instance. */
  private appliedPitch = 1;
  /** ADR 0162 (K4): the §1.2 options last applied, and the curve object they carried. */
  private appliedM3 = "";
  /** F-22: the play request carried the attenuation, so the first `apply` doesn't send it again. */
  private playedAttenuation = false;
  private readonly appliedCurve: number[] = [];
  private readonly zeroVelocity = new Vector3();
  /** ADR 0162 §2.4 (B5): the playing clip is ambisonic, so `spatial`, the distance fields, `occlusion` and `dopplerLevel` don't apply. */
  private ambisonicClip = false;
  /** One warning per source about those fields. */
  private warnedAmbisonic = false;

  /** ADR 0162 §1.2: the source's velocity in world units per second (Doppler). Read-only: the Doppler pass's estimate (zero while not playing, or on a backend without it). */
  get velocity(): Vector3 {
    const id = this.voice?.id ?? 0;
    const b = audioBackend() as { _velocityOf?: (id: number, out: Vector3) => boolean };
    if (id === 0 || !b._velocityOf?.(id, this.zeroVelocity)) this.zeroVelocity.set(0, 0, 0);
    return this.zeroVelocity;
  }

  /** ADR 0162 §1.2 (`occlusionGain`: the field `occlusion` holds the switch): the playing sound's smoothed dry occlusion gain, 1 open (and while not playing). */
  get occlusionGain(): number {
    if (this.instance) return this.instance.playing ? this.instance.occlusion : 1;
    return this.voice !== null && this.voice.playing ? (this.voice.occlusion ?? 1) : 1;
  }

  /** ADR 0162 §1.2: the panner the playing sound uses, or null when not playing (or on a backend without panners). */
  get panner(): AudioPanner | null {
    if (this.instance) return this.instance.playing ? this.instance.panner : null;
    return this.voice !== null && this.voice.playing ? (this.voice.panner ?? null) : null;
  }

  get isPlaying(): boolean {
    if (this.instance) return this.instance.playing;
    return this.voice !== null && this.voice.playing;
  }

  play(): void {
    if (!this.clip || !worldPlays(this._world)) return;
    this.stop();
    const path = this.clip.replace(/^asset:/, "");
    if (isAudioEventPath(path)) {
      this.instance = events().play(path, {
        pitch: this.pitch, priority: clamp255(this.priority), bus: this.output || undefined, position: this.node.transform?.worldPosition,
        ...this.eventSpatialOptions(),
      }, worldKeyOf(this._world));
      this.applied = "";
      this.appliedPitch = this.pitch;
      if (this.instance) {
        this.instance.musicSource = this; // ADR 0166 K2: this node's `onMusicBeat`, `onMusicBar`, `onMusicCue` hear the music
        this.applyEvent();
      }
      return;
    }
    this.ambisonicClip = isAmbisonicClip(path);
    if (this.ambisonicClip) this.warnAmbisonicIgnored(path);
    // F-22: a spatial source starts positioned. With its clip resident the core sends the PLAY inside `play`, and a voice
    // can't turn spatial on the core after its PLAY, so a position given only afterwards (`apply`) left every replay flat.
    const spatial = this.spatial && !this.ambisonicClip && this.node.transform !== null;
    this.voice = startClip(path, this.loop, this.output, {
      priority: clamp255(this.priority), world: worldKeyOf(this._world), owner: this.node.name, ...this.spatialOptions(),
      ...(spatial ? { attenuation: { minDistance: this.minDistance, maxDistance: this.maxDistance, rolloff: this.rolloff }, position: this.node.transform!.worldPosition } : null),
    });
    this.applied = "";
    this.appliedM3 = "";
    this.appliedCurve.length = 0;
    this.playedAttenuation = spatial;
    if (this.voice) this.apply(path);
  }

  pause(): void {
    this.voice?.pause();
    this.instance?.pause();
  }

  resume(): void {
    this.voice?.resume();
    this.instance?.resume();
  }

  /** ADR 0158: set one of the playing event's own parameters. Does nothing for a clip. */
  setParameter(name: string, value: number | string): void {
    this.instance?.setParameter(name, value);
  }

  /** ADR 0158: one of the playing event's parameters (else a global one); undefined for a clip or when not playing. */
  getParameter(name: string): number | string | undefined {
    return this.instance?.getParameter(name);
  }

  /** ADR 0158: key-off the playing event, so its sustain loops play their tails. Does nothing for a clip. */
  release(): void {
    this.instance?.release();
  }

  /**
   * Moves the playing sound to `seconds` (clamped to 0 and the end; a loop wraps). A 5 ms fade-out and fade-in cover
   * the jump, and a streamed sound drops everything decoded before it, so nothing of the old position is heard after
   * the fade. Does nothing when not playing, or on the Babylon fallback (the core backend only).
   * @internal Not public yet: §1 of the 0157 design declares no seek; making it public needs a decision record
   * (owner review, entry 21).
   */
  seek(seconds: number): void {
    this.voice?.seek?.(seconds);
  }

  stop(): void {
    this.voice?.stop();
    this.voice = null;
    this.instance?.stop();
    this.instance = null;
  }

  /** @internal Each frame (the audio system): volume, pitch and, for spatial sources, position and falloff. */
  _sync(): void {
    if (this.instance) return this.applyEvent();
    if (!this.voice) return;
    this.apply(this.clip.replace(/^asset:/, ""));
  }

  /**
   * ADR 0162 §1.2, §1.3 (K4): the source's M3 options as K0's `PlayRequest` fields, clamped. `ambisonic` itself comes from
   * the clip's sidecar (B5), not from the source.
   */
  private spatialOptions(): Pick<PlayRequest, "occlusion" | "dopplerLevel" | "reverbSend" | "reverbSendCurve" | "yaw"> {
    return {
      occlusion: this.occlusion !== false,
      dopplerLevel: clampOr(this.dopplerLevel, 0, 5, 1),
      reverbSend: clampOr(this.reverbSend, 0, 2, 1),
      reverbSendCurve: Array.isArray(this.reverbSendCurve) ? this.reverbSendCurve : DEFAULT_SEND_CURVE,
      yaw: clampOr(this.ambisonicYaw, -180, 180, 0),
    };
  }

  /** ADR 0162 §1.2 (D4): the options an event the source plays gets (the event's own `spatial` keys win; a flat event ignores them). */
  /**
   * ADR 0162 D4: the source's §1.2 options an event it plays inherits where the event leaves them unset. Not
   * `dopplerLevel`: Doppler is authored on the event (§2.5 default 0, as in Wwise and FMOD), so a source's default 1
   * doesn't override it (coordinator ruling, build log).
   */
  private eventSpatialOptions(): Pick<EventOptions, "occlusion" | "reverbSend" | "reverbSendCurve"> {
    const { occlusion, reverbSend, reverbSendCurve } = this.spatialOptions();
    return { occlusion, reverbSend, reverbSendCurve };
  }

  /**
   * ADR 0162 §1.2 (B5): a source whose clip is ambisonic ignores `spatial`, the distance fields, `occlusion` and
   * `dopplerLevel` (the Inspector greys them); one warning per source, when it has set any of them.
   */
  private warnAmbisonicIgnored(path: string): void {
    if (this.warnedAmbisonic) return;
    if (!(this.spatial || this.minDistance !== 1 || this.maxDistance !== 100 || this.rolloff !== "inverse" || this.occlusion === false || this.dopplerLevel !== 1)) return;
    this.warnedAmbisonic = true;
    console.warn(`[myco] audio: AudioSource "${this.node.name}" plays the ambisonic clip "${path}", which ignores spatial, minDistance, maxDistance, rolloff, occlusion and dopplerLevel (ADR 0162)`);
  }

  /**
   * An event's volume follows `volume` (as the instance's fade multiplier), its pitch follows `pitch`, and a spatial event
   * follows the node. The rest applies at the next play. ADR 0162 (K4): §1.2's options for events (the event's own
   * `spatial` additions, §2.5) reach its voices through the event runtime (D4); the source's fields don't apply to an event yet.
   */
  private applyEvent(): void {
    const instance = this.instance!;
    const signature = `${this.volume}`;
    if (signature !== this.applied) {
      this.applied = signature;
      instance.fade(Math.min(4, Math.max(0, this.volume)), 0);
    }
    if (this.pitch !== this.appliedPitch) {
      this.appliedPitch = this.pitch;
      instance.setPitch(this.pitch);
    }
    if (instance.asset.spatial && this.node.transform) instance.position = this.node.transform.worldPosition;
  }

  private apply(path: string): void {
    const voice = this.voice!;
    // A streamed clip is spatial on the core; the Babylon fallback flattens it (and warns) itself.
    const spatial = this.spatial && !this.ambisonicClip;
    const signature = `${this.priority}|${this.volume}|${this.pitch}|${spatial}|${this.minDistance}|${this.maxDistance}|${this.rolloff}|${this.output}`;
    if (signature !== this.applied) {
      this.applied = signature;
      if (this.ambisonicClip) this.warnAmbisonicIgnored(path);
      voice.setBus(mixer.resolveOutput(this.output));
      voice.setPriority(clamp255(this.priority));
      voice.setVolume(this.volume * clipVolume(path));
      voice.setPitch(this.pitch);
      if (spatial && !this.playedAttenuation) voice.setAttenuation(this);
      this.playedAttenuation = false;
    }
    // ADR 0162 §1.2 (K4): Play edits of the M3 options take effect next frame on a voice that takes them.
    const m3 = `${this.occlusion}|${this.dopplerLevel}|${this.reverbSend}|${this.ambisonicYaw}`;
    if (this.curveEdited() || m3 !== this.appliedM3) {
      const first = this.appliedM3 === "";
      this.appliedM3 = m3;
      if (!first) voice.setSpatialOptions?.(this.spatialOptions());
    }
    if (spatial) voice.setPosition(this.node.transform!.worldPosition);
  }

  /** ADR 0162 E7: whether `reverbSendCurve`'s points differ from the last applied ones (a point edited in place counts; replacing the array with equal points doesn't). Refreshes the copy; no allocation once it is the right size. */
  private curveEdited(): boolean {
    const curve = this.reverbSendCurve, copy = this.appliedCurve;
    const n = Array.isArray(curve) ? curve.length : 0;
    let edited = copy.length !== n * 2;
    for (let k = 0; k < n; k++) {
      const x = curve[k]?.[0] as number, y = curve[k]?.[1] as number;
      if (!Object.is(copy[2 * k], x) || !Object.is(copy[2 * k + 1], y)) {
        edited = true;
        copy[2 * k] = x;
        copy[2 * k + 1] = y;
      }
    }
    copy.length = n * 2;
    return edited;
  }

  override _onActivate(): void {
    if (this.playOnAwake && this.voice === null) this.play();
    else this.resume();
  }

  override _onDeactivate(): void {
    this.pause();
  }

  override _onDetach(): void {
    this.stop();
  }
}
