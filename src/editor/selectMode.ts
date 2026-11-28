// One rule turns a click, press or box gesture into a selection (ADR 0468), for every selectable
// view: the scene view, the hierarchy, the Assets panel, the graph canvases (Shader Graph, Particle
// Graph, the animation graphs) and the dope sheets. Shift adds, Ctrl/Cmd toggles (and wins over
// Shift), no modifier replaces. Pure, with no editor imports, so the graph view and plugins use it.

/** How a box or click combines with the current selection: replace it, add to it (Shift), or toggle (Ctrl/Cmd). */
export type SelectMode = "replace" | "add" | "toggle";

/** The selection mode for a gesture's modifier keys. Ctrl/Cmd wins over Shift. */
export function selectModeFor(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectMode {
  return e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "add" : "replace";
}

/** `current` combined with `hits` under `mode`, keeping selection order (new keys go last). */
export function combineSelection(current: readonly string[], hits: readonly string[], mode: SelectMode): string[] {
  if (mode === "replace") return [...new Set(hits)];
  if (mode === "add") return [...new Set([...current, ...hits])];
  const toggled = new Set(hits);
  return [...current.filter((k) => !toggled.has(k)), ...[...toggled].filter((k) => !current.includes(k))];
}

/**
 * The selection after pressing item `id` (ADR 0468): Shift adds it, Ctrl/Cmd toggles it, and a plain
 * press selects just it, unless it is already selected, when the selection stays (so a drag that
 * follows moves every selected item). Returns `selected` itself when the press changes nothing.
 */
export function pressSelection(selected: readonly string[], id: string, mode: SelectMode): readonly string[] {
  if (mode === "replace") return selected.includes(id) ? selected : [id];
  if (mode === "add" && selected.includes(id)) return selected;
  return combineSelection(selected, [id], mode);
}
