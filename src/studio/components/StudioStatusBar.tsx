// The Studio's status bar (ADR 0349 `StudioStatusBar`; the prototype's status bar, spec §3.6): the audio core's
// readouts on the left and the device, voice cap, meters and saved state on the right (`statusBarModel.ts`, from the
// runtime's public debug info), with the editor's last status message between them.
import type { StudioAudioStats } from "../runtime/audioStats";
import type { StudioAudioState } from "../runtime/studioAudioHost";
import { statusReadouts, type StatusContext, type StatusPart } from "./statusBarModel";
import "./studioComponents.css";

export interface StudioStatusBarProps extends StatusContext {
  readonly state: StudioAudioState;
  readonly stats: StudioAudioStats | null;
  /** The last message (project opened, a save failed). */
  readonly message?: { readonly kind: "info" | "error" | "warning"; readonly text: string } | null;
}

function Parts(props: { parts: readonly StatusPart[]; class: string }) {
  return (
    <span class={`studio-status-parts ${props.class}`}>
      {props.parts.map((p, i) => (
        <span key={i} class={`studio-status-part${p.tone ? ` ${p.tone}` : ""}`} title={p.title}>
          {p.text}
        </span>
      ))}
    </span>
  );
}

export function StudioStatusBar(props: StudioStatusBarProps) {
  const { left, right } = statusReadouts(props.state, props.stats, props);
  return (
    <div class="studio-status" role="status" aria-label="Engine status">
      <Parts parts={left} class="left" />
      <span class={`studio-status-message${props.message ? ` ${props.message.kind}` : ""}`} title={props.message?.text}>
        {props.message?.text ?? ""}
      </span>
      <Parts parts={right} class="right" />
    </div>
  );
}
