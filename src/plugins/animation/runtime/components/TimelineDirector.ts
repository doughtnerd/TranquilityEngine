/**
 * Plays a timeline (`*.timeline.json`, ADR 0371, 0372): tracks on many nodes, with paths relative to this node, plus
 * control, sub-clip, activation and audio tracks. `animation.Timeline` advances it before `animation.Gather`.
 */
import { Component } from "../../../../engine/core/Component";
import { AssetRef, component, field } from "../../../../engine/core/registry";
import { GameObject } from "../../../../engine/scene/GameObject";
import * as timeline from "../features/timeline";
import type { AnimationPlayResult, TimelineWrapMode } from "../types";

@component("engine.TimelineDirector")
export class TimelineDirector extends Component {
  /** The timeline asset. */
  @field(AssetRef, { kind: "timeline", animatable: false, description: "The timeline to play." })
  timeline = "";
  /** Tracks bound to nodes other than their path's, by track name; `bindingNodes[i]` is track `bindingTracks[i]`'s node. Edited in the Timeline window. */
  @field([String], { hidden: true })
  bindingTracks: string[] = [];
  /** The node each of `bindingTracks` animates. */
  @field([GameObject], { hidden: true })
  bindingNodes: (GameObject | null)[] = [];
  /** Start playing when the director starts. */
  @field(Boolean, { animatable: false, description: "Start playing when the scene starts." })
  playOnStart = true;
  /** At the end: stay on the last frame, loop, or stop and go back to the start. */
  @field(String, { choices: ["hold", "loop", "none"], animatable: false, description: "What happens at the end." })
  wrapMode: TimelineWrapMode = "hold";
  /**
   * The playhead, in seconds (ADR 0372's "time"; `time` is the component's clock). It moves while playing; writing it
   * seeks, and no events fire for the skipped span.
   */
  @field(Number, { description: "The playhead in seconds; writing it seeks." })
  playhead = 0;

  /** Play from the playhead. The promise resolves when the timeline ends (`finished`), is stopped, or `play` is called again (`interrupted`). */
  play(): Promise<AnimationPlayResult> {
    return timeline.playTimeline(this);
  }

  /** Hold the playhead where it is; `play` continues. */
  pause(): void {
    timeline.pauseTimeline(this);
  }

  /** Stop and put the playhead back to 0; the play's promise resolves with `stopped`. */
  stop(): void {
    timeline.stopTimeline(this);
  }

  override _onAttach(): void {
    timeline.timelineHooks.attach?.(this);
  }

  override _onActivate(): void {
    timeline.timelineHooks.activate?.(this);
  }

  override _onDeactivate(): void {
    timeline.timelineHooks.deactivate?.(this);
  }

  override _onDetach(): void {
    timeline.timelineHooks.detach?.(this);
  }
}
