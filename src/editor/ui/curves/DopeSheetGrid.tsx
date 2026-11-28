// The dope sheet's grid (ADR 0346, 0373): a time ruler (drag to choose a range, click to move the playhead, double-click
// for the whole length) over rows of keys drawn as diamonds, with spans (ranges) under them. One generic part, shared:
// the curve editor's dope sheet (`DopeSheet.tsx`, one row per time lane, one key selected) and the Animation window's
// (rows per bound node, component and field, many keys selected) both draw through it, so there is one dope sheet.
//
// - **Keys** have ids; the selection is a set of ids the host owns. A click selects a key (Shift or Ctrl/Cmd adds or
//   toggles); dragging a key drags it with the rest of the selection (`onDrag` reports the time offset, the host moves
//   the keys and snaps); right-click opens the host's key menu.
// - **Box select:** dragging on empty grid space draws a box; the keys inside it are selected (Shift adds). A click on
//   empty space picks that row and clears the selection.
// - Nothing here edits keys: the host's model does, so the rules live in one place (`keyList.ts`, the host's logic).
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import { selectModeFor, type SelectMode } from "../../selectMode";
import { playheadAt, rulerRange } from "./curveEditorModel";
import { axisTicks } from "./keyList";
import "./curveEditor.css";

/** One key on a row. */
export interface DopeKey {
  readonly id: string;
  readonly x: number;
  /** The key's accessible name and tooltip ("Position.x key at 0.40 s, 1.2"). */
  readonly label: string;
}

/** A range drawn on a row (a notify state, an activation's on span). */
export interface DopeSpan {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly label: string;
  /** Drawn as a blend region (clips overlapping): over the bars, hatched, instead of a faint span in the row's colour. */
  readonly blend?: boolean;
}

/** A range drawn on a row as a bar that can be selected, moved, trimmed at its ends and opened (the Timeline window's clips). */
export interface DopeBar {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly label: string;
  /** Ease-in and ease-out lengths in seconds, drawn as handles inside the bar's ends (a clip's blend in and out). */
  readonly easeIn?: number;
  readonly easeOut?: number;
}

/** Which part of a bar a drag holds: its body (move), an end (trim), or an ease handle. */
export type DopeBarPart = "move" | "start" | "end" | "easeIn" | "easeOut";

/** One row of the grid. */
export interface DopeRow {
  readonly id: string;
  readonly label: string;
  /** Indentation level of the name (0: top). */
  readonly depth?: number;
  /** A group heading (a node, a component): drawn stronger. */
  readonly heading?: boolean;
  /** The keys' colour (a CSS value, a theme token such as `var(--series-2)`); default the accent. */
  readonly color?: string;
  /** Dimmed (a hidden curve, a track whose target is missing). */
  readonly muted?: boolean;
  readonly title?: string;
  readonly keys: readonly DopeKey[];
  readonly spans?: readonly DopeSpan[];
  /** Selectable bars (clips); their ids join the key ids in the selection and the box select. */
  readonly bars?: readonly DopeBar[];
}

/** How a selection click combines with what is selected: the editor's one rule (ADR 0468); `combineSelection` applies it. */
export type DopeSelectMode = SelectMode;

export interface DopeSheetGridProps {
  /** The time axis's length (seconds): x runs 0..length. */
  readonly length: number;
  readonly rows: readonly DopeRow[];
  readonly selected: ReadonlySet<string>;
  /** The row drawn as picked. */
  readonly activeRow?: string | null;
  readonly playhead: number;
  /** A range shown on the ruler (what the curve editor shows). */
  readonly range?: readonly [number, number] | null;
  /** Extra time marks on the ruler and rows (onion skin frames). */
  readonly ghosts?: readonly number[];
  /** The name over the row names ("Time"). */
  readonly axisName?: string;
  /** Width of the names column in px (default 120). */
  readonly nameWidth?: number;
  onPlayhead(t: number): void;
  onRange?(range: readonly [number, number] | null): void;
  onRow?(id: string): void;
  onSelect(ids: readonly string[], mode: DopeSelectMode): void;
  /**
   * Key `key` is dragged by `dx` seconds from where the drag began (`alt`: Alt held, no snapping), with the selection.
   * At "start" the selection the click made may not have reached `selected` yet: `key` is in it.
   */
  onDrag?(phase: "start" | "move" | "end" | "cancel", dx: number, alt: boolean, key: string): void;
  onKeyMenu?(id: string, at: { x: number; y: number }): void;
  /**
   * Bar `id`'s `part` is dragged by `dx` seconds from where the drag began (`alt`: no snapping). Pressing a bar selects it
   * first (as for keys); `onSelect` reports it. At "start" the bar is in the selection.
   */
  onBarDrag?(phase: "start" | "move" | "end" | "cancel", part: DopeBarPart, dx: number, alt: boolean, id: string): void;
  /** A bar is double-clicked (a nested timeline opens). */
  onBarOpen?(id: string): void;
  /** Something after a row's name (a remove button). */
  aside?(row: DopeRow): ComponentChildren;
}

