// The Take screen's "Record from a build" controls (ADR 0348, ADR 0403, plan U5): shown above the Takes list while a
// build is connected. Start records a take on the build; while it records, a marker text and Mark, and Stop; once
// stopped, Save uploads the take into the project's takes/ folder, with the chunks received as it comes. A failure says
// why (with Save again when the build still holds the take). A view over props (`recordFromBuild.ts` is the flow).
import { useState } from "preact/hooks";
import { buildTakeStatus, type BuildTakeState } from "./recordFromBuild";
import "./buildTake.css";

export interface BuildTakeControlsProps {
  /** The connected build's name. */
  readonly build: string;
  readonly state: BuildTakeState;
  /** Writing into the project is possible (a writable project is open); Save says why not otherwise. */
  readonly whyNotSave: string | null;
  onStart(): void;
  onMark(text: string): void;
  onStop(): void;
  onSave(): void;
  onDismiss(): void;
}

export function BuildTakeControls(props: BuildTakeControlsProps) {
  const [text, setText] = useState("");
  const s = props.state;
  const status = buildTakeStatus(s, props.build);
  const canSave = s.kind === "stopped" || s.kind === "recording" || (s.kind === "failed" && s.canSave);
  const saveButton = (
    <button type="button" class="tk-btn bt-primary" disabled={props.whyNotSave !== null} title={props.whyNotSave ?? `Upload the take from ${props.build} into takes/`} onClick={() => props.onSave()}>
      Save into takes/
    </button>
  );
  let actions;
  if (s.kind === "recording") {
    const mark = () => {
      props.onMark(text.trim() || "Mark");
      setText("");
    };
    actions = (
      <>
        <input
          class="bt-mark-text"
          type="text"
          aria-label="Marker text"
          placeholder="Marker text"
          maxLength={120}
          value={text}
          onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") mark();
          }}
        />
        <button type="button" class="tk-btn" title="Mark this moment of the take on the build" onClick={mark}>
          Mark
        </button>
        <button type="button" class="tk-btn bt-stop" title={`Stop the take on ${props.build}`} onClick={() => props.onStop()}>
          Stop
        </button>
      </>
    );
  } else if (s.kind === "starting" || s.kind === "stopping" || s.kind === "saving") {
    actions = null;
  } else if (s.kind === "uploading") {
    actions = <progress class="bt-progress" aria-label="Chunks received" max={s.chunks} value={s.received} />;
  } else {
    actions = (
      <>
        <button type="button" class="tk-btn" title={`Record a new take on ${props.build}`} onClick={() => props.onStart()}>
          {s.kind === "stopped" ? "New take" : "Start take"}
        </button>
        {canSave && saveButton}
        {(s.kind === "saved" || s.kind === "failed") && (
          <button type="button" class="tk-btn" onClick={() => props.onDismiss()}>
            Dismiss
          </button>
        )}
      </>
    );
  }
  return (
    <section class="bt-controls" aria-label={`Record from ${props.build}`}>
      <div class="bt-head">
        <span class={`bt-dot${s.kind === "recording" ? " on" : ""}`} aria-hidden="true" />
        <strong class="bt-title" title={props.build}>
          {props.build}
        </strong>
      </div>
      <div class="bt-actions">{actions}</div>
      {status && (
        <p class={s.kind === "failed" ? "bt-error" : "bt-status"} role={s.kind === "failed" ? "alert" : "status"}>
          {status}
        </p>
      )}
    </section>
  );
}
