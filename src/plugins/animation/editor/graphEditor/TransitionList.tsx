// The transition list panel (ADR 0373 "a transition list panel per state: reorder, a condition editor, blend settings and
// interruption"; D51–D53): a state's transitions (or the any-state list) in priority order, highest first. Drag a row (or
// use its arrows) to change its priority; open one to edit its condition rows, when it may fire, how it blends (with the
// fade shape's curve drawn from audio's shape with the same curve, `AUDIO_FADE_SHAPE`), its bridge and which
// transitions may interrupt it. Every edit is `machineLogic.ts`'s refused-or-next result, applied as one undo step.
import { useState } from "preact/hooks";
import { FADE_SHAPES, TRANSITION_HOWS, type AnimGraph, type FadeShape, type TransitionHow, type TransitionWhen } from "../../../../engine/animation/animGraph";
import type { EditResult } from "../../../../editor/sdk";
import { conditionText } from "./conditionLogic";
import { ConditionRows } from "./ConditionRows";
import { nodeById, nodeTitle } from "./graphEditLogic";
import {
  FADE_SHAPE_LABELS, addTransition, fadePreview, interruptChoices, moveTransition, priorityLabel, removeTransition, setTransition, setTransitionCondition, transitionsOf,
  type TransitionOwner, type TransitionRef,
} from "./machineLogic";
import type { PlacedProblem } from "./problemLogic";

export interface TransitionListProps {
  graph: AnimGraph;
  /** The state machine node. */
  machine: string;
  /** The state whose transitions these are (null: any state). */
  from: TransitionOwner;
  apply(result: EditResult<AnimGraph>, label: string): void;
  readOnly?: boolean;
  /** The open transition (its index), or null. */
  open: number | null;
  onOpen(index: number | null): void;
  /** Problems per transition index. */
  problems?: (index: number) => readonly PlacedProblem[];
}

const HOW_LABELS: Readonly<Record<TransitionHow, string>> = { crossfade: "Crossfade", cut: "Cut", inertialize: "Inertialize", bridge: "Bridge" };

