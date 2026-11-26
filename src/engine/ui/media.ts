/**
 * Video and audio elements' playback (ADR 0426): what `UIVideo` and `UIAudio` share. Not public API itself; the
 * components expose it.
 *
 * - **A media source** is anything with the `HTMLMediaElement` members the UI uses (`UIMediaSource`): an
 *   `HTMLVideoElement` a video makes from its `src` in a browser (or one a game hands it), or, for audio, an adapter over
 *   an engine `AudioSource` the element's node owns (the audio plugin's; `AudioSourceMedia`). Headless Worlds make none
 *   by themselves; a source handed to `media` works anywhere.
 * - **The player** (`UIMediaPlayer`) keeps the element's fields (`loop`, `muted`, `volume`, `playbackRate`, `src`) on its
 *   source each frame, starts `autoplay` once, forwards the source's media events (`play`, `pause`, `ended`,
 *   `timeupdate`, `volumechange`…) to the element's listeners, and pauses when the element goes (as a removed media
 *   element pauses on the web).
 * - `engine.UIMedia`, a late-update system, ticks every active media element of a World on its unscaled clock.
 */
import type { Component } from "../core/Component";
import { getComponentClass } from "../core/registry";
import { defineBuiltinSystem } from "../core/systems";
import type { World } from "../core/World";
import { Assets } from "../scene/Assets";
import type { GameObject } from "../scene/GameObject";

