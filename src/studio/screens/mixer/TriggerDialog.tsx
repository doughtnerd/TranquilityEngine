// The Trigger dialog (ADR 0344 "Snapshots blend"; the prototype's trigger window, spec §4.3.8): when a snapshot starts
// (when conditions match, always as the base mix, from game code, or never: audition only), the conditions (all or any;
// one row per condition: the parameter with its type, the comparisons that type allows, its value, and a live dot from
// the test values), the transition (fade in, fade out, minimum hold), and — unless it is the base mix — its priority,
// Override or Add, and the snapshots it overlaps with (named in words: buses and effect parameters) and who wins where.
// Every picker is an in-app dropdown. It edits a draft; Done writes it as one undo step ("Edit trigger · <snapshot>").
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { KitDialog } from "../../../editor/ui/KitDialog";
import { effectSpec } from "../../../engine/audio/effects/catalogue";
import { isLabelled, parameterKind, parameterKindText, type ParameterDef } from "../../../engine/audio/parameters";
import { MIX_LIMITS } from "../../../engine/audio/project/format";
import type { AudioProject, Snapshot, SnapshotCondition, SnapshotStart } from "../../../engine/audio/project/types";
import { Icon } from "../../components/Icon";
import { NEW_PARAMETER_LABEL } from "../../components/newParameterModel";
import { busOf, returnOf } from "./busTree";
import { sessionParametersHost } from "./globalParametersHost";
import { labelOn, setTrigger, type TriggerPatch } from "./mixEdits";
import type { MixerSession } from "./mixerScreen";
import { MixDropdown } from "./MixDropdown";
import { askNewGlobalParameter } from "./newGlobalParameter";
import { conditionHolds, defaultCondition, opIndex, opsFor, overlapsOf, retarget, startHolds, withOp } from "./snapshotBlend";

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
  { value: "never", label: "Never (audition only)", title: "The game never starts it; audition it by selecting it" },
];

type Draft = Required<TriggerPatch>;

/** A small number field with its unit (the prototype's `.nf`: 54 px, right-aligned). */
function Num(props: { label: string; value: number; range: readonly [number, number]; step?: number; unit?: string; title?: string; onValue(v: number): void }) {
  return (
    <label class="mx-trfield" title={props.title}>
      <span class="mx-trlabel">{props.label}</span>
      <input
        type="number"
        class="mx-nf"
        min={props.range[0]}
        max={props.range[1]}
        step={props.step ?? 10}
        value={props.value}
        onInput={(e) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(v)) props.onValue(Math.min(props.range[1], Math.max(props.range[0], v)));
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {props.unit && <span class="mx-unit">{props.unit}</span>}
    </label>
  );
}

/** "Music › Low-pass cutoff": an effect parameter of a bus, in words (never its internal id). */
function effectParamText(p: AudioProject, bus: string, id: string, param: string): string {
  const owner = busOf(p, bus) ?? returnOf(p, bus);
  const fx = owner?.effects.find((e) => e.id === id);
  if (!fx) return `${bus} › ${param}`;
  const spec = effectSpec(fx.type);
  const same = owner!.effects.filter((e) => e.type === fx.type);
  const label = same.length > 1 ? `${spec.label} ${same.indexOf(fx) + 1}` : spec.label;
  return `${bus} › ${label} ${(spec.params.find((q) => q.name === param)?.label ?? param).toLowerCase()}`;
}