/** The fade shape's curve: the incoming state's weight (and the outgoing one's, dashed) across the transition. */
export function FadeShapePreview(props: { shape: FadeShape; width?: number; height?: number }) {
  const w = props.width ?? 96, h = props.height ?? 40;
  const levels = fadePreview(props.shape);
  const pts = (f: (v: number) => number) => levels.map((v, i) => `${((i / (levels.length - 1)) * w).toFixed(1)},${(h - f(v) * h).toFixed(1)}`).join(" ");
  return (
    <svg class="ag-fade" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${FADE_SHAPE_LABELS[props.shape]} fade`}>
      <polyline class="ag-fade-out" points={pts((v) => 1 - v)} />
      <polyline class="ag-fade-in" points={pts((v) => v)} />
    </svg>
  );
}

/** How `when` reads in the select: now, exit, marker or time. */
const whenKind = (w: TransitionWhen) => (typeof w === "number" ? "time" : w.startsWith("marker:") ? "marker" : w);

export function TransitionList(props: TransitionListProps) {
  const { graph, machine, from, apply, readOnly = false } = props;
  const m = nodeById(graph, machine)?.machine;
  const [dragging, setDragging] = useState<number | null>(null);
  if (!m) return null;
  const list = transitionsOf(m, from);
  const owner = from ?? "Any State";
  const ref = (index: number): TransitionRef => ({ from, index });
  const name = (i: number) => `${owner} → ${list[i]!.to}`;
  const move = (i: number, to: number) => apply(moveTransition(graph, machine, ref(i), to), `Change the priority of ${name(i)}`);
  const otherStates = m.states.map((s) => s.name);
  return (
    <div class="ag-transitions" role="group" aria-label={`Transitions from ${owner}`}>
      <div class="ag-section-head">
        <span>Transitions from {owner}</span>
        <span class="ag-muted">{from === null ? "tried before every state's own" : "tried top to bottom"}</span>
      </div>
      {list.length === 0 && <p class="ag-muted">None. Drag from a state's edge to another state, or add one here.</p>}
      <ol class="ag-transition-list">
        {list.map((t, i) => {
          const problems = props.problems?.(i) ?? [];
          const isOpen = props.open === i;
          return (
            <li
              key={`${i}:${t.to}:${t.id}`}
              class={`ag-transition${isOpen ? " open" : ""}${dragging === i ? " dragging" : ""}${problems.length ? (problems.some((p) => p.severity === "error") ? " error" : " warning") : ""}`}
              data-transition={i}
              draggable={!readOnly}
              onDragStart={(e) => { setDragging(i); e.dataTransfer?.setData("text/x-myco-transition", String(i)); }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => { if (dragging !== null) e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); if (dragging !== null && dragging !== i) move(dragging, i); setDragging(null); }}
            >
              <div class="ag-transition-row">
                <span class="ag-priority" title="Priority: 1 is tried first">{priorityLabel(ref(i))}</span>
                <button class="ag-transition-title" aria-expanded={isOpen} aria-label={`Transition ${priorityLabel(ref(i))} ${name(i)}`} onClick={() => props.onOpen(isOpen ? null : i)}>
                  → {t.to}
                  <span class="ag-muted"> {conditionText(t.if)}</span>
                </button>
                <button class="icon" aria-label={`Raise ${name(i)}`} title="Higher priority" disabled={readOnly || i === 0} onClick={() => move(i, i - 1)}>↑</button>
                <button class="icon" aria-label={`Lower ${name(i)}`} title="Lower priority" disabled={readOnly || i === list.length - 1} onClick={() => move(i, i + 1)}>↓</button>
                <button class="icon" aria-label={`Remove ${name(i)}`} disabled={readOnly} onClick={() => apply(removeTransition(graph, machine, ref(i)), `Remove transition ${name(i)}`)}>×</button>
              </div>
              {problems.map((p, k) => <p key={k} class={`ag-problem ${p.severity}`}>{p.message}</p>)}
              {isOpen && <TransitionDetails {...props} index={i} label={name(i)} states={otherStates} />}
            </li>
          );
        })}
      </ol>
      <label class="ag-add-row">
        <span>Add a transition to</span>
        <select
          aria-label={`Add a transition from ${owner}`}
          value=""
          disabled={readOnly || otherStates.length === 0}
          onChange={(e) => {
            const to = (e.currentTarget as HTMLSelectElement).value;
            if (to) apply(addTransition(graph, machine, from, to), `Add transition ${owner} → ${to}`);
          }}
        >
          <option value="">…</option>
          {otherStates.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
    </div>
  );
}

function TransitionDetails(props: TransitionListProps & { index: number; label: string; states: string[] }) {
  const { graph, machine, from, apply, index, label, readOnly = false } = props;
  const m = nodeById(graph, machine)!.machine!;
  const t = transitionsOf(m, from)[index]!;
  const ref: TransitionRef = { from, index };
  const set = (patch: Parameters<typeof setTransition>[3], what: string) => apply(setTransition(graph, machine, ref, patch), `${what} (${label})`);
  const kind = whenKind(t.when);
  const choices = interruptChoices(m, ref);
  const list = typeof t.interrupt === "string" ? [] : t.interrupt;
  return (
    <div class="ag-transition-details">
      <ConditionRows
        graph={graph}
        condition={t.if}
        label={label}
        readOnly={readOnly}
        apply={(r, l) => apply("refused" in r ? r : setTransitionCondition(graph, machine, ref, r.next), l)}
      />
      <div class="ag-fields">
        <label class="ag-field"><span>To</span>
          <select aria-label={`Target of ${label}`} value={t.to} disabled={readOnly} onChange={(e) => set({ to: (e.currentTarget as HTMLSelectElement).value }, "Change target")}>
            {props.states.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label class="ag-field"><span>Id</span>
          <input type="text" aria-label={`Id of ${label}`} placeholder="none" value={t.id} disabled={readOnly} onChange={(e) => set({ id: (e.currentTarget as HTMLInputElement).value }, "Rename transition")} />
        </label>
        <label class="ag-field"><span>When</span>
          <select
            aria-label={`When of ${label}`}
            value={kind}
            disabled={readOnly}
            onChange={(e) => {
              const k = (e.currentTarget as HTMLSelectElement).value;
              set({ when: k === "time" ? 1 : k === "marker" ? "marker:Exit" : (k as "now" | "exit") }, "Change when");
            }}
          >
            <option value="now">Now</option>
            <option value="exit">At exit (marker or clip end)</option>
            <option value="marker">At a marker</option>
            <option value="time">At a normalised time</option>
          </select>
        </label>
        {kind === "marker" && (
          <label class="ag-field"><span>Marker</span>
            <input type="text" aria-label={`Marker of ${label}`} value={(t.when as string).slice(7)} disabled={readOnly} onChange={(e) => set({ when: `marker:${(e.currentTarget as HTMLInputElement).value.trim()}` }, "Change marker")} />
          </label>
        )}
        {kind === "time" && (
          <label class="ag-field"><span>Time</span>
            <input type="number" step="any" min={0} aria-label={`Normalised time of ${label}`} value={t.when as number} disabled={readOnly} onChange={(e) => set({ when: (e.currentTarget as HTMLInputElement).valueAsNumber }, "Change time")} />
          </label>
        )}
        <label class="ag-field"><span>How</span>
          <select aria-label={`How of ${label}`} value={t.how} disabled={readOnly} onChange={(e) => set({ how: (e.currentTarget as HTMLSelectElement).value as TransitionHow }, "Change blend")}>
            {TRANSITION_HOWS.map((h) => <option key={h} value={h}>{HOW_LABELS[h]}</option>)}
          </select>
        </label>
        {t.how === "bridge" || t.bridge ? (
          <label class="ag-field"><span>Bridge</span>
            <select aria-label={`Bridge of ${label}`} value={t.bridge ?? ""} disabled={readOnly} onChange={(e) => set({ bridge: (e.currentTarget as HTMLSelectElement).value || null }, "Change bridge")}>
              <option value="">…</option>
              {graph.nodes.filter((n) => n.id !== machine).map((n) => <option key={n.id} value={n.id}>{nodeTitle(n)}</option>)}
            </select>
          </label>
        ) : null}
        {t.how !== "cut" && (
          <label class="ag-field"><span>Duration (s)</span>
            <input type="number" step="any" min={0} aria-label={`Duration of ${label}`} value={t.duration} disabled={readOnly} onChange={(e) => { const v = (e.currentTarget as HTMLInputElement).valueAsNumber; if (Number.isFinite(v)) set({ duration: v }, "Change duration"); }} />
          </label>
        )}
        {t.how !== "cut" && (
          <label class="ag-field ag-field-shape"><span>Fade shape</span>
            <select aria-label={`Fade shape of ${label}`} value={t.shape} disabled={readOnly} onChange={(e) => set({ shape: (e.currentTarget as HTMLSelectElement).value as FadeShape }, "Change fade shape")}>
              {FADE_SHAPES.map((s) => <option key={s} value={s}>{FADE_SHAPE_LABELS[s]}</option>)}
            </select>
            <FadeShapePreview shape={t.shape} />
          </label>
        )}
      </div>
      <div class="ag-interrupt" role="group" aria-label={`Interruption of ${label}`}>
        <label class="ag-field"><span>Interrupted by</span>
          <select
            aria-label={`Interrupted by (${label})`}
            value={typeof t.interrupt === "string" ? t.interrupt : "list"}
            disabled={readOnly}
            onChange={(e) => {
              const v = (e.currentTarget as HTMLSelectElement).value;
              set({ interrupt: v === "list" ? (choices[0] ? [choices[0].id] : []) : (v as "never" | "any") }, "Change interruption");
            }}
          >
            <option value="never">Nothing</option>
            <option value="any">Any transition of the current state or any state</option>
            <option value="list" disabled={choices.length === 0}>These transitions…</option>
          </select>
        </label>
        {choices.length === 0 && typeof t.interrupt === "string" && <p class="ag-muted">Give other transitions an id to list them here.</p>}
        {typeof t.interrupt !== "string" && (
          <ul class="ag-interrupt-list">
            {choices.map((c) => (
              <li key={c.id}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Interrupted by ${c.id} (${label})`}
                    checked={list.includes(c.id)}
                    disabled={readOnly}
                    onChange={(e) => set({ interrupt: (e.currentTarget as HTMLInputElement).checked ? [...list, c.id] : list.filter((x) => x !== c.id) }, "Change interruption")}
                  />
                  {c.label}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
