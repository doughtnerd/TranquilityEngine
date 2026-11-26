// A text file's change as one replaced stretch (ADR 0077): the differing middle of the old and new
// text, so history files stay small. The scene's history keeps these for the UI files its
// commands write; an asset document's history (ADR 0141) is a tree of them over one file.

/**
 * A text file's change in one step: the text at `start` that was `before` became `after`.
 * `created`: the file didn't exist before (undo deletes it); `removed`: the step deleted it.
 */
export interface FilePatch {
  path: string;
  start: number;
  before: string;
  after: string;
  created?: true;
  removed?: true;
}

/** The change from `a` to `b` as one replaced stretch: common prefix and suffix left out. */
export function diffText(a: string, b: string): { start: number; before: string; after: string } {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let q = 0;
  while (q < max - p && a.charCodeAt(a.length - 1 - q) === b.charCodeAt(b.length - 1 - q)) q++;
  return { start: p, before: a.slice(p, a.length - q), after: b.slice(p, b.length - q) };
}

/**
 * `text` with `patch`'s stretch replaced forward (redo: `before` → `after`) or back (undo), or null
 * when the stretch isn't there (the text changed elsewhere, or a damaged history).
 */
export function applyFilePatch(text: string, patch: FilePatch, direction: "undo" | "redo"): string | null {
  const [from, to] = direction === "undo" ? [patch.after, patch.before] : [patch.before, patch.after];
  // Past the end, an empty stretch would still "match" (slice gives ""): an insertion there is refused, not appended.
  if (!Number.isInteger(patch.start) || patch.start < 0 || patch.start + from.length > text.length) return null;
  if (text.slice(patch.start, patch.start + from.length) !== from) return null;
  return text.slice(0, patch.start) + to + text.slice(patch.start + from.length);
}