/** The `HTMLMediaElement` members a UI media element uses (an `HTMLVideoElement` or `HTMLAudioElement` has them all). */
export interface UIMediaSource {
  play(): Promise<void> | void;
  pause(): void;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  volume: number;
  muted: boolean;
  loop: boolean;
  playbackRate: number;
  readonly readyState?: number;
  readonly seeking?: boolean;
  /** Video: the frame's size in pixels (0 before its metadata). */
  readonly videoWidth?: number;
  readonly videoHeight?: number;
  src?: string;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/** The media events an element forwards from its source. */
export const UI_MEDIA_EVENTS = [
  "play", "playing", "pause", "ended", "timeupdate", "durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough",
  "volumechange", "ratechange", "seeking", "seeked", "waiting", "progress", "emptied", "error",
] as const;
export type UIMediaEventType = (typeof UI_MEDIA_EVENTS)[number];

/** What an element's media listeners get. */
export interface UIMediaEvent {
  readonly type: UIMediaEventType;
  /** The element's component. */
  readonly target: Component;
}

/** The element fields the player keeps on its source. */
export interface UIMediaFields {
  readonly src: string;
  readonly autoplay: boolean;
  readonly loop: boolean;
  readonly muted: boolean;
  readonly volume: number;
  readonly playbackRate: number;
}

/** A `src` as a URL: `asset:` paths through `Assets.url`, anything else as written. */
export function mediaUrl(src: string): string {
  const s = src.trim();
  if (!s) return "";
  if (s.startsWith("asset:")) {
    try {
      return Assets.url(s.slice(6));
    } catch {
      return "";
    }
  }
  return s;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[myco] ${message}`);
}

/** A small event target for sources the engine makes itself. */
class Listeners {
  private readonly map = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(type: string, fn: (e: unknown) => void): void {
    let set = this.map.get(type);
    if (!set) this.map.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.map.get(type)?.delete(fn);
  }
  protected emit(type: string): void {
    for (const fn of [...(this.map.get(type) ?? [])]) fn({ type, target: this });
  }
}

/** What `AudioSourceMedia` uses of the audio plugin's `AudioSource` (reached by its registered name, so the UI core doesn't import the plugin). */
interface AudioSourceLike {
  clip: string;
  volume: number;
  loop: boolean;
  pitch: number;
  playOnAwake: boolean;
  readonly isPlaying: boolean;
  play(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  seek(seconds: number): void;
}

/**
 * ADR 0426: an `<audio>` element's source: the media API over an engine `AudioSource` its node owns (made on first
 * play, `playOnAwake` off). Time is kept here on the element's clock (unscaled seconds × `playbackRate`), the end
 * noticed when the playing sound stops by itself. `duration` is NaN (an engine sound doesn't report its length).
 * `playbackRate` is the source's `pitch` (speed and pitch together); `muted` plays at volume 0.
 */
export class AudioSourceMedia extends Listeners implements UIMediaSource {
  private time = 0;
  readonly duration = NaN;
  paused = true;
  ended = false;
  private _volume = 1;
  private _muted = false;
  loop = false;
  private _rate = 1;
  src = "";
  private audio: AudioSourceLike | null = null;
  private started = false;
  private heard = false;
  private sinceUpdate = 0;

  constructor(private readonly node: GameObject) {
    super();
  }

  get readyState(): number {
    return this.src ? 4 : 0;
  }

  /** Seconds played; set it to seek (a playing sound jumps there on the core audio backend). */
  get currentTime(): number {
    return this.time;
  }

  set currentTime(seconds: number) {
    this.time = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    this.emit("seeking");
    if (this.started) this.audio?.seek(this.time);
    this.emit("seeked");
    this.emit("timeupdate");
  }

  get volume(): number {
    return this._volume;
  }

  set volume(v: number) {
    const x = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
    if (x === this._volume) return;
    this._volume = x;
    this.emit("volumechange");
  }

  get muted(): boolean {
    return this._muted;
  }

  set muted(v: boolean) {
    if (!!v === this._muted) return;
    this._muted = !!v;
    this.emit("volumechange");
  }

  get playbackRate(): number {
    return this._rate;
  }

  set playbackRate(v: number) {
    const x = Number.isFinite(v) && v > 0 ? v : 1;
    if (x === this._rate) return;
    this._rate = x;
    this.emit("ratechange");
  }

  play(): void {
    if (!this.paused) return;
    if (this.ended) {
      this.ended = false;
      this.time = 0;
      this.started = false;
    }
    this.paused = false;
    const a = this.source();
    if (a) {
      this.applyTo(a);
      if (this.started) a.resume();
      else {
        a.play();
        if (this.time > 0) a.seek(this.time);
        this.started = true;
        this.heard = false;
      }
    }
    this.emit("play");
    this.emit("playing");
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.audio?.pause();
    this.emit("pause");
  }

  /** @internal Each frame: the fields on the sound, the clock, and its end. */
  _tick(dt: number): void {
    const a = this.audio;
    if (a) this.applyTo(a);
    if (this.paused) return;
    this.time += dt * this._rate;
    if (a?.isPlaying) this.heard = true;
    else if (a && this.heard && !this.loop) {
      // It stopped by itself: the end.
      this.paused = true;
      this.ended = true;
      this.started = false;
      this.emit("timeupdate");
      this.emit("pause");
      this.emit("ended");
      return;
    }
    // Browsers fire timeupdate every 15–250 ms while playing.
    this.sinceUpdate += dt;
    if (this.sinceUpdate >= 0.25) {
      this.sinceUpdate = 0;
      this.emit("timeupdate");
    }
  }

  /** @internal The element went: the sound stops. */
  _release(): void {
    this.audio?.stop();
    this.paused = true;
    this.started = false;
  }

  private applyTo(a: AudioSourceLike): void {
    const clip = this.src ? (this.src.startsWith("asset:") ? this.src : `asset:${this.src.replace(/^\//, "")}`) : "";
    if (a.clip !== clip) a.clip = clip;
    const volume = this._muted ? 0 : this._volume;
    if (a.volume !== volume) a.volume = volume;
    if (a.loop !== this.loop) a.loop = this.loop;
    if (a.pitch !== this._rate) a.pitch = this._rate;
  }

  private source(): AudioSourceLike | null {
    if (this.audio) return this.audio;
    const type = getComponentClass("engine.AudioSource");
    if (!type) {
      warnOnce("an <audio> element plays through the audio plugin's AudioSource, and the audio plugin isn't on: it keeps time but makes no sound.");
      return null;
    }
    const node = this.node as unknown as { getComponent(t: unknown): unknown; addComponent(t: unknown, init?: object): unknown };
    this.audio = (node.getComponent(type) ?? node.addComponent(type, { playOnAwake: false })) as AudioSourceLike;
    this.audio.playOnAwake = false;
    return this.audio;
  }
}

/** The element a player belongs to: its component, node and fields. */
interface MediaOwner extends UIMediaFields {
  readonly node: GameObject;
  readonly _world: World;
}

/**
 * One media element's playback: its source (handed in, or made from `src`), the fields kept on it, autoplay, and its
 * events forwarded to the element's listeners.
 */
export class UIMediaPlayer {
  private source: UIMediaSource | null = null;
  /** True when the player made the source (so it owns its `src`). */
  private owned = false;
  private appliedSrc: string | null = null;
  private autoplayed = false;
  private readonly listeners = new Map<string, Set<(e: UIMediaEvent) => void>>();
  private readonly forward = new Map<string, (e: unknown) => void>();

  constructor(
    private readonly owner: MediaOwner & Component,
    private readonly make: (owner: MediaOwner & Component) => UIMediaSource | null,
  ) {}

  /** The source, made from `src` the first time it's asked for when none was handed in. */
  get media(): UIMediaSource | null {
    if (!this.source) {
      const made = this.make(this.owner);
      if (made) {
        this.attach(made);
        this.owned = true;
      }
    }
    return this.source;
  }

  set media(source: UIMediaSource | null) {
    if (source === this.source) return;
    this.detach();
    if (source) this.attach(source);
    this.owned = false;
  }

  /** The source without making one. */
  get current(): UIMediaSource | null {
    return this.source;
  }

  on(type: UIMediaEventType, listener: (e: UIMediaEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  off(type: UIMediaEventType, listener: (e: UIMediaEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  play(): Promise<void> {
    const m = this.media;
    if (!m) return Promise.resolve();
    this.sync(m);
    try {
      const r = m.play();
      return r instanceof Promise ? r.catch((err: unknown) => warnOnce(`a media element couldn't play: ${(err as Error)?.message ?? err}`)) : Promise.resolve();
    } catch (err) {
      warnOnce(`a media element couldn't play: ${(err as Error)?.message ?? err}`);
      return Promise.resolve();
    }
  }

  pause(): void {
    this.source?.pause();
  }

  /** The fields onto the source now (a renderer's property write), rather than at the next frame. */
  refresh(): void {
    if (this.source) this.sync(this.source);
  }

  /** Each frame: fields onto the source, autoplay once, the engine's own sources ticked. */
  tick(dt: number): void {
    const m = this.owner.autoplay || this.source ? this.media : null;
    if (!m) return;
    this.sync(m);
    if (this.owner.autoplay && !this.autoplayed) {
      this.autoplayed = true;
      void this.play();
    }
    if (m instanceof AudioSourceMedia) m._tick(dt);
  }

  /** The element was disabled or removed: pause, as a media element taken out of the document pauses. */
  stop(): void {
    const m = this.source;
    if (!m) return;
    if (m instanceof AudioSourceMedia) m._release();
    else if (!m.paused) m.pause();
    this.autoplayed = false;
  }

  /** The element is gone: let go of the source (one it made stops loading). */
  dispose(): void {
    this.stop();
    const m = this.source;
    this.detach();
    if (m && this.owned && typeof (m as { removeAttribute?: unknown }).removeAttribute === "function") {
      (m as unknown as HTMLMediaElement).removeAttribute("src");
      (m as unknown as HTMLMediaElement).load?.();
    }
  }

  private sync(m: UIMediaSource): void {
    const o = this.owner;
    if (this.owned) {
      const url = m instanceof AudioSourceMedia ? o.src : mediaUrl(o.src);
      if (url !== this.appliedSrc) {
        this.appliedSrc = url;
        m.src = url;
      }
    }
    if (m.loop !== !!o.loop) m.loop = !!o.loop;
    if (m.muted !== !!o.muted) m.muted = !!o.muted;
    const volume = Math.min(1, Math.max(0, Number.isFinite(o.volume) ? o.volume : 1));
    if (m.volume !== volume) m.volume = volume;
    const rate = Number.isFinite(o.playbackRate) && o.playbackRate > 0 ? o.playbackRate : 1;
    if (m.playbackRate !== rate) m.playbackRate = rate;
  }

  private attach(source: UIMediaSource): void {
    this.source = source;
    this.appliedSrc = null;
    for (const type of UI_MEDIA_EVENTS) {
      const fn = () => {
        // A change made on the source itself (a script, a browser's own controls) is the element's now: its fields follow.
        const o = this.owner as unknown as Record<string, unknown>;
        if (type === "volumechange") {
          o.volume = source.volume;
          o.muted = source.muted;
        } else if (type === "ratechange") o.playbackRate = source.playbackRate;
        const set = this.listeners.get(type);
        if (!set?.size) return;
        const e: UIMediaEvent = { type, target: this.owner };
        for (const l of [...set]) {
          try {
            l(e);
          } catch (err) {
            console.error(`[myco] a media "${type}" listener threw:`, err);
          }
        }
      };
      this.forward.set(type, fn);
      source.addEventListener(type, fn);
    }
  }

  private detach(): void {
    const s = this.source;
    if (!s) return;
    for (const [type, fn] of this.forward) s.removeEventListener(type, fn);
    this.forward.clear();
    this.source = null;
  }
}

// --- Ticking ---------------------------------------------------------------------------------------

const players = new WeakMap<World, Set<UIMediaPlayer>>();

/** @internal An active media element's player ticks with its World. */
export function _addMediaPlayer(world: World, player: UIMediaPlayer): void {
  let set = players.get(world);
  if (!set) players.set(world, (set = new Set()));
  set.add(player);
}

/** @internal */
export function _removeMediaPlayer(world: World, player: UIMediaPlayer): void {
  players.get(world)?.delete(player);
}

defineBuiltinSystem({
  name: "engine.UIMedia",
  phase: "lateUpdate",
  // After the UI syncs: a Svelte binding's write this frame reaches the source this frame.
  after: ["engine.UIDocumentSync", "engine.UIHostSync"],
  run: (w) => {
    const set = players.get(w);
    if (!set?.size) return;
    const dt = w.time.unscaledDeltaTime;
    for (const p of [...set]) p.tick(dt);
  },
});

/** A video element's source in a browser: an `HTMLVideoElement` (inline, never shown itself); none headless. */
export function makeVideoSource(): UIMediaSource | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const v = document.createElement("video");
  v.playsInline = true;
  v.preload = "auto";
  // Drawn into the UI's canvas, which a cross-origin frame would taint (and its texture upload fail).
  v.crossOrigin = "anonymous";
  return v as unknown as UIMediaSource;
}
