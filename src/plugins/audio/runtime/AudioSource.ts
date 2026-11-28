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
import { clipRequest, clipVolume, isAmbisonicClip } from "./clipResolver";
import { playSampleVoice, releaseSampleVoice } from "./sampleVoice";
import { isSpatialPassHost } from "./core/spatial";
import { Assets } from "../../../engine/scene/Assets";
import { audioBackend, hasAudioBackend, DEFAULT_SEND_CURVE, type AudioPanner, type AudioVoice, type PlayRequest, type Rolloff, type SendCurve } from "./backend";
import { isAudioEventPath } from "../../../engine/audio/retiredAudioEvent";
import type { EventOptions } from "./playlists/options";
import { isPlaylistPath } from "../../../engine/audio/playlist/format";
import { playlists } from "./playlists/playlistSystem";
import type { PlaylistInstance } from "./playlists/instance";
import { playlistHandleOf } from "./playlists/handle";
import { takePlayOptions, takeTap, type TakeEmitter } from "./capture/takeTap";
import { normalizeAssetPath } from "../../../engine/scene/assetPath";


export type { Rolloff } from "./backend";

// ADR 0166 P8: the editor saving an asset drops the decoded clips and the worker's encoded bytes of the file (only when a
// backend exists: an edit before any sound needs nothing dropped). A playing Sequence picks up its edited playlist itself
// and swaps at its next bar (`playlists/sequence.ts`, the reload rule of `music/reload.ts`).
Assets.onChanged((path) => {
  if (hasAudioBackend()) audioBackend().clipCache?.invalidateClip(path);
});

