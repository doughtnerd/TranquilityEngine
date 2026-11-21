// Ed7 (api-and-models §7, §2.4): the editor of one transition rule, beside the rules table. The edits are the pure functions
// of `ruleEdits.ts`; the component hands each result to the table's `apply` (the asset document's adapter, ADR 0307: one
// undo step, or the refusal in the status bar) and shows the lint rows of the rule and the "audition this transition"
// action.
import { useState } from "preact/hooks";
import { useDraftText } from "../../../../editor/sdk";
import { FADE_CURVES, RULE_WILDCARD, type FadeCurve, type TransitionEnter, type TransitionExit, type TransitionFade } from "../../../../engine/audio/musicRules";
import type { MusicContainerNode } from "../../../../engine/audio/musicFormat";
import { endSegments, type RuleLintIssue } from "./ruleLint";
import { setRuleEnds, gridSpec, setExit, setEnter, type FadeSlot, setFade, setBridgeOwnFade, setBridge } from "./ruleEdits";
import type { EditResult } from "../editResult";
import "./ruleEditor.css";

// --- the form -----------------------------------------------------------------------------------------------------------

/** A number that commits on Enter or blur, reverts on Escape. */
function Num(props: { label: string; value: number; onCommit: (n: number) => void; disabled?: boolean }) {
  const shown = String(props.value);
  const { setDraft, input } = useDraftText(shown, (draft) => {
    const n = Number(draft);
    if (draft.trim() !== shown && draft.trim() !== "" && Number.isFinite(n)) props.onCommit(n);
    setDraft(shown);
  });
  return <input type="text" inputMode="decimal" class="narrow" aria-label={props.label} disabled={props.disabled} {...input} />;
}

const val = (e: Event): string => (e.currentTarget as HTMLSelectElement).value;

export interface RuleEditorProps {
  readonly container: MusicContainerNode;
  readonly index: number;
  /** Lint rows of this rule. */
  readonly issues: readonly RuleLintIssue[];
  readonly readOnly: boolean;
  /** Apply an edit (one undo step, or the refusal reported). */
  readonly apply: (edit: EditResult<MusicContainerNode>, label: string) => void;
  /** Start "audition this transition"; its note or refusal comes back as text. */
  readonly onAudition: (bar: number | undefined) => void;
  /** The line under the audition button (what it plays, or why it can't). */
  readonly auditionText: string | null;
  /** Why the audition can't run, when it can't (the button is disabled). */
  readonly auditionBlocked: string | null;
}

