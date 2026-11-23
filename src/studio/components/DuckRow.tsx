// A ducking row (ADR 0349 `DuckRow`, ADR 0344 ducking): one rule lowering a bus while another plays, collapsible like
// an effect card: caret, the trigger's name and "−6 dB · while playing" while closed, On/Off and Remove; open, Ducked
// by, When (While playing | Above level), the threshold (level only), Duck by, Attack and Release. Edits come back as
// `{ next } | { refused }` for the owner to apply as undo steps.
import { MIX_LIMITS } from "../../engine/audio/project/format";
import type { DuckingRule } from "../../engine/audio/project/types";
import { SegmentedControl } from "../../editor/ui/SegmentedControl";
import type { EditResult } from "../../editor/sdk/editResult";
import { duckSummary, editDuck, type DuckPatch } from "./mixRowsModel";
import { Icon } from "./Icon";
import { ParameterRow } from "./ParameterRow";
import type { ParamSpec } from "./parameterRowModel";
import "./audioParts.css";

// Ranges from the parse (one place, ADR 0306).
const [thrLo, thrHi] = MIX_LIMITS.thresholdDb, [amtLo, amtHi] = MIX_LIMITS.amountDb, [msLo, msHi] = MIX_LIMITS.duckMs;
const THRESHOLD: ParamSpec = { label: "Above", min: thrLo, max: thrHi, step: 0.5, unit: "dBFS" };
const AMOUNT: ParamSpec = { label: "Duck by", min: amtLo, max: amtHi, step: 0.5, unit: "dB" };
const ATTACK: ParamSpec = { label: "Attack", min: msLo, max: msHi, step: 1, unit: "ms", scale: "log" };
const RELEASE: ParamSpec = { label: "Release", min: msLo, max: msHi, step: 1, unit: "ms", scale: "log" };

export interface DuckRowProps {
  readonly rule: DuckingRule;
  readonly open: boolean;
  /** The buses that may trigger it, with why not (`duckTriggerOptions`). */
  readonly triggers: readonly { readonly name: string; readonly disabled: string | null }[];
  readonly readOnly?: boolean;
  onOpen(open: boolean): void;
  onEdit(result: EditResult<DuckingRule>, label: string, drag?: boolean): void;
  onRemove(): void;
}

export function DuckRow(props: DuckRowProps) {
  const { rule, open, readOnly } = props;
  const bodyId = `studio-duck-${rule.target}-${rule.trigger}`;
  const edit = (patch: DuckPatch, label: string, drag?: boolean) => props.onEdit(editDuck(rule, patch), label, drag);
  return (
    <div class={`studio-row studio-duck${rule.enabled ? "" : " off"}`}>
      <div class="studio-row-head">
        <button type="button" class="studio-row-caret" aria-expanded={open} aria-controls={bodyId} aria-label={`${open ? "Collapse" : "Expand"} ducking by ${rule.trigger}`} onClick={() => props.onOpen(!open)}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        </button>
        <span class="studio-row-name" title={`Ducked by ${rule.trigger}`}>
          {rule.trigger}
        </span>
        {!open && <span class="studio-row-summary">{duckSummary(rule)}</span>}
        <span class="studio-row-tools">
          <button type="button" class={`studio-onoff${rule.enabled ? "" : " off"}`} aria-pressed={rule.enabled} title={rule.enabled ? "On: click to turn off" : "Off: click to turn on"} disabled={readOnly} onClick={() => edit({ enabled: !rule.enabled }, rule.enabled ? "Turn off ducking" : "Turn on ducking")}>
            {rule.enabled ? "On" : "Off"}
          </button>
          <button type="button" class="studio-icon-button" aria-label={`Remove ducking by ${rule.trigger}`} title={`Remove ducking by ${rule.trigger}`} disabled={readOnly} onClick={props.onRemove}>
            <Icon name="close" size={14} />
          </button>
        </span>
      </div>
      {open && (
        <div class="studio-row-body" id={bodyId}>
          <label class="studio-param">
            <span>Ducked by</span>
            <select value={rule.trigger} disabled={readOnly} onChange={(e) => edit({ trigger: (e.currentTarget as HTMLSelectElement).value }, "Change ducking trigger")}>
              {props.triggers.map((t) => (
                <option key={t.name} value={t.name} disabled={t.disabled !== null && t.name !== rule.trigger}>
                  {t.disabled && t.name !== rule.trigger ? `${t.name} (${t.disabled})` : t.name}
                </option>
              ))}
            </select>
          </label>
          <div class="studio-param">
            <span>When</span>
            <SegmentedControl
              label="Duck when"
              size="small"
              value={rule.mode}
              options={[
                { value: "presence", label: "While playing", title: "While anything plays on the trigger bus", disabled: readOnly },
                { value: "level", label: "Above level", title: "While the trigger bus is louder than the threshold", disabled: readOnly },
              ]}
              onChange={(mode) => edit({ mode }, "Change ducking mode")}
            />
          </div>
          {rule.mode === "level" && <ParameterRow spec={THRESHOLD} value={rule.thresholdDb} disabled={readOnly} onValue={(v, drag) => edit({ thresholdDb: v }, "Set ducking threshold", drag)} />}
          <ParameterRow spec={AMOUNT} value={rule.amountDb} disabled={readOnly} onValue={(v, drag) => edit({ amountDb: v }, "Set ducking amount", drag)} />
          <ParameterRow spec={ATTACK} value={rule.attackMs} disabled={readOnly} onValue={(v, drag) => edit({ attackMs: v }, "Set ducking attack", drag)} />
          <ParameterRow spec={RELEASE} value={rule.releaseMs} disabled={readOnly} onValue={(v, drag) => edit({ releaseMs: v }, "Set ducking release", drag)} />
        </div>
      )}
    </div>
  );
}
