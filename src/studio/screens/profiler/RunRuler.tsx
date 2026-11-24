// The Take and Profiler playhead ruler (spec §4.5.4, §4.6.3; the prototype's ruler row): the head shows "PLAYHEAD" and
// the time in 14px figures; the lane has second labels, a strip of small ticks and the accent triangle at the playhead.
// Press and drag scrubs (a pointer drag, so touch works); the arrow keys step it as a slider. Extra marks (the
// Profiler's problems) go in as children, positioned in percent. And the playhead line itself, glowing, for the lanes
// below. Views over props.
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { formatTime, type TimeSpan } from "../../components/timeRulerModel";
import { useElementWidth } from "../../components/useElementWidth";
import { rulerMarks } from "./runRulerModel";
import "./runRuler.css";

const CTX = { rate: 48000 } as const;

/** The playhead as the ruler head shows it: "00:20.480". */
export const playheadText = (t: number): string => formatTime(Math.max(0, t), "timecode", CTX);

export interface RunRulerProps {
  readonly duration: number;
  /** The playhead, seconds. */
  readonly time: number;
  /** The slider's accessible name ("Take time"). */
  readonly label: string;
  onSeek(t: number, done: boolean): void;
  /** The seconds the lane shows (a zoomed timeline); default the whole `duration`. */
  readonly view?: TimeSpan;
  /** Marks over the lane (positioned by the caller, in percent of the view). */
  readonly children?: ComponentChildren;
}

const pct = (t: number, view: TimeSpan) => {
  const d = view.end - view.start;
  return d > 0 ? ((t - view.start) / d) * 100 : 0;
};
/** The whole `[0, duration]`, or the view. */
const within = (t: number, duration: number) => Math.min(Math.max(t, 0), Math.max(0, duration));
const spanOf = (duration: number, view?: TimeSpan): TimeSpan => view ?? { start: 0, end: Math.max(0.001, duration) };

export function RunRuler(props: RunRulerProps) {
  const lane = useRef<HTMLDivElement>(null);
  const width = useElementWidth(lane);
  const d = Math.max(0.001, props.duration);
  const v = spanOf(props.duration, props.view);
  const span = v.end - v.start;
  const marks = rulerMarks(span, width, v.start);
  const head = within(props.time, props.duration);
  const at = (e: PointerEvent) => {
    const r = lane.current!.getBoundingClientRect();
    return r.width > 0 ? v.start + (Math.min(Math.max(e.clientX - r.left, 0), r.width) / r.width) * span : 0;
  };
  return (
    <div class="run-ruler-row">
      <div class="run-ruler-head">
        <span class="run-cap">Playhead</span>
        <span class="run-readout" aria-live="off">{playheadText(props.time)}</span>
      </div>
      <div
        ref={lane}
        class="run-ruler"
        role="slider"
        tabIndex={0}
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={d}
        aria-valuenow={props.time}
        aria-valuetext={playheadText(props.time)}
        title="Click or drag to move the playhead"
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          props.onSeek(at(e), false);
        }}
        onPointerMove={(e) => {
          if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) props.onSeek(at(e), false);
        }}
        onPointerUp={(e) => {
          if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) props.onSeek(at(e), true);
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 1 : 0.1;
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            props.onSeek(Math.min(d, Math.max(0, props.time + (e.key === "ArrowLeft" ? -step : step))), true);
          } else if (e.key === "Home" || e.key === "End") {
            e.preventDefault();
            props.onSeek(e.key === "Home" ? 0 : d, true);
          }
        }}
      >
        {marks.labels.map((m, i) => (
          <span key={m.t} class={`run-label${i === 0 && m.t <= v.start + span * 0.02 ? " first" : ""}${pct(m.t, v) > 96 ? " last" : ""}`} style={{ left: `${pct(m.t, v)}%` }}>
            {m.text}
          </span>
        ))}
        <span class="run-ticks" style={{ backgroundSize: `${Math.max(2, (marks.tick / span) * 100)}% 100%`, backgroundPosition: `${-((v.start % marks.tick) / span) * width}px 0` }} aria-hidden="true" />
        {props.children}
        {head >= v.start - 1e-9 && head <= v.end + 1e-9 && <span class="run-head" style={{ left: `${pct(head, v)}%` }} aria-hidden="true" />}
      </div>
    </div>
  );
}

/** The playhead line through the lanes under the ruler (1px accent, glowing). */
export function RunPlayhead(props: { readonly time: number; readonly duration: number; readonly view?: TimeSpan }) {
  const v = spanOf(props.duration, props.view);
  const t = within(props.time, props.duration);
  if (t < v.start - 1e-9 || t > v.end + 1e-9) return null;
  return <div class="run-playhead" style={{ left: `${pct(t, v)}%` }} aria-hidden="true" />;
}
