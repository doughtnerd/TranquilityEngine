// The Event editor's properties (ADR 0158 §7): the selected node's fields, or the event's own, rendered from the
// descriptors in nodeFields.ts, with the automation lists on the shared curve widget. Each change hands the parent a
// new node (or event); the panel makes it one undo step (sliders and curve drags coalesce into one).
import type { ComponentChildren } from "preact";
import { CurveEditor } from "../../../../editor/sdk";
import {
  EVENT_TARGETS,
  isLabelled,
  parameterRange,
  type AudioEventAsset,
  type Automation,
  type EventNode,
  type EventTarget,
  type ParameterDef,
} from "../../../../engine/audio/eventFormat";
import type { Curve, CurveKey } from "../../../../engine/core/curve";
import { useState } from "preact/hooks";
import { isMusicContainer, MUSIC_LIMITS, type MusicNode, type MusicSwitchNode, type PlaylistNode } from "../../../../engine/audio/musicFormat";
import type { StingerDef } from "../../../../engine/audio/musicRules";
import { draggedClips } from "./assetDrop";
import { isLibraryPath, musicIdProblem, nodeLabel, type NodePath } from "./EventTree";
import {
  coerceField, eventFields, musicNodeFields, newStinger, nodeFields, patchStinger, readField, stingerAtFrom, stingerAtKind, writeField,
  STINGER_AT_KINDS, STINGER_IF_TOO_LATE,
  type AuxSend, type FieldDescriptor, type GroupField, type StingerAtKind,
} from "./nodeFields";

/** What the fields choose from. */
export interface FieldContext {
  /** Audio clip paths in the project, for clip pickers. */
  clips: readonly string[];
  /** Bus names from the project's audio settings (the first is Master). */
  buses: readonly string[];
  /** The event's local parameters. */
  local: readonly ParameterDef[];
  /** The project's global parameters (a local one of the same name wins). */
  global: readonly ParameterDef[];
  readOnly: boolean;
  /** Labels the text fields offer as suggestions (a switch's labelled parameter, for its children's `value` and its own `default`). */
  labels?: readonly string[];
}

/** `drag`: a slider or curve drag whose changes in a row make one undo step. */
export type OnChange<T> = (next: T, drag?: boolean, label?: string) => void;

/** Local parameters, then global ones whose names aren't local. */
export const allParameters = (c: FieldContext): ParameterDef[] => [...c.local, ...c.global.filter((g) => !c.local.some((l) => l.name === g.name))];

/** The y bounds of an automation target: a gain multiplier, a pitch ratio, a low-pass cutoff in Hz. */
const TARGET_Y: Record<EventTarget, [number, number]> = { volume: [0, 4], pitch: [0.0625, 16], lowpass: [20, 20000] };
const TARGET_REST: Record<EventTarget, number> = { volume: 1, pitch: 1, lowpass: 20000 };
const TARGET_LABEL: Record<EventTarget, string> = { volume: "Volume (×)", pitch: "Pitch (×)", lowpass: "Low-pass (Hz)" };

