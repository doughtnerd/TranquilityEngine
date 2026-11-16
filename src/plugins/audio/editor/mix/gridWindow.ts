// The windowed grid's layout maths (ADR 0171 amended by 0172, task Pf5): which rows of a long list are rendered for a
// scroll offset (at most `MAX_RENDERED_ROWS`, the 64 of `voiceTableModel`'s `MAX_VOICE_ROWS`), the scroll offset that
// brings a row into view, and where a navigation key moves the focused row. Pure; `WindowedGrid.tsx` draws with it.
import { MAX_VOICE_ROWS } from "./voiceTableModel";

// --- the row window ----------------------------------------------------------------------------------------------------

/** Rows the window renders at most, whatever the table's length (the live debug table's cap). */
export const MAX_RENDERED_ROWS = MAX_VOICE_ROWS;
/** A table row's height in CSS pixels (`profilerTables.css` sets the same 20 px on `.pgrid-row` and `.pgrid-head`). */
export const ROW_HEIGHT = 20;
/** The scrolling region's height: twelve rows. */
export const VIEWPORT_ROWS = 12;
export const VIEWPORT_HEIGHT = ROW_HEIGHT * VIEWPORT_ROWS;
/** Rows rendered beyond each edge so a quick scroll never shows a gap before the next scroll event. */
export const OVERSCAN_ROWS = 4;

export interface WindowInput {
  total: number;
  rowHeight?: number;
  viewportHeight?: number;
  scrollTop: number;
  overscan?: number;
  max?: number;
}

/** The rows `[start, end)` to render, the pixel height of the whole list and the scroll offset after clamping. */
export interface RowWindow {
  start: number;
  end: number;
  /** `total * rowHeight`: the spacer's height. */
  height: number;
  scrollTop: number;
}

/** The window for a scroll offset. A scroll offset past the end is clamped to it; the window never exceeds `max` rows. */
export function windowRows(input: WindowInput): RowWindow {
  const rowHeight = input.rowHeight ?? ROW_HEIGHT;
  const viewport = input.viewportHeight ?? VIEWPORT_HEIGHT;
  const overscan = input.overscan ?? OVERSCAN_ROWS;
  const max = input.max ?? MAX_RENDERED_ROWS;
  const total = Math.max(0, Math.floor(input.total));
  const height = total * rowHeight;
  const scrollTop = Math.min(Math.max(Number.isFinite(input.scrollTop) ? input.scrollTop : 0, 0), Math.max(0, height - viewport));
  const first = Math.floor(scrollTop / rowHeight);
  const last = Math.ceil((scrollTop + viewport) / rowHeight);
  const start = Math.min(Math.max(0, first - overscan), total);
  const end = Math.min(total, Math.max(start, last + overscan), start + max);
  return { start, end, height, scrollTop };
}

/** The scroll offset that shows row `index` fully, moving as little as possible from `scrollTop`. */
export function scrollToIndex(index: number, scrollTop: number, rowHeight = ROW_HEIGHT, viewportHeight = VIEWPORT_HEIGHT): number {
  const top = index * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + viewportHeight) return top + rowHeight - viewportHeight;
  return scrollTop;
}

// --- keyboard focus ----------------------------------------------------------------------------------------------------

/** The keys a table row handles. */
export type NavKey = "ArrowUp" | "ArrowDown" | "PageUp" | "PageDown" | "Home" | "End";
export const NAV_KEYS: readonly NavKey[] = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"];

/** Where `key` moves the focused row of a `total`-row table (clamped to the table); null for a key the table doesn't take or an empty table. */
export function moveFocus(current: number, key: string, total: number, pageRows = VIEWPORT_ROWS): number | null {
  if (total <= 0 || !(NAV_KEYS as readonly string[]).includes(key)) return null;
  const last = total - 1;
  const at = Math.min(Math.max(current, 0), last);
  switch (key as NavKey) {
    case "ArrowUp": return Math.max(0, at - 1);
    case "ArrowDown": return Math.min(last, at + 1);
    case "PageUp": return Math.max(0, at - pageRows);
    case "PageDown": return Math.min(last, at + pageRows);
    case "Home": return 0;
    case "End": return last;
  }
}

export interface GridPosition {
  focus: number;
  scrollTop: number;
}

/** A key's effect on a grid: the focused row moves and the scroll follows it. Null when the key isn't one the grid takes. */
export function navigate(pos: GridPosition, key: string, total: number, rowHeight = ROW_HEIGHT, viewportHeight = VIEWPORT_HEIGHT): GridPosition | null {
  const focus = moveFocus(pos.focus, key, total, Math.max(1, Math.floor(viewportHeight / rowHeight)));
  if (focus === null) return null;
  return { focus, scrollTop: scrollToIndex(focus, pos.scrollTop, rowHeight, viewportHeight) };
}
