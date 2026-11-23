// ADR 0348: one record toggle's button (Record take, Record capture) over its `RecordToggle` model: pressed while
// recording, disabled outside Play unless a recording is still running, its tooltip the model's state in words.
import { useEffect, useState } from "preact/hooks";
import { recordToggleTitle, type RecordToggle } from "./recordToggleModel";
import "./recordToggles.css";

/** A toggle's button, given its model and whether the editor plays. */
export function RecordButton(props: { model: RecordToggle; playing: boolean; label: string }) {
  const { model, playing } = props;
  const [, bump] = useState(0);
  // Effects run after paint: a press (or Play stopping) can change the model before this subscribes, so draw once more then.
  useEffect(() => {
    const stop = model.subscribe(() => bump((n) => n + 1));
    bump((n) => n + 1);
    return stop;
  }, [model]);
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
      class={`icon-button record-toggle record-${model.kind}${model.recording ? " active" : ""}`}
      aria-label={props.label}
      aria-pressed={model.recording}
      disabled={busy || (!playing && !model.recording)}
      title={recordToggleTitle(model.kind, s, model.seconds, playing)}
      onClick={() => void model.toggle()}
    >
      <span class="record-dot"><RecordIcon /></span>
    </button>
  );
}

/** The Record icon (a filled dot), in `currentColor`; drawn like the editor's tool icons (class `tool-icon`). */
const RecordIcon = () => (
  <svg class="tool-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor"><circle cx="8" cy="8" r="4.5" /></svg>
);