function ConditionRow(props: { session: MixerSession; c: SnapshotCondition; i: number; match: "all" | "any"; replace(next: SnapshotCondition): void; remove(): void; addParameter(use: (d: ParameterDef) => void): void }) {
  const { session, c, i } = props;
  const p = session.project.value;
  const def = p.parameters.find((q) => q.name === c.parameter);
  const holds = conditionHolds(c, p.parameters, session.testValues.value);
  const ops = opsFor(def);
  const kind = def ? parameterKind(def) : "number";
  const at = opIndex(c, def);
  return (
    <div class="mx-cnr" role="group" aria-label={`Condition ${i + 1}`}>
      <span class="mx-cnr-lead">{i === 0 ? "If" : props.match === "all" ? "and" : "or"}</span>
      <MixDropdown
        label="Parameter"
        value={c.parameter}
        fallback={`${c.parameter} (missing)`}
        options={p.parameters.map((q) => ({ value: q.name, label: q.name, note: parameterKindText(q) }))}
        extra={session.readOnly ? [] : [{ id: "new", label: NEW_PARAMETER_LABEL, run: () => props.addParameter((d) => props.replace(retarget(c, d))) }]}
        onChange={(name) => {
          const d = p.parameters.find((q) => q.name === name);
          if (d) props.replace(retarget(c, d));
        }}
      />
      <MixDropdown label="Comparison" value={String(Math.max(0, at))} options={ops.map((o, k) => ({ value: String(k), label: o.label }))} onChange={(k) => props.replace(withOp(c, ops[Number(k)]!))} />
      <span class="mx-cnr-value">
        {kind === "bool" ? null : kind === "state" && def && isLabelled(def) ? (
          <MixDropdown label="Value" value={String(c.value)} fallback={String(c.value)} options={def.labels.map((l) => ({ value: l, label: l }))} onChange={(v) => props.replace({ ...c, value: v })} />
        ) : kind === "text" && def && isLabelled(def) ? (
          <input type="text" class="mx-cnr-text" aria-label="Value" placeholder="text" list={`mx-text-${i}`} value={String(c.value)} title={`Values the game sends: ${def.labels.join(", ")}`} onInput={(e) => props.replace({ ...c, value: (e.target as HTMLInputElement).value })} />
        ) : (
          <>
            <input type="number" class="mx-nf" aria-label="Value" value={typeof c.value === "number" ? c.value : 0} title={def && !isLabelled(def) ? `${def.min} to ${def.max}` : undefined} onInput={(e) => props.replace({ ...c, value: Number((e.target as HTMLInputElement).value) })} />
            {c.op === "between" && (
              <>
                <span class="mx-faint">and</span>
                <input type="number" class="mx-nf" aria-label="Second value" value={c.value2 ?? (typeof c.value === "number" ? c.value : 0)} onInput={(e) => props.replace({ ...c, value2: Number((e.target as HTMLInputElement).value) })} />
              </>
            )}
          </>
        )}
        {kind === "text" && def && isLabelled(def) && (
          <datalist id={`mx-text-${i}`}>
            {def.labels.map((l) => <option key={l} value={l} />)}
          </datalist>
        )}
      </span>
      <span class={`mx-dot${holds ? " on" : ""}`} role="img" aria-label={holds ? "True with the test values" : "False with the test values"} title={holds ? "True now with the test values" : "False now with the test values"} />
      <button class="kit-icon-button mx-cnr-x" aria-label={`Remove condition ${i + 1}`} title="Remove this condition" onClick={props.remove}><Icon name="close" size={12} /></button>
    </div>
  );
}

