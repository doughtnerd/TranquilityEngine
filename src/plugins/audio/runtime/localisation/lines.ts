/**
 * Voice-over lines at runtime (ADR 0354 §5, §7; 0357 §1–§3; 0355 §5): `Audio.line(key)`, `Audio.onLine`, and the line
 * handle `Audio.say` hands out too.
 *
 * - **Playing.** A line plays through its table's `template` playlist (a playlist with a programmer `line` entry, the key
 *   given as `EventOptions.line`), else an implicit one-shot Clip of one programmer line entry on the table's `output`
 *   (default Voice when the mix has it, else Master), positioned when the play gives a position or a node. The line
 *   entry resolves the key's file in the current audio language's chain as it is picked.
 * - **Missing everywhere.** With `localisation.missing: "subtitleOnly"` (default) the line still runs for the reading
 *   time of its subtitle (0357 §3: `max(minDisplay, characters / readingSpeed)` in the subtitle language), firing its
 *   start and end; with `"silent"` it is refused with reason `missingLanguage`. An unknown key gives an inert handle with
 *   reason `unknownLine` and one warning.
 * - **Subtitles** (0357 §1): the line's string key (`textKey`, else its key; null: never subtitled) in its table's string
 *   table, in the subtitle language through its chain; `handle.text` is read live, so it follows a language change.
 * - **Events.** `Audio.onLine` hears `start`, `end` (with the reason) and `marker` (a Cue marker of the heard file).
 * - **Lip-sync** (§7): `viseme()` reads the heard file's sidecar `lipsync` keys at the heard time.
 */
import { World } from "../../../../engine/core/World";
import type { Vec3Like } from "../../../../engine/core/math";
import { mixer } from "../../../../engine/audio/mixer";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { parsePlaylist } from "../../../../engine/audio/playlist/format";
import { PLAYLIST_FORMAT, type PlaylistAsset } from "../../../../engine/audio/playlist/types";
import type { MusicEvent, MusicHandle, MusicKind } from "../../../../engine/audio/musicTypes";
import { subtitleKeyOf } from "../../../../engine/audio/localisation/lines/format";
import { lineFile, type LineLocation } from "../../../../engine/audio/localisation/lines/resolve";
import { readingTime } from "../../../../engine/localisation/subtitles";
import { Assets } from "../../../../engine/scene/Assets";
import type { AudioMarkerEvent, AudioMarkerType, AudioPanner, AudioPlaylistHandle, AudioReason } from "../backend";
import { clipDuration, samplePass, samplePlan, sampleEdits } from "../clipResolver";
import { warnOnce } from "../core/handle";
import { onAudioSessionReleased } from "../audioSession";
import { worldKeyOf, worldPlays } from "../AudioSource";
import { takePlayOptions, takeTap, type TakeEmitter } from "../capture/takeTap";
import { playlistHost, type HostedRuntime } from "../playlists/host";
import { playlistHandleOf } from "../playlists/handle";
import { STOP_FADE_SECONDS, type PlaylistInstance, type PlaylistOptions } from "../playlists/instance";
import type { EventOptions } from "../playlists/options";
import { playlists } from "../playlists/playlistSystem";
import { audioChain, audioLanguage, audioLocalisation, effectiveSubtitleLanguage, noteMissingLanguage, readingRuleOf, subtitleText } from "./languageState";
import { lineLocation } from "./lineRegistry";
import { visemeAt, type AudioViseme } from "./viseme";

/** Options for `Audio.line` (ADR 0354 §5): the play options, plus a node it plays from and follows. */
export interface LineOptions extends EventOptions {
  /** Plays from and follows this node's world position (a flat template ignores it). */
  node?: GameObject;
}

/** How a line ended: played out, stopped by the game, cut off by a more important line, or never played. */
export type LineEnd = "ended" | "stopped" | "interrupted" | "refused";

/** ADR 0354 §5, 0355 §5: a voice-over line's handle (`Audio.line`, `Audio.say`). */
export interface AudioLineHandle extends AudioPlaylistHandle {
  readonly key: string;
  readonly speaker: string | null;
  /** The language actually heard (after fallback); null when nothing plays (subtitle-only, refused). */
  readonly language: string | null;
  /** The subtitle in the subtitle language, read live; null without one. */
  readonly text: string | null;
  /** Seconds of the heard file, or the subtitle's reading time for a subtitle-only line. */
  readonly duration: number;
  readonly finished: Promise<LineEnd>;
  /** ADR 0355 §5: waiting in its speaker channel's queue, playing, or over. */
  readonly state: "queued" | "playing" | "ended";
  /** ADR 0355 §5: the dialogue event that said it; null for `Audio.line`. */
  readonly event: string | null;
  /** ADR 0355 §5: the event's path that matched; null for `Audio.line`. */
  readonly path: readonly string[] | null;
  /** The mouth shape at the heard time (ADR 0354 §7); null without lip-sync data or while nothing plays. */
  viseme(): AudioViseme | null;
}

