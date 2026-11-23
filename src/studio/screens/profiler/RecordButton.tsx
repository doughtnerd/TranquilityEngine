// The Profiler's Record button in the player bar (ADR 0348 "Profiling a take as it plays"; the prototype's togRec):
// it records the Studio's own runtime while it plays something (an audition, a take's replay), and Stop saves the
// capture into the project's captures folder. Disabled, with why, while nothing plays. A view over props.
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
  const title = props.recording ? "Stop and save the capture into the project's captures folder" : (props.blocked ?? "Record a capture of the Studio's runtime");
  return (
    <button type="button" class={`pf-record${props.recording ? " on" : ""}`} aria-pressed={props.recording} disabled={disabled} title={title} onClick={() => props.onToggle()}>
      <span class="pf-record-dot" aria-hidden="true" />
      {props.recording ? "Stop" : props.busy ? "Saving…" : "Record"}
    </button>
  );
}

/** Why the Studio's runtime can't be recorded now (null: it can). */
export function whyNotRecord(state: { readonly playable: boolean; readonly voices: number }): string | null {
  if (!state.playable) return "The Studio's audio runtime isn't running";
  if (state.voices === 0) return "Nothing is playing: audition a playlist or replay a take, then record";
  return null;
}
