// The Profiler's Record button in the player bar (ADR 0348 "Profiling a take as it plays"; the prototype's togRec):
// it records the Studio's own runtime while it plays something (an audition, a take's replay), and Stop saves the
// capture into the project's captures folder. Disabled, with why, while nothing plays. A view over props, drawn as the
// player bar's `TransportButton` (ADR 0361) with its name beside the dot, in the prototype's record look (`.btn.rec`:
// the danger edge and tint while it can record, the dot red).
import { TransportButton } from "../../components/PlayerBar";

export interface RecordButtonProps {
  readonly recording: boolean;
  /** Saving after Stop. */
  readonly busy: boolean;
  /** Why it can't record now, or null. */
  readonly blocked: string | null;
  onToggle(): void;
}

export function RecordButton(props: RecordButtonProps) {
  const disabled = props.busy || (!props.recording && props.blocked !== null);
  const title = props.recording ? "Stop recording and save the capture into the selected folder" : (props.blocked ?? "Record: capture the Studio's runtime as a new capture");
  return (
    <span class={`pf-record${props.recording ? " on" : ""}`}>
      <TransportButton icon="record" text record label={props.recording ? "Stop recording" : props.busy ? "Saving…" : "Record"} pressed={props.recording} disabled={disabled} title={title} onClick={() => props.onToggle()} />
    </span>
  );
}

/** Why the Studio's runtime can't be recorded now (null: it can). */
export function whyNotRecord(state: {
  readonly playable: boolean;
  readonly voices: number;
  /** A take replays (the game session): recordable even while it sounds nothing of this project. */
  readonly replaying?: boolean;
}): string | null {
  if (!state.playable) return "The Studio's audio runtime isn't running";
  if (state.voices === 0 && !state.replaying) return "Nothing is playing: audition a playlist or replay a take, then record";
  return null;
}
