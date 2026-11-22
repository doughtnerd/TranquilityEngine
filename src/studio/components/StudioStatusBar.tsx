// The Studio's status bar (ADR 0335 `StudioStatusBar`): the editor's last status message on the left, the audio
// runtime's state and figures (`statusBarModel.ts`, from the runtime's public debug info) on the right.
import type { StudioAudioStats } from "../runtime/audioStats";
import type { StudioAudioState } from "../runtime/studioAudioHost";
import { statusParts } from "./statusBarModel";
import "./studioComponents.css";

export interface StudioStatusBarProps {
  readonly state: StudioAudioState;
  readonly stats: StudioAudioStats | null;
  /** The last message (project opened, a save failed). */
  readonly message?: { readonly kind: "info" | "error" | "warning"; readonly text: string } | null;
  /** The output device's name. */
  readonly device?: string;
}

export function StudioStatusBar(props: StudioStatusBarProps) {
  const parts = statusParts(props.state, props.stats);
  return (
    <div class="studio-status" role="status">
      <span class={`studio-status-message${props.message ? ` ${props.message.kind}` : ""}`} title={props.message?.text}>
        {props.message?.text ?? ""}
      </span>
      <span class="studio-status-parts">
        {parts.map((p, i) => (
          <span key={i} class={`studio-status-part${p.tone ? ` ${p.tone}` : ""}`} title={p.title}>
            {p.text}
          </span>
        ))}
        {props.device && props.state.kind !== "failed" && props.state.kind !== "idle" && (
          <span class="studio-status-part muted" title="Output device">
            {props.device}
          </span>
        )}
      </span>
    </div>
  );
}
