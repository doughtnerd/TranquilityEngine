// A tree of states drawn like the undotree plugin (ADR 0027, 0174): newest at the top, a column per
// branch, the current state filled and a marked one (the History panel's "saved") outlined. Click a
// state to pick it. The History panel shows the scene's edit history with it, and Manage Layouts a
// layout's saved versions. `layoutHistory` (historyLayout.ts) does the layout.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { layoutHistory, relativeTime } from "../../historyLayout";
import "../history.css";

const ROW = 22;
const COL = 16;
const PAD = 10;

export interface UndoTreeState {
  readonly seq: number;
  /** The parent state's `seq` (0, or any seq not listed, for a root). */
  readonly parent: number;
  readonly label: string;
  /** When it was made (ms since the epoch), shown relative to now. */
  readonly time: number;
}

export interface UndoTreeProps {
  states: readonly UndoTreeState[];
  /** The current state's seq (filled, scrolled into view). */
  current?: number;
  /** A state to mark (outlined, with `markLabel` beside it), e.g. the saved one. */
  marked?: number;
  /** The mark's text ("saved"); default "saved". */
  markLabel?: string;
  /** The mark's tooltip. */
  markTitle?: string;
  /** A state's tooltip; default "<label> · state <seq>". */
  titleOf?(state: UndoTreeState): string;
  onPick(seq: number): void;
  /** The list's accessible name. */
  label: string;
  /** Something to re-scroll on besides `current` (another tree shown in the same place). */
  scrollKey?: unknown;
  /** Extra content for a row, after its label (buttons). */
  rowExtra?(state: UndoTreeState): ComponentChildren;
}

export function UndoTree(props: UndoTreeProps) {
  const { states, current, marked } = props;
  const list = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    list.current?.querySelector(".history-row.current")?.scrollIntoView({ block: "nearest" });
  }, [current, states.length, props.scrollKey]);

  const layout = layoutHistory(states);
  const rowOf = new Map(layout.rows.map((r, i) => [r.seq, i]));
  const byseq = new Map(states.map((s) => [s.seq, s]));
  const width = PAD * 2 + (layout.columns - 1) * COL;
  const x = (col: number) => PAD + col * COL;
  const y = (row: number) => row * ROW + ROW / 2;
  const colOf = new Map(layout.rows.map((r) => [r.seq, r.col]));
  const markLabel = props.markLabel ?? "saved";

  return (
    <div class="history-list" ref={list} role="list" aria-label={props.label}>
      <svg class="history-gutter" width={width} height={layout.rows.length * ROW} aria-hidden="true">
        {layout.rows.map((r) => {
          const pRow = rowOf.get(r.parent);
          if (pRow === undefined) return null;
          const cx = x(r.col), cy = y(rowOf.get(r.seq)!);
          const px = x(colOf.get(r.parent)!), py = y(pRow);
          // Down the branch's own column, then across to the parent.
          const d = cx === px ? `M${cx},${cy} L${px},${py}` : `M${cx},${cy} L${cx},${py - ROW / 2} L${px},${py}`;
          return <path key={r.seq} d={d} class="history-edge" />;
        })}
        {layout.rows.map((r, i) => (
          <circle key={r.seq} cx={x(r.col)} cy={y(i)} r={r.seq === current ? 5 : 3.5} class={`history-dot${r.seq === current ? " current" : ""}${r.seq === marked ? " saved" : ""}`} />
        ))}
      </svg>
      {layout.rows.map((r, i) => {
        const s = byseq.get(r.seq)!;
        const isCurrent = r.seq === current;
        return (
          <div
            key={r.seq}
            role="listitem"
            class={`history-row${isCurrent ? " current" : ""}`}
            style={{ top: `${i * ROW}px`, left: `${width}px` }}
            data-seq={r.seq}
            aria-current={isCurrent ? "step" : undefined}
            title={props.titleOf?.(s) ?? `${s.label} · state ${s.seq}${r.seq === marked ? ` · ${markLabel}` : ""}`}
            onClick={() => props.onPick(r.seq)}
          >
            <span class="history-label">{s.label}</span>
            {r.seq === marked && (
              <span class="history-saved" title={props.markTitle}>
                {markLabel}
              </span>
            )}
            {props.rowExtra?.(s)}
            <span class="history-time">{relativeTime(s.time, now)}</span>
          </div>
        );
      })}
      <div style={{ height: `${layout.rows.length * ROW}px` }} />
    </div>
  );
}