/** A parameter's x range for a curve (a zero-width range is widened to one unit, so the graph has an axis). */
function xRangeOf(p: ParameterDef | undefined): [number, number] {
  const [lo, hi] = p ? parameterRange(p) : [0, 1];
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

/** `curve` with its x values moved from one range to another, proportionally. */
function remapCurve(curve: Curve, from: [number, number], to: [number, number]): Curve {
  const scale = (to[1] - to[0]) / (from[1] - from[0]);
  return curve.map((k) => [to[0] + (k[0] - from[0]) * scale, k[1], ...k.slice(2)] as unknown as CurveKey);
}

const clampY = (curve: Curve, [lo, hi]: [number, number]): Curve => curve.map((k) => [k[0], Math.min(hi, Math.max(lo, k[1])), ...k.slice(2)] as unknown as CurveKey);

/** The automation list: one row per binding (parameter, target, curve), with add and remove. */
export function AutomationList(props: { list: readonly Automation[]; context: FieldContext; label: string; onChange: OnChange<Automation[]> }) {
  const { list, context, onChange } = props;
  const params = allParameters(context);
  const find = (name: string) => params.find((p) => p.name === name);
  const set = (i: number, a: Automation, drag?: boolean, label?: string) => onChange(list.map((x, j) => (j === i ? a : x)), drag, label);
  const add = () => {
    const p = params[0];
    if (!p) return;
    const [x0, x1] = xRangeOf(p);
    onChange([...list, { parameter: p.name, target: "volume", curve: [[x0, 1], [x1, 1]] }], false, "Add automation");
  };
  return (
    <div class="ev-automation" role="group" aria-label={props.label} data-testid="event-automation">
      {list.map((a, i) => {
        const p = find(a.parameter);
        const xRange = xRangeOf(p);
        return (
          <div class="ev-automation-item" key={i}>
            <div class="ev-automation-head">
              <select aria-label={`${props.label} ${i + 1} parameter`} value={a.parameter} disabled={context.readOnly} onChange={(e) => {
                const name = (e.currentTarget as HTMLSelectElement).value;
                set(i, { ...a, parameter: name, curve: remapCurve(a.curve, xRange, xRangeOf(find(name))) }, false, "Automation parameter");
              }}>
                {!p && <option value={a.parameter}>{a.parameter} (unknown)</option>}
                {params.map((q) => <option key={q.name} value={q.name}>{q.name}</option>)}
              </select>
              <select aria-label={`${props.label} ${i + 1} target`} value={a.target} disabled={context.readOnly} onChange={(e) => {
                const target = (e.currentTarget as HTMLSelectElement).value as EventTarget;
                const curve = a.curve.every((k) => k[1] === TARGET_REST[a.target]) ? a.curve.map((k) => [k[0], TARGET_REST[target], ...k.slice(2)] as unknown as CurveKey) : clampY(a.curve, TARGET_Y[target]);
                set(i, { ...a, target, curve }, false, "Automation target");
              }}>
                {EVENT_TARGETS.map((t) => <option key={t} value={t}>{TARGET_LABEL[t]}</option>)}
              </select>
              <button class="icon" aria-label={`Remove ${props.label.toLowerCase()} ${i + 1}`} title="Remove this automation" disabled={context.readOnly} onClick={() => onChange(list.filter((_, j) => j !== i), false, "Remove automation")}>
                ×
              </button>
            </div>
            <CurveEditor
              curve={a.curve}
              onChange={(curve) => set(i, { ...a, curve: curve.length > 0 ? curve : a.curve }, true, "Edit curve")}
              xRange={xRange}
              yRange={TARGET_Y[a.target]}
              interpolation
              label={`${a.parameter} to ${a.target}`}
              readOnly={context.readOnly}
            />
          </div>
        );
      })}
      <button disabled={context.readOnly || params.length === 0} title={params.length === 0 ? "Add a parameter first" : "Drive a property from a parameter"} onClick={add}>
        + Automation
      </button>
    </div>
  );
}

/** A number input that commits on change (Enter or blur). */
function NumberInput(props: { value: number; label: string; step: number; disabled: boolean; onCommit: (v: number) => void }) {
  return (
    <input
      type="number"
      class="ev-number"
      aria-label={props.label}
      step={props.step}
      value={+props.value.toFixed(4)}
      disabled={props.disabled}
      onChange={(e) => {
        const v = Number((e.currentTarget as HTMLInputElement).value);
        if (Number.isFinite(v)) props.onCommit(v);
      }}
    />
  );
}

/** A number input for an optional value that may be absent: empty (with `placeholder`) is absent, and commits `undefined`. */
function OptionalNumberInput(props: { value: number | undefined; label: string; step: number; placeholder: string; disabled: boolean; onCommit: (v: number | undefined) => void }) {
  return (
    <input
      type="number"
      class="ev-number"
      aria-label={props.label}
      step={props.step}
      placeholder={props.placeholder}
      value={props.value === undefined ? "" : +props.value.toFixed(4)}
      disabled={props.disabled}
      onChange={(e) => {
        const raw = (e.currentTarget as HTMLInputElement).value;
        if (raw.trim() === "") props.onCommit(undefined);
        else if (Number.isFinite(Number(raw))) props.onCommit(Number(raw));
      }}
    />
  );
}

/** The small button that puts an optional field back to "not set" (the key leaves the file). */
function ResetButton(props: { label: string; disabled: boolean; onReset: () => void }) {
  return <button class="icon ev-reset" aria-label={`Reset ${props.label}`} title="Reset to the default (removes it from the file)" disabled={props.disabled} onClick={props.onReset}>↺</button>;
}

/** One field's row. `value` is its current value on the target; `onValue` gets the coerced new one. */
function FieldRow(props: { field: FieldDescriptor; value: unknown; context: FieldContext; prefix: string; onValue: (v: unknown, drag?: boolean) => void }) {
  const { field: f, value, context, onValue } = props;
  const label = `${props.prefix}${f.label}`;
  const disabled = context.readOnly;
  const commit = (v: unknown, drag?: boolean) => onValue(coerceField(f, v), drag);
  const row = (control: ComponentChildren, extra = "") => (
    <div class={`ev-field${extra}`} title={f.help} data-field={f.name}>
      <span class="ev-field-label">{f.label}</span>
      <span class="ev-field-value">{control}</span>
    </div>
  );
  switch (f.kind) {
    case "number": {
      const n = typeof value === "number" ? value : f.default;
      if (f.offLabel !== undefined) {
        return row(
          <OptionalNumberInput value={typeof value === "number" ? value : undefined} label={label} step={f.step} placeholder={f.offLabel} disabled={disabled} onCommit={(v) => onValue(v === undefined ? undefined : coerceField(f, v), false)} />,
        );
      }
      const slider = f.max - f.min <= 1000;
      return row(
        <span class="ev-slider">
          {slider && <input type="range" aria-label={label} min={f.min} max={f.max} step={f.step} value={n} disabled={disabled} onInput={(e) => commit(Number((e.currentTarget as HTMLInputElement).value), true)} />}
          <NumberInput value={n} label={slider ? `${label} value` : label} step={f.step} disabled={disabled} onCommit={(v) => commit(v)} />
          {f.optional && typeof value === "number" && <ResetButton label={label} disabled={disabled} onReset={() => onValue(undefined)} />}
        </span>,
      );
    }
    case "range": {
      const pair = Array.isArray(value) ? (value as [number, number]) : undefined;
      const on = pair !== undefined;
      return row(
        <span class="ev-range">
          {f.optional && <input type="checkbox" aria-label={`${label} on`} checked={on} disabled={disabled} onChange={(e) => commit((e.currentTarget as HTMLInputElement).checked ? [...f.default] : undefined)} />}
          {(on || !f.optional) && (
            <>
              <NumberInput value={(pair ?? f.default)[0]} label={`${label} low`} step={f.step} disabled={disabled} onCommit={(v) => commit([v, (pair ?? f.default)[1]])} />
              <span class="ev-range-sep">to</span>
              <NumberInput value={(pair ?? f.default)[1]} label={`${label} high`} step={f.step} disabled={disabled} onCommit={(v) => commit([(pair ?? f.default)[0], v])} />
            </>
          )}
        </span>,
      );
    }
    case "select":
      return row(
        <select aria-label={label} value={typeof value === "string" ? value : f.default} disabled={disabled} onChange={(e) => commit((e.currentTarget as HTMLSelectElement).value)}>
          {f.optional && <option value="">{f.emptyLabel ?? "(none)"}</option>}
          {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>,
      );
    case "text": {
      const listId = context.labels?.length ? `ev-labels-${f.name}` : undefined;
      return row(
        <>
          <input
          type="text"
          list={listId}
          aria-label={label}
          placeholder={f.optional ? "(none)" : ""}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(e) => commit((e.currentTarget as HTMLInputElement).value)}
          />
          {listId && <datalist id={listId}>{context.labels!.map((l) => <option key={l} value={l} />)}</datalist>}
        </>,
      );
    }
    case "asset": {
      const path = typeof value === "string" ? value : "";
      return row(
        <select
          aria-label={label}
          value={path}
          disabled={disabled}
          onChange={(e) => commit((e.currentTarget as HTMLSelectElement).value)}
          onPointerUp={() => {
            const clips = draggedClips(1);
            if (clips.length > 0 && !disabled) commit(clips[0]);
          }}
        >
          <option value="">(no clip)</option>
          {path !== "" && !context.clips.includes(path) && <option value={path}>{path} (missing)</option>}
          {context.clips.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>,
      );
    }
    case "boolean":
      return row(<input type="checkbox" aria-label={label} checked={typeof value === "boolean" ? value : f.default} disabled={disabled} onChange={(e) => commit((e.currentTarget as HTMLInputElement).checked)} />);
    case "parameter": {
      const name = typeof value === "string" ? value : "";
      const params = allParameters(context).filter((p) => !f.labelled || isLabelled(p));
      return row(
        <select aria-label={label} value={name} disabled={disabled} onChange={(e) => commit((e.currentTarget as HTMLSelectElement).value)}>
          <option value="">(none)</option>
          {name !== "" && !params.some((p) => p.name === name) && <option value={name}>{name} (unknown)</option>}
          {params.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>,
      );
    }
    case "bus": {
      const bus = typeof value === "string" ? value : "";
      const names = context.buses.slice(1);
      return row(
        <select aria-label={label} value={bus} disabled={disabled} onChange={(e) => commit((e.currentTarget as HTMLSelectElement).value)}>
          <option value="">{context.buses[0] ?? "Master"}</option>
          {bus !== "" && !names.includes(bus) && <option value={bus}>{bus} (unknown)</option>}
          {names.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>,
      );
    }
    case "curve": {
      const set = Array.isArray(value) && value.length > 0;
      return (
        <div class="ev-field ev-field-wide" data-field={f.name} title={f.help}>
          <span class="ev-field-label">
            {f.label}
            {set && <ResetButton label={label} disabled={disabled} onReset={() => onValue(undefined)} />}
          </span>
          <CurveEditor curve={set ? (value as Curve) : f.default} onChange={(curve) => commit(curve, true)} xRange={f.xRange} yRange={f.yRange} interpolation label={label} readOnly={disabled} />
        </div>
      );
    }
    case "aux": {
      const aux = (value as AuxSend | undefined) ?? undefined;
      const names = context.buses.slice(1);
      return row(
        <>
          <select aria-label={`${label} bus`} value={aux?.bus ?? ""} disabled={disabled} onChange={(e) => {
            const bus = (e.currentTarget as HTMLSelectElement).value;
            commit(bus === "" ? undefined : { bus, level: aux?.level ?? f.default });
          }}>
            <option value="">(none)</option>
            {aux && !names.includes(aux.bus) && <option value={aux.bus}>{aux.bus} (unknown)</option>}
            {names.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          {aux && <NumberInput value={aux.level} label={`${label} level`} step={f.step} disabled={disabled} onCommit={(v) => commit({ bus: aux.bus, level: v })} />}
        </>,
      );
    }
    case "curves":
      return (
        <div class="ev-field ev-field-wide" data-field={f.name}>
          <span class="ev-field-label" title={f.help}>{f.label}</span>
          <AutomationList list={Array.isArray(value) ? (value as Automation[]) : []} context={context} label={`${props.prefix}${f.label}`} onChange={(next, drag) => onValue(next, drag)} />
        </div>
      );
    case "group":
      return <GroupRow field={f} value={value} context={context} prefix={props.prefix} onValue={onValue} />;
  }
}

function GroupRow(props: { field: GroupField; value: unknown; context: FieldContext; prefix: string; onValue: (v: unknown, drag?: boolean) => void }) {
  const { field: f, context } = props;
  const stored = props.value && typeof props.value === "object" ? (props.value as Record<string, unknown>) : undefined;
  const group = stored ?? (f.implicit ? {} : undefined);
  return (
    <fieldset class="ev-group" data-field={f.name} title={f.help}>
      <legend>
        {f.optional && !f.implicit ? (
          <label>
            <input type="checkbox" aria-label={`${props.prefix}${f.label}`} checked={group !== undefined} disabled={context.readOnly} onChange={(e) => props.onValue((e.currentTarget as HTMLInputElement).checked ? structuredClone(f.default) : undefined)} />
            {f.label}
          </label>
        ) : (
          f.label
        )}
      </legend>
      {group && <FieldList fields={f.fields} target={group} context={context} prefix={`${props.prefix}${f.label} `} onChange={(next, drag) => props.onValue(next, drag)} />}
    </fieldset>
  );
}

/** Rows for `fields` on `target`; a change hands back a copy of `target` with the field written. */
export function FieldList<T extends object>(props: { fields: readonly FieldDescriptor[]; target: T; context: FieldContext; prefix?: string; onChange: OnChange<T> }) {
  const { target } = props;
  return (
    <>
      {props.fields.map((f) => (
        <FieldRow
          key={f.name}
          field={f}
          value={readField(target as Record<string, unknown>, f)}
          context={props.context}
          prefix={props.prefix ?? ""}
          onValue={(v, drag) => props.onChange(writeField(target, f, v), drag, f.label)}
        />
      ))}
    </>
  );
}

/** The selected node's properties. */
export function NodeProperties(props: { node: EventNode; parent: EventNode | null; slot?: string; context: FieldContext; onChange: OnChange<EventNode> }) {
  const { node, parent } = props;
  const where = parent === null ? "the root" : props.slot ? `the ${props.slot} of a sustain` : `a child of ${parent.type}`;
  // A switch's labels: suggested for its children's `value` and for its own `default`.
  const sw = node.type === "switch" ? node : parent?.type === "switch" ? parent : null;
  const param = sw ? allParameters(props.context).find((p) => p.name === sw.parameter) : undefined;
  const context = param && isLabelled(param) ? { ...props.context, labels: param.labels } : props.context;
  return (
    <div class="ev-props" data-testid="event-node-properties" data-node-type={node.type}>
      <div class="ev-props-head">
        <span class="ev-badge">{node.type}</span>
        <span class="ev-props-name">{nodeLabel(node)}</span>
        <span class="ev-props-where">{where}</span>
      </div>
      <FieldList fields={nodeFields(node, parent)} target={node} context={context} onChange={props.onChange} />
    </div>
  );
}

/** The event's own properties (bus, levels, randoms, priority, spatial, limit, cooldown, automation). */
export function EventProperties(props: { event: AudioEventAsset; context: FieldContext; onChange: OnChange<AudioEventAsset> }) {
  return (
    <div class="ev-props" data-testid="event-event-properties">
      <div class="ev-props-head">
        <span class="ev-badge">event</span>
        <span class="ev-props-name">Event</span>
      </div>
      <FieldList fields={eventFields()} target={props.event} context={props.context} onChange={props.onChange} />
    </div>
  );
}

// --- music nodes (ADR 0166 §2.3, §2.5, §7) -------------------------------------------------------------------------------

/** What an audition offers the stinger rows: `AudioEventHandle.trigger` of the playing instance. Absent: nothing is playing. */
export interface StingerAudition {
  trigger(name: string): boolean;
}

export interface MusicPropertiesProps {
  /** The event's whole music tree, which the id check reads. */
  root: MusicNode;
  node: MusicNode;
  path: NodePath;
  parent: MusicNode | null;
  context: FieldContext;
  /** A change to the node's own fields or lists (never its id): the new node. */
  onChange: OnChange<MusicNode>;
  /** A new id for the node (already checked): the panel renames it and every rule, bridge and stinger naming it. */
  onRename(id: string): void;
  /** "Open segment view" on a segment (children and library segments alike). */
  onOpenSegment?(id: string): void;
  /** "Open rules table" on a container. */
  onOpenRules?(id: string): void;
  /** The playing audition, for the stinger trigger buttons; absent or null disables them. */
  audition?: StingerAudition | null;
}

/** The id row: refuses (and says why) an id the format would reject or another node already has, keeping the old id. */
function IdRow(props: { root: MusicNode; node: MusicNode; path: NodePath; disabled: boolean; onRename(id: string): void }) {
  const { node } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const commit = (raw: string) => {
    const id = raw.trim();
    if (id === node.id) {
      setDraft(null);
      setProblem(null);
      return;
    }
    const bad = musicIdProblem(props.root, props.path, id);
    setProblem(bad);
    setDraft(bad ? raw : null);
    if (!bad) props.onRename(id);
  };
  return (
    <div class="ev-field" title="The node's name in this event: 1 to 48 letters, digits, - or _, unique in the event." data-field="id">
      <span class="ev-field-label">Id</span>
      <span class="ev-field-value">
        <input type="text" aria-label="Id" aria-invalid={problem !== null} value={draft ?? node.id} disabled={props.disabled} onChange={(e) => commit((e.currentTarget as HTMLInputElement).value)} />
        {problem && <span class="ev-aud-notice" role="alert" data-testid="event-id-problem">{problem}</span>}
      </span>
    </div>
  );
}

/** The button that opens a segment in the segment view, or a container's rules table. */
function OpenButton(props: { node: MusicNode; onOpenSegment?(id: string): void; onOpenRules?(id: string): void }) {
  const { node } = props;
  return (
    <div class="ev-field ev-field-wide" data-field="open">
      {isMusicContainer(node) ? (
        <button data-testid="open-rules-table" onClick={() => props.onOpenRules?.(node.id)} disabled={!props.onOpenRules} title="Rules for changing between this container's children">Open rules table</button>
      ) : (
        <button data-testid="open-segment-view" onClick={() => props.onOpenSegment?.(node.id)} disabled={!props.onOpenSegment} title="Edit this segment's stems, cues, regions and tempo">Open segment view</button>
      )}
    </div>
  );
}

/** A container's stingers: one row each (trigger name, library segment, when, repeat guard, late rule) with a trigger button. */
function StingerList(props: { node: PlaylistNode | MusicSwitchNode; context: FieldContext; onChange: OnChange<MusicNode>; audition?: StingerAudition | null }) {
  const { node, context } = props;
  const disabled = context.readOnly;
  const library = node.library.map((s) => s.id);
  const set = (list: StingerDef[], label: string) => props.onChange({ ...node, stingers: list }, false, label);
  const patch = (i: number, p: Partial<StingerDef>, label: string) => set(node.stingers.map((s, j) => (j === i ? patchStinger(s, p) : s)), label);
  const canTrigger = !!props.audition;
  return (
    <fieldset class="ev-group" data-field="stingers" title="One-shot segments played over the music when a script or the audition triggers their name.">
      <legend>Stingers</legend>
      {node.stingers.map((s, i) => {
        const kind = stingerAtKind(s.at);
        const label = `Stinger ${i + 1}`;
        return (
          <div class="ev-automation-item" key={i} data-testid="event-stinger" data-trigger={s.trigger}>
            <div class="ev-automation-head">
              <input type="text" aria-label={`${label} trigger`} placeholder="trigger name" value={s.trigger} disabled={disabled} onChange={(e) => {
                const trigger = (e.currentTarget as HTMLInputElement).value.trim();
                if (trigger !== "") patch(i, { trigger }, "Edit stinger");
              }} />
              <button
                aria-label={`Trigger ${s.trigger}`}
                data-testid="stinger-trigger"
                disabled={!canTrigger}
                title={canTrigger ? "Play this stinger now in the running audition" : "Start the audition (Play) to trigger a stinger"}
                onClick={() => props.audition?.trigger(s.trigger)}
              >
                Trigger
              </button>
              <button class="icon" aria-label={`Remove ${label.toLowerCase()}`} title="Remove this stinger" disabled={disabled} onClick={() => set(node.stingers.filter((_, j) => j !== i), "Remove stinger")}>×</button>
            </div>
            <div class="ev-field" data-field="segment">
              <span class="ev-field-label">Segment</span>
              <span class="ev-field-value">
                <select aria-label={`${label} segment`} value={s.segment} disabled={disabled} onChange={(e) => patch(i, { segment: (e.currentTarget as HTMLSelectElement).value }, "Edit stinger")}>
                  {!library.includes(s.segment) && <option value={s.segment}>{s.segment} (unknown)</option>}
                  {library.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              </span>
            </div>
            <div class="ev-field" data-field="at">
              <span class="ev-field-label">At</span>
              <span class="ev-field-value">
                <select aria-label={`${label} at`} value={kind} disabled={disabled} onChange={(e) => patch(i, { at: stingerAtFrom((e.currentTarget as HTMLSelectElement).value as StingerAtKind, s.at) }, "Edit stinger")}>
                  {kind === "every" && <option value="every">every n (edit in the file)</option>}
                  {STINGER_AT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                {typeof s.at === "object" && "cue" in s.at && (
                  <input type="text" aria-label={`${label} cue`} placeholder="cue name" value={s.at.cue} disabled={disabled} onChange={(e) => patch(i, { at: { cue: (e.currentTarget as HTMLInputElement).value.trim() } }, "Edit stinger")} />
                )}
              </span>
            </div>
            <div class="ev-field" data-field="dontRepeat" title="Seconds during which the same stinger is not played again.">
              <span class="ev-field-label">Don't repeat</span>
              <span class="ev-field-value"><NumberInput value={s.dontRepeat} label={`${label} don't repeat`} step={0.1} disabled={disabled} onCommit={(v) => patch(i, { dontRepeat: Math.min(3600, Math.max(0, v)) }, "Edit stinger")} /></span>
            </div>
            <div class="ev-field" data-field="ifTooLate" title="What to do when the stinger's grid point has already passed.">
              <span class="ev-field-label">If too late</span>
              <span class="ev-field-value">
                <select aria-label={`${label} if too late`} value={s.ifTooLate} disabled={disabled} onChange={(e) => patch(i, { ifTooLate: (e.currentTarget as HTMLSelectElement).value as StingerDef["ifTooLate"] }, "Edit stinger")}>
                  {STINGER_IF_TOO_LATE.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </span>
            </div>
            <div class="ev-field" data-field="volume" title="Linear gain 0 to 4; empty uses the segment's own.">
              <span class="ev-field-label">Volume</span>
              <span class="ev-field-value">
                <OptionalNumberInput value={s.volume} label={`${label} volume`} step={0.05} placeholder="segment's" disabled={disabled} onCommit={(v) => patch(i, { volume: v === undefined ? undefined : Math.min(4, Math.max(0, v)) }, "Edit stinger")} />
              </span>
            </div>
            <div class="ev-field" data-field="bus" title="The bus the stinger plays through; empty is the event's.">
              <span class="ev-field-label">Bus</span>
              <span class="ev-field-value">
                <select aria-label={`${label} bus`} value={s.bus ?? ""} disabled={disabled} onChange={(e) => patch(i, { bus: (e.currentTarget as HTMLSelectElement).value }, "Edit stinger")}>
                  <option value="">(event's)</option>
                  {s.bus && !context.buses.includes(s.bus) && <option value={s.bus}>{s.bus} (unknown)</option>}
                  {context.buses.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </span>
            </div>
          </div>
        );
      })}
      <button
        disabled={disabled || library.length === 0 || node.stingers.length >= MUSIC_LIMITS.stingers}
        title={library.length === 0 ? "Add a library segment to the container first" : "Add a stinger that plays a library segment"}
        onClick={() => set([...node.stingers, newStinger(node.stingers.map((s) => s.trigger), library[0])], "Add stinger")}
      >
        + Stinger
      </button>
    </fieldset>
  );
}

/** The selected music node's properties: id, the type's fields, and for a container its stingers and library; segments and containers open their panels. */
export function MusicNodeProperties(props: MusicPropertiesProps) {
  const { node, parent, path } = props;
  const inLibrary = isLibraryPath(path);
  const where = parent === null ? "the root" : inLibrary ? "the library of its container" : `a child of ${parent.type}`;
  // A music switch's labels: suggested for its children's `value` and for its own `default`.
  const sw = node.type === "musicSwitch" ? node : parent?.type === "musicSwitch" ? parent : null;
  const param = sw ? allParameters(props.context).find((p) => p.name === sw.parameter) : undefined;
  const context = param && isLabelled(param) ? { ...props.context, labels: param.labels } : props.context;
  const fields = musicNodeFields(node, parent, inLibrary).filter((f) => f.name !== "id");
  return (
    <div class="ev-props" data-testid="event-node-properties" data-node-type={node.type}>
      <div class="ev-props-head">
        <span class="ev-badge">{node.type}</span>
        <span class="ev-props-name">{node.id}</span>
        <span class="ev-props-where">{where}</span>
      </div>
      <IdRow root={props.root} node={node} path={path} disabled={context.readOnly} onRename={props.onRename} />
      <OpenButton node={node} onOpenSegment={props.onOpenSegment} onOpenRules={props.onOpenRules} />
      <FieldList fields={fields} target={node} context={context} onChange={props.onChange} />
      {isMusicContainer(node) && (
        <>
          <StingerList node={node} context={props.context} onChange={props.onChange} audition={props.audition} />
          <fieldset class="ev-group" data-field="library" title="Bridge and stinger segments of this container; they are not children. Add them from the tree.">
            <legend>Library</legend>
            {node.library.length === 0 && <p class="ev-empty">No library segments. Use + Add, Library segment in the tree.</p>}
            {node.library.map((s) => (
              <div class="ev-field" key={s.id} data-testid="event-library-item" data-library-id={s.id}>
                <span class="ev-field-label">{s.id}</span>
                <span class="ev-field-value"><button disabled={!props.onOpenSegment} onClick={() => props.onOpenSegment?.(s.id)}>Open segment view</button></span>
              </div>
            ))}
          </fieldset>
        </>
      )}
    </div>
  );
}
