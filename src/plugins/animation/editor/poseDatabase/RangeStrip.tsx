// One clip's tagged ranges on a strip (ADR 0373 "pick clips and tag ranges"; T55). The strip is the clip's length; each
// range is a coloured segment labelled with its tags. Drag a segment's edges to change its start or end, its body to move
// it, or drag on the empty strip to add a range; the edit is reported once, on release (so it is one undo step). The
// number fields beside the strip (PoseDatabaseEditor) do the same by typing. Colours are the theme's series tokens.
import { useRef, useState } from "preact/hooks";
import type { PoseRange } from "../../../../engine/animation/poseDatabase";
import { colorSlot, dragRange, percentOf, rangeLabel, timeAt, type RangeDrag } from "./timelineStripLogic";

/** The shortest range a drag on the empty strip makes (s). */
const MIN_NEW = 0.05;

export interface RangeStripProps {
  readonly clip: string;
  /** The clip's length in seconds, or 0 while it is unknown (the strip then spans the ranges). */
  readonly duration: number;
  readonly ranges: readonly PoseRange[];
  /** Every tag of the database in order, for colours. */
  readonly tagOrder: readonly string[];
  readonly selected: number | null;
  readonly disabled?: boolean;
  onSelect(range: number | null): void;
  onChange(range: number, from: number, to: number): void;
  onAdd(from: number, to: number): void;
}

type Gesture = { kind: "range"; index: number; part: RangeDrag; x0: number; from: number; to: number } | { kind: "new"; x0: number; t0: number; t1: number };

export function RangeStrip(props: RangeStripProps) {
  const { ranges, selected, disabled } = props;
  const bar = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  // While the clip's length is unknown the strip spans what is on it, so it still reads.
  const span = props.duration > 0 ? props.duration : Math.max(1, ...ranges.map((r) => r.to));
  const width = () => bar.current?.getBoundingClientRect().width || 1;
  const secondsOf = (dx: number) => (dx / width()) * span;

  const shown = ranges.map((r, i) => (gesture?.kind === "range" && gesture.index === i ? { ...r, from: gesture.from, to: gesture.to } : r));
  const fresh = gesture?.kind === "new" ? { from: Math.min(gesture.t0, gesture.t1), to: Math.max(gesture.t0, gesture.t1) } : null;

  const startRange = (e: PointerEvent, index: number, part: RangeDrag) => {
    e.stopPropagation();
    props.onSelect(index);
    if (disabled) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setGesture({ kind: "range", index, part, x0: e.clientX, from: ranges[index]!.from, to: ranges[index]!.to });
  };
  const startNew = (e: PointerEvent) => {
    props.onSelect(null);
    if (disabled) return;
    const rect = bar.current?.getBoundingClientRect();
    if (!rect) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const t = timeAt((e.clientX - rect.left) / rect.width, span);
    setGesture({ kind: "new", x0: e.clientX, t0: t, t1: t });
  };
  const move = (e: PointerEvent) => {
    if (!gesture) return;
    if (gesture.kind === "range") {
      const base = ranges[gesture.index]!;
      const next = dragRange(base, gesture.part, secondsOf(e.clientX - gesture.x0), props.duration);
      setGesture({ ...gesture, ...next });
    } else {
      const rect = bar.current?.getBoundingClientRect();
      if (rect) setGesture({ ...gesture, t1: timeAt((e.clientX - rect.left) / rect.width, span) });
    }
  };
  const end = () => {
    const g = gesture;
    setGesture(null);
    if (!g) return;
    if (g.kind === "range") {
      const base = ranges[g.index]!;
      if (g.from !== base.from || g.to !== base.to) props.onChange(g.index, g.from, g.to);
    } else {
      const from = Math.min(g.t0, g.t1), to = Math.max(g.t0, g.t1);
      if (to - from >= MIN_NEW) props.onAdd(from, props.duration > 0 ? Math.min(to, props.duration) : to);
    }
  };

  return (
    <div class="posedb-strip" role="group" aria-label={`Ranges of ${props.clip}`}>
      <div ref={bar} class="posedb-strip-bar" data-disabled={disabled ? "" : undefined} onPointerDown={startNew} onPointerMove={move} onPointerUp={end} onPointerCancel={() => setGesture(null)}>
        {ranges.length === 0 && !fresh && <span class="posedb-strip-whole">the whole clip, untagged</span>}
        {shown.map((r, i) => {
          const left = percentOf(r.from, span), right = percentOf(r.to, span);
          return (
            <div
              key={i}
              class={`posedb-range slot-${colorSlot(props.tagOrder, r)}${selected === i ? " selected" : ""}`}
              style={{ left: `${left}%`, width: `${Math.max(right - left, 0.5)}%` }}
              role="button"
              tabIndex={0}
              aria-label={`Range ${i + 1}: ${rangeLabel(r)}`}
              aria-pressed={selected === i}
              title={rangeLabel(r)}
              onPointerDown={(e) => startRange(e, i, "move")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") props.onSelect(i);
              }}
            >
              <span class="posedb-range-edge start" aria-hidden="true" onPointerDown={(e) => startRange(e, i, "start")} />
              <span class="posedb-range-label">{r.tags.join(" ") || `${r.from.toFixed(1)}–${r.to.toFixed(1)}`}</span>
              <span class="posedb-range-edge end" aria-hidden="true" onPointerDown={(e) => startRange(e, i, "end")} />
            </div>
          );
        })}
        {fresh && <div class="posedb-range slot-0 fresh" style={{ left: `${percentOf(fresh.from, span)}%`, width: `${Math.max(percentOf(fresh.to, span) - percentOf(fresh.from, span), 0.5)}%` }} />}
      </div>
      <div class="posedb-strip-scale" aria-hidden="true">
        <span>0</span>
        <span>{span.toFixed(2)} s</span>
      </div>
    </div>
  );
}
