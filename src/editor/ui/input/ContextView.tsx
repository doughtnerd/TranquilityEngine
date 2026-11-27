// The Input dialog's view of a context (ADR 0417): its name, the scene nodes whose InputContext turns it on (with
// their priority), its file, and its mappings, each with the action picker (grouped by set, making a missing action
// where it's needed), its controls, a warning when a control doesn't suit the action's type, its modifiers and
// triggers. The default context also lists the code sets' inline defaults, read-only, marked "from a script".
import { useEffect, useMemo, useRef } from "preact/hooks";
import type { InputContextSpec, MappingSpec } from "../../../engine";
import { inputContextProblems, type InputActionSetInfo } from "../../../engine/editor";
import { actionChoices, actionRefFor, moveItem, problemsByMapping, replaceAt, resolveActionRef, unsuitedControls } from "../../inputContextModel";
import type { ContextEntry, ContextUser } from "../../inputDialogModel";
import { useDraftText } from "../draftText";
import { ActionPicker } from "./ActionPicker";
import type { PickerSet } from "./actionPickerModel";
import { ControlSuggestions, MappingCard } from "./MappingRows";

export interface ContextViewProps {
  readonly entry: ContextEntry;
  readonly sets: readonly InputActionSetInfo[];
  readonly pickerSets: readonly PickerSet[];
  /** The code sets' inline defaults (shown in the default context). */
  readonly scripts: readonly { readonly set: string; readonly mapping: MappingSpec }[];
  readonly users: readonly ContextUser[];
  readonly projectReadOnly: boolean;
  /** A mapping to bring into view (a Mapped in chip was clicked), or null. */
  readonly focus: number | null;
  onFocused(): void;
  onEdit(next: InputContextSpec, label: string): void;
  onRename(name: string): void;
  onRemoveMapping(index: number): void;
  /** Make `name` in `set` (typed from the mapping) and point mapping `index` at it. */
  onCreateAction(set: string, name: string, index: number): void;
  onNewSet(name: string, index: number): void;
}

let views = 0;

function NameRow(props: { name: string; readOnly: boolean; onCommit: (name: string) => void }) {
  const draft = useDraftText(props.name, (v) => v.trim() !== props.name && v.trim() && props.onCommit(v.trim()));
  return <input type="text" aria-label="Context name" disabled={props.readOnly} {...draft.input} />;
}

export function ContextView(props: ContextViewProps) {
  const { entry, sets } = props;
  const spec = entry.spec;
  const readOnly = props.projectReadOnly;
  const listId = useMemo(() => `input-dialog-controls-${++views}`, []);
  const root = useRef<HTMLElement>(null);
  const actions = actionChoices(sets);
  const problems = problemsByMapping(inputContextProblems(spec));
  const kindOf = (ref: string) => {
    const r = resolveActionRef(ref, sets);
    return r ? sets.find((s) => s.id === r.set)?.actions.find((a) => a.name === r.name)?.kind : undefined;
  };
  const setMappings = (mappings: MappingSpec[], label: string) => props.onEdit({ ...spec, mappings }, label);
  useEffect(() => {
    if (props.focus === null) return;
    const el = root.current?.querySelector<HTMLElement>(`[data-mapping-index="${props.focus}"]`);
    el?.scrollIntoView?.({ block: "center" });
    el?.focus();
    props.onFocused();
  }, [props.focus, entry.path]);

  const picker = (m: MappingSpec, i: number, ro: boolean) => (
    <ActionPicker
      sets={props.pickerSets}
      current={resolveActionRef(m.action, sets)}
      value={m.action}
      readOnly={ro}
      onPick={(set, name) => {
        const ref = actionRefFor(set, name, sets);
        if (ref !== m.action) setMappings(replaceAt(spec.mappings, i, { ...m, action: ref }), "Set Action");
      }}
      onCreate={(set, name) => props.onCreateAction(set, name, i)}
      onNewSet={(name) => props.onNewSet(name, i)}
    />
  );

  return (
    <section ref={root} class="input-view" aria-label={`Context ${entry.name}`}>
      <div class="input-fields">
        <label class="input-field">
          <span>Name</span>
          <NameRow name={spec.name} readOnly={readOnly || entry.isDefault} onCommit={props.onRename} />
        </label>
        <div class="input-field">
          <span>Used by</span>
          {/* Nodes in the project's scenes and prefabs (the open scene as edited) whose own InputContext names this context. */}
          {entry.isDefault ? (
            <span class="input-muted">Every player, whenever no other context is on (priority 0)</span>
          ) : props.users.length ? (
            <span class="input-users">
              {props.users.map((u) => (
                <span key={`${u.file}:${u.node}`} class="input-user" title={u.file}>
                  {u.node} <span class="input-muted">priority {u.priority}</span>
                </span>
              ))}
            </span>
          ) : (
            <span class="input-muted">No node's InputContext names it yet</span>
          )}
        </div>
        <div class="input-field">
          <span>Asset path</span>
          <code class="input-path">{entry.path}</code>
        </div>
      </div>
      {entry.isDefault && <p class="input-note">Every project has this context. It is on whenever no other context is, so it holds each action's everyday controls. Mappings marked “from a script” come from defineActions and are read-only.</p>}
      <ControlSuggestions id={listId} />
      <div class="input-section-head">
        <h3>Mappings</h3>
        <span class="input-count">{spec.mappings.length}</span>
        <button class="input-add" disabled={readOnly} onClick={() => setMappings([...spec.mappings, { action: "", control: "" }], "Add Mapping")}>
          Add mapping
        </button>
      </div>
      <ol class="input-mappings" aria-label="Mappings">
        {spec.mappings.map((m, i) => {
          const kind = kindOf(m.action);
          return (
            <MappingCard
              key={i}
              index={i}
              count={spec.mappings.length}
              mapping={m}
              action={picker(m, i, readOnly)}
              actions={actions}
              problems={problems.get(i) ?? []}
              warnings={kind ? unsuitedControls(m, kind) : []}
              listId={listId}
              readOnly={readOnly}
              onChange={(next, label) => setMappings(replaceAt(spec.mappings, i, next), label)}
              onMove={(by) => setMappings(moveItem(spec.mappings, i, by), "Move Mapping")}
              onDuplicate={() => setMappings([...spec.mappings.slice(0, i + 1), structuredClone(m), ...spec.mappings.slice(i + 1)], "Duplicate Mapping")}
              onRemove={() => props.onRemoveMapping(i)}
            />
          );
        })}
      </ol>
      {spec.mappings.length === 0 && <p class="input-note">No mappings yet. Add one for each control that drives an action in this context.</p>}
      {entry.isDefault && props.scripts.length > 0 && (
        <ol class="input-mappings" aria-label="Mappings from scripts">
          {props.scripts.map((s, i) => (
            <MappingCard
              key={`s${i}`}
              index={i}
              count={props.scripts.length}
              mapping={s.mapping}
              action={picker(s.mapping, i, true)}
              actions={actions}
              problems={[]}
              fromScript
              listId={listId}
              readOnly
              onChange={() => {}}
              onMove={() => {}}
              onDuplicate={() => {}}
              onRemove={() => {}}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
