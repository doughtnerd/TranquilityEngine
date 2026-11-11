// The Event editor's parameters pane (ADR 0158 §2, §7): the event's local parameters (add, rename, numeric or
// labelled, range, default, seek speed, remove) and a slider per parameter for auditioning. The sliders don't edit
// the asset: they set the values `onAudition` hands the panel, which passes them to Audition (E6.4, contract C4).
import { TextField, editor } from "../../../../editor/sdk";
import { MAX_LOCAL_PARAMETERS, isLabelled, type AudioEventAsset, type ParameterDef } from "../../../../engine/audio/eventFormat";
import { parameterUses } from "./EventTree";
import {
  addParameter,
  parameterNameProblem,
  removeParameter,
  renameParameterAt,
  setLabels,
  setParameterAt,
  toggleLabelled,
  updateNumeric,
} from "./eventParameters";
import type { OnChange } from "./NodeProperties";

export interface ParametersPaneProps {
  event: AudioEventAsset;
  onChange: OnChange<AudioEventAsset>;
  /** The audition value of each local parameter (a number, or a label). */
  values: Readonly<Record<string, number | string>>;
  /** A slider moved: the parameter's new audition value. */
  onAudition(name: string, value: number | string): void;
  readOnly: boolean;
}

/** A number input committing on change; non-numbers are ignored. */
function Num(props: { value: number; label: string; disabled: boolean; min?: number; onCommit: (v: number) => void }) {
  return (
    <input
      type="number"
      class="ev-number"
      aria-label={props.label}
      min={props.min}
      step="any"
      value={+props.value.toFixed(4)}
      disabled={props.disabled}
      onChange={(e) => {
        const v = Number((e.currentTarget as HTMLInputElement).value);
        if (Number.isFinite(v)) props.onCommit(v);
      }}
    />
  );
}

function ParameterRow(props: ParametersPaneProps & { index: number; parameter: ParameterDef }) {
  const { event, index, parameter: p, onChange, readOnly } = props;
  const set = (next: ParameterDef, label: string) => onChange(setParameterAt(event, index, next), false, label);
  const uses = parameterUses(event, p.name);
  const value = props.values[p.name];
  return (
    <div class="ev-param" data-testid="event-parameter" data-parameter={p.name} role="group" aria-label={`Parameter ${p.name}`}>
      <div class="ev-param-head">
        <TextField
          value={p.name}
          label={`Parameter ${index + 1} name`}
          class="ev-param-name"
          onCommit={(name) => {
            const problem = parameterNameProblem(event.parameters, index, name.trim());
            if (problem) return void editor.messages.error(`Can't rename ${p.name}: ${problem}.`);
            onChange(renameParameterAt(event, index, name), false, "Rename parameter");
          }}
        />
        <select aria-label={`${p.name} kind`} value={isLabelled(p) ? "labelled" : "numeric"} disabled={readOnly} onChange={() => set(toggleLabelled(p), "Parameter kind")}>
          <option value="numeric">Numeric</option>
          <option value="labelled">Labelled</option>
        </select>
        <button
          class="icon"
          aria-label={`Remove parameter ${p.name}`}
          title={uses > 0 ? `Remove this parameter (used in ${uses} place${uses === 1 ? "" : "s"}; those uses stay and read as a global parameter)` : "Remove this parameter"}
          disabled={readOnly}
          onClick={() => onChange(removeParameter(event, index), false, "Remove parameter")}
        >
          ×
        </button>
      </div>
      {isLabelled(p) ? (
        <div class="ev-param-fields">
          <label class="ev-param-field ev-param-wide">
            <span>Labels</span>
            <TextField value={p.labels.join(", ")} label={`${p.name} labels`} onCommit={(text) => set(setLabels(p, text), "Parameter labels")} />
          </label>
          <label class="ev-param-field">
            <span>Default</span>
            <select aria-label={`${p.name} default`} value={p.default} disabled={readOnly} onChange={(e) => set({ ...p, default: (e.currentTarget as HTMLSelectElement).value }, "Parameter default")}>
              {p.labels.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
        </div>
      ) : (
        <div class="ev-param-fields">
          <label class="ev-param-field"><span>Min</span><Num value={p.min} label={`${p.name} min`} disabled={readOnly} onCommit={(v) => set(updateNumeric(p, { min: v }), "Parameter range")} /></label>
          <label class="ev-param-field"><span>Max</span><Num value={p.max} label={`${p.name} max`} disabled={readOnly} onCommit={(v) => set(updateNumeric(p, { max: v }), "Parameter range")} /></label>
          <label class="ev-param-field"><span>Default</span><Num value={p.default} label={`${p.name} default`} disabled={readOnly} onCommit={(v) => set(updateNumeric(p, { default: v }), "Parameter default")} /></label>
          <label class="ev-param-field" title="Units per second toward a new value; 0 jumps"><span>Seek speed</span><Num value={p.seekSpeed} min={0} label={`${p.name} seek speed`} disabled={readOnly} onCommit={(v) => set(updateNumeric(p, { seekSpeed: v }), "Parameter seek speed")} /></label>
        </div>
      )}
      <div class="ev-param-audition" title="Audition value (not saved)">
        {isLabelled(p) ? (
          <span class="ev-param-labels" role="radiogroup" aria-label={`Audition ${p.name}`}>
            {p.labels.map((l) => (
              <button key={l} role="radio" aria-checked={value === l} class={value === l ? "active" : undefined} onClick={() => props.onAudition(p.name, l)}>
                {l}
              </button>
            ))}
          </span>
        ) : (
          <>
            <input
              type="range"
              aria-label={`Audition ${p.name}`}
              data-testid="event-parameter-slider"
              min={p.min}
              max={p.max}
              step={p.max > p.min ? (p.max - p.min) / 200 : 1}
              value={typeof value === "number" ? value : p.default}
              onInput={(e) => props.onAudition(p.name, Number((e.currentTarget as HTMLInputElement).value))}
            />
            <span class="ev-param-value">{(typeof value === "number" ? value : p.default).toFixed(2)}</span>
          </>
        )}
      </div>
    </div>
  );
}

export function ParametersPane(props: ParametersPaneProps) {
  const { event, readOnly } = props;
  const full = event.parameters.length >= MAX_LOCAL_PARAMETERS;
  return (
    <section class="ev-params" aria-label="Parameters" data-testid="event-parameters">
      <div class="ev-section-head">
        <span>Parameters</span>
        <button disabled={readOnly || full} title={full ? `At most ${MAX_LOCAL_PARAMETERS} parameters per event` : "Add a local parameter"} onClick={() => props.onChange(addParameter(event), false, "Add parameter")}>
          + Parameter
        </button>
      </div>
      {event.parameters.length === 0 && <p class="ev-empty">No local parameters. Switches, blends and automation can also use the project's global ones.</p>}
      {event.parameters.map((p, i) => (
        <ParameterRow key={`${i}:${p.name}`} {...props} index={i} parameter={p} />
      ))}
    </section>
  );
}
