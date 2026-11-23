// What each editor tool's registration seam gets (`<tool>/register.ts`): which optional dependencies (ADR 0374) are
// active for this activation of the editor half, read once by its `activate()` (`index.ts`).

/** @internal The optional dependencies active for this activation of the editor half. */
export interface AnimationEditorIntegrations {
  /** `myco.physics` is active (root-motion targets, grounder previews). */
  readonly physics: boolean;
  /** `myco.audio` is active (audio rows in the Animation and Timeline windows, music-timed previews). */
  readonly audio: boolean;
}