/** `Audio.onLine`'s event (ADR 0354 §5, 0357 §1, 0355 §5). */
export interface AudioLineEvent {
  phase: "start" | "end" | "marker";
  key: string;
  speaker: string | null;
  language: string | null;
  text: string | null;
  /** The subtitle's string key, so a display can re-resolve it on a language change; null when never subtitled. */
  textKey: string | null;
  duration: number;
  /** Heard time (`Audio.time`'s base). */
  time: number;
  /** Phase `marker`: a Cue marker of the line's file. */
  marker?: AudioMarkerEvent;
  /** Phase `end`. */
  reason?: "ended" | "stopped" | "interrupted";
  /** The dialogue event that said it (absent for `Audio.line`). */
  event?: string;
}

const listeners = new Set<(e: AudioLineEvent) => void>();

/** `Audio.onLine(fn)`: returns the unsubscribe. */
export function onLine(fn: (e: AudioLineEvent) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit(e: AudioLineEvent): void {
  for (const fn of [...listeners]) {
    try { fn(e); } catch (err) { console.error("[myco] an Audio.onLine listener threw:", err); }
  }
}

const NO_MUSIC = (): (() => void) => () => {};

/** One line, from the call (or a say's queueing) to its end. */
export class LineHandle implements AudioLineHandle {
  readonly finished: Promise<LineEnd>;
  private settle!: (e: LineEnd) => void;
  key: string;
  speaker: string | null = null;
  readonly event: string | null;
  path: readonly string[] | null = null;
  state: "queued" | "playing" | "ended" = "queued";
  /** ADR 0355 §4: the priority it speaks with, and its channel (say only). */
  priority = 50;
  channel: string | null = null;
  /** Called once when it ends (the dialogue system frees its channel). */
  onEnd: ((h: LineHandle, how: LineEnd) => void) | null = null;
  private refusedWith: AudioReason | null = null;
  private instance: PlaylistInstance | null = null;
  private h: AudioPlaylistHandle | null = null;
  private heard: { path: string; language: string } | null = null;
  private textKey: string | null = null;
  private subtitleOnly = false;
  private startTime = 0;
  private endTime = Infinity;
  private seconds = 0;
  private node: GameObject | null = null;
  private stopping = false;
  private interrupting = false;
  private markerOff: (() => void) | null = null;

  constructor(key: string, event: string | null = null) {
    this.key = key;
    this.event = event;
    this.finished = new Promise((resolve) => { this.settle = resolve; });
  }

  // --- AudioLineHandle -------------------------------------------------------------------------------------------------

  get playing(): boolean { return this.state !== "ended"; }
  get reason(): AudioReason | null { return this.refusedWith ?? this.instance?.reason ?? null; }
  get language(): string | null { return this.heard?.language ?? null; }
  get duration(): number { return this.seconds; }
  get text(): string | null {
    return this.textKey === null ? null : subtitleText(this.textKey);
  }
  get position(): Vec3Like | null { return this.h?.position ?? null; }
  set position(p: Vec3Like | null) { if (this.h) this.h.position = p; }
  get panner(): AudioPanner | null { return this.h?.panner ?? null; }
  get occlusion(): number { return this.h?.occlusion ?? 1; }
  get music(): MusicHandle | undefined { return this.h?.music; }

  stop(fadeSeconds?: number): void {
    if (this.state === "ended") return;
    if (this.state === "queued") { this.end("stopped"); return; }
    const fade = fadeSeconds === undefined || !Number.isFinite(fadeSeconds) ? STOP_FADE_SECONDS : Math.max(0, fadeSeconds);
    takeTap.sink?.stop(this, fade);
    this.stopping = true;
    this.h?.stop(fade);
    this.end("stopped");
  }
  fade(to: number, seconds: number): void { this.h?.fade(to, seconds); }
  setParameter(name: string, value: number | string): void { this.h?.setParameter(name, value); }
  getParameter(name: string): number | string | undefined { return this.h?.getParameter(name); }
  release(): void { if (this.h) { takeTap.sink?.release(this); this.h.release(); } }
  onMarker(type: AudioMarkerType, fn: (e: AudioMarkerEvent) => void): () => void { return this.h ? this.h.onMarker(type, fn) : () => {}; }
  onMusic(kind: MusicKind, fn: (e: MusicEvent) => void): () => void { return this.h ? this.h.onMusic(kind, fn) : NO_MUSIC(); }
  trigger(name: string): boolean { return this.h?.trigger(name) ?? false; }
  pause(): void { this.h?.pause(); }
  resume(): void { this.h?.resume(); }
  get paused(): boolean { return this.h?.paused ?? false; }

  viseme(): AudioViseme | null {
    if (this.state !== "playing" || !this.heard) return null;
    const from = samplePlan(this.heard.path).trim?.[0] ?? 0;
    return visemeAt(sampleEdits(this.heard.path)?.lipsync, from + playlistHost().clock() - this.startTime);
  }

  // --- the runtime's ----------------------------------------------------------------------------------------------------

  /** @internal Takes the line row's facts (speaker, subtitle key, string table). */
  bind(loc: LineLocation): void {
    this.key = loc.line.key;
    this.speaker = loc.line.speaker;
    this.textKey = subtitleKeyOf(loc.line);
  }

  /** @internal Never played: `finished` resolves "refused" with `reason`. */
  refuse(reason: AudioReason | null): this {
    this.refusedWith = reason;
    this.end("refused");
    return this;
  }

  /** @internal Cut off by a more important line (ADR 0355 §4): fades out over `fade` seconds and ends "interrupted". */
  interrupt(fade: number): void {
    if (this.state !== "playing") return;
    takeTap.sink?.stop(this, fade);
    this.interrupting = true;
    this.h?.stop(fade);
    this.end("interrupted");
  }

  /** The event a listener hears now. */
  private eventOf(phase: AudioLineEvent["phase"], time: number): AudioLineEvent {
    const e: AudioLineEvent = { phase, key: this.key, speaker: this.speaker, language: this.language, text: this.text, textKey: this.textKey, duration: this.seconds, time };
    if (this.event !== null) e.event = this.event;
    return e;
  }

  /** @internal Starts as a subtitle-only line for its reading time. */
  startSubtitleOnly(now: number): void {
    this.subtitleOnly = true;
    this.seconds = readingTime(this.text ?? "", readingRuleOf(effectiveSubtitleLanguage()));
    this.begin(now);
    this.endTime = now + this.seconds;
  }

  /** @internal Starts playing `instance` (its line entry heard `file`). */
  startPlaying(instance: PlaylistInstance, file: { path: string; language: string }, node: GameObject | null): void {
    this.instance = instance;
    this.h = playlistHandleOf(instance);
    this.heard = instance.heardLine ? { path: instance.heardLine.path, language: instance.heardLine.language } : file;
    this.node = node;
    const pass = samplePass(this.heard.path);
    this.seconds = pass.length ?? clipDuration(this.heard.path) ?? 0;
    this.markerOff = this.h.onMarker("cue", (m) => emit({ ...this.eventOf("marker", m.time), marker: m }));
    this.begin(instance.startOf(null));
  }

  private begin(now: number): void {
    this.state = "playing";
    this.startTime = now;
    active.add(this);
    playlistHost().host(runtime);
    emit(this.eventOf("start", now));
  }

  /** @internal Once per frame while playing: follows its node; ends once its sound (or reading time) is over. */
  update(now: number): void {
    if (this.state !== "playing") return;
    if (this.node && this.h) {
      const p = this.node.isValid ? this.node.transform?.worldPosition : undefined;
      if (p) this.h.position = p;
    }
    if (this.subtitleOnly ? now >= this.endTime : !(this.instance?.playing ?? false)) this.end("ended");
  }

  private end(how: LineEnd): void {
    if (this.state === "ended") return;
    const wasPlaying = this.state === "playing";
    this.state = "ended";
    active.delete(this);
    this.markerOff?.();
    this.markerOff = null;
    if (wasPlaying) {
      const reason = this.interrupting ? "interrupted" : this.stopping ? "stopped" : how === "refused" ? "stopped" : how;
      emit({ ...this.eventOf("end", playlistHost().clock()), reason });
    }
    this.settle(how);
    const cb = this.onEnd;
    this.onEnd = null;
    cb?.(this, how);
  }
}

const active = new Set<LineHandle>();

const runtime: HostedRuntime = {
  update() {
    if (active.size === 0) return;
    const now = playlistHost().clock();
    for (const h of [...active]) h.update(now);
  },
  onGlobal() {},
  resend() {},
  stopAll() { for (const h of [...active]) h.stop(0); },
  release() { active.clear(); },
  forgetWorld() {},
  sweep() {},
};

onAudioSessionReleased(() => active.clear());

// --- playing a line ---------------------------------------------------------------------------------------------------------

const implicitClips = new Map<string, PlaylistAsset>();

/** A line's implicit playlist (no template): a one-shot Clip of one programmer line entry on `output`, spatial when placed. */
function implicitClip(output: string | null, spatial: boolean): PlaylistAsset {
  const key = `${output ?? ""}\u0000${spatial}`;
  let p = implicitClips.get(key);
  if (!p) {
    p = parsePlaylist({ format: PLAYLIST_FORMAT, type: "clip", entries: [{ line: null }], ...(output !== null ? { output } : {}), ...(spatial ? { spatial: {} } : {}) }, "line").playlist;
    implicitClips.set(key, p);
  }
  return p;
}

/** A table's output (0354 §5): its own, else Voice when the mix has it, else Master (null). */
function outputOf(loc: LineLocation): string | null {
  return loc.table.output ?? (mixer.busNames.includes("Voice") ? "Voice" : null);
}

/** The play options a line's playlist gets: the caller's (less `node`), its position (or the node's), and the key. */
function playOptions(key: string, o: LineOptions, trigger: string): { options: PlaylistOptions; node: GameObject | null } {
  const { node, ...rest } = o;
  const n = node && typeof node === "object" && node.isValid ? node : null;
  const position = rest.position ?? n?.transform?.worldPosition;
  // ADR 0435: the capture's "Why it played" names the request and the line's node.
  return { options: { ...rest, ...(position ? { position: { x: position.x, y: position.y, z: position.z } } : {}), line: key, trigger, triggerNode: n }, node: n };
}

/** The take's emitter for a placed line: its node, or where it was placed. */
function emitterOf(handle: LineHandle, key: string, node: GameObject | null, position: Vec3Like | undefined): TakeEmitter | null {
  if (node) return { key: node, name: node.name, position: () => node.transform?.worldPosition ?? null };
  if (!position) return null;
  return { key: handle, name: key, position: () => handle.position };
}

/**
 * Plays the line at `loc` into `handle` now (ADR 0354 §5). The handle ends refused when nothing can play: no World plays
 * sound, its template is refused, or (`missing: "silent"`) no language of the chain has its file. `trigger` is the request
 * a capture's "Why it played" names (ADR 0435).
 */
export function startLine(handle: LineHandle, loc: LineLocation, options: LineOptions, trigger = "Audio.line"): LineHandle {
  handle.bind(loc);
  const key = loc.line.key;
  const now = playlistHost().clock();
  const file = lineFile(loc.table, loc.line, audioChain(), audioLocalisation().roots, (p) => Assets.has(p));
  const { options: play, node } = playOptions(key, options, trigger);
  const record = (language: string | null): void => {
    if (takeTap.sink && handle.event === null) takeTap.sink.line(handle, key, language, emitterOf(handle, key, node, play.position), takePlayOptions(options));
  };
  if (!file) {
    noteMissingLanguage(key, audioLanguage());
    if (audioLocalisation().missing === "silent") { record(null); return handle.refuse("missingLanguage"); }
    record(null);
    handle.startSubtitleOnly(now);
    return handle;
  }
  if (!worldPlays(World.active)) return handle.refuse(null);
  const world = worldKeyOf(World.active);
  const template = loc.table.template;
  const instance = template !== null
    ? playlists().play(template, play, world)
    : playlists().play(`${loc.path}#${key}`, play, world, undefined, implicitClip(outputOf(loc), play.position !== undefined));
  if (!instance || !instance.playing) {
    if (!instance && template !== null) warnOnce(`line:template:${template}`, `the line table "${loc.path}"'s template "${template}" didn't play; its lines play nothing.`);
    record(null);
    return handle.refuse(instance?.reason ?? "failed");
  }
  record(instance.heardLine?.language ?? file.language);
  handle.startPlaying(instance, file, node);
  return handle;
}

/** `Audio.line(key, options)`: plays now (no queueing); an unknown key gives an inert handle with reason `unknownLine`. */
export function playLine(key: string, options: LineOptions = {}): AudioLineHandle {
  const handle = new LineHandle(String(key));
  const loc = lineLocation(String(key));
  if (!loc) {
    warnOnce(`line:unknown:${String(key)}`, `Audio.line: no line table has the line "${String(key)}"; nothing plays (reason "unknownLine").`);
    return handle.refuse("unknownLine");
  }
  return startLine(handle, loc, options);
}
