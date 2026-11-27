// A context's mapping rows (ADR 0336, 0417), shared by the Input dialog's context view: a mapping's action (a slot
// the dialog fills with its picker), its controls (a single control, or a composite's parts: typed, picked from a list
// grouped by device, or captured with Bind, the next press), a warning when a control doesn't suit the action's type,
// its modifiers as an ordered stack (run top to bottom; reordered by dragging a handle, from the keyboard, or with a
// row's ⋯ menu; a value tried through the chain shows each step's output, from the engine's own modifiers), its
// triggers as chips grouped by how they combine (any of these, all of these, blocked by), whether it consumes its
// controls, and a note. A card folds to its head, which then says its controls in one line. Under each mapping are the
// problems the evaluator reports for it, the messages Play would log. Split out of the Inspector's context editor,
// which the dialog replaced.
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { MappingSpec, ModifierSpec, TriggerSpec, TriggerType } from "../../../engine";
import { canonicalControlPath, traceInputModifiers } from "../../../engine/editor";
import type { ActionKind } from "../../../engine/input/actions";
import { captureControl } from "../../controlCapture";
import {
  COMPOSITES,
  CONTROL_GROUPS,
  MODIFIERS,
  TRIGGERS,
  TRIGGER_GROUPS,
  compositeOf,
  controlSummary,
  groupTriggers,
  mappingControls,
  moveItem,
  newStep,
  newTriggerIn,
  partValue,
  removeAt,
  replaceAt,
  setComposite,
  setConsume,
  setNote,
  setPart,
  setStepParam,
  setTriggerGroup,
  stepName,
  stepParams,
  triggerSummary,
  triggerType,
  typeForMapping,
  withSteps,
  type ActionChoice,
  type CompositeKind,
  type ModifierName,
  isOff,
  setOff,
  type ParamSpec,
  type StepSpec,
  type TriggerName,
} from "../../inputContextModel";
import { ContextMenu } from "../ContextMenu";
import { useDraftText } from "../draftText";
import { SortableList } from "../SortableList";
import { moveItem as moveTo } from "../sortableListLogic";
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
  /** The type of the action it names, when it names one (a value tried through the modifiers has its components). */
  actionKind?: ActionKind;
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
  /** Folded to its head. */
  folded?: boolean;
  onFold?(folded: boolean): void;
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
  const folded = !!props.folded;
  return (
    <li class={`input-mapping${props.problems.length ? " has-problems" : ""}${props.fromScript ? " from-script" : ""}${folded ? " folded" : ""}`} aria-label={name} data-mapping-index={props.fromScript ? undefined : props.index} tabIndex={-1}>
      <div class="input-mapping-head">
        {props.onFold && (
          <button class="input-mapping-fold" aria-expanded={!folded} aria-label={folded ? `Unfold ${name}` : `Fold ${name}`} title={folded ? "Unfold" : "Fold"} onClick={() => props.onFold!(!folded)}>
            <span aria-hidden="true">{folded ? "▸" : "▾"}</span>
          </button>
        )}
        <span class="input-mapping-number">{n}</span>
        <span class="input-mapping-action">{props.action}</span>
        {folded && (
          <span class="input-mapping-summary" title={m.note || undefined}>
            {controlSummary(m)}
            {(m.modifiers?.length ?? 0) > 0 && <span class="input-muted"> · {m.modifiers!.length} modifier{m.modifiers!.length === 1 ? "" : "s"}</span>}
            {(m.triggers?.length ?? 0) > 0 && <span class="input-muted"> · {m.triggers!.length} trigger{m.triggers!.length === 1 ? "" : "s"}</span>}
          </span>
        )}
        {props.fromScript && <span class="input-tag" title="Given inline in defineActions; change it in the script">from a script</span>}
        {!props.fromScript && <span class="input-mapping-tools">
          <button disabled={readOnly || props.index === 0} title="Move up" aria-label="Move mapping up" onClick={() => props.onMove(-1)}>↑</button>
          <button disabled={readOnly || props.index === props.count - 1} title="Move down" aria-label="Move mapping down" onClick={() => props.onMove(1)}>↓</button>
          <button disabled={readOnly} title="Duplicate" aria-label="Duplicate mapping" onClick={props.onDuplicate}>⧉</button>
          <button disabled={readOnly} class="danger" title="Remove" aria-label="Remove mapping" onClick={props.onRemove}>✕</button>
        </span>}
      </div>
      {!folded && (
        <>
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
          <ModifierStack mapping={m} kind={props.actionKind ?? typeForMapping(m)} actions={actions} readOnly={readOnly} onChange={(steps, label) => props.onChange(withSteps(m, "modifiers", steps), label)} />
          <TriggerGroups triggers={m.triggers ?? []} actions={actions} readOnly={readOnly} onChange={(steps, label) => props.onChange(withSteps(m, "triggers", steps), label)} />
          <label class="import-row" title="A performing mapping takes its controls, so lower-priority contexts don't see them">
            <span>Consume</span>
            <select aria-label="Consume" disabled={readOnly} value={consume} onChange={(e) => props.onChange(setConsume(m, e.currentTarget.value as "" | "true" | "false"), "Set Consume")}>
              <option value="">The action's setting (yes unless it says no)</option>
              <option value="true">Yes: lower contexts don't see these controls</option>
              <option value="false">No: lower contexts see them too</option>
            </select>
          </label>
          <NoteRow note={m.note ?? ""} readOnly={readOnly} onCommit={(note) => props.onChange(setNote(m, note), "Set Note")} />
        </>
      )}
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

/** A mapping's note: why it's there, for whoever edits the context next (saved in the file; the game ignores it). */
function NoteRow(props: { note: string; readOnly: boolean; onCommit: (note: string) => void }) {
  const draft = useDraftText(props.note, (v) => v.trim() !== props.note && props.onCommit(v));
  return (
    <label class="import-row" title="Saved in the context file for whoever edits it next; the game ignores it">
      <span>Note</span>
      <input type="text" aria-label="Note" placeholder="Why this mapping is here (optional)" disabled={props.readOnly} {...draft.input} />
    </label>
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

const KIND_DIMS: Record<ActionKind, number> = { button: 1, axis: 1, vec2: 2, vec3: 3 };
const AXES = ["x", "y", "z"] as const;

/** A value as the stack shows it: `0.50`, or `(0.00, 0.76)`. */
const shownValue = (v: readonly number[]): string => {
  const parts = v.map((x) => (Object.is(x, -0) ? 0 : x).toFixed(2).replace("-", "−"));
  return parts.length === 1 ? parts[0] : `(${parts.join(", ")})`;
};

/** The value tried at first: halfway on each component, so dead zones, curves and scales all show. */
const startValue = (dims: number): number[] => (dims === 1 ? [0.5] : dims === 2 ? [0.3, 0.8] : [0.3, 0.8, 0.5]);

/**
 * A mapping's modifiers as an ordered stack: one numbered row each with its parameters, the value it hands on, and a ⋯
 * menu (Move up, Move down, Turn off / on, Duplicate, Remove); rows reorder by their handle, by drag or Space, arrows, Space. Above
 * them "Try a value", tried through the chain with the engine's modifiers; below, what the action gets.
 */
function ModifierStack(props: { mapping: MappingSpec; kind: ActionKind; actions: readonly ActionChoice[]; readOnly: boolean; onChange: (steps: ModifierSpec[], label: string) => void }) {
  const { readOnly } = props;
  const steps = props.mapping.modifiers ?? [];
  const controls = mappingControls(props.mapping);
  const dims = Math.max(KIND_DIMS[props.kind], KIND_DIMS[typeForMapping(props.mapping)]);
  const [tried, setTried] = useState<number[]>(() => startValue(dims));
  const input = tried.length === dims ? tried : startValue(dims);
  const trace = useMemo(() => traceInputModifiers(steps, input, { kind: props.kind, controls }), [steps, input.join(","), props.kind, controls.join(",")]);
  const implicit = trace.steps[0]?.implicit ? trace.steps[0] : null;
  const traced = implicit ? trace.steps.slice(1) : trace.steps;
  const [menu, setMenu] = useState<{ index: number; at: Element } | null>(null);
  const labelOf = (step: ModifierSpec) => (MODIFIERS as Record<string, StepSpec>)[stepName(step)]?.label ?? stepName(step);
  const set = (list: ModifierSpec[], label: string) => props.onChange(list, label);
  return (
    <div class="input-steps input-modifiers" role="group" aria-label="Modifiers">
      <div class="input-steps-head">
        <span>Modifiers</span>
        <span class="input-count">{steps.length}</span>
        <span class="input-muted input-steps-hint">Run top to bottom</span>
        <select
          aria-label="Add modifier"
          disabled={readOnly}
          value=""
          onChange={(e) => {
            const name = e.currentTarget.value;
            if (name) set([...steps, newStep(name as ModifierName)], "Add Modifier");
          }}
        >
          <option value="">Add modifier…</option>
          {Object.entries(MODIFIERS).map(([name, s]) => (
            <option key={name} value={name}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div class="input-try" role="group" aria-label="Try a value">
        <span>Try a value</span>
        {input.map((v, i) => (
          <label key={i} class="input-param">
            {dims > 1 && AXES[i]}
            <TryNumber label={dims > 1 ? `Try ${AXES[i]}` : "Try a value"} value={v} onCommit={(x) => setTried(replaceAt(input, i, x))} />
          </label>
        ))}
        {implicit && (
          <span class="input-muted" title="A stick's mapping with no dead zone gets the engine's (0.15, or the player's own setting) before its modifiers">
            stick dead zone first → <output class="input-trace">{shownValue(implicit.value)}</output>
          </span>
        )}
      </div>
      {steps.length > 0 && (
        <SortableList
          items={steps}
          label="Modifiers, in the order they run"
          class="input-modifier-list"
          disabled={readOnly}
          itemKey={(_, i) => String(i)}
          itemLabel={(step, i) => `${labelOf(step)} (modifier ${i + 1})`}
          onMove={(from, to) => set(moveTo(steps, from, to), "Move Modifier")}
          renderItem={(step, i) => {
            const s = (MODIFIERS as Record<string, StepSpec>)[stepName(step)];
            const t = traced[i];
            return (
              <div class={`input-step input-modifier${isOff(step) ? " is-off" : ""}`} aria-label={`${labelOf(step)} modifier${isOff(step) ? ", off" : ""}`}>
                <span class="input-step-number">{i + 1}</span>
                <span class="input-step-name">{labelOf(step)}</span>
                {s ? <StepParams step={step} spec={s} actions={props.actions} readOnly={readOnly} onChange={(next) => set(replaceAt(steps, i, next as ModifierSpec), "Set Modifier")} /> : <code class="input-step-raw">{JSON.stringify(step)}</code>}
                {t?.off && (
                  <output class="input-trace input-muted" aria-label={`${labelOf(step)} gives`} title="Turned off: skipped, as if it weren't there">
                    off
                  </output>
                )}
                {t && !t.off && (
                  <output class={`input-trace${t.error ? " failed" : ""}`} aria-label={`${labelOf(step)} gives`} title={t.error ?? (t.timeBased ? "Smooth follows its input over time, so one value passes through; in Play it eases toward it" : undefined)}>
                    → {shownValue(t.value)}
                    {t.timeBased && <span class="input-muted"> (over time)</span>}
                    {t.error && <span> (skipped)</span>}
                  </output>
                )}
                <button class="input-step-more" disabled={readOnly} aria-label={`More for ${labelOf(step)}`} aria-haspopup="menu" title="Move, turn off, duplicate or remove" onClick={(e) => setMenu({ index: i, at: e.currentTarget })}>
                  ⋯
                </button>
              </div>
            );
          }}
        />
      )}
      <div class="input-try-out">
        <span>Out</span>
        <output class="input-trace" aria-label="The action gets">
          {shownValue(trace.out)}
        </output>
        {props.kind === "button" && <span class="input-muted">a button reads the value's size, up to 1</span>}
      </div>
      {menu && (
        <ContextMenu
          label={`${labelOf(steps[menu.index] ?? {})} menu`}
          at={menu.at}
          onClose={() => setMenu(null)}
          entries={[
            { id: "up", label: "Move up", disabled: menu.index === 0, run: () => set(moveItem(steps, menu.index, -1), "Move Modifier") },
            { id: "down", label: "Move down", disabled: menu.index === steps.length - 1, run: () => set(moveItem(steps, menu.index, 1), "Move Modifier") },
            { id: "off", label: isOff(steps[menu.index] ?? ({} as ModifierSpec)) ? "Turn on" : "Turn off", run: () => set(replaceAt(steps, menu.index, setOff(steps[menu.index], !isOff(steps[menu.index]))), isOff(steps[menu.index]) ? "Turn On Modifier" : "Turn Off Modifier") },
            { id: "duplicate", label: "Duplicate", run: () => set([...steps.slice(0, menu.index + 1), structuredClone(steps[menu.index]), ...steps.slice(menu.index + 1)], "Duplicate Modifier") },
            { id: "remove", label: "Remove", danger: true, run: () => set(removeAt(steps, menu.index), "Remove Modifier") },
          ]}
        />
      )}
    </div>
  );
}

/** A number to try: any value, kept while typing, committed on change. */
function TryNumber(props: { label: string; value: number; onCommit: (v: number) => void }) {
  const draft = useDraftText(String(props.value), (text) => {
    const v = Number(text);
    if (text.trim() !== "" && Number.isFinite(v) && v !== props.value) props.onCommit(v);
  });
  return <input type="number" aria-label={props.label} step={0.05} {...draft.input} />;
}

/**
 * A mapping's triggers as chips in three groups by how they combine: Any of these (explicit), All of these
 * (implicit), Blocked by (blocker). Each group adds a trigger into itself; a chip opens its settings below the groups,
 * where its parameters are edited, its group changed, or it's removed.
 */
function TriggerGroups(props: { triggers: readonly TriggerSpec[]; actions: readonly ActionChoice[]; readOnly: boolean; onChange: (steps: TriggerSpec[], label: string) => void }) {
  const { triggers, readOnly } = props;
  const [open, setOpen] = useState<number | null>(null);
  const shown = open !== null && open < triggers.length ? open : null;
  const groups = groupTriggers(triggers);
  const labelOf = (t: TriggerSpec) => (TRIGGERS as Record<string, StepSpec>)[stepName(t)]?.label ?? stepName(t);
  const firstAction = props.actions[0]?.value ?? "";
  return (
    <div class="input-steps input-triggers" role="group" aria-label="Triggers">
      <div class="input-steps-head">
        <span>Triggers</span>
        <span class="input-count">{triggers.length}</span>
        <span class="input-muted input-steps-hint">{triggers.length ? "No order; grouped by how they combine" : "None: the action triggers while its controls are held"}</span>
      </div>
      {groups.map((g) => (
        <div key={g.type} class="input-trigger-group" role="group" aria-label={g.label} title={g.hint}>
          <span class="input-trigger-group-label">{g.label}</span>
          <span class="input-chips">
            {g.items.map(({ trigger, index }) => (
              <button
                key={index}
                class={`input-chip input-trigger-chip${shown === index ? " open" : ""}`}
                aria-expanded={shown === index}
                aria-label={`${triggerSummary(trigger)} trigger`}
                title="Settings"
                onClick={() => setOpen(shown === index ? null : index)}
              >
                {triggerSummary(trigger)}
              </button>
            ))}
            {g.items.length === 0 && <span class="input-muted">none</span>}
          </span>
          <select
            class="input-trigger-add"
            aria-label={`Add trigger to ${g.label}`}
            title={`Add a trigger to ${g.label}`}
            disabled={readOnly}
            value=""
            onChange={(e) => {
              const name = e.currentTarget.value as TriggerName;
              if (!name) return;
              props.onChange([...triggers, newTriggerIn(name, g.type, firstAction)], "Add Trigger");
              setOpen(triggers.length);
            }}
          >
            <option value="">+</option>
            {Object.entries(TRIGGERS).map(([name, s]) => (
              <option key={name} value={name}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      ))}
      {shown !== null && (
        <TriggerSettings
          trigger={triggers[shown]}
          label={labelOf(triggers[shown])}
          actions={props.actions}
          readOnly={readOnly}
          onChange={(next, label) => props.onChange(replaceAt(triggers, shown, next), label)}
          onRemove={() => {
            setOpen(null);
            props.onChange(removeAt(triggers, shown), "Remove Trigger");
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

/** One trigger's settings, opened from its chip: its parameters, the group it combines in, Remove. */
function TriggerSettings(props: { trigger: TriggerSpec; label: string; actions: readonly ActionChoice[]; readOnly: boolean; onChange: (next: TriggerSpec, label: string) => void; onRemove(): void; onClose(): void }) {
  const { trigger, readOnly } = props;
  const s = (TRIGGERS as Record<string, StepSpec>)[stepName(trigger)];
  return (
    <div class="input-trigger-settings" role="group" aria-label={`${props.label} trigger settings`}>
      <span class="input-step-name">{props.label}</span>
      {s ? <StepParams step={trigger} spec={s} actions={props.actions} readOnly={readOnly} onChange={(next) => props.onChange(next as TriggerSpec, "Set Trigger")} /> : <code class="input-step-raw">{JSON.stringify(trigger)}</code>}
      <label class="input-param">
        Combines as
        <select aria-label="Group" disabled={readOnly} value={triggerType(trigger)} onChange={(e) => props.onChange(setTriggerGroup(trigger, e.currentTarget.value as TriggerType), "Change Trigger Group")}>
          {TRIGGER_GROUPS.map((g) => (
            <option key={g.type} value={g.type}>
              {g.label}
            </option>
          ))}
        </select>
      </label>
      <span class="input-step-tools">
        <button disabled={readOnly} class="danger" aria-label="Remove trigger" title="Remove" onClick={props.onRemove}>
          Remove
        </button>
        <button aria-label="Close trigger settings" title="Close" onClick={props.onClose}>
          Done
        </button>
      </span>
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
