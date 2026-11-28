/**
 * Sound captions (ADR 0357 §4): `Audio.onCaption`. A playlist with a `caption` (`{ key, minGap }`) reports each instance
 * that starts sounding (`start`: a voice of it is audible, so not when refused, virtual or culled by voice limits) and
 * stops (`end`). The same caption isn't repeated within `minGap` seconds of its last start. The text is the key in the
 * captions string table (`audio.json` `localisation.captions`) in the subtitle language, read live.
 */
import type { Vec3Like } from "../../../../engine/core/math";
import type { PlaylistCaption } from "../../../../engine/audio/playlist/types";
import { listenerPoseIn } from "../AudioListener";
import { onAudioSessionReleased } from "../audioSession";
import { playlistHost, type HostedRuntime } from "../playlists/host";
import type { PlaylistInstance } from "../playlists/instance";
import { subtitleText } from "./languageState";

/** `Audio.onCaption`'s event. */
export interface AudioCaptionEvent {
  phase: "start" | "end";
  /** The playlist's project path. */
  playlist: string;
  key: string;
  /** In the subtitle language; null when the captions table has no text for the key. */
  text: string | null;
  /** Heard time (`Audio.time`'s base). */
  time: number;
  /** Seconds; null for a looping or open-ended instance. */
  duration: number | null;
  /** -1..1 relative to the listener for a positioned instance, else null. */
  pan: number | null;
}

interface Watched {
  readonly instance: PlaylistInstance;
  readonly caption: PlaylistCaption;
  started: boolean;
}

const watched: Watched[] = [];
const lastStart = new Map<string, number>();
const listeners = new Set<(e: AudioCaptionEvent) => void>();

/** The caption's text in the subtitle language (null when the table has none). */
export function captionText(key: string): string | null {
  // String keys are unique across the project, so `Locale` finds the captions table's (`localisation.captions`) keys.
  return subtitleText(key);
}

/** `Audio.onCaption(fn)`: returns the unsubscribe. */
export function onCaption(fn: (e: AudioCaptionEvent) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit(e: AudioCaptionEvent): void {
  for (const fn of [...listeners]) {
    try { fn(e); } catch (err) { console.error("[myco] an Audio.onCaption listener threw:", err); }
  }
}

/** Whether a voice of the instance is audible now (playing, no reason: not virtual, stolen, muted or waiting). */
function sounding(i: PlaylistInstance): boolean {
  return i.voices.some((v) => !v.leaving && v.voice.playing && v.voice.reason === null);
}

/** Seconds until the instance's voices end; null when it loops, plays until stopped or a length is unknown. */
function durationOf(i: PlaylistInstance, now: number): number | null {
  if (i.untilStopped) return null;
  let end = now;
  for (const v of i.voices) {
    if (v.leaving || !v.voice.playing) continue;
    if (v.loop?.looping || v.length === null) return null;
    end = Math.max(end, (v.start ?? now) + v.length);
  }
  return end - now;
}

/** The listener of the World of key `world` (ADR 0462): its position and its right-hand direction; null without one. */
function listener(world: number): { position: Vec3Like; right: Vec3Like } | null {
  const w = playlistHost().worldOf(world);
  const pose = w ? listenerPoseIn(w) : null;
  if (!pose) return null;
  const { position, forward: f, up: u } = pose;
  return { position, right: { x: u.y * f.z - u.z * f.y, y: u.z * f.x - u.x * f.z, z: u.x * f.y - u.y * f.x } };
}

/** -1..1: where a positioned instance is left to right of the listener; null for a flat one. */
function panOf(i: PlaylistInstance): number | null {
  const p = i.position;
  if (!p) return null;
  const l = listener(i.world);
  if (!l) return 0;
  const dx = p.x - l.position.x, dy = p.y - l.position.y, dz = p.z - l.position.z;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) return 0;
  const pan = (dx * l.right.x + dy * l.right.y + dz * l.right.z) / d;
  return Math.max(-1, Math.min(1, pan));
}

function event(w: Watched, phase: "start" | "end", now: number): AudioCaptionEvent {
  return {
    phase, playlist: w.instance.path, key: w.caption.key, text: captionText(w.caption.key), time: now,
    duration: phase === "start" ? durationOf(w.instance, now) : null, pan: panOf(w.instance),
  };
}

/** Checks a watched instance: start once it sounds (unless within `minGap`), end once it stops. False when done. */
function check(w: Watched, now: number): boolean {
  const i = w.instance;
  if (!w.started) {
    if (!i.playing) return false;
    if (!sounding(i)) return true;
    const last = lastStart.get(w.caption.key);
    if (last !== undefined && now - last < w.caption.minGap) return false; // repeated too soon: no caption for this one
    lastStart.set(w.caption.key, now);
    w.started = true;
    emit(event(w, "start", now));
    return true;
  }
  if (i.playing) return true;
  emit(event(w, "end", now));
  return false;
}

const runtime: HostedRuntime = {
  update() {
    if (watched.length === 0) return;
    const now = playlistHost().clock();
    for (let k = watched.length - 1; k >= 0; k--) if (!check(watched[k]!, now)) watched.splice(k, 1);
  },
  onGlobal() {},
  resend() {},
  stopAll() {},
  release() { watched.length = 0; lastStart.clear(); },
  forgetWorld() {},
  sweep() {},
};

onAudioSessionReleased(() => { watched.length = 0; lastStart.clear(); });

/** @internal The playlist runtime started `instance` of a playlist with `caption`. */
export function watchCaption(instance: PlaylistInstance, caption: PlaylistCaption): void {
  playlistHost().host(runtime);
  const w: Watched = { instance, caption, started: false };
  if (check(w, playlistHost().clock())) watched.push(w);
}
