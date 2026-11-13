// ADR 0171 amended by 0172 (M5a, task Pf5; api-and-models §7): the profiler tables' shared grid. A long table renders only
// a window of its rows (`windowRows`: the visible rows plus an overscan, at most `MAX_RENDERED_ROWS`), inside a spacer as
// tall as the whole list, so scrolling moves the window and 1,024 voices cost 64 DOM rows at most. Keyboard: the arrow,
// page, Home and End keys move the focused row (`navigate`), and the scroll follows it.
//
// `WindowedGridView` is a pure function of its props (the tests call it with chosen scroll offsets); `useGridState` is the
// small hook the stateful tables use to feed it.
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { MAX_RENDERED_ROWS, ROW_HEIGHT, VIEWPORT_HEIGHT, navigate, windowRows } from "./profilerTablesModel";
import "./profilerTables.css";

/** A cell: its text, and an optional flag the stylesheet reads (`data-flag`). */
export type GridCell = string | { text: string; flag?: string };

export interface GridColumn {
  key: string;
  title: string;
  /** CSS width of the column (a `fr`, `px` or `ch` track). Default `1fr`. */
  width?: string;
  align?: "end";
}

export interface WindowedGridProps<T> {
  /** The table's name (the grid's accessible label and its `data-table`). */
  label: string;
  columns: readonly GridColumn[];
  rows: readonly T[];
  rowKey(row: T, index: number): string | number;
  cells(row: T): readonly GridCell[];
  /** A `data-state` for the row (the stylesheet colours by it). */
  rowState?(row: T): string | undefined;
  scrollTop: number;
  focus: number;
  onScroll(scrollTop: number): void;
  onKey(key: string, preventDefault: () => void): void;
  onFocusRow(index: number): void;
  /** Pixel height of the scrolling region. */
  viewportHeight?: number;
}

const columnsStyle = (columns: readonly GridColumn[]): string => columns.map((c) => c.width ?? "1fr").join(" ");

/** The grid as a pure function of its props. */
export function WindowedGridView<T>(p: WindowedGridProps<T>): JSX.Element {
  const viewport = p.viewportHeight ?? VIEWPORT_HEIGHT;
  const win = windowRows({ total: p.rows.length, scrollTop: p.scrollTop, viewportHeight: viewport, max: MAX_RENDERED_ROWS });
  const template = columnsStyle(p.columns);
  const focus = Math.min(Math.max(p.focus, 0), Math.max(0, p.rows.length - 1));
  const focusRendered = focus >= win.start && focus < win.end;
  const rendered = p.rows.slice(win.start, win.end);
  return (
    <div
      class="pgrid"
      role="grid"
      aria-label={p.label}
      aria-rowcount={p.rows.length + 1}
      data-table={p.label}
      onKeyDown={(e) => p.onKey(e.key, () => e.preventDefault())}
    >
      <div class="pgrid-head" role="row" style={{ gridTemplateColumns: template }}>
        {p.columns.map((c) => (
          <span key={c.key} class="pgrid-cell" role="columnheader" data-align={c.align}>
            {c.title}
          </span>
        ))}
      </div>
      <div
        class="pgrid-scroll"
        role="rowgroup"
        data-scroll
        tabIndex={focusRendered ? -1 : 0}
        style={{ height: `${viewport}px` }}
        onScroll={(e) => p.onScroll((e.currentTarget as HTMLElement).scrollTop)}
      >
        <div class="pgrid-spacer" style={{ height: `${win.height}px` }}>
          {rendered.map((row, i) => {
            const index = win.start + i;
            const state = p.rowState?.(row);
            return (
              <div
                key={p.rowKey(row, index)}
                class="pgrid-row"
                role="row"
                aria-rowindex={index + 2}
                data-index={index}
                data-state={state}
                tabIndex={index === focus ? 0 : -1}
                style={{ top: `${index * ROW_HEIGHT}px`, gridTemplateColumns: template }}
                onFocus={() => p.onFocusRow(index)}
                onClick={() => p.onFocusRow(index)}
              >
                {p.cells(row).map((cell, c) => {
                  const col = p.columns[c]!;
                  const text = typeof cell === "string" ? cell : cell.text;
                  const flag = typeof cell === "string" ? undefined : cell.flag;
                  return (
                    <span key={col.key} class="pgrid-cell" role="gridcell" data-align={col.align} data-flag={flag} title={text}>
                      {text}
                    </span>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** What a stateful table keeps for its grid: scroll offset, focused row, and the handlers that feed `WindowedGridView`. */
export interface GridState {
  scrollTop: number;
  focus: number;
  scrollRef: { current: HTMLElement | null };
  onScroll(scrollTop: number): void;
  onKey(key: string, preventDefault: () => void): void;
  onFocusRow(index: number): void;
}

/**
 * Scroll offset and focus for a grid of `total` rows. A key moves the focus and the scroll; the scroll region is set to the
 * new offset and the focused row takes DOM focus once it is rendered. The grid element is found from `rootRef`.
 */
export function useGridState(total: number, rootRef: { current: HTMLElement | null }): GridState {
  const [scrollTop, setScrollTop] = useState(0);
  const [focus, setFocus] = useState(0);
  const wantFocus = useRef(false);
  const scrollRef = useRef<HTMLElement | null>(null);
  const last = Math.max(0, total - 1);
  const clampedFocus = Math.min(focus, last);

  useEffect(() => {
    const scroller = rootRef.current?.querySelector<HTMLElement>("[data-scroll]") ?? null;
    scrollRef.current = scroller;
    if (scroller && Math.abs(scroller.scrollTop - scrollTop) > 0.5) scroller.scrollTop = scrollTop;
    if (wantFocus.current) {
      wantFocus.current = false;
      rootRef.current?.querySelector<HTMLElement>(`[data-index="${clampedFocus}"]`)?.focus();
    }
  });

  return {
    scrollTop,
    focus: clampedFocus,
    scrollRef,
    onScroll: (top) => setScrollTop(top),
    onKey: (key, preventDefault) => {
      const next = navigate({ focus: clampedFocus, scrollTop }, key, total);
      if (!next) return;
      preventDefault();
      wantFocus.current = true;
      setFocus(next.focus);
      setScrollTop(next.scrollTop);
    },
    onFocusRow: (index) => setFocus(index),
  };
}
