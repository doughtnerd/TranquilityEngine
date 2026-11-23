// ADR 0348: one record toggle's button (Record take, Record capture) over its `RecordToggle` model: pressed while
// recording, disabled outside Play unless a recording is still running, its tooltip the model's state in words.
import { useEffect, useState } from "preact/hooks";
import { recordToggleTitle, type RecordToggle } from "./recordToggleModel";
import "./recordToggles.css";

/** A toggle's button, given its model and whether the editor plays. */
export function RecordButton(props: { model: RecordToggle; playing: boolean; label: string }) {
  const { model, playing } = props;
  const [, bump] = useState(0);
  useEffect(() => model.subscribe(() => bump((n) => n + 1)), [model]);
  // While recording, the tooltip's seconds move; once a second is enough.
  useEffect(() => {
    if (!model.recording) return;
    const id = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [model, model.recording]);
  // Play stopped while recording: the recorder kept the take; write it now.
  useEffect(() => {
    if (!playing && model.recording) void model.stop();
  }, [playing, model]);
  const s = model.state;
  const busy = s.kind === "starting" || s.kind === "saving";
  return (
    <button
      class={`record-toggle record-${model.kind}${model.recording ? " active" : ""}`}
      aria-pressed={model.recording}
      disabled={busy || (!playing && !model.recording)}
      title={recordToggleTitle(model.kind, s, model.seconds, playing)}
      onClick={() => void model.toggle()}
    >
      <span class="record-dot" aria-hidden="true">●</span> {props.label}
    </button>
  );
}
