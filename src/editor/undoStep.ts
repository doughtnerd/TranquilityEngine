// Long-running undo steps (ADR 0231): a step that stays open across events (a drag, a pointer gesture on an
// Inspector control, an edit that waits on file writes) and closes once, recording everything done meanwhile as
// one step, or is cancelled, putting the document back. The editor SDK's `editor.scene.edit`/`beginEdit`, the viewport
// tools' gestures and the shell's own edits (the transform gizmo, Inspector scrubs, UI handle drags, every multi-command
// edit) open them; only this module calls `CommandStack.beginGroup` itself.
import type { CommandStack } from "./document";

/** An open undo step. Closing it twice, or cancelling a closed one, does nothing. */
export interface UndoStep {
  /** Whether it is still open. */
  readonly open: boolean;
  /** Close it: everything edited since it opened is one undo step (none when nothing changed). */
  end(): void;
  /** Close it without recording it, putting back what was edited since it opened (when it isn't nested in another step). */
  cancel(): void;
}

/**
 * The outermost open step on each stack as a gesture number, and how deep steps are nested in it (ADR 0373: writes a
 * field write interceptor takes inside one step, a gizmo drag say, are grouped by it).
 */
const gestures = new WeakMap<CommandStack, { readonly gesture: number; depth: number }>();
let lastGesture = 0;
const gestureListeners = new Set<(gesture: number, cancelled: boolean) => void>();

/** The gesture number of the outermost step open on `stack`, or null when none is. */
export const openGesture = (stack: CommandStack): number | null => gestures.get(stack)?.gesture ?? null;

/** Calls `listener` when an outermost step closes (`cancelled`: put back). Returns the unsubscribe. */
export function onGestureClosed(listener: (gesture: number, cancelled: boolean) => void): () => void {
  gestureListeners.add(listener);
  return () => gestureListeners.delete(listener);
}

function closeGesture(stack: CommandStack, cancelled: boolean): void {
  const g = gestures.get(stack);
  if (!g || --g.depth > 0) return;
  gestures.delete(stack);
  for (const listener of [...gestureListeners]) listener(g.gesture, cancelled);
}

/** Open a step named `label` on `stack`. */
export function beginUndoStep(stack: CommandStack, label: string): UndoStep {
  stack.beginGroup(label);
  const g = gestures.get(stack);
  if (g) g.depth++;
  else gestures.set(stack, { gesture: ++lastGesture, depth: 1 });
  let open = true;
  return {
    get open() {
      return open;
    },
    end() {
      if (!open) return;
      open = false;
      stack.endGroup();
      closeGesture(stack, false);
    },
    cancel() {
      if (!open) return;
      open = false;
      stack.cancelGroup();
      closeGesture(stack, true);
    },
  };
}

/** Run `fn` as one undo step named `label` on `stack` and return what it returns; the step closes even when `fn` throws. */
export function undoStep<T>(stack: CommandStack, label: string, fn: () => T): T {
  const step = beginUndoStep(stack, label);
  try {
    return fn();
  } finally {
    step.end();
  }
}
