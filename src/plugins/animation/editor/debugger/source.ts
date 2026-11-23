// Where the live animation debugger's data comes from (ADR 0373 "Live debugger"; T52): an interface over "a running
// game", so the graph editor's overlay, the live parameters and the recorder read the same frames whether the game runs
// in the editor's play session (`localSource.ts`, now) or in a build connected through the debug link (0376, T60, which
// fills a second implementation from its animation topic). `registerDebugger` (`register.ts`) installs the local one.
import { signal } from "@preact/signals";
import type { CompiledAnimGraph } from "../../../../engine/animation/graphCompile";
import type { AnimatorDebugFrame, DebugParamValue } from "../../runtime/features/debug/frame";

/** @internal A graph Animator the debugger can show. */
export interface DebugTarget {
  /** Stable while the Animator lives (its World and entity). */
  readonly id: string;
  /** The node's name, and its World's when the session has several. */
  readonly label: string;
  /** The graph asset it runs (project path). */
  readonly graph: string;
  /** The tables of the graph as the game compiled it (node, machine, transition and condition indices; strings). */
  readonly tables: CompiledAnimGraph;
}

/** @internal An Animator's recent frames, kept by the game (the recorder). */
export interface DebugRecording {
  /** The kept frames, oldest first. */
  readonly frames: readonly AnimatorDebugFrame[];
  /** Seconds kept (default 10). */
  seconds: number;
  isKeyframe(index: number): boolean;
  /**
   * Shows frame `index`'s re-evaluated pose on the character (null: the live pose again); false when it can't be
   * re-evaluated. Only while the game is paused: the next frame puts the live pose back.
   */
  show(index: number | null): boolean;
  /** The frame shown, or null for the live pose. */
  readonly showing: number | null;
}

/** @internal A running game's animation, as the debugger reads it. */
export interface AnimationDebugSource {
  /** What the source is ("Play mode", a build's name). */
  readonly name: string;
  /** Whether the game is running now (playing, or a build connected). */
  readonly live: boolean;
  /** Whether the game is paused (scrubbing shows poses then). */
  readonly paused: boolean;
  /** The graph Animators running `graph` (a project path), or every graph Animator when absent. */
  targets(graph?: string): readonly DebugTarget[];
  /** The target the game's own selection points at (the Hierarchy's selected node while playing), or null. */
  selected(): string | null;
  /** The newest frame of `target` (starts recording it), or null while its graph loads. */
  frame(target: string): AnimatorDebugFrame | null;
  /** `target`'s recording (null: the source keeps none). */
  recording(target: string): DebugRecording | null;
  /** Sets a parameter on `target` through `Animator.set`; false when the target is gone. */
  set(target: string, parameter: string, value: DebugParamValue): boolean;
  /** Draws the game again (after showing a recorded pose while paused). */
  redraw(): void;
}

/** @internal The source the graph editor's debugger reads (null: none, the overlay stays off). */
export const liveDebugSource = signal<AnimationDebugSource | null>(null);
