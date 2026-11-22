// The player bar's replay slot (ADR 0334, 0335 `PlayerBar`; owner decision 2026-11-22: take replay stands in for the
// game session in v1): the open take on every screen, with play/pause, a scrub over the take and its time, a link to the
// Take screen and a close. A view over props; the shell wires it to the replay store (`shell/ReplaySlot.tsx`).
import { formatClock } from "./replayControlsModel";
import "./replayControls.css";

export interface ReplayControlsProps {
  readonly title: string;
  /** Take seconds. */
  readonly time: number;
  readonly duration: number;
  readonly playing: boolean;
  onToggle(): void;
  onSeek(t: number): void;
  /** Show the take on the Take screen (absent: already there). */
  onShow?(): void;
  onClose(): void;
}

export function ReplayControls(props: ReplayControlsProps) {
  const { time, duration } = props;
  return (
    <div class="studio-replay" role="group" aria-label={`Take replay: ${props.title}`}>
      <button type="button" class="studio-replay-play" aria-label={props.playing ? "Pause the take" : "Replay the take"} aria-pressed={props.playing} title={props.playing ? "Pause the take" : "Replay the take: its requests drive your current audio"} onClick={props.onToggle}>
        {props.playing ? "❚❚" : "▶"}
      </button>
      {props.onShow ? (
        <button type="button" class="studio-replay-title" title="Show this take on the Take screen" onClick={props.onShow}>
          {props.title}
        </button>
      ) : (
        <span class="studio-replay-title">{props.title}</span>
      )}
      <input
        type="range"
        class="studio-replay-scrub"
        aria-label="Take position"
        aria-valuetext={`${formatClock(time)} of ${formatClock(duration)}`}
        min={0}
        max={Math.max(0.001, duration)}
        step={0.01}
        value={time}
        onInput={(e) => props.onSeek(Number((e.currentTarget as HTMLInputElement).value))}
      />
      <span class="studio-replay-time">{formatClock(time)}</span>
      <button type="button" class="studio-replay-close" aria-label="Close the take" title="Close the take (its sounds stop)" onClick={props.onClose}>
        ×
      </button>
    </div>
  );
}
