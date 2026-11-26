// The Take screen's "Record from a build" controls (ADR 0348, ADR 0403, plan U5): shown above the Takes list while a
// build is connected. Start records a take on the build; while it records, a marker text and Mark, and Stop; once
// stopped, Save uploads the take into the project's recordings/ folder (a takes folder workspace's own folder, shown with
// Change…, ADR 0408), with the chunks received as it comes. A failure says
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
  /** Where Save writes the take, as shown (default "recordings/", the project's folder; a takes folder's path, ADR 0408). */
  readonly into?: string;
  /** Change… the folder takes save to (offered only for a takes folder, ADR 0408). */
  onChangeFolder?(): void;
  onStart(): void;
  onMark(text: string): void;
  onStop(): void;
  onSave(): void;
  onDismiss(): void;
}

export function BuildTakeControls(props: BuildTakeControlsProps) {
  const [text, setText] = useState("");
  const s = props.state;
  const into = props.into ?? "recordings/";
  const status = buildTakeStatus(s, props.build, into);
  const canSave = s.kind === "stopped" || s.kind === "recording" || (s.kind === "failed" && s.canSave);
  const saveButton = (
    <button type="button" class="tk-btn bt-primary" disabled={props.whyNotSave !== null} title={props.whyNotSave ?? `Upload the take from ${props.build} into ${into}`} onClick={() => props.onSave()}>
      {props.into ? "Save take" : "Save into recordings/"}
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
      {props.into && (
        <p class="bt-into">
          <span class="bt-into-label">Takes save to</span>{" "}
          <span class="bt-into-path" title={props.into}>
            {props.into}
          </span>
          {props.onChangeFolder && (
            <button type="button" class="tk-btn bt-into-change" title="Choose the folder recorded takes are saved to" onClick={() => props.onChangeFolder!()}>
              Change…
            </button>
          )}
        </p>
      )}
      {status && (
        <p class={s.kind === "failed" ? "bt-error" : "bt-status"} role={s.kind === "failed" ? "alert" : "status"}>
          {status}
        </p>
      )}
    </section>
  );
}
