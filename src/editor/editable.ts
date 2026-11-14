// Kept apart from shortcuts.ts so modules that only need this check don't pull in the session (an import cycle).
/** A text field (or other control) that keeps its own keys. */
// Tag names, not `instanceof HTMLInputElement`: an element in a detached panel window (ADR 0174) is
// made by that window's constructors, so the main window's `instanceof` is false for it.
export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  const tag = typeof el.tagName === "string" ? el.tagName.toLowerCase() : "";
  if (tag === "textarea" || tag === "select") return true;
  return tag === "input" && !["checkbox", "radio", "button", "color", "range"].includes((el as HTMLInputElement).type);
}