export function RuleEditor(props: RuleEditorProps) {
  const { container, index, readOnly, apply } = props;
  const rule = container.transitions[index];
  const [bar, setBar] = useState("");
  if (!rule) return <p class="empty">Choose a rule in the list to edit it.</p>;
  const run = apply;
  const runGrid = (every: "beat" | "bar", n: number) => {
    const g = gridSpec(every, n);
    run("refused" in g ? g : setExit(container, index, g.next), "Set exit grid");
  };
  const ends = [RULE_WILDCARD, ...container.children.map((c) => c.id)];
  const enterKind = typeof rule.enter === "string" ? rule.enter : "cue";
  const exitKind = typeof rule.exit === "string" ? rule.exit : rule.exit.every;
  const exitN = typeof rule.exit === "object" ? rule.exit.n : 1;
  const grid = typeof rule.exit === "object" || rule.exit === "beat" || rule.exit === "bar";
  const targets = endSegments(container, rule.to);
  const cueNames = [...new Set(targets.flatMap((s) => s.cues.map((c) => c.name)))];
  const barNumber = bar.trim() === "" ? undefined : Number(bar);
  const barBad = barNumber !== undefined && (!Number.isInteger(barNumber) || barNumber < 1);

  const fadeRow = (label: string, slot: FadeSlot, fade: TransitionFade, own = true) => (
    <div class="re-row" role="group" aria-label={label}>
      <span class="re-label">{label}</span>
      <select aria-label={`${label} unit`} value={fade.unit} disabled={readOnly || !own} onChange={(e) => run(setFade(container, index, slot, { unit: val(e) as "beats" | "seconds" }), `Set ${label} unit`)}>
        <option value="beats">beats</option>
        <option value="seconds">seconds</option>
      </select>
      <Num label={`${label} amount`} value={fade.amount} disabled={readOnly || !own} onCommit={(n) => run(setFade(container, index, slot, { amount: n }), `Set ${label}`)} />
      <span class="re-suffix">offset</span>
      <Num label={`${label} offset`} value={fade.offset} disabled={readOnly || !own} onCommit={(n) => run(setFade(container, index, slot, { offset: n }), `Set ${label} offset`)} />
      <select aria-label={`${label} curve`} value={fade.curve} disabled={readOnly || !own} onChange={(e) => run(setFade(container, index, slot, { curve: val(e) as FadeCurve }), `Set ${label} curve`)}>
        {FADE_CURVES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    </div>
  );

  return (
    <section class="rule-editor" aria-label={`Rule ${index}`} data-rule={index}>
      <h3>Rule #{index}</h3>
      <div class="re-row">
        <label>from
          <select aria-label="From" value={rule.from} disabled={readOnly} onChange={(e) => run(setRuleEnds(container, index, { from: val(e) }), "Set rule from")}>
            {!ends.includes(rule.from) && <option value={rule.from}>{rule.from} (missing)</option>}
            {ends.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label>to
          <select aria-label="To" value={rule.to} disabled={readOnly} onChange={(e) => run(setRuleEnds(container, index, { to: val(e) }), "Set rule to")}>
            {!ends.includes(rule.to) && <option value={rule.to}>{rule.to} (missing)</option>}
            {ends.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
      </div>

      <div class="re-row">
        <label>exit
          <select
            aria-label="Exit" value={grid ? "grid" : (rule.exit as string)} disabled={readOnly}
            onChange={(e) => {
              const v = val(e);
              run(setExit(container, index, v === "grid" ? "bar" : (v as TransitionExit)), "Set exit");
            }}
          >
            <option value="grid">on the grid</option>
            <option value="immediate">immediate</option>
            <option value="nextCue">next cue</option>
            <option value="exitCue">exit cue</option>
          </select>
        </label>
        {grid && (
          <>
            <span class="re-suffix">every</span>
            <Num label="Exit every" value={exitN} disabled={readOnly} onCommit={(n) => runGrid(exitKind as "beat" | "bar", n)} />
            <select aria-label="Exit unit" value={exitKind} disabled={readOnly} onChange={(e) => runGrid(val(e) as "beat" | "bar", exitN)}>
              <option value="beat">beat</option>
              <option value="bar">bar</option>
            </select>
          </>
        )}
      </div>

      <div class="re-row">
        <label>enter
          <select
            aria-label="Enter" value={enterKind} disabled={readOnly}
            onChange={(e) => {
              const v = val(e);
              run(setEnter(container, index, v === "cue" ? { cue: cueNames[0] ?? "" } : (v as TransitionEnter)), "Set enter");
            }}
          >
            <option value="entryCue">entry cue (with pre-entry)</option>
            <option value="sameTime">same musical time</option>
            <option value="cue">a named cue</option>
          </select>
        </label>
        {typeof rule.enter === "object" && (
          <select aria-label="Enter cue" value={rule.enter.cue} disabled={readOnly} onChange={(e) => run(setEnter(container, index, { cue: val(e) }), "Set enter cue")}>
            {!cueNames.includes(rule.enter.cue) && <option value={rule.enter.cue}>{rule.enter.cue || "(none)"} (missing)</option>}
            {cueNames.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </div>

      {fadeRow("Fade out", "fadeOut", rule.fadeOut)}
      {fadeRow("Fade in", "fadeIn", rule.fadeIn)}

      <div class="re-row">
        <label>bridge
          <select aria-label="Bridge" value={rule.bridge?.segment ?? ""} disabled={readOnly} onChange={(e) => run(setBridge(container, index, val(e) === "" ? null : val(e)), "Set bridge")}>
            <option value="">none</option>
            {rule.bridge && !container.library.some((s) => s.id === rule.bridge!.segment) && <option value={rule.bridge.segment}>{rule.bridge.segment} (missing)</option>}
            {container.library.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select>
        </label>
        {container.library.length === 0 && <span class="re-suffix">the container's library has no segments</span>}
      </div>
      {rule.bridge && (
        <div class="re-bridge">
          {(["fadeOut", "fadeIn"] as const).map((which) => {
            const own = rule.bridge![which];
            const label = which === "fadeOut" ? "Bridge fade out" : "Bridge fade in";
            return (
              <div key={which}>
                <label class="re-own">
                  <input type="checkbox" aria-label={`${label}: its own`} checked={own !== undefined} disabled={readOnly} onChange={(e) => run(setBridgeOwnFade(container, index, which, (e.currentTarget as HTMLInputElement).checked), `Set ${label}`)} />
                  {own ? label : `${label}: the rule's own`}
                </label>
                {own && fadeRow(label, which === "fadeOut" ? "bridgeFadeOut" : "bridgeFadeIn", own)}
              </div>
            );
          })}
        </div>
      )}


      {props.issues.length > 0 && (
        <ul class="re-lint" aria-label="Lint">
          {props.issues.map((x, i) => <li key={i} class={x.severity} data-code={x.code}>{x.message}</li>)}
        </ul>
      )}

      <div class="re-audition">
        <button type="button" disabled={readOnly || props.auditionBlocked !== null || barBad} onClick={() => props.onAudition(barNumber)}>Audition this transition</button>
        <label class="re-suffix">from bar
          <input type="text" inputMode="numeric" class="narrow" aria-label="Audition from bar" placeholder="auto" value={bar} onInput={(e) => setBar((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <p class="re-hint">{props.auditionBlocked ?? props.auditionText ?? "Plays the event from the chosen bar and asks for the change to this rule's target."}</p>
      </div>
    </section>
  );
}
