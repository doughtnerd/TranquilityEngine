// Preview playback in the viewport without entering play mode (ADR 0373): the clip being edited plays on the bound
// Animator in the Editor World through the runtime's own path (the animation service runs in every World kind, T13t),
// so the viewport shows exactly what the game would: `Animator.play` with speed 0 at the playhead's normalised time,
// the clip resolved by `clipSources.ts` and played in its raw form (T19's `rawClip.ts`), property tracks written by
// the binding table (T20t). No TypeScript evaluates the clip.
//
// The runtime acquires a clip once per Animator and path and keeps it (D119), so each edited version of the clip is
// served under a path of its own (`.animation-preview/<n>/<file>`) from an in-memory asset source: the next show after
// an edit plays the new version. Only the latest versions are kept in the source.
import type { AnimSource } from "../../../../engine/animation/animSource";
import { animSourceToJson } from "../../../../engine/animation/animSource";
import { timelineToJson, TIMELINE_FORMAT, TIMELINE_SUFFIX, type Timeline } from "../../../../engine/animation/timeline";
import { Assets, type AssetSource } from "../../../../engine/scene/Assets";
import type { Animator } from "../../runtime/components/Animator";

/** Versions kept in the preview source (older ones are dropped; an Animator holding one keeps its loaded copy). */
const KEPT = 4;
const ROOT = ".animation-preview";

/** Plays clip versions on Animators for the Animation window's preview. */
export class ClipPreviewPlayer {
  private readonly files = new Map<string, unknown>();
  private readonly source: AssetSource = { has: (p) => this.files.has(p), get: (p) => this.files.get(p), paths: () => this.files.keys() };
  private version = 0;
  private last: { clip: AnimSource | Timeline; path: string } | null = null;

  /**
   * The path the current version of `clip` is served at (a new one when `clip` is a new value). A timeline (the Timeline
   * window, T53) is served the same way under its own ending.
   */
  pathOf(clip: AnimSource | Timeline, file = "clip.anim.json"): string {
    if (this.last?.clip === clip) return this.last.path;
    const timeline = clip.format === TIMELINE_FORMAT;
    const suffix = timeline ? TIMELINE_SUFFIX : ".anim.json";
    const name = file.slice(file.lastIndexOf("/") + 1) || `clip${suffix}`;
    const path = `${ROOT}/${++this.version}/${name.toLowerCase().endsWith(suffix) ? name : `${name}${suffix}`}`;
    this.files.set(path, clip.format === TIMELINE_FORMAT ? timelineToJson(clip) : animSourceToJson(clip));
    while (this.files.size > KEPT) this.files.delete(this.files.keys().next().value!);
    this.last = { clip, path };
    if (!Assets.has(path)) Assets.addSource(this.source); // first use, or the sources were cleared
    return path;
  }

  /** Show `clip` at `t` seconds on `animator`: a play at speed 0 from the playhead's normalised time. */
  show(animator: Animator, clip: AnimSource, t: number, file?: string): void {
    const path = this.pathOf(clip, file);
    const d = clip.duration;
    const normalizedTime = d > 0 ? Math.min(1, Math.max(0, t / d)) : 0;
    void animator.play(path, { speed: 0, normalizedTime, loop: false });
  }

  /** Stop previewing on `animator` (its fields keep the last values shown, as in the game, D107). */
  stop(animator: Animator): void {
    animator.stop();
  }

  /** Drop the served versions and leave the asset sources. */
  dispose(): void {
    this.files.clear();
    this.last = null;
    Assets.removeSource(this.source);
  }
}
