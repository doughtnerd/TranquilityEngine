// The row editors (ADR 0373): one key of an event, marker, audio or activation track, edited under the dope sheet when
// it is the only key selected. Each change is one labelled undo step on the clip (`rowEditorsLogic.ts`'s refused-or-next
// edits, applied by the window); a refused change says why in the status bar and leaves the key as it was.
import type { AnimSource } from "../../../../engine/animation/animSource";
import { MARKER_KINDS, type Track } from "../../../../engine/animation/tracks";
import type { EditResult } from "../../../../editor/sdk";
import { jsonText, removeRowKey, setActivationRange, setAudioKey, setEventKey, setMarkerKey } from "./rowEditorsLogic";
import { assetRefTarget } from "../../../../editor/sdk";

export interface RowEditorProps {
  readonly clip: AnimSource;
  readonly track: number;
  readonly index: number;
  /** Apply an edit as one undo step named `label`. */
  onApply(result: EditResult<AnimSource>, label: string): void;
}

/** The track kinds that have a row editor. */
export const ROW_EDITOR_KINDS: ReadonlySet<Track["kind"]> = new Set(["event", "marker", "audio", "activation"]);

const value = (e: Event) => (e.currentTarget as HTMLInputElement).value;
const num = (e: Event) => Number(value(e));

export function RowEditor(props: RowEditorProps) {
  const { clip, track: ti, index: ki, onApply } = props;
  const track = clip.tracks[ti];
  if (!track || !("keys" in track) || !track.keys[ki] || !ROW_EDITOR_KINDS.has(track.kind)) return null;
  const at = (track.keys[ki] as { time: number }).time;
  const remove = (
    <button type="button" class="aw-danger" onClick={() => onApply(removeRowKey(clip, ti, ki), `Delete ${track.kind} key`)}>
      Delete key
    </button>
  );
  const head = (what: string) => (
    <span class="aw-re-head">
      {what} at <b>{at.toFixed(2)} s</b>
    </span>
  );

  if (track.kind === "event") {
    const k = track.keys[ki]!;
    return (
      <div class="aw-row-editor" role="group" aria-label="Event key">
        {head("Notify")}
        <label>
          Method
          <input type="text" value={k.method} spellcheck={false} onChange={(e) => onApply(setEventKey(clip, ti, ki, { method: value(e) }), "Set notify method")} />
        </label>
        <label>
          Args (JSON)
          <input type="text" value={jsonText(k.args)} spellcheck={false} placeholder="none" onChange={(e) => onApply(setEventKey(clip, ti, ki, { args: value(e) }), "Set notify args")} />
        </label>
        <label title="The notify fires only while its clip's weight is at least this (0–1).">
          Weight threshold
          <input type="number" min={0} max={1} step={0.05} value={k.threshold} onChange={(e) => onApply(setEventKey(clip, ti, ki, { threshold: num(e) }), "Set notify threshold")} />
        </label>
        <label class="aw-check" title="Fire even when the clip's weight is under the threshold.">
          <input type="checkbox" checked={k.always} onChange={(e) => onApply(setEventKey(clip, ti, ki, { always: (e.currentTarget as HTMLInputElement).checked }), "Set notify always")} />
          Always
        </label>
        <label title="A notify state runs from its time to its end; empty: an instant notify.">
          End (s)
          <input type="text" inputMode="decimal" value={k.end === undefined ? "" : String(k.end)} placeholder="instant" onChange={(e) => onApply(setEventKey(clip, ti, ki, { end: value(e).trim() === "" ? null : num(e) }), "Set notify end")} />
        </label>
        {remove}
      </div>
    );
  }
  if (track.kind === "marker") {
    const k = track.keys[ki]!;
    return (
      <div class="aw-row-editor" role="group" aria-label="Marker key">
        {head("Marker")}
        <label>
          Kind
          <select value={k.kind} onChange={(e) => onApply(setMarkerKey(clip, ti, ki, { kind: (e.currentTarget as HTMLSelectElement).value }), "Set marker kind")}>
            {MARKER_KINDS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input type="text" value={k.name ?? ""} placeholder="none" onChange={(e) => onApply(setMarkerKey(clip, ti, ki, { name: value(e) }), "Rename marker")} />
        </label>
        {remove}
      </div>
    );
  }
  if (track.kind === "audio") {
    const k = track.keys[ki]!;
    return (
      <div class="aw-row-editor" role="group" aria-label="Audio key">
        {head("Audio")}
        <label>
          Audio
          <input type="text" value={assetRefTarget(k.audio)} spellcheck={false} onChange={(e) => onApply(setAudioKey(clip, ti, ki, { audio: value(e) }), "Set audio")} />
        </label>
        <label>
          Params (JSON)
          <input type="text" value={jsonText(k.params)} spellcheck={false} placeholder="none" onChange={(e) => onApply(setAudioKey(clip, ti, ki, { params: value(e) }), "Set audio params")} />
        </label>
        {remove}
      </div>
    );
  }
  const k = (track as Extract<Track, { kind: "activation" }>).keys[ki]!;
  return (
    <div class="aw-row-editor" role="group" aria-label="Activation key">
      {head("On")}
      <label>
        From (s)
        <input type="number" min={0} max={clip.duration} step={1 / clip.rate} value={k.time} onChange={(e) => onApply(setActivationRange(clip, ti, ki, { time: num(e) }), "Set activation start")} />
      </label>
      <label>
        To (s)
        <input type="number" min={0} max={clip.duration} step={1 / clip.rate} value={k.end} onChange={(e) => onApply(setActivationRange(clip, ti, ki, { end: num(e) }), "Set activation end")} />
      </label>
      {remove}
    </div>
  );
}
