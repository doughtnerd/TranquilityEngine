// A context's mapping rows (ADR 0336, 0417), shared by the Input dialog's context view: a mapping's action (a slot
// the dialog fills with its picker), its controls (a single control, or a composite's parts: typed, picked from a list
// grouped by device, or captured with Bind, the next press), a warning when a control doesn't suit the action's type,
// its modifiers (run top to bottom) and triggers with their parameters, and whether it consumes its controls. Under
// each mapping are the problems the evaluator reports for it, the messages Play would log. Split out of the
// Inspector's context editor, which the dialog replaced.
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { MappingSpec, ModifierSpec, TriggerSpec, TriggerType } from "../../../engine";
import { canonicalControlPath } from "../../../engine/editor";
import { captureControl } from "../../controlCapture";
import {
  COMPOSITES,
  CONTROL_GROUPS,
  MODIFIERS,
  TRIGGERS,
  TRIGGER_TYPES,
  compositeOf,
  moveItem,
  newStep,
  partValue,
  removeAt,
  replaceAt,
  setComposite,
  setConsume,
  setPart,
  setStepParam,
  setTriggerType,
  stepName,
  stepParams,
  withSteps,
  type ActionChoice,
  type CompositeKind,
  type ModifierName,
  type ParamSpec,
  type StepSpec,
  type TriggerName,
} from "../../inputContextModel";
import { useDraftText } from "../draftText";
import "./inputDialog.css";

/** The control suggestions every control box offers (one list per page). */
export function ControlSuggestions(props: { id: string }) {
  return (
    <datalist id={props.id}>
      {CONTROL_GROUPS.flatMap((g) => g.controls.map((c) => <option key={c} value={c} />))}
    </datalist>
  );
}

export interface MappingProps {
  index: number;
  count: number;
  mapping: MappingSpec;
  /** The action's picker, drawn in the card's head. */
  action: ComponentChildren;
  /** Actions chord and combo triggers may name. */
  actions: readonly ActionChoice[];
  problems: readonly string[];
  /** Why the controls don't suit the action's type (`unsuitedControls`). */
  warnings?: readonly string[];
  /** A code set's inline default, shown in `default` read-only. */
  fromScript?: boolean;
  /** The control suggestions' datalist. */
  listId: string;
  readOnly: boolean;
  onChange(next: MappingSpec, label: string): void;
  onMove(by: number): void;
  onDuplicate(): void;
  onRemove(): void;
}

