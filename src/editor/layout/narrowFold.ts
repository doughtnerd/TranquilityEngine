// Folding a dock on a narrow screen (ADR 0361): when a dock layout is narrower than its host's `foldBelow` and has open
// docks on both sides, its outermost open left dock folds to its strip, so the middle keeps its room. The fold is only
// how the layout is drawn: the stored layout keeps the dock open, so it is open again once the screen is wide. Opening
// the folded dock (its chevron or a tab in its strip) keeps it open while the screen stays narrow; collapsing it again
// folds it back, still without storing a collapse.
import type { Layout } from "./model";

/** The dock that folds at `width`: the outermost open left dock, below `below` with an open right dock; else null. */
export function foldCandidate(layout: Layout, width: number, below: number): string | null {
  if (width >= below) return null;
  const sides = layout.docks.slice(0, -1); // the filling dock never folds
  if (!sides.some((d) => d.side === "right" && !d.collapsed)) return null;
  return sides.find((d) => d.side === "left" && !d.collapsed)?.id ?? null;
}

/** The layout as drawn with dock `id` folded to its strip. */
export function foldView(layout: Layout, id: string): Layout {
  return { ...layout, docks: layout.docks.map((d) => (d.id === id ? { ...d, collapsed: true } : d)) };
}

/**
 * An edit made on the drawn layout, to store. `candidate` is the dock that folds at this width (`foldCandidate` of the
 * stored layout). The candidate stays open in what is stored; `open` says whether the edit leaves it open (true) or
 * folded (false) on screen, and is undefined when there is no candidate or the edit took it away.
 */
export function unfoldEdit(next: Layout, candidate: string | null): { layout: Layout; open?: boolean } {
  const dock = candidate === null ? undefined : next.docks.find((d) => d.id === candidate);
  if (!dock || dock === next.docks.at(-1)) return { layout: next };
  if (!dock.collapsed) return { layout: next, open: true };
  return { layout: { ...next, docks: next.docks.map((d) => (d === dock ? (({ collapsed: _, ...rest }) => rest)(d) : d)) }, open: false };
}