const clamp255 = (p: number): number => (Number.isFinite(p) ? Math.min(255, Math.max(0, Math.round(p))) : 128);
/** Clamps `v` to lo..hi; a non-finite value gives `fallback`. */
const clampOr = (v: number, lo: number, hi: number, fallback: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** Whether the active World has the view, or plays sound without one (ADR 0341's audio-only World): only it plays sound (ADR 0074). */
export const worldPlays = (world: World | null): boolean => !!world && (!!world.render || world._audioOnly === true);

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
   * What to play: a clip (an audio file) or a playlist (`*.playlist.json`, ADR 0343). For a playlist, `loop` and `spatial`
   * come from the asset and `minDistance`/`maxDistance` stretch its attenuation; `volume` and `pitch` still apply on top.
   * An old audio event file (`*.audioevent.json`) is refused with a message naming the migration.
   */
  @field(AssetRef, { kind: ["audio", "playlist"], description: "A sound clip, or a playlist (`*.playlist.json`) to play as an instance." }) clip = "";
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
  /** ADR 0343: the playing playlist instance when `clip` is a playlist. */
  private playlist: PlaylistInstance | null = null;
  /** What was last applied to the playing sound, so a frame only touches the backend for changes. */
  private applied = "";
  /** The pitch last given to the playing playlist instance. */
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
    const b = audioBackend();
    if (id === 0 || !isSpatialPassHost(b) || !b.velocityOf(id, this.zeroVelocity)) this.zeroVelocity.set(0, 0, 0);
    return this.zeroVelocity;
  }

  /** ADR 0162 §1.2 (`occlusionGain`: the field `occlusion` holds the switch): the playing sound's smoothed dry occlusion gain, 1 open (and while not playing). */
  get occlusionGain(): number {
    if (this.playlist) return this.playlist.playing ? this.playlist.occlusion : 1;
    return this.voice !== null && this.voice.playing ? (this.voice.occlusion ?? 1) : 1;
  }

  /** ADR 0162 §1.2: the panner the playing sound uses, or null when not playing (or on a backend without panners). */
  get panner(): AudioPanner | null {
    if (this.playlist) return this.playlist.playing ? this.playlist.panner : null;
    return this.voice !== null && this.voice.playing ? (this.voice.panner ?? null) : null;
  }

  get isPlaying(): boolean {
    if (this.playlist) return this.playlist.playing;
    return this.voice !== null && this.voice.playing;
  }

  play(): void {
    if (!this.clip || !worldPlays(this._world)) return;
    this.stop();
    const path = normalizeAssetPath(this.clip);
    // An old audio event goes to the playlist runtime too, which refuses it with the migration's message.
    if (isPlaylistPath(path) || isAudioEventPath(path)) {
      this.playlist = playlists().play(path, {
        pitch: this.pitch, priority: clamp255(this.priority), bus: this.output || undefined, position: this.node.transform?.worldPosition,
        ...this.eventSpatialOptions(), ...this.distanceOverrides(), owner: this.node.name, trigger: "AudioSource", triggerNode: this.owner,
      }, worldKeyOf(this._world));
      this.applied = "";
      this.appliedPitch = this.pitch;
      if (this.playlist) {
        takeTap.sink?.play(this.playlist, path, this.takeEmitter(), takePlayOptions({ pitch: this.pitch, priority: clamp255(this.priority), bus: this.output || undefined }));
        // D20 (ADR 0343): this node's `onAudioMarker`, `onMusicBeat` and `onMusicBar` hear the playlist.
        this.playlist.attachSource(this, playlistHandleOf(this.playlist));
        this.applyPlaylist();
      }
      return;
    }
    this.ambisonicClip = isAmbisonicClip(path);
    if (this.ambisonicClip) this.warnAmbisonicIgnored(path);
    // F-22: a spatial source starts positioned. With its clip resident the core sends the PLAY inside `play`, and a voice
    // can't turn spatial on the core after its PLAY, so a position given only afterwards (`apply`) left every replay flat.
    const spatial = this.spatial && !this.ambisonicClip && this.node.transform !== null;
    // G9b: the voice starts at its volume and pitch. Set only afterwards (`apply`), the PLAY went out at gain 1 and the
    // volume a frame later, so a quiet source was heard at full scale for that frame (and dipped a level rule's target).
    // ADR 0342: the sample's trim, normalisation gain and (when `loop`) loop region, as every play of it.
    const req = clipRequest(path, this.loop, this.output);
    this.voice = playSampleVoice(path, Object.assign(req, {
      volume: this.volume * req.volume!, pitch: this.pitch,
      priority: clamp255(this.priority), world: worldKeyOf(this._world), owner: this.node.name, ...this.spatialOptions(),
      ...(spatial ? { attenuation: { minDistance: this.minDistance, maxDistance: this.maxDistance, rolloff: this.rolloff }, position: this.node.transform!.worldPosition } : null),
    }));
    this.applied = "";
    this.appliedM3 = "";
    this.appliedCurve.length = 0;
    this.playedAttenuation = spatial;
    if (this.voice) {
      takeTap.sink?.play(this.voice, path, spatial ? this.takeEmitter() : null, takePlayOptions({ volume: this.volume, pitch: this.pitch, priority: clamp255(this.priority), bus: this.output || undefined }));
      this.apply(path);
    }
  }

  /** ADR 0348: this node as a take's emitter (its world position each read). */
  private takeEmitter(): TakeEmitter {
    const node = this.node;
    return { key: node, name: node.name, position: () => node.transform?.worldPosition ?? null };
  }

  pause(): void {
    const sink = takeTap.sink; // ADR 0386: the take records what was paused
    if (sink) for (const p of [this.voice, this.playlist]) if (p) sink.pause(p);
    this.voice?.pause();
    this.playlist?.pause();
  }

  resume(): void {
    const sink = takeTap.sink;
    if (sink) for (const p of [this.voice, this.playlist]) if (p) sink.resume(p);
    this.voice?.resume();
    this.playlist?.resume();
  }

  /** Set one of the playing playlist's own parameters. Does nothing for a clip. */
  setParameter(name: string, value: number | string): void {
    this.playlist?.setParameter(name, value);
  }

  /** One of the playing playlist's parameters (else a global one); undefined for a clip or when not playing. */
  getParameter(name: string): number | string | undefined {
    return this.playlist?.getParameter(name);
  }

  /**
   * Key-off: the playing playlist's held loops, or a looping sample's held loop (ADR 0342, its sidecar's first loop),
   * end by their exit settings. Does nothing for a clip without a held loop.
   */
  release(): void {
    const sink = takeTap.sink;
    if (sink && this.playlist) sink.release(this.playlist);
    this.playlist?.release();
    if (this.voice) releaseSampleVoice(this.voice);
  }

  /**
   * Moves the playing sound to `seconds` (clamped to 0 and the end; a loop wraps). A 5 ms fade-out and fade-in cover
   * the jump, and a streamed sound drops everything decoded before it, so nothing of the old position is heard after
   * the fade. Does nothing when not playing, or on the Babylon fallback (the core backend only).
   * @internal Not public yet: §1 of the 0157 design declares no seek; making it public needs a decision record
   * (owner review, entry 21).
   */
  seek(seconds: number): void {
    this.voice?.seek(seconds);
  }

  stop(): void {
    const sink = takeTap.sink;
    if (sink) for (const p of [this.voice, this.playlist]) if (p) sink.stop(p, p === this.playlist ? 0.12 : 0);
    this.voice?.stop();
    this.voice = null;
    this.playlist?.stop();
    this.playlist = null;
  }

  /** @internal Each frame (the audio system): volume, pitch and, for spatial sources, position and falloff. */
  _sync(): void {
    if (this.playlist) return this.applyPlaylist();
    if (!this.voice) return;
    this.apply(normalizeAssetPath(this.clip));
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

  /**
   * ADR 0162 D4: the source's §1.2 options a playlist it plays inherits where the playlist leaves them unset. Not
   * `dopplerLevel`: Doppler is authored on the playlist (§2.5 default 0, as in Wwise and FMOD), so a source's default 1
   * doesn't override it (coordinator ruling, build log).
   */
  private eventSpatialOptions(): Pick<EventOptions, "occlusion" | "reverbSend" | "reverbSendCurve"> {
    const { occlusion, reverbSend, reverbSendCurve } = this.spatialOptions();
    return { occlusion, reverbSend, reverbSendCurve };
  }

  /**
   * ADR 0347: for a playlist, `minDistance` and `maxDistance` are overrides that stretch its attenuation curves. A field
   * left at its default (1 and 100) is no override, so the playlist's own distances apply.
   */
  private distanceOverrides(): { minDistance?: number; maxDistance?: number } {
    const out: { minDistance?: number; maxDistance?: number } = {};
    if (this.minDistance !== 1 && Number.isFinite(this.minDistance)) out.minDistance = Math.max(0, this.minDistance);
    if (this.maxDistance !== 100 && Number.isFinite(this.maxDistance)) out.maxDistance = this.maxDistance;
    return out;
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

  /** ADR 0343: a playlist follows `volume` (its fade gain), `pitch` and, when spatial, the node. */
  private applyPlaylist(): void {
    const instance = this.playlist!;
    const signature = `${this.volume}`;
    if (signature !== this.applied) {
      this.applied = signature;
      instance.fade(Math.min(4, Math.max(0, this.volume)), 0);
    }
    if (this.pitch !== this.appliedPitch) {
      this.appliedPitch = this.pitch;
      instance.setPitch(this.pitch);
    }
    if (instance.spatial && this.node.transform) instance.position = this.node.transform.worldPosition;
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
      if (!first) voice.setSpatialOptions(this.spatialOptions());
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
