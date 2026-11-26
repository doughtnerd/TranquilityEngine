/**
 * Editing a text's inline runs (ADR 0425, `contenteditable`): the player's typing arrives as the hidden input's whole new
 * text; the change (one replaced span: what the text before and after share at both ends is kept) is written into the
 * components that hold the runs' text, so the runs keep their styles. Text typed at a boundary between runs takes the
 * style of the run before it, as browsers do; an inline image can't be deleted (it comes back). Rich formatting
 * commands are out of scope.
 */
import type { UIComponentType, UIText } from "../components";
import type { UIInlineRun } from "../uiCoreTypes";

/** The one span `before` → `after` replaces: `[start, end)` of `before` becomes `insert`. */
export function inlineEditSpan(before: string, after: string): { start: number; end: number; insert: string } {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  return { start: p, end: before.length - s, insert: after.slice(p, after.length - s) };
}

const isTextSource = (c: UIComponentType | null): c is UIText => !!c && typeof (c as UIText).text === "string";

/**
 * Write the edit `before` → `after` into the runs' sources (`runs` laid out from `before`); `root` is the edited text
 * element, which takes typing when it has no text run to put it in. Editable text keeps its whitespace, so each run's
 * text is its source's text.
 */
export function applyInlineEdit(root: UIText, runs: readonly UIInlineRun[], before: string, after: string): void {
  const { start, end, insert } = inlineEditSpan(before, after);
  const next = new Map<UIText, string>();
  const textOf = (c: UIText) => next.get(c) ?? c.text;
  // The run typing goes into: the text run holding the character before `start`, else the one starting there.
  let target: { source: UIText; offset: number } | null = null;
  let at = 0;
  const spans = runs.map((r) => {
    const s = at;
    at += r.text.length;
    return { r, s, e: at };
  });
  for (const { r, s, e } of spans) if (!r.image && r.text !== "\n" && isTextSource(r.source) && s < start && start <= e) target ??= { source: r.source, offset: start - s };
  if (!target) for (const { r, s } of spans) if (!r.image && r.text !== "\n" && isTextSource(r.source) && s === start) target ??= { source: r.source, offset: 0 };
  // Deletions, run by run (from the end of each source's text, so offsets before them hold).
  for (const { r, s, e } of [...spans].reverse()) {
    if (r.image || !isTextSource(r.source)) continue;
    const a = Math.max(start, s), b = Math.min(end, e);
    if (b <= a) continue;
    const t = textOf(r.source);
    next.set(r.source, t.slice(0, a - s) + t.slice(b - s));
  }
  if (insert) {
    if (target) {
      const t = textOf(target.source);
      next.set(target.source, t.slice(0, target.offset) + insert + t.slice(target.offset));
    } else next.set(root, insert + textOf(root));
  }
  for (const [c, t] of next) if (c.text !== t) c.text = t;
}
