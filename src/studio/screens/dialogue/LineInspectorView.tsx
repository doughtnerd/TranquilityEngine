// The Line inspector (ADR 0354 §9, §7, 0355 §4, 0357 §6): the selected line's speaker and table; per language its
// status, text, file, length, normalisation and lip-sync keys, an Audition button (the preview language's is also
// Space on the screen) and "Open in Samples", and the subtitle strip; then notes, tags, subtitled, cooldown and once.
// A view over props: edits are callbacks, each one undo step.
import { Chip } from "../../../editor/ui/Chip";
import { FieldRow, NumberBox } from "../../../editor/ui/PanelFields";
import { LINE_LIMITS } from "../../../engine/audio/localisation/lines/format";
import type { LineRow } from "../../../engine/audio/localisation/types";
import { Icon } from "../../components/Icon";
import type { InspectorLanguage } from "./inspectorModel";
import { cellLabel } from "./lineStatus";
import { InlineText } from "./LinesView";
import { SubtitleStripView } from "./SubtitleStripView";

export interface LineInspectorViewProps {
  readonly line: LineRow | null;
  readonly table: string | null;
  readonly languages: readonly InspectorLanguage[];
  readonly preview: string;
  /** The language being auditioned, or null. */
  readonly auditioning: string | null;
  readonly readOnly?: boolean;
  onAudition(code: string): void;
  onStop(): void;
  onOpenFile(path: string): void;
  onText(code: string, text: string): void;
  onNotes(notes: string): void;
  onTags(tags: string[]): void;
  onCooldown(seconds: number): void;
  onOnce(once: boolean): void;
  onSubtitled(on: boolean): void;
}

export function LineInspectorView(props: LineInspectorViewProps) {
  const line = props.line;
  if (!line) return <p class="dl-note" style={{ padding: "8px" }}>Select a line to see its recordings, subtitles and settings.</p>;
  const subtitled = line.textKey !== null;
  return (
    <div class="dl-insp" role="group" aria-label={`Line ${line.key}`}>
      <h3 class="dl-ellipsis" title={`${line.key}${line.speaker ? ` · ${line.speaker}` : ""}`}>{line.key}{line.speaker ? ` · ${line.speaker}` : ""}</h3>
      {props.table && <p class="dl-note">{props.table}{line.textKey ? ` · subtitle key ${line.textKey}` : ""}</p>}
      {props.languages.map((l) => {
        const label = cellLabel(l.cell);
        const playing = props.auditioning === l.def.code;
        return (
          <section key={l.def.code} class="dl-lang" aria-label={`${l.def.name} (${l.def.code})`}>
            <div class="dl-lang-head">
              <b>{l.def.code}</b>
              <span class={`dl-cell ${label.tone}`} title={label.title}>{label.text}</span>
              <span class="dl-path" title={l.file ?? ""}>{l.file ?? "no file in its chain"}</span>
              {l.def.code === props.preview && <Chip tone="accent" title="The preview language (header chip)">preview</Chip>}
              <button disabled={!l.file} aria-pressed={playing} title={l.file ? `Audition ${l.file} on the table's bus` : "Nothing to play"} onClick={() => (playing ? props.onStop() : props.onAudition(l.def.code))}>
                <Icon name={playing ? "stop" : "play"} /> {playing ? "Stop" : "Audition"}
              </button>
              {l.file && <button class="smp-link" title={`Open ${l.file} in the Samples screen`} onClick={() => props.onOpenFile(l.file!)}><Icon name="samples" /> Open in Samples</button>}
            </div>
            <div class="dl-row dl-muted">
              <span>{l.duration === null ? (l.file ? "measuring…" : "—") : `${l.duration.toFixed(2)} s`}</span>
              {l.loudness && <span>· normalised {l.loudness}</span>}
              <span>· lip-sync {l.lipsync === null ? "none" : `${l.lipsync} keys`}</span>
            </div>
            {subtitled && (
              <InlineText value={l.text ?? ""} label={`${l.def.code} text of ${line.key}`} placeholder={l.text === null ? `No ${l.def.code} text yet` : undefined} disabled={props.readOnly} onCommit={(v) => props.onText(l.def.code, v)} />
            )}
            {l.strip && <SubtitleStripView strip={l.strip} speaker={line.speaker} />}
          </section>
        );
      })}
      <div class="dl-fields">
        <label for="dl-notes">Notes</label>
        <textarea id="dl-notes" aria-label="Notes for actors" disabled={props.readOnly} value={line.notes ?? ""} onChange={(e) => props.onNotes((e.currentTarget as HTMLTextAreaElement).value)} />
        <span>Tags</span>
        <InlineText value={line.tags.join(", ")} label="Tags" placeholder="main, act1" disabled={props.readOnly} onCommit={(v) => props.onTags(v.split(","))} />
      </div>
      <FieldRow label="Subtitled" title="Off for breaths and efforts (textKey: null)">
        <input type="checkbox" aria-label="Subtitled" checked={subtitled} disabled={props.readOnly} onChange={(e) => props.onSubtitled((e.currentTarget as HTMLInputElement).checked)} />
      </FieldRow>
      <FieldRow label="Cooldown" unit="s" title="Seconds before a dialogue event may say it again">
        <NumberBox label="Cooldown" value={line.cooldown} min={0} max={LINE_LIMITS.cooldown} step={0.5} digits={1} disabled={props.readOnly} onValue={props.onCooldown} />
      </FieldRow>
      <FieldRow label="Once" title="A dialogue event says it at most once a session">
        <input type="checkbox" aria-label="Once" checked={line.once} disabled={props.readOnly} onChange={(e) => props.onOnce((e.currentTarget as HTMLInputElement).checked)} />
      </FieldRow>
    </div>
  );
}
