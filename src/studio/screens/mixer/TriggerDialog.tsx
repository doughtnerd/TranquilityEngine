// The Trigger dialog (ADR 0344 "Snapshots blend"; the prototype's trigger window): when a snapshot starts (when
// conditions match, always as the base mix, from game code, or never: audition only), the conditions (all or any;
// one row per condition with the comparisons its parameter's type allows and a live true/false dot from the test
// values), the transition (fade in, fade out, minimum hold), the priority and Override or Add, and the snapshots it
// overlaps with and who wins where. It edits a draft; Done writes it as one undo step ("Edit trigger · <snapshot>").
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { isLabelled, type ParameterDef } from "../../../engine/audio/parameters";
import { MIX_LIMITS } from "../../../engine/audio/project/format";
import type { Snapshot, SnapshotCondition, SnapshotStart } from "../../../engine/audio/project/types";
import { Icon } from "../../components/Icon";
import { isNewParameter, NEW_PARAMETER, NEW_PARAMETER_LABEL } from "../../components/newParameterModel";
import { sessionParametersHost } from "./globalParametersHost";
import { askNewGlobalParameter } from "./newGlobalParameter";
import { parameterNote } from "./boardModel";
import { labelOn, setTrigger, type TriggerPatch } from "./mixEdits";
import type { MixerSession } from "./mixerScreen";
import { conditionHolds, defaultCondition, opsFor, overlapsOf, retarget, startHolds } from "./snapshotBlend";

const target = signal<{ session: MixerSession; name: string } | null>(null);

/** Open the Trigger dialog on snapshot `name`. */
export function openTriggerDialog(session: MixerSession, name: string): void {
  target.value = { session, name };
}

/** Mounted once by the Mixer screen. */
export function TriggerDialogHost() {
  const t = target.value;
  if (!t) return null;
  const s = t.session.project.value.snapshots.find((x) => x.name === t.name);
  if (!s) return null;
  return <TriggerDialog session={t.session} snapshot={s} onClose={() => (target.value = null)} />;
}

type Kind = SnapshotStart["kind"];
const KINDS: { value: Kind; label: string; title: string }[] = [
  { value: "conditions", label: "When conditions match", title: "Starts and stops by itself as game parameters change" },
  { value: "base", label: "Always (base mix)", title: "Always on: the mix everything else applies on top of" },
  { value: "code", label: "From game code", title: "Started and stopped by a script" },
  { value: "never", label: "Never", title: "Audition only: the game never starts it" },
];

type Draft = Required<TriggerPatch>;

