// The editor SDK's viewport surface (ADR 0231): which viewport tool is active and its mode, read and set from
// outside the tool's install (the Inspector's Edit Collider button, the Tile Palette's brush buttons). The host
// (viewportTools.ts) ends the mode on its own; see `ViewportToolContribution`.
import { computed, type ReadonlySignal } from "@preact/signals";
import { activateViewportTool, activeViewportTool, activeViewportToolMode, playState } from "../state";

export interface ViewportSurface {
  /** The active viewport tool's id, or null while the transform tools have the scene view. Tracks. */
  readonly activeTool: string | null;
  /**
   * Tool `id`'s mode: what it was entered with while it is active, else null. A signal, so `.value` tracks and
   * `.peek()` doesn't; the same signal for the same id.
   */
  mode<M>(id: string): ReadonlySignal<M | null>;
  /** Make tool `id` the active tool in `mode` (a transform tool or another viewport tool steps aside). Ignored while playing. */
  enter<M>(id: string, mode: M): void;
  /** End tool `id`'s mode if it is the active tool: the scene view goes back to the transform tools. */
  leave(id: string): void;
}

const modes = new Map<string, ReadonlySignal<unknown>>();

export const viewport: ViewportSurface = {
  get activeTool() {
    return activeViewportTool.value;
  },
  mode<M>(id: string): ReadonlySignal<M | null> {
    let m = modes.get(id);
    if (!m) {
      m = computed(() => {
        const a = activeViewportToolMode.value;
        return a && a.id === id ? a.mode : null;
      });
      modes.set(id, m);
    }
    return m as ReadonlySignal<M | null>;
  },
  enter(id, mode) {
    if (playState.peek() !== "edit") return;
    activateViewportTool(id, mode);
  },
  leave(id) {
    if (activeViewportTool.peek() === id) activateViewportTool(null);
  },
};
