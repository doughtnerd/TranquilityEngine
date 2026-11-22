// A span lane's layout (ADR 0335 `SpanLane`): playing instances or voices as spans over time, each with an optional
// held part (a sustain or a held loop), a status that picks its colour, rows so overlapping spans don't cover each other,
// dimming for a "problems only" filter, and keyboard movement between spans.
import type { TimeToX } from "./timeAxis";

/** What happened to an instance or voice. */
export type SpanStatus = "ok" | "virtual" | "stolen" | "blocked" | "error";

export interface Span {
  readonly id: string;
  /** Seconds. */
  readonly start: number;
  /** Seconds; null while it is still playing (drawn to `now`). */
  readonly end: number | null;
  /** The held part (a sustain or held loop), seconds. */
  readonly held?: { readonly start: number; readonly end: number | null } | null;
  readonly status: SpanStatus;
  readonly label: string;
}

/** Status words for tooltips and screen readers. */
export const STATUS_TEXT: Readonly<Record<SpanStatus, string>> = {
  ok: "Played",
  virtual: "Virtual (silent, kept in time)",
  stolen: "Warning · voice stolen",
  blocked: "Warning · blocked by a limit",
  error: "Error",
};

/** A problem is anything but played or virtual. */
export const isProblem = (span: Span): boolean => span.status === "stolen" || span.status === "blocked" || span.status === "error";

/** Whether a span is dimmed under `filter`. */
export const isDimmed = (span: Span, filter: "all" | "problems"): boolean => filter === "problems" && !isProblem(span);

/** A span's end, with `now` standing in for one still playing. */
export const spanEnd = (span: Span, now: number): number => (span.end === null ? Math.max(span.start, now) : span.end);

/**
 * Rows for the spans: each span takes the first row whose last span ended at or before it starts (by start time, then
 * id), so overlapping spans stack. Returns each id's row and the row count (at least 1).
 */
export function packSpans(spans: readonly Span[], now: number): { rows: ReadonlyMap<string, number>; count: number } {
  const order = [...spans].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const ends: number[] = [];
  const rows = new Map<string, number>();
  for (const s of order) {
    let row = ends.findIndex((e) => e <= s.start);
    if (row < 0) row = ends.length;
    ends[row] = spanEnd(s, now);
    rows.set(s.id, row);
  }
  return { rows, count: Math.max(1, ends.length) };
}

/** A span's boxes in the lane: the whole span and its held part, at least `minWidth` pixels wide. */
export function spanBoxes(span: Span, toX: TimeToX, now: number, minWidth = 3): { x: number; width: number; held: { x: number; width: number } | null } {
  const x = toX(span.start);
  const width = Math.max(minWidth, toX(spanEnd(span, now)) - x);
  let held: { x: number; width: number } | null = null;
  if (span.held) {
    const hx = toX(span.held.start);
    const hEnd = span.held.end === null ? spanEnd(span, now) : span.held.end;
    held = { x: hx, width: Math.max(1, toX(hEnd) - hx) };
  }
  return { x, width, held };
}

/** The span under time `t` (the latest started, when several are), or null. */
export function spanAt(spans: readonly Span[], t: number, now: number): Span | null {
  let best: Span | null = null;
  for (const s of spans) if (s.start <= t && t <= spanEnd(s, now) && (!best || s.start >= best.start)) best = s;
  return best;
}

/**
 * The span a key selects from `selected` (an id), or null for other keys: Right and Left move to the next or previous
 * span by start time, Home and End to the first and last. From nothing, Right picks the first and Left the last.
 */
export function stepSpan(spans: readonly Span[], selected: string | null, key: string): string | null {
  if (spans.length === 0) return null;
  const order = [...spans].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const at = order.findIndex((s) => s.id === selected);
  switch (key) {
    case "ArrowRight":
      return order[at < 0 ? 0 : Math.min(order.length - 1, at + 1)]!.id;
    case "ArrowLeft":
      return order[at < 0 ? order.length - 1 : Math.max(0, at - 1)]!.id;
    case "Home":
      return order[0]!.id;
    case "End":
      return order[order.length - 1]!.id;
    default:
      return null;
  }
}