export function DopeSheetGrid(props: DopeSheetGridProps) {
  const { rows, playhead, range, length } = props;
  const len = length > 0 ? length : 1;
  const pc = (x: number) => `${((Math.min(Math.max(x, 0), len) / len) * 100).toFixed(3)}%`;
  const grid = useRef<HTMLDivElement>(null);
  const ruler = useRef<{ rect: DOMRect; x0: number; px: number; dragged: boolean } | null>(null);
  const drag = useRef<{ rect: DOMRect; x0: number; moved: boolean } | null>(null);
  const barDrag = useRef<{ rect: DOMRect; x0: number; moved: boolean; part: DopeBarPart } | null>(null);
  const box = useRef<{ x: number; y: number; row: string; mode: DopeSelectMode } | null>(null);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const timeAt = (clientX: number, rect: DOMRect) => ((clientX - rect.left) / (rect.width || 1)) * len;
  const ticks = [0, ...axisTicks([0, len], 5), len];

  /** The keys whose diamonds lie inside the client-space box. */
  const keysIn = (a: { x: number; y: number }, b: { x: number; y: number }): string[] => {
    const el = grid.current;
    if (!el) return [];
    const [l, r, t, bt] = [Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(a.y, b.y), Math.max(a.y, b.y)];
    const hits: string[] = [];
    el.querySelectorAll<HTMLElement>("[data-key]").forEach((d) => {
      const rc = d.getBoundingClientRect();
      const cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
      if (cx >= l && cx <= r && cy >= t && cy <= bt) hits.push(d.dataset.key!);
    });
    return hits;
  };

  return (
    <div class="ce-dope-grid" ref={grid} style={props.nameWidth ? { gridTemplateColumns: `${props.nameWidth}px minmax(0, 1fr)` } : undefined}>
      <span class="ce-muted ce-dope-name">{props.axisName ?? "Time"}</span>
      <div
        class="ce-ruler"
        title="Click to move the playhead · drag to choose a range · double-click to show the whole length"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          ruler.current = { rect, x0: timeAt(e.clientX, rect), px: e.clientX, dragged: false };
        }}
        onPointerMove={(e) => {
          const r = ruler.current;
          if (!r) return;
          if (!props.onRange) {
            props.onPlayhead(playheadAt(timeAt(e.clientX, r.rect), len)); // scrub
            r.dragged = true;
            return;
          }
          if (!r.dragged && Math.abs(e.clientX - r.px) < 4) return;
          r.dragged = true;
          const picked = rulerRange(r.x0, timeAt(e.clientX, r.rect), len);
          if (picked) props.onRange(picked);
        }}
        onPointerUp={(e) => {
          const r = ruler.current;
          ruler.current = null;
          if (r && !r.dragged) props.onPlayhead(playheadAt(timeAt(e.clientX, r.rect), len));
        }}
        onPointerCancel={() => (ruler.current = null)}
        onDblClick={() => props.onRange?.(null)}
      >
        {range && <div class="ce-range" style={{ left: pc(range[0]), width: pc(range[1] - range[0]) }} />}
        {ticks.map((t, i) => (
          <span key={i} class="ce-tick" style={{ left: pc(t), transform: `translateX(${i === 0 ? "3px" : i === ticks.length - 1 ? "calc(-100% - 3px)" : "-50%"})` }}>
            {t.toFixed(2)}
          </span>
        ))}
        {props.ghosts?.map((g, i) => <div key={`g${i}`} class="ce-ghost-flag" style={{ left: pc(g) }} aria-hidden="true" />)}
        <div class="ce-playhead-flag" style={{ left: pc(playhead) }} />
      </div>
      {rows.map((row) => {
        const on = row.id === props.activeRow;
        const color = row.color ?? "var(--accent)";
        return [
          <div key={`${row.id}-n`} class={`ce-dl-cell${row.heading ? " heading" : ""}`} style={{ paddingLeft: `${(row.depth ?? 0) * 12}px` }}>
            <button type="button" class={`ce-dl${on ? " on" : ""}${row.muted ? " off" : ""}`} aria-pressed={on} title={row.title ?? row.label} onClick={() => props.onRow?.(row.id)}>
              {!row.heading && <span class="ce-swatch" style={{ background: color }} aria-hidden="true" />}
              <span class="ce-dl-name">{row.label}</span>
            </button>
            {props.aside?.(row)}
          </div>,
          <div
            key={`${row.id}-r`}
            class={`ce-drow${row.heading ? " heading" : ""}`}
            data-row={row.id}
            onPointerDown={(e) => {
              if (e.button !== 0 || e.target !== e.currentTarget) return;
              e.preventDefault();
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              box.current = { x: e.clientX, y: e.clientY, row: row.id, mode: selectModeFor(e) };
            }}
            onPointerMove={(e) => {
              const b = box.current;
              const el = grid.current;
              if (!b || !el) return;
              if (Math.abs(e.clientX - b.x) < 3 && Math.abs(e.clientY - b.y) < 3) return;
              const g = el.getBoundingClientRect();
              setMarquee({ left: Math.min(b.x, e.clientX) - g.left, top: Math.min(b.y, e.clientY) - g.top, width: Math.abs(e.clientX - b.x), height: Math.abs(e.clientY - b.y) });
            }}
            onPointerUp={(e) => {
              const b = box.current;
              box.current = null;
              if (!b) return;
              setMarquee(null);
              if (Math.abs(e.clientX - b.x) < 3 && Math.abs(e.clientY - b.y) < 3) {
                props.onRow?.(b.row);
                if (b.mode === "replace") props.onSelect([], "replace");
                return;
              }
              props.onSelect(keysIn(b, { x: e.clientX, y: e.clientY }), b.mode === "replace" ? "replace" : "add");
            }}
            onPointerCancel={() => {
              box.current = null;
              setMarquee(null);
            }}
          >
            {range && <div class="ce-range-faint" style={{ left: pc(range[0]), width: pc(range[1] - range[0]) }} />}
            {row.spans?.map((s) => <div key={s.id} class={`ce-span${s.blend ? " blend" : ""}`} style={{ left: pc(s.from), width: pc(s.to - s.from), ...(s.blend ? {} : { background: color }) }} title={s.label} />)}
            {row.bars?.map((b) => {
              const on = props.selected.has(b.id);
              const len = b.to - b.from || 1;
              /** Pointer handlers of one part: pressing selects the bar (a body press as a key press does), then the drag reports offsets. */
              const part = (p: DopeBarPart) => ({
                onPointerDown: (e: PointerEvent) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  e.preventDefault();
                  const mode = p === "move" ? selectModeFor(e) : "replace";
                  if (mode !== "replace" || !on) props.onSelect([b.id], mode);
                  if (mode === "toggle" && on) return;
                  const rect = (e.currentTarget as HTMLElement).closest<HTMLElement>(".ce-drow")!.getBoundingClientRect();
                  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                  barDrag.current = { rect, x0: timeAt(e.clientX, rect), moved: false, part: p };
                  props.onBarDrag?.("start", p, 0, e.altKey, b.id);
                },
                onPointerMove: (e: PointerEvent) => {
                  const d = barDrag.current;
                  if (!d || d.part !== p) return;
                  d.moved = true;
                  props.onBarDrag?.("move", p, timeAt(e.clientX, d.rect) - d.x0, e.altKey, b.id);
                },
                onPointerUp: (e: PointerEvent) => {
                  const d = barDrag.current;
                  if (!d || d.part !== p) return;
                  barDrag.current = null;
                  props.onBarDrag?.(d.moved ? "end" : "cancel", p, d.moved ? timeAt(e.clientX, d.rect) - d.x0 : 0, e.altKey, b.id);
                },
                onPointerCancel: () => {
                  const d = barDrag.current;
                  if (!d || d.part !== p) return;
                  barDrag.current = null;
                  props.onBarDrag?.("cancel", p, 0, false, b.id);
                },
              });
              return (
                <div key={b.id} class={`ce-bar${on ? " on" : ""}`} style={{ left: pc(b.from), width: pc(b.to - b.from), borderColor: color, background: on ? color : undefined }}>
                  {b.easeIn ? <div class="ce-bar-ease in" style={{ width: `${Math.min(100, (b.easeIn / len) * 100)}%` }} aria-hidden="true" /> : null}
                  {b.easeOut ? <div class="ce-bar-ease out" style={{ width: `${Math.min(100, (b.easeOut / len) * 100)}%` }} aria-hidden="true" /> : null}
                  <button type="button" data-key={b.id} class="ce-bar-body" aria-label={b.label} aria-pressed={on} title={b.label} onDblClick={() => props.onBarOpen?.(b.id)} {...part("move")}>
                    <span class="ce-bar-label">{b.label}</span>
                  </button>
                  <span class="ce-bar-trim start" title="Drag to trim the start" {...part("start")} />
                  <span class="ce-bar-trim end" title="Drag to trim the end" {...part("end")} />
                  <span class="ce-bar-handle in" style={{ left: `${Math.min(100, ((b.easeIn ?? 0) / len) * 100)}%` }} title="Drag to set the ease-in" {...part("easeIn")} />
                  <span class="ce-bar-handle out" style={{ right: `${Math.min(100, ((b.easeOut ?? 0) / len) * 100)}%` }} title="Drag to set the ease-out" {...part("easeOut")} />
                </div>
              );
            })}
            {props.ghosts?.map((g, i) => <div key={`g${i}`} class="ce-drow-ghost" style={{ left: pc(g) }} aria-hidden="true" />)}
            <div class="ce-drow-playhead" style={{ left: pc(playhead) }} />
            {row.keys.map((k) => {
              const s = props.selected.has(k.id);
              return (
                <button
                  key={k.id}
                  type="button"
                  data-key={k.id}
                  class={`ce-dia${s ? " on" : ""}`}
                  style={{ left: pc(k.x), borderColor: color, ...(s ? { background: color } : {}) }}
                  aria-label={k.label}
                  aria-pressed={s}
                  title={k.label}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    e.preventDefault();
                    const mode = selectModeFor(e);
                    if (mode !== "replace" || !s) props.onSelect([k.id], mode);
                    if (mode === "toggle" && s) return; // toggled off: nothing to drag
                    const rect = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
                    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                    drag.current = { rect, x0: timeAt(e.clientX, rect), moved: false };
                    props.onDrag?.("start", 0, e.altKey, k.id);
                  }}
                  onPointerMove={(e) => {
                    const d = drag.current;
                    if (!d) return;
                    d.moved = true;
                    props.onDrag?.("move", timeAt(e.clientX, d.rect) - d.x0, e.altKey, k.id);
                  }}
                  onPointerUp={(e) => {
                    const d = drag.current;
                    drag.current = null;
                    if (!d) return;
                    if (d.moved) props.onDrag?.("end", timeAt(e.clientX, d.rect) - d.x0, e.altKey, k.id);
                    else props.onDrag?.("cancel", 0, e.altKey, k.id);
                  }}
                  onPointerCancel={() => {
                    if (!drag.current) return;
                    drag.current = null;
                    props.onDrag?.("cancel", 0, false, k.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!s) props.onSelect([k.id], "replace");
                    props.onKeyMenu?.(k.id, { x: e.clientX, y: e.clientY });
                  }}
                />
              );
            })}
          </div>,
        ];
      })}
      {marquee && <div class="ce-marquee" style={{ left: `${marquee.left}px`, top: `${marquee.top}px`, width: `${marquee.width}px`, height: `${marquee.height}px` }} aria-hidden="true" />}
    </div>
  );
}
