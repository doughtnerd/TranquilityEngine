// Preview playback of the timeline being edited, in the viewport without entering play mode (ADR 0373): the scene's
// TimelineDirector plays the edited timeline through the runtime's own path (the animation service runs in every World
// kind), so the viewport shows exactly what the game would. No TypeScript evaluates the timeline.
//
// - **Version:** the runtime loads a director's timeline once, on activation, so each edited version is served under a path
//   of its own from an in-memory source (`ClipPreviewPlayer.pathOf`, T50's, which serves timelines too) and the director
//   is pointed at it and re-activated (`enabled` off and on). Scrubbing within one version only writes `playhead`, which
//   the runtime treats as a seek at the next frame: nothing plays (no time passes), nothing fires for the skipped span.
// - **Leaving:** `stop` puts the director's own fields back (its timeline, play on start, wrap mode and playhead) and
//   re-activates it on its own timeline. The scene's animated fields are put back by the session
//   (`timelineSession.ts`), which knows the scene.
import type { Timeline } from "../../../../engine/animation/timeline";
import type { TimelineDirector } from "../../runtime/components/TimelineDirector";
import { ClipPreviewPlayer } from "../animationWindow/previewLogic";

/** What a director held before the first show. */
interface Saved {
  readonly timeline: string;
  readonly playOnStart: boolean;
  readonly wrapMode: TimelineDirector["wrapMode"];
  readonly playhead: number;
  /** The path of the version the director is loaded with. */
  path: string;
}

/** Shows timeline versions on directors for the Timeline window's preview. */
export class TimelinePreviewPlayer {
  private readonly versions = new ClipPreviewPlayer();
  private readonly saved = new Map<TimelineDirector, Saved>();

  /** The path the current version of `tl` is served at (a new one when `tl` is a new value). */
  pathOf(tl: Timeline, file = "timeline.timeline.json"): string {
    return this.versions.pathOf(tl, file);
  }

  /** Show `tl` at `t` seconds on `director`: a new version reloads it; the same version seeks. */
  show(director: TimelineDirector, tl: Timeline, t: number, file?: string): void {
    const path = this.pathOf(tl, file);
    let s = this.saved.get(director);
    if (!s) this.saved.set(director, (s = { timeline: director.timeline, playOnStart: director.playOnStart, wrapMode: director.wrapMode, playhead: director.playhead, path: "" }));
    const at = Math.min(Math.max(t, 0), tl.duration);
    if (s.path === path) {
      director.playhead = at;
      return;
    }
    s.path = path;
    director.timeline = path;
    director.playOnStart = false;
    director.wrapMode = "hold";
    director.playhead = at;
    reactivate(director);
  }

  /** Stop previewing on `director`: its own fields back, loaded again. Does nothing when it was never shown. */
  stop(director: TimelineDirector): void {
    const s = this.saved.get(director);
    if (!s) return;
    this.saved.delete(director);
    director.timeline = s.timeline;
    director.playOnStart = s.playOnStart;
    director.wrapMode = s.wrapMode;
    director.playhead = s.playhead;
    reactivate(director);
  }

  /** Stop on every director and drop the served versions. */
  dispose(): void {
    for (const d of [...this.saved.keys()]) this.stop(d);
    this.versions.dispose();
  }
}

/** The runtime loads a director's timeline when it activates: turn it off and on. */
function reactivate(director: TimelineDirector): void {
  if (!director.node.isValid) return;
  director.enabled = false;
  director.enabled = true;
}
