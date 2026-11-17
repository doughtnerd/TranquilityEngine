// Long-running undo steps (ADR 0231): a step that stays open across events (a drag, a pointer gesture on an
// Inspector control, an edit that waits on file writes) and closes once, recording everything done meanwhile as
// one step, or is cancelled, putting the document back. The editor SDK's `editor.scene.beginEdit` and the viewport
// tools' gestures open them; nothing outside the shell calls `CommandStack.beginGroup` itself.
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

/** Open a step named `label` on `stack`. */
export function beginUndoStep(stack: CommandStack, label: string): UndoStep {
  stack.beginGroup(label);
  let open = true;
  return {
    get open() {
      return open;
    },
    end() {
      if (!open) return;
      open = false;
      stack.endGroup();
    },
    cancel() {
      if (!open) return;
      open = false;
      stack.cancelGroup();
    },
  };
}

/** Run `fn` as one undo step named `label` on `stack`; the step closes even when `fn` throws. */
export function undoStep(stack: CommandStack, label: string, fn: () => void): void {
  const step = beginUndoStep(stack, label);
  try {
    fn();
  } finally {
    step.end();
  }
}
