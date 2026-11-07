// Kept apart from shortcuts.ts so modules that only need this check don't pull in the session (an import cycle).
/** A text field (or other control) that keeps its own keys. */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && !["checkbox", "radio", "button", "color", "range"].includes(el.type);
}
