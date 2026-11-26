// The parameter cards (ADR 0304): one view of a parameter list, the project's global ones (the Audio Studio's Mixer
// screen) or a holder's own. A card per parameter: name, kind, remove, then range, default and seek speed, or labels and
// default, and an optional slot under it (a holder's extra controls). Every edit is the
// list's refused-or-next result, handed to the holder's adapter (ADR 0307), which applies it as one undo step or reports
// the refusal.
import type { ComponentChildren } from "preact";
import { TextField } from "../ui/settingsControls";
import { isLabelled, type ParameterDef } from "../../engine/audio/parameters";
import type { EditResult } from "./editResult";
import type { ParameterKind, ParameterList } from "./parameterList";
import "./parameters.css";
import { EmptyState } from "../ui/EmptyState";

export interface ParameterCardsProps<H> {
  list: ParameterList<H>;
  holder: H;
  /** Apply an edit (the holder's adapter: one undo step, or the refusal reported). */
  apply(result: EditResult<H>, label: string): void;
  readOnly?: boolean;
  /** The line beside the heading: what the list is for. */
  hint: string;
  /** Shown when the list is empty. */
  empty: string;
  /** The remove button's tooltip: what goes with the parameter, or stays. */
  removeTitle(p: ParameterDef): string;
  /** Under each card (a holder's extra controls). */
  extra?(p: ParameterDef): ComponentChildren;
  /**
   * A holder whose parameters are typed its own way (an animation graph's float, int, bool…): its fields replace the
   * kind select and the range or labels fields, and the list offers only "+ Parameter".
   */
  fields?(p: ParameterDef): ComponentChildren;
}

/** A number input committing on change; non-numbers and the same value are ignored. */
function Num(props: { label: string; value: number; min?: number; disabled?: boolean; onCommit: (n: number) => void }) {
  return (
    <input
      type="number"
      class="param-number"
      aria-label={props.label}
      value={props.value}
      step="any"
      min={props.min}
      disabled={props.disabled}
      onChange={(e) => {
        const n = (e.currentTarget as HTMLInputElement).valueAsNumber;
        if (Number.isFinite(n) && n !== props.value) props.onCommit(n);
      }}
    />
  );
}

export function ParameterCard<H>(props: ParameterCardsProps<H> & { parameter: ParameterDef }) {
  const { list, holder, apply, parameter: p, readOnly = false } = props;
  const name = p.name;
  return (
    <div class="param-card" role="group" aria-label={`Parameter ${name}`} data-parameter={name} data-kind={isLabelled(p) ? "labelled" : "numeric"}>
      <div class="param-head">
        <TextField class="param-name" value={name} label={`Parameter ${name} name`} onCommit={(v) => apply(list.rename(holder, name, v), `Rename parameter ${name} to ${v.trim()}`)} />
        {!props.fields && <select
          aria-label={`${name} kind`}
          value={isLabelled(p) ? "labelled" : "numeric"}
          disabled={readOnly}
          onChange={(e) => {
            const kind = (e.currentTarget as HTMLSelectElement).value as ParameterKind;
            apply(list.setKind(holder, name, kind), `Make ${name} ${kind}`);
          }}
        >
          <option value="numeric">Numeric</option>
          <option value="labelled">Labelled</option>
        </select>}
        <button class="icon param-remove" aria-label={`Remove parameter ${name}`} title={props.removeTitle(p)} disabled={readOnly} onClick={() => apply(list.remove(holder, name), `Remove parameter ${name}`)}>
          ×
        </button>
      </div>
      {props.fields ? props.fields(p) : isLabelled(p) ? (
        <div class="param-fields">
          <label class="param-field param-wide" title="Comma-separated; the first is the default unless you pick another">
            <span>Labels</span>
            <TextField value={p.labels.join(", ")} label={`${name} labels`} onCommit={(v) => apply(list.setLabels(holder, name, v), `Set ${name} labels`)} />
          </label>
          <label class="param-field">
            <span>Default</span>
            <select aria-label={`${name} default`} value={p.default} disabled={readOnly} onChange={(e) => apply(list.setDefaultLabel(holder, name, (e.currentTarget as HTMLSelectElement).value), `Set ${name} default`)}>
              {p.labels.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
        </div>
      ) : (
        <div class="param-fields">
          <label class="param-field"><span>Min</span><Num label={`${name} min`} value={p.min} disabled={readOnly} onCommit={(n) => apply(list.setRange(holder, name, { min: n }), `Set ${name} min`)} /></label>
          <label class="param-field"><span>Max</span><Num label={`${name} max`} value={p.max} disabled={readOnly} onCommit={(n) => apply(list.setRange(holder, name, { max: n }), `Set ${name} max`)} /></label>
          <label class="param-field"><span>Default</span><Num label={`${name} default`} value={p.default} disabled={readOnly} onCommit={(n) => apply(list.setRange(holder, name, { default: n }), `Set ${name} default`)} /></label>
          <label class="param-field" title="Units per second the value moves toward its target; 0 jumps at once">
            <span>Seek speed</span>
            <Num label={`${name} seek speed`} value={p.seekSpeed} min={0} disabled={readOnly} onCommit={(n) => apply(list.setRange(holder, name, { seekSpeed: n }), `Set ${name} seek speed`)} />
          </label>
        </div>
      )}
      {props.extra?.(p)}
    </div>
  );
}

/** The list: heading and hint, a card per parameter (or the empty line), then the add buttons. */
export function ParameterCards<H>(props: ParameterCardsProps<H>) {
  const { list, holder, apply, readOnly = false } = props;
  const parameters = list.parameters(holder);
  const full = list.full(holder);
  const addTitle = full ? `At most ${list.limit} parameters` : undefined;
  return (
    <div class="param-list" role="group" aria-label="Parameters">
      <div class="param-list-head">
        <span>Parameters</span>
        <span class="param-hint">{props.hint}</span>
      </div>
      {parameters.length === 0 && <EmptyState compact title={props.empty} />}
      {parameters.map((p) => <ParameterCard key={p.name} {...props} parameter={p} />)}
      <div class="param-add">
        <button disabled={readOnly || full} title={addTitle} onClick={() => apply(list.add(holder), "Add parameter")}>
          + Parameter
        </button>
        {!props.fields && (
          <button disabled={readOnly || full} title={addTitle} onClick={() => apply(list.add(holder, "labelled"), "Add labelled parameter")}>
            + Labelled parameter
          </button>
        )}
      </div>
    </div>
  );
}