export function MappingCard(props: MappingProps) {
  const { mapping: m, readOnly, actions } = props;
  const kind = compositeOf(m);
  const n = props.index + 1;
  const consume = m.consume === undefined ? "" : String(m.consume);
  const name = props.fromScript ? `Script mapping ${n}` : `Mapping ${n}`;
  return (
    <li class={`input-mapping${props.problems.length ? " has-problems" : ""}${props.fromScript ? " from-script" : ""}`} aria-label={name} data-mapping-index={props.fromScript ? undefined : props.index} tabIndex={-1}>
      <div class="input-mapping-head">
        <span class="input-mapping-number">{n}</span>
        <span class="input-mapping-action">{props.action}</span>
        {props.fromScript && <span class="input-tag" title="Given inline in defineActions; change it in the script">from a script</span>}
        {!props.fromScript && <span class="input-mapping-tools">
          <button disabled={readOnly || props.index === 0} title="Move up" aria-label="Move mapping up" onClick={() => props.onMove(-1)}>↑</button>
          <button disabled={readOnly || props.index === props.count - 1} title="Move down" aria-label="Move mapping down" onClick={() => props.onMove(1)}>↓</button>
          <button disabled={readOnly} title="Duplicate" aria-label="Duplicate mapping" onClick={props.onDuplicate}>⧉</button>
          <button disabled={readOnly} class="danger" title="Remove" aria-label="Remove mapping" onClick={props.onRemove}>✕</button>
        </span>}
      </div>
      <label class="import-row">
        <span>Controls</span>
        <select aria-label="Composite" disabled={readOnly} value={kind} onChange={(e) => props.onChange(setComposite(m, e.currentTarget.value as CompositeKind), "Set Composite")}>
          {(Object.keys(COMPOSITES) as CompositeKind[]).map((k) => (
            <option key={k} value={k}>
              {COMPOSITES[k].label}
            </option>
          ))}
        </select>
      </label>
      {COMPOSITES[kind].parts.map((part) => (
        <ControlRow key={part} part={part} listId={props.listId} single={kind === "single"} value={partValue(m, part)} readOnly={readOnly} onCommit={(path) => path !== partValue(m, part) && props.onChange(setPart(m, part, path), "Set Control")} />
      ))}
      <StepList
        title="Modifiers"
        noun="modifier"
        table={MODIFIERS}
        steps={m.modifiers ?? []}
        actions={actions}
        readOnly={readOnly}
        onChange={(steps, label) => props.onChange(withSteps(m, "modifiers", steps), label)}
        make={(name) => newStep(name as ModifierName)}
      />
      <StepList
        title="Triggers"
        noun="trigger"
        table={TRIGGERS}
        steps={m.triggers ?? []}
        actions={actions}
        readOnly={readOnly}
        triggers
        onChange={(steps, label) => props.onChange(withSteps(m, "triggers", steps), label)}
        make={(name) => newStep(name as TriggerName)}
      />
      <label class="import-row" title="A performing mapping takes its controls, so lower-priority contexts don't see them">
        <span>Consume</span>
        <select aria-label="Consume" disabled={readOnly} value={consume} onChange={(e) => props.onChange(setConsume(m, e.currentTarget.value as "" | "true" | "false"), "Set Consume")}>
          <option value="">The action's setting (yes unless it says no)</option>
          <option value="true">Yes: lower contexts don't see these controls</option>
          <option value="false">No: lower contexts see them too</option>
        </select>
      </label>
      {(props.warnings?.length ?? 0) > 0 && (
        <ul class="input-mapping-warnings" aria-label={`${name} warnings`}>
          {props.warnings!.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {props.problems.length > 0 && (
        <ul class="input-mapping-problems" aria-label={`${name} problems`}>
          {props.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

const PART_LABELS: Record<string, string> = { control: "Control", up: "Up", down: "Down", left: "Left", right: "Right", negative: "Negative", positive: "Positive", modifier: "Modifier" };

/** One control path: typed (with suggestions), picked by device, or bound with the next press. */
function ControlRow(props: { part: string; listId: string; single: boolean; value: string; readOnly: boolean; onCommit: (path: string) => void }) {
  const [capturing, setCapturing] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  const commit = (path: string) => props.onCommit(canonicalControlPath(path.trim()) ?? path.trim());
  const draft = useDraftText(props.value, commit);
  const label = props.single ? "Control" : PART_LABELS[props.part] ?? props.part;
  const bind = (e: MouseEvent) => {
    if (capturing) {
      stop.current?.();
      setCapturing(false);
      return;
    }
    setCapturing(true);
    // Now, not after a timer: the browser runs input before timers, so a key pressed while the page is busy would
    // reach the page instead. This click's own events have passed the window's capture phase, so they aren't taken.
    // A press on this button (now "Cancel") cancels rather than binding the mouse button.
    stop.current = captureControl((path) => {
      stop.current = null;
      setCapturing(false);
      if (path) commit(path);
    }, e.currentTarget as Element);
  };
  return (
    <div class="import-row input-control-row">
      <span>{label}</span>
      <span class="input-control">
        <input type="text" aria-label={label} list={props.listId} spellcheck={false} placeholder="<Keyboard>/space" disabled={props.readOnly || capturing} {...draft.input} value={capturing ? "Press a key, button or stick… (Esc cancels)" : draft.input.value} />
        <select
          aria-label={`Pick ${label.toLowerCase()}`}
          title="Pick a control"
          disabled={props.readOnly || capturing}
          value=""
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v) commit(v);
          }}
        >
          <option value="">…</option>
          {CONTROL_GROUPS.map((g) => (
            <optgroup key={g.device} label={g.device}>
              {g.controls.map((c) => (
                <option key={c} value={c}>
                  {c.slice(c.indexOf("/") + 1)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button class={capturing ? "active" : ""} disabled={props.readOnly} aria-pressed={capturing} title={capturing ? "Stop waiting for a press" : "Bind: press the key, button, stick, touch or pen to use, on any device"} onClick={bind}>
          {capturing ? "Cancel" : "Bind"}
        </button>
      </span>
    </div>
  );
}

type Step = ModifierSpec | TriggerSpec;

/** A mapping's modifiers or triggers: each with its parameters (and a trigger's type), in order, plus Add. */
function StepList(props: {
  title: string;
  noun: string;
  table: Record<string, StepSpec>;
  steps: readonly Step[];
  actions: readonly ActionChoice[];
  readOnly: boolean;
  triggers?: boolean;
  onChange: (steps: Step[], label: string) => void;
  make: (name: string) => Step;
}) {
  const { steps, table, readOnly } = props;
  const label = props.noun[0].toUpperCase() + props.noun.slice(1);
  return (
    <div class="input-steps" role="group" aria-label={props.title}>
      <div class="input-steps-head">
        <span>{props.title}</span>
        <select
          aria-label={`Add ${props.noun}`}
          disabled={readOnly}
          value=""
          onChange={(e) => {
            const name = e.currentTarget.value;
            if (name) props.onChange([...steps, props.make(name)], `Add ${label}`);
          }}
        >
          <option value="">Add…</option>
          {Object.entries(table).map(([name, s]) => (
            <option key={name} value={name}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      {steps.map((step, i) => {
        const name = stepName(step);
        const s = table[name];
        const set = (next: Step) => props.onChange(replaceAt(steps, i, next), `Set ${label}`);
        return (
          <div key={i} class="input-step" aria-label={`${s?.label ?? name} ${props.noun}`}>
            <span class="input-step-name">{s?.label ?? name}</span>
            {s ? <StepParams step={step} spec={s} actions={props.actions} readOnly={readOnly} onChange={set} /> : <code class="input-step-raw">{JSON.stringify(step)}</code>}
            {props.triggers && (
              <select aria-label="Trigger type" disabled={readOnly} value={(step as { type?: TriggerType }).type ?? ""} onChange={(e) => set(setTriggerType(step as TriggerSpec, e.currentTarget.value as TriggerType | ""))}>
                <option value="">default type</option>
                {TRIGGER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            )}
            <span class="input-step-tools">
              <button disabled={readOnly || i === 0} aria-label={`Move ${props.noun} up`} title="Move up (they apply in order)" onClick={() => props.onChange(moveItem(steps, i, -1), `Move ${label}`)}>↑</button>
              <button disabled={readOnly} class="danger" aria-label={`Remove ${props.noun}`} title="Remove" onClick={() => props.onChange(removeAt(steps, i), `Remove ${label}`)}>✕</button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A step's parameter inputs, from its table entry. */
function StepParams(props: { step: Step; spec: StepSpec; actions: readonly ActionChoice[]; readOnly: boolean; onChange: (next: Step) => void }) {
  const { step, spec, readOnly } = props;
  const params = stepParams(step);
  const set = (key: string, value: unknown) => props.onChange(setStepParam(step, key, value));
  const name = stepName(step);
  if (spec.perComponent) {
    return (
      <span class="input-step-params">
        {(["x", "y", "z"] as const).map((k) =>
          spec.perComponent === "bool" ? (
            <label key={k} class="input-param">
              <input type="checkbox" aria-label={k} disabled={readOnly} checked={params[k] === true} onChange={(e) => set(k, e.currentTarget.checked)} />
              {k}
            </label>
          ) : (
            <label key={k} class="input-param">
              {k}
              <NumberParam label={k} value={typeof params[k] === "number" ? (params[k] as number) : 1} step={0.1} readOnly={readOnly} onCommit={(v) => set(k, v ?? 1)} />
            </label>
          ),
        )}
      </span>
    );
  }
  if (name === "combo") return <ComboSteps step={step as TriggerSpec} actions={props.actions} readOnly={readOnly} onChange={props.onChange} />;
  return (
    <span class="input-step-params">
      {spec.params.map((p) => (
        <label key={p.key} class="input-param">
          {p.type !== "bool" && p.label}
          <ParamInput param={p} value={params[p.key]} actions={props.actions} readOnly={readOnly} onCommit={(v) => set(p.key, v)} />
          {p.type === "bool" && p.label}
        </label>
      ))}
    </span>
  );
}

function ParamInput(props: { param: ParamSpec; value: unknown; actions: readonly ActionChoice[]; readOnly: boolean; onCommit: (v: unknown) => void }) {
  const { param: p, value, readOnly } = props;
  switch (p.type) {
    case "number":
      return <NumberParam label={p.label} value={typeof value === "number" ? value : null} placeholder={p.optional ? "—" : String(p.default ?? "")} min={p.min} step={p.step} readOnly={readOnly} onCommit={(v) => props.onCommit(v === null ? (p.optional ? undefined : p.default) : v)} />;
    case "bool":
      return <input type="checkbox" aria-label={p.label} disabled={readOnly} checked={value === true} onChange={(e) => props.onCommit(e.currentTarget.checked || undefined)} />;
    case "choice":
      return (
        <select aria-label={p.label} disabled={readOnly} value={typeof value === "string" ? value : ""} onChange={(e) => props.onCommit(e.currentTarget.value || undefined)}>
          {p.options.map((o) => (
            <option key={o} value={o}>
              {o || "default"}
            </option>
          ))}
        </select>
      );
    case "text":
      return <TextParam label={p.label} value={typeof value === "string" ? value : ""} placeholder={p.placeholder} readOnly={readOnly} onCommit={props.onCommit} />;
    case "action":
      return <ActionSelect label={p.label} value={typeof value === "string" ? value : ""} actions={props.actions} readOnly={readOnly} onCommit={props.onCommit} />;
  }
}

function ActionSelect(props: { label: string; value: string; actions: readonly ActionChoice[]; readOnly: boolean; onCommit: (v: string) => void }) {
  const known = props.actions.some((a) => a.value === props.value);
  return (
    <select aria-label={props.label} disabled={props.readOnly} value={props.value} onChange={(e) => props.onCommit(e.currentTarget.value)}>
      {!known && <option value={props.value}>{props.value ? `${props.value} (not defined)` : "(choose)"}</option>}
      {props.actions.map((a) => (
        <option key={a.value} value={a.value}>
          {a.value}
        </option>
      ))}
    </select>
  );
}

/** A number, committed on change; empty is null (an optional parameter left out). */
function NumberParam(props: { label: string; value: number | null; placeholder?: string; min?: number; step?: number; readOnly: boolean; onCommit: (v: number | null) => void }) {
  const shown = props.value === null ? "" : String(props.value);
  const draft = useDraftText(shown, (text) => {
    if (text === shown) return;
    if (text.trim() === "") return props.onCommit(null);
    const v = Number(text);
    if (Number.isFinite(v)) props.onCommit(v);
  });
  return <input type="number" aria-label={props.label} min={props.min} step={props.step ?? "any"} placeholder={props.placeholder} disabled={props.readOnly} {...draft.input} />;
}

function TextParam(props: { label: string; value: string; placeholder?: string; readOnly: boolean; onCommit: (v: string) => void }) {
  const draft = useDraftText(props.value, (v) => v !== props.value && props.onCommit(v.trim()));
  return <input type="text" aria-label={props.label} placeholder={props.placeholder} disabled={props.readOnly} {...draft.input} />;
}

/** A combo's steps: each an action of the same set and the seconds it may follow the one before. */
function ComboSteps(props: { step: TriggerSpec; actions: readonly ActionChoice[]; readOnly: boolean; onChange: (next: TriggerSpec) => void }) {
  const combo = (props.step as { combo: { steps: readonly { action: string; within?: number }[] } }).combo;
  const steps = useMemo(() => (Array.isArray(combo?.steps) ? combo.steps : []), [combo]);
  const type = (props.step as { type?: TriggerType }).type;
  const write = (next: readonly { action: string; within?: number }[]) => props.onChange({ combo: { ...combo, steps: next }, ...(type ? { type } : {}) } as TriggerSpec);
  return (
    <span class="input-step-params input-combo">
      {steps.map((s, i) => (
        <span key={i} class="input-combo-step">
          <ActionSelect label={`Step ${i + 1} action`} value={s.action} actions={props.actions} readOnly={props.readOnly} onCommit={(action) => write(replaceAt(steps, i, { ...s, action }))} />
          <label class="input-param">
            within
            <NumberParam label={`Step ${i + 1} within`} value={s.within ?? null} placeholder="—" min={0} step={0.05} readOnly={props.readOnly} onCommit={(v) => write(replaceAt(steps, i, v === null ? { action: s.action } : { ...s, within: v }))} />
          </label>
          <button disabled={props.readOnly || steps.length <= 1} aria-label={`Remove step ${i + 1}`} onClick={() => write(removeAt(steps, i))}>✕</button>
        </span>
      ))}
      <button disabled={props.readOnly} onClick={() => write([...steps, { action: props.actions[0]?.value ?? "", within: 0.5 }])}>
        Add step
      </button>
    </span>
  );
}
