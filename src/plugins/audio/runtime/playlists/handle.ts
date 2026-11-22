/**
 * The public handle over a playlist instance (ADR 0329 `AudioPlaylistHandle`): the event handle's members across the
 * instance's voices, plus `onMarker`. `stop()` without a fade fades over 120 ms (ADR 0329); `trigger` fires a stinger;
 * `music` reads the musical clock of the playing entry (a Sequence with a tempo, or a Clip whose sample has one) and is
 * undefined without one.
 */
import type { Vec3Like } from "../../../../engine/core/math";
import type { GridPoint, GridSpec, MusicEvent, MusicHandle, MusicKind, MusicPositionAt, MusicSeekResult } from "../../../../engine/audio/musicTypes";
import type { AudioMarkerEvent, AudioMarkerType, AudioPanner, AudioPlaylistHandle, AudioReason } from "../backend";
import { getCalibration } from "../music/calibration";
import { audioTimeAt } from "../music/handle";
import { STOP_FADE_SECONDS, type PlaylistInstance } from "./instance";
import type { MusicalPosition } from "./musical";

/** `handle.music` over the instance's musical clock (one object per handle; every read asks the clock). */
class PlaylistMusic implements MusicHandle {
  constructor(private readonly instance: PlaylistInstance) {}
  private now(): number { return this.instance.clock(); }
  private pos(): MusicalPosition | null { return this.instance.musicalSource()?.positionAt(this.now()) ?? null; }
  get segment(): string | null { return this.pos() ? this.instance.musicalSource()!.label : null; }
  get bar(): number { return this.pos()?.bar ?? 1; }
  get beat(): number { return this.pos()?.beat ?? 1; }
  get beatFraction(): number { return this.pos()?.beatFraction ?? 0; }
  get tempo(): number { return this.pos()?.tempo ?? 0; }
  get beatsPerBar(): number { return this.pos()?.beatsPerBar ?? 0; }
  get beatUnit(): number { return this.pos()?.beatUnit ?? 0; }
  get time(): number { return this.now(); }
  get transition(): { to: string; time: number } | null { return null; }
  nextGrid(spec: GridSpec): GridPoint | null {
    const s = this.instance.musicalSource();
    const p = s?.nextGrid(spec, this.now());
    return s && p ? { time: p.time, bar: p.bar, beat: p.beat, segment: s.label } : null;
  }
  positionAt(performanceTime: number): MusicPositionAt {
    const s = this.instance.musicalSource();
    const time = audioTimeAt(performanceTime);
    const p = s && Number.isFinite(time) ? s.positionAt(time) : null;
    const spb = s?.secondsPerBeat() ?? null;
    if (!s || !p || spb === null) return { segment: null, bar: 0, beat: 0, beatFraction: 0, nearestBeatTime: 0, offset: 0, judged: 0 };
    const nearest = p.beatFraction < 0.5 ? time - p.beatFraction * spb : time + (1 - p.beatFraction) * spb;
    const offset = time - nearest;
    return { segment: s.label, bar: p.bar, beat: p.beat, beatFraction: p.beatFraction, nearestBeatTime: nearest, offset, judged: offset - getCalibration() };
  }
  seek(to: string): MusicSeekResult {
    const s = this.instance.musicalSource();
    if (!s) return { ok: false, reason: "notPlaying", permanent: true };
    return s.seek(String(to));
  }
}

class PlaylistHandle implements AudioPlaylistHandle {
  private musicView: PlaylistMusic | null = null;
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
  get music(): MusicHandle | undefined {
    if (!this.instance.musicalSource()?.hasGrid) return undefined;
    return (this.musicView ??= new PlaylistMusic(this.instance));
  }
  onMusic(kind: MusicKind, fn: (e: MusicEvent) => void): () => void {
    if (typeof fn !== "function" || this.instance.stopped) return () => {};
    return this.instance.musicCallbacks(this).on(kind, fn);
  }
  trigger(name: string): boolean { return this.instance.trigger(String(name)); }
}

const handles = new WeakMap<PlaylistInstance, PlaylistHandle>();

/** One public handle per instance. */
export function playlistHandleOf(instance: PlaylistInstance): AudioPlaylistHandle {
  let h = handles.get(instance);
  if (!h) handles.set(instance, (h = new PlaylistHandle(instance)));
  return h;
}
