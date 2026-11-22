// The marker a graph editor's root carries to say it owns the editor's node keys (ADR 0046, 0228):
// inside it, Delete, the clipboard keys, Ctrl/Cmd+D and the Q/W/E/R tool keys are the graph's,
// and the editor's shortcuts (`../shortcuts.ts`) leave them alone; Play, Save and undo/redo still
// pass through. `useGraphSelection` puts it on the root with its key handlers (`rootProps`), so
// every graph editor declares it the same way and the shortcuts don't list graph class names.

/** The attribute a root sets to own the editor's node keys. */
export const KEY_OWNER = "data-owns-editor-keys";

/** Whether an event target is inside a root that owns the editor's node keys. */
export const insideKeyOwner = (target: EventTarget | null): boolean => !!(target as Element | null)?.closest?.(`[${KEY_OWNER}]`);