export function TriggerDialog(props: { session: MixerSession; snapshot: Snapshot; onClose(): void }) {
  const { session, snapshot, onClose } = props;
  const p = session.project.value;
  const values = session.testValues.value;
  const [draft, setDraft] = useState<Draft>(() => ({ start: structuredClone(snapshot.start), fadeInMs: snapshot.fadeInMs, fadeOutMs: snapshot.fadeOutMs, holdMs: snapshot.holdMs, priority: snapshot.priority, combine: snapshot.combine }));
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => body.current?.querySelector<HTMLElement>("button.mx-dd")?.focus(), []);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const conds = draft.start.kind === "conditions" ? draft.start : null;
  const setConds = (conditions: SnapshotCondition[], match = conds?.match ?? "all") => set({ start: { kind: "conditions", match, conditions } });
  /** "+ New parameter…": the New parameter dialog, then use the parameter just added (read from the mix, which has it now). */
  const addParameter = (use: (d: ParameterDef) => void) =>
    askNewGlobalParameter(sessionParametersHost(session), (name) => {
      const d = session.project.peek().parameters.find((q) => q.name === name);
      if (d) use(d);
    });
  const setKind = (kind: Kind) => set({ start: kind === "conditions" ? { kind, match: conds?.match ?? "all", conditions: conds?.conditions ?? (p.parameters[0] ? [defaultCondition(p.parameters[0])] : []) } : { kind } });
  const on = startHolds(draft.start, p.parameters, values);
  const overlaps = overlapsOf(p.snapshots, snapshot.name, p.parameters, values, { ...snapshot, ...draft }, (bus, id, param) => effectParamText(p, bus, id, param));
  const done = () => {
    if (session.commit(setTrigger(session.project.peek(), snapshot.name, draft), labelOn("Edit trigger", snapshot.name))) onClose();
  };
  const kind = draft.start.kind;
  return (
    <KitDialog
      title={<>Trigger <span class="mx-trname">{snapshot.name}</span></>}
      width={600}
      class="mx-trigger"
      onClose={onClose}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) done();
      }}
      summary={
        <span class={`mx-trstatus${on ? " on" : ""}`} role="status">
          <span class={`mx-dot${on ? " on" : ""}`} aria-hidden="true" /> {on ? "True now with the test values" : "False now with the test values"}
        </span>
      }
      buttons={
        <>
          <button onClick={onClose}>Cancel</button>
          <button class="primary" disabled={session.readOnly} onClick={done}>Done</button>
        </>
      }
    >
      <div ref={body} class="mx-trbody">
        <div class="mx-trrow">
          <span class="mx-trlabel">Starts</span>
          <MixDropdown label="Starts" value={kind} options={KINDS} onChange={setKind} title={KINDS.find((k) => k.value === kind)?.title} />
        </div>
        {kind === "base" && <p class="mx-trnote">Always active: the mix every other snapshot is applied on top of.</p>}
        {kind === "code" && (
          <div class="mx-trnote">
            Start and stop it from game code:
            <code class="mx-tcode">Audio.snapshot("{snapshot.name}").start()</code>
            <code class="mx-tcode">Audio.snapshot("{snapshot.name}").stop()</code>
          </div>
        )}
        {kind === "never" && <p class="mx-trnote">Never starts by itself. Audition it here by selecting it.</p>}
        {conds && (
          <div class="mx-conds">
            <div class="mx-trrow">
              <span>Active while</span>
              <MixDropdown label="Match" value={conds.match} options={[{ value: "all", label: "all" }, { value: "any", label: "any" }]} onChange={(m) => setConds(conds.conditions, m)} />
              <span>of these are true</span>
            </div>
            {conds.conditions.map((c, i) => (
              <ConditionRow
                key={i}
                session={session}
                c={c}
                i={i}
                match={conds.match}
                replace={(next) => setConds(conds.conditions.map((x, j) => (j === i ? next : x)))}
                remove={() => setConds(conds.conditions.filter((_, j) => j !== i))}
                addParameter={addParameter}
              />
            ))}
            {conds.conditions.length === 0 && <p class="mx-note">No conditions yet: it never starts on its own.</p>}
            {p.parameters.length > 0 ? (
              <button class="mx-tool" onClick={() => setConds([...conds.conditions, defaultCondition(p.parameters[conds.conditions.length % p.parameters.length]!)])}><Icon name="plus" size={13} /> Condition</button>
            ) : (
              <button class="mx-tool" disabled={session.readOnly} onClick={() => addParameter((d) => setConds([...conds.conditions, defaultCondition(d)]))}><Icon name="plus" size={13} /> New parameter…</button>
            )}
          </div>
        )}
        <section class="mx-trsec" aria-label="Transition">
          <h3 class="mx-trcap">Transition</h3>
          <div class="mx-trrow">
            <Num label="Fade in" value={draft.fadeInMs} range={MIX_LIMITS.snapshotMs} unit="ms" onValue={(v) => set({ fadeInMs: v })} />
            <Num label="Fade out" value={draft.fadeOutMs} range={MIX_LIMITS.snapshotMs} unit="ms" onValue={(v) => set({ fadeOutMs: v })} />
            <Num label="Hold at least" value={draft.holdMs} range={MIX_LIMITS.snapshotMs} unit="ms" title="Stay active at least this long once started, so a value hovering at the threshold doesn't flicker the mix" onValue={(v) => set({ holdMs: v })} />
          </div>
        </section>
        {kind !== "base" && (
          <section class="mx-trsec" aria-label="When other snapshots are active too">
            <h3 class="mx-trcap">When other snapshots are active too</h3>
            <div class="mx-trrow">
              <Num label="Priority" value={draft.priority} range={MIX_LIMITS.snapshotPriority} step={1} unit="higher wins" onValue={(v) => set({ priority: Math.round(v) })} />
              <span class="mx-trlabel">Combine</span>
              <MixDropdown label="Combine" value={draft.combine} options={[{ value: "override", label: "Override: higher priority wins" }, { value: "add", label: "Add: dB changes stack" }]} onChange={(combine) => set({ combine })} />
            </div>
            {overlaps.length === 0 ? (
              <p class="mx-note">No other snapshot changes the same buses.</p>
            ) : (
              <ul class="mx-overlaps" aria-label="Overlapping snapshots">
                {overlaps.map((o) => (
                  <li key={o.name} class="mx-clr" title={`Both change ${o.shared.join(", ")}`}>
                    <span class={`mx-dot${o.onNow ? (on ? " warn" : " on") : ""}`} role="img" aria-label={o.onNow ? "Active now" : "Not active now"} />
                    <span class="mx-clr-main">
                      <span class="mx-clr-name">{o.name}</span>
                      <span class="mx-clr-sub">priority {o.priority} · also changes {o.changes.join(", ")}</span>
                    </span>
                    <span class={`mx-clr-out${o.warn ? " warn" : ""}`}>{o.outcome}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </KitDialog>
  );
}
