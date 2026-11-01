import { useEffect, useRef, useState } from "preact/hooks";
import { layoutHistory, relativeTime } from "../historyLayout";
import { docVersion, openScene } from "../state";
import "./history.css";

const ROW = 22;
const COL = 16;
const PAD = 10;

/**
 * The open scene's edit history as a tree (ADR 0027), like the undotree plugin: newest state at
 * the top, a column per branch, the current state filled, the saved state marked. Click a state
 * to jump to it; nothing is lost when you then edit, since edits start a new branch.
 */
export function HistoryPanel() {
  docVersion.value; // re-render on every history change
  const scene = openScene.value;
  const list = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  const stack = scene?.stack;
  const current = stack?.current;
  useEffect(() => {
    list.current?.querySelector(".history-row.current")?.scrollIntoView({ block: "nearest" });
  }, [current, docVersion.value]);
  if (!scene || !stack) return <p class="empty">No scene open</p>;

  const states = stack.allStates;
  const layout = layoutHistory(states);
  const rowOf = new Map(layout.rows.map((r, i) => [r.seq, i]));
  const byseq = new Map(states.map((s) => [s.seq, s]));
  const width = PAD * 2 + (layout.columns - 1) * COL;
  const x = (col: number) => PAD + col * COL;
  const y = (row: number) => row * ROW + ROW / 2;
  const colOf = new Map(layout.rows.map((r) => [r.seq, r.col]));

  return (
    <div class="history-panel">
      <div class="history-hint" title="Ctrl/Cmd+Alt+Z and Ctrl/Cmd+Alt+Shift+Z step back and forward through states in the order they were made (like Vim's g- / g+)">
        Click a state to go there · Ctrl+Alt+Z / Ctrl+Alt+Shift+Z: step by time
      </div>
      <div class="history-list" ref={list} role="list" aria-label="Edit history">
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
            <circle
              key={r.seq}
              cx={x(r.col)}
              cy={y(i)}
              r={r.seq === current ? 5 : 3.5}
              class={`history-dot${r.seq === current ? " current" : ""}${r.seq === stack.saved ? " saved" : ""}`}
            />
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
              title={`${s.label} · state ${s.seq}${r.seq === stack.saved ? " · saved" : ""}`}
              onClick={() => stack.jumpTo(r.seq)}
            >
              <span class="history-label">{s.label}</span>
              {r.seq === stack.saved && <span class="history-saved" title="Matches the file as last saved">saved</span>}
              <span class="history-time">{relativeTime(s.time, now)}</span>
            </div>
          );
        })}
        <div style={{ height: `${layout.rows.length * ROW}px` }} />
      </div>
    </div>
  );
}