export function TriggerDialog(props: { session: MixerSession; snapshot: Snapshot; onClose(): void }) {
  const { session, snapshot, onClose } = props;
  const p = session.project.value;
  const values = session.testValues.value;
  const [draft, setDraft] = useState<Draft>(() => ({ start: structuredClone(snapshot.start), fadeInMs: snapshot.fadeInMs, fadeOutMs: snapshot.fadeOutMs, holdMs: snapshot.holdMs, priority: snapshot.priority, combine: snapshot.combine }));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.querySelector<HTMLElement>("[role=radio][aria-checked=true], button")?.focus(), []);
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const conds = draft.start.kind === "conditions" ? draft.start : null;
  const setConds = (conditions: SnapshotCondition[], match = conds?.match ?? "all") => set({ start: { kind: "conditions", match, conditions } });
  /** After "+ New parameter…": use the parameter just added (read from the mix, which has it now). */
  const withParameter = (name: string, use: (d: ParameterDef) => void) => {
    const d = session.project.peek().parameters.find((q) => q.name === name);
    if (d) use(d);
  };
  const setKind = (kind: Kind) => set({ start: kind === "conditions" ? { kind, match: conds?.match ?? "all", conditions: conds?.conditions ?? (p.parameters[0] ? [defaultCondition(p.parameters[0])] : []) } : { kind } });
  const on = startHolds(draft.start, p.parameters, values);
  const overlaps = overlapsOf(p.snapshots, snapshot.name, p.parameters, values, { ...snapshot, ...draft });
  const done = () => {
    if (session.commit(setTrigger(session.project.peek(), snapshot.name, draft), labelOn("Edit trigger", snapshot.name))) onClose();
  };
  const num = (key: "fadeInMs" | "fadeOutMs" | "holdMs" | "priority", label: string, range: readonly [number, number], unit: string) => (
    <label class="mx-field">
      <span>{label}</span>
      <input type="number" min={range[0]} max={range[1]} step={key === "priority" ? 1 : 10} value={draft[key]} onInput={(e) => set({ [key]: Number((e.target as HTMLInputElement).value) })} />
      <span class="mx-faint">{unit}</span>
    </label>
  );
  return (
    <div class="mx-modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        class="mx-modal mx-trigger"
        role="dialog"
        aria-modal="true"
        aria-label={`Trigger: ${snapshot.name}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); onClose(); }
          else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) done();
        }}
      >
        <h2 class="mx-modal-title">Trigger · {snapshot.name}</h2>
        <div class="mx-field-row">
          <span class="mx-label">Starts</span>
          <SegmentedControl label="Starts" value={draft.start.kind} options={KINDS} onChange={setKind} />
        </div>
        {draft.start.kind === "code" && (
          <p class="mx-note">
            A script starts and stops it: <code>Audio.snapshot("{snapshot.name}").start()</code> and <code>.stop()</code>.
          </p>
        )}
        {draft.start.kind === "base" && <p class="mx-note">Always on. Its levels are the base mix the other snapshots apply on top of.</p>}
        {draft.start.kind === "never" && <p class="mx-note">The game never starts it; pick it in Snapshots to hear it while you mix.</p>}
        {conds && (
          <div class="mx-conds">
            <div class="mx-field-row">
              <span class="mx-label">Active while</span>
              <SegmentedControl label="Match" size="small" value={conds.match} options={[{ value: "all", label: "all" }, { value: "any", label: "any" }]} onChange={(m) => setConds(conds.conditions, m)} />
              <span>of these are true</span>
            </div>
            {p.parameters.length === 0 && <p class="mx-note">The project has no game parameters yet. Add one to test it.</p>}
            {conds.conditions.map((c, i) => {
              const def = p.parameters.find((q) => q.name === c.parameter);
              const holds = conditionHolds(c, p.parameters, values);
              const replace = (next: SnapshotCondition) => setConds(conds.conditions.map((x, j) => (j === i ? next : x)));
              return (
                <div key={i} class="mx-cond" role="group" aria-label={`Condition ${i + 1}`}>
                  <span class="mx-faint">{i === 0 ? "If" : conds.match === "all" ? "and" : "or"}</span>
                  <select aria-label="Parameter" value={c.parameter} onChange={(e) => {
                    const sel = e.target as HTMLSelectElement;
                    if (isNewParameter(sel.value)) {
                      sel.value = c.parameter;
                      return askNewGlobalParameter(sessionParametersHost(session), (name) => withParameter(name, (d) => replace(retarget(c, d))));
                    }
                    const d = p.parameters.find((q) => q.name === sel.value);
                    if (d) replace(retarget(c, d));
                  }}>
                    {!def && <option value={c.parameter}>{c.parameter} (missing)</option>}
                    {p.parameters.map((q) => <option key={q.name} value={q.name}>{q.name}</option>)}
                    <option value={NEW_PARAMETER}>{NEW_PARAMETER_LABEL}</option>
                  </select>
                  <select aria-label="Comparison" value={c.op} onChange={(e) => replace({ ...c, op: (e.target as HTMLSelectElement).value as SnapshotCondition["op"] })}>
                    {opsFor(def).map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                  </select>
                  {def && isLabelled(def) ? (
                    <select aria-label="Value" value={String(c.value)} onChange={(e) => replace({ ...c, value: (e.target as HTMLSelectElement).value })}>
                      {def.labels.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                  ) : (
                    <>
                      <input type="number" aria-label="Value" value={typeof c.value === "number" ? c.value : 0} onInput={(e) => replace({ ...c, value: Number((e.target as HTMLInputElement).value) })} />
                      {c.op === "between" && <><span>and</span><input type="number" aria-label="Second value" value={c.value2 ?? (typeof c.value === "number" ? c.value : 0)} onInput={(e) => replace({ ...c, value2: Number((e.target as HTMLInputElement).value) })} /></>}
                    </>
                  )}
                  {def && <span class="mx-faint" title="Its range">{parameterNote(def)}</span>}
                  <span class={`mx-dot${holds ? " on" : ""}`} role="img" aria-label={holds ? "True with the test values" : "False with the test values"} title={holds ? "True now" : "False now"} />
                  <button class="kit-icon-button" aria-label={`Remove condition ${i + 1}`} title="Remove this condition" onClick={() => setConds(conds.conditions.filter((_, j) => j !== i))}><Icon name="close" size={14} /></button>
                </div>
              );
            })}
            {p.parameters.length > 0 ? (
              <button class="mx-tool" onClick={() => setConds([...conds.conditions, defaultCondition(p.parameters[0]!)])}><Icon name="plus" /> Condition</button>
            ) : (
              <button class="mx-tool" disabled={session.readOnly} onClick={() => askNewGlobalParameter(sessionParametersHost(session), (name) => withParameter(name, (d) => setConds([...conds.conditions, defaultCondition(d)])))}><Icon name="plus" /> New parameter…</button>
            )}
          </div>
        )}
        <fieldset class="mx-fieldset">
          <legend>Transition</legend>
          {num("fadeInMs", "Fade in", MIX_LIMITS.snapshotMs, "ms")}
          {num("fadeOutMs", "Fade out", MIX_LIMITS.snapshotMs, "ms")}
          {num("holdMs", "Hold at least", MIX_LIMITS.snapshotMs, "ms")}
        </fieldset>
        <fieldset class="mx-fieldset">
          <legend>When snapshots overlap</legend>
          {num("priority", "Priority", MIX_LIMITS.snapshotPriority, "higher wins")}
          <div class="mx-field-row">
            <span class="mx-label">Combine</span>
            <SegmentedControl label="Combine" size="small" value={draft.combine} options={[{ value: "override", label: "Override", title: "Per bus, the highest priority wins" }, { value: "add", label: "Add", title: "Its level changes add on top" }]} onChange={(combine) => set({ combine })} />
          </div>
          {overlaps.length === 0 ? (
            <p class="mx-note">No other snapshot changes the same buses.</p>
          ) : (
            <ul class="mx-overlaps" aria-label="Overlapping snapshots">
              {overlaps.map((o) => (
                <li key={o.name} class={o.warn ? "warn" : ""}>
                  <span class={`mx-dot${o.onNow ? " on" : ""}`} aria-hidden="true" /> <strong>{o.name}</strong> <span class="mx-faint">({o.shared.join(", ")})</span>: {o.outcome}
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        <div class="mx-modal-buttons">
          <span class="mx-status-line" role="status">
            <span class={`mx-dot${on ? " on" : ""}`} aria-hidden="true" /> {on ? "True now with the test values" : "False now with the test values"}
          </span>
          <button onClick={onClose}>Cancel</button>
          <button class="primary" disabled={session.readOnly} onClick={done}>Done</button>
        </div>
      </div>
    </div>
  );
}
