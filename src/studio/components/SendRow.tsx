// A send row (ADR 0349 `SendRow`, ADR 0344 returns): one post-fader send from a bus to a return, collapsible like an
// effect card: caret, "→ Reverb" with its level while closed, Automate and Remove; open, the level as a row
// (−60..+6 dB, 0.5 dB steps). Edits come back as `{ next } | { refused }` for the owner to apply as undo steps.
import type { Send } from "../../engine/audio/project/types";
import type { EditResult } from "../../plugins/audio/editor/editResult";
import { FADER_MAX_DB, FADER_MIN_DB, FADER_STEP_DB } from "./faderModel";
import { editSendLevel, sendSummary } from "./mixRowsModel";
import { Icon } from "./Icon";
import { ParameterRow } from "./ParameterRow";
import type { ParamSpec } from "./parameterRowModel";
import "./audioParts.css";

const LEVEL: ParamSpec = { label: "Level", min: FADER_MIN_DB, max: FADER_MAX_DB, step: FADER_STEP_DB, unit: "dB", default: -12 };

export interface SendRowProps {
  readonly send: Send;
  readonly open: boolean;
  /** The level is automated: its current value text. */
  readonly automated?: string;
  readonly readOnly?: boolean;
  onOpen(open: boolean): void;
  onEdit(result: EditResult<Send>, label: string, drag?: boolean): void;
  onRemove(): void;
  onAutomate?(): void;
}

export function SendRow(props: SendRowProps) {
  const { send, open } = props;
  const bodyId = `studio-send-${send.to}`;
  return (
    <div class="studio-row studio-send">
      <div class="studio-row-head">
        <button type="button" class="studio-row-caret" aria-expanded={open} aria-controls={bodyId} aria-label={`${open ? "Collapse" : "Expand"} send to ${send.to}`} onClick={() => props.onOpen(!open)}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        </button>
        <span class="studio-row-name" title="Post-fader send">
          → {send.to}
        </span>
        {!open && <span class="studio-row-summary">{props.automated !== undefined ? `auto · ${props.automated}` : sendSummary(send).replace(`→ ${send.to} · `, "")}</span>}
        <span class="studio-row-tools">
          {props.onAutomate && (
            <button type="button" class={`studio-icon-button${props.automated !== undefined ? " set" : ""}`} aria-label={`Automate send to ${send.to}`} title={`Automate the send to ${send.to} by a game parameter`} disabled={props.readOnly} onClick={props.onAutomate}>
              <Icon name="automate" size={14} />
            </button>
          )}
          <button type="button" class="studio-icon-button" aria-label={`Remove send to ${send.to}`} title={`Remove the send to ${send.to} (its automation goes too)`} disabled={props.readOnly} onClick={props.onRemove}>
            <Icon name="close" size={14} />
          </button>
        </span>
      </div>
      {open && (
        <div class="studio-row-body" id={bodyId}>
          <ParameterRow
            spec={LEVEL}
            value={send.levelDb}
            disabled={props.readOnly || props.automated !== undefined}
            note={props.automated !== undefined ? `auto · ${props.automated}` : undefined}
            title={props.automated !== undefined ? "The level is automated; edit it in the curve window" : undefined}
            onValue={(v, drag) => props.onEdit(editSendLevel(send, v), `Set send to ${send.to}`, drag)}
          />
        </div>
      )}
    </div>
  );
}
