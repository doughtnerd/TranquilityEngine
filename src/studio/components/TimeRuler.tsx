// The time ruler (ADR 0349 `TimeRuler`): ticks and labels for a view in one of the three time displays
// (`timeRulerModel.ts`). Pressing and dragging on it scrubs: `onScrub` gets the time under the pointer, with `done`
// on release. It is a slider for assistive tech (`aria-valuetext` the position in the display's words).
import { useRef } from "preact/hooks";
import { useElementWidth } from "./useElementWidth";
import { formatTime, rulerTicks, type TimeContext, type TimeFormat, type TimeSpan } from "./timeRulerModel";
import { timeToX, xToTime } from "./waveformModel";
import "./timelineComponents.css";

export interface TimeRulerProps {
  readonly view: TimeSpan;
  readonly format: TimeFormat;
  readonly context: TimeContext;
  /** The playhead, for the slider's value. */
  readonly position?: number;
  /** The whole length (the slider's max). */
  readonly length?: number;
  readonly label?: string;
  onScrub?(t: number, done: boolean): void;
}

export function TimeRuler(props: TimeRulerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const { view, format, context } = props;
  const ticks = rulerTicks(view, width, format, context);
  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, xToTime(e.clientX - r.left, view, r.width));
  };
  const pos = props.position ?? view.start;
  return (
    <div
      ref={ref}
      class="tl-ruler"
      role="slider"
      tabIndex={-1}
      aria-label={props.label ?? "Time"}
      aria-valuemin={0}
      aria-valuemax={props.length ?? view.end}
      aria-valuenow={pos}
      aria-valuetext={formatTime(pos, format, context)}
      onPointerDown={(e) => {
        if (!props.onScrub || e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        props.onScrub(at(e), false);
      }}
      onPointerMove={(e) => {
        if (props.onScrub && (e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) props.onScrub(at(e), false);
      }}
      onPointerUp={(e) => {
        if (props.onScrub && (e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) props.onScrub(at(e), true);
      }}
    >
      {ticks.map((t) => (
        <div key={t.t} class={`tl-tick${t.major ? " major" : ""}`} style={{ left: `${timeToX(t.t, view, width)}px` }}>
          {t.label && <span class="tl-tick-label">{t.label}</span>}
        </div>
      ))}
    </div>
  );
}
