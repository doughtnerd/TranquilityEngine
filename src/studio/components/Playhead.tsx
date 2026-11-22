// The playhead (ADR 0335 `Playhead`): a vertical line at a time in a view, laid over a waveform or a lane. Hidden
// when the time is outside the view. Where the time comes from is `playheadModel.ts`'s (the audio clock).
import type { TimeSpan } from "./timeRulerModel";
import "./timelineComponents.css";

export interface PlayheadProps {
  readonly t: number;
  readonly view: TimeSpan;
  /** Playing (drawn in the accent colour) or parked (muted). */
  readonly playing?: boolean;
  readonly label?: string;
}

export function Playhead(props: PlayheadProps) {
  const { t, view } = props;
  if (t < view.start || t > view.end) return null;
  const pct = ((t - view.start) / (view.end - view.start)) * 100;
  return <div class={`tl-playhead${props.playing ? " playing" : ""}`} style={{ left: `${pct}%` }} aria-hidden="true" title={props.label} />;
}
