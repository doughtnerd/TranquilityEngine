// The clip preview's model side (ADR 0373; T18): which model a clip previews on, how long the clip is, and the playhead
// the preview's play/pause button and time scrubber drive. The view is `ClipPreview.tsx`.
//
// - **Model:** a model's own clip (`model.glb#Anim/<name>`) previews on that model; an authored or compiled clip names no
//   model, so the user drags one in (remembered per clip for the session).
// - **Duration:** an authored clip's `duration` (`myco.anim-source@1`), a compiled clip's header (`myco.anim@1`); a model's
//   clip is read from the importer's cut (`loadClipSource`), so it has one once its model has loaded; the scrubber spans
//   one second until then (or when the model can't be read).
// - **Playhead:** time in seconds, advanced by the preview's frame clock while playing; it loops for a looping clip and
//   stops at the end otherwise.
import { signal, type Signal } from "@preact/signals";
import { parseAnimSource } from "../../../../engine/animation/animSource";
import { Assets } from "../../../../engine/scene/Assets";
import { clipRefKind } from "../../../../engine/animation/compile/keys";
import { readClipInfo } from "../../runtime/assetInfo";
import { loadClipSource } from "../../runtime/features/clipSources";
import { assetRefTarget } from "../../../../editor/sdk";

/** The model a model's clip belongs to (`models/hero.glb#Anim/Run` → `models/hero.glb`), or null for a clip file. */
export function modelOfClip(entry: string): string | null {
  const at = entry.indexOf("#Anim/");
  return at > 0 ? assetRefTarget(entry.slice(0, at)) : null;
}

/** Models the user dragged onto a clip's preview this session, by clip. */
const chosen = new Map<string, Signal<string | null>>();

/** The model `clip` previews on: its own model, else the one dragged onto its preview (a signal the view reads). */
export function previewModel(clip: string): Signal<string | null> {
  let s = chosen.get(clip);
  if (!s) chosen.set(clip, (s = signal<string | null>(modelOfClip(clip))));
  return s;
}

/** A clip's length and loop flag, as far as the editor can read it now. */
export interface ClipTiming {
  /** Seconds; 1 when unknown. */
  readonly duration: number;
  readonly looping: boolean;
  /** False when the clip couldn't be read (a model's clip before the importer makes it a file): `duration` is a stand-in. */
  readonly known: boolean;
}

const UNKNOWN: ClipTiming = { duration: 1, looping: true, known: false };

/** The timing of the clip `entry` (a project path, or `asset:` reference). Never rejects. */
export async function clipTiming(entry: string): Promise<ClipTiming> {
  const path = assetRefTarget(entry);
  try {
    const kind = clipRefKind(path);
    if (kind === "model") {
      const data = await loadClipSource(path);
      return data ? { duration: data.source.duration, looping: data.source.loop, known: true } : UNKNOWN;
    }
    if (!Assets.has(path)) return UNKNOWN;
    if (kind === "source") {
      const clip = parseAnimSource(Assets.get(path)).value;
      return { duration: clip.duration, looping: clip.loop, known: true };
    }
    const info = readClipInfo(await Assets.bytes(path));
    return info ? { duration: info.duration, looping: info.looping, known: true } : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

/** The preview's playhead: play/pause, scrub, and the frame clock's advance. */
export class ClipPlayhead {
  /** Seconds into the clip. */
  readonly time = signal(0);
  readonly playing = signal(false);
  private timing: ClipTiming = UNKNOWN;

  /** Use `timing` (a new clip, or its file changed): the time stays where it was, within the new length. */
  setTiming(timing: ClipTiming): void {
    this.timing = timing;
    this.time.value = Math.min(this.time.peek(), timing.duration);
  }

  get duration(): number {
    return this.timing.duration;
  }

  /** Play from where it is (from the start when it stopped at the end of a clip that doesn't loop). */
  play(): void {
    if (!this.timing.looping && this.time.peek() >= this.timing.duration) this.time.value = 0;
    this.playing.value = true;
  }

  pause(): void {
    this.playing.value = false;
  }

  toggle(): void {
    if (this.playing.peek()) this.pause();
    else this.play();
  }

  /** Scrub to `seconds` (clamped to the clip); scrubbing pauses. */
  seek(seconds: number): void {
    this.playing.value = false;
    this.time.value = Math.min(Math.max(Number.isFinite(seconds) ? seconds : 0, 0), this.timing.duration);
  }

  /** The frame clock: `dt` seconds pass while playing; a looping clip wraps, another stops at its end. */
  advance(dt: number): void {
    if (!this.playing.peek() || !(dt > 0)) return;
    const d = this.timing.duration;
    if (d <= 0) {
      this.playing.value = false;
      return;
    }
    const t = this.time.peek() + dt;
    if (t < d) this.time.value = t;
    else if (this.timing.looping) this.time.value = t % d;
    else {
      this.time.value = d;
      this.playing.value = false;
    }
  }
}
