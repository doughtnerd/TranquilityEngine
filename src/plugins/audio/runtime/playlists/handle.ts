/**
 * The public handle over a playlist instance (ADR 0329 `AudioPlaylistHandle`): the event handle's members across the
 * instance's voices, plus `onMarker`. `stop()` without a fade fades over 120 ms (ADR 0329); `music` is undefined and
 * `trigger` refuses until sequences and stingers arrive (M5).
 */
import type { Vec3Like } from "../../../../engine/core/math";
import type { MusicEvent, MusicHandle, MusicKind } from "../../../../engine/audio/musicTypes";
import type { AudioMarkerEvent, AudioMarkerType, AudioPanner, AudioPlaylistHandle, AudioReason } from "../backend";
import { warnOnce } from "../core/handle";
import { STOP_FADE_SECONDS, type PlaylistInstance } from "./instance";

class PlaylistHandle implements AudioPlaylistHandle {
  constructor(private readonly instance: PlaylistInstance) {}
  get playing(): boolean { return this.instance.playing; }
  get reason(): AudioReason | null { return this.instance.reason; }
  get position(): Vec3Like | null { return this.instance.position; }
  set position(p: Vec3Like | null) { this.instance.position = p; }
  get panner(): AudioPanner | null { return this.instance.panner; }
  get occlusion(): number { return this.instance.occlusion; }
  stop(fadeSeconds?: number): void { this.instance.stop(fadeSeconds === undefined || !Number.isFinite(fadeSeconds) ? STOP_FADE_SECONDS : Math.max(0, fadeSeconds)); }
  fade(to: number, seconds: number): void { this.instance.fade(Math.min(4, Math.max(0, to)), Math.max(0, seconds)); }
  setParameter(name: string, value: number | string): void { this.instance.setParameter(String(name), value); }
  getParameter(name: string): number | string | undefined { return this.instance.getParameter(String(name)); }
  release(): void { this.instance.release(); }
  onMarker(type: AudioMarkerType, fn: (e: AudioMarkerEvent) => void): () => void {
    if (typeof fn !== "function") return () => {};
    return this.instance.onMarker(type, fn);
  }
  get music(): MusicHandle | undefined { return undefined; }
  onMusic(_kind: MusicKind, _fn: (e: MusicEvent) => void): () => void { return () => {}; }
  trigger(name: string): boolean {
    warnOnce(`playlist:trigger:${this.instance.path}`, `AudioPlaylistHandle.trigger("${name}"): playlist stingers play from M5; ignored.`);
    return false;
  }
}

const handles = new WeakMap<PlaylistInstance, PlaylistHandle>();

/** One public handle per instance. */
export function playlistHandleOf(instance: PlaylistInstance): AudioPlaylistHandle {
  let h = handles.get(instance);
  if (!h) handles.set(instance, (h = new PlaylistHandle(instance)));
  return h;
}
