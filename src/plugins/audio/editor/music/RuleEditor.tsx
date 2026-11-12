// Ed7 (api-and-models §7, §2.4): the editor of one transition rule, beside the rules table. The edits are pure functions of
// the container (`RuleEdit`: the next container or a one-line reason it was refused), validated against the same limits the
// parser clamps to, so what a form writes survives `formatAudioEvent` / `parseAudioEvent` unchanged. The component applies
// a result through the event's asset document (one undo step per edit) and shows the lint rows of the rule and the
// "audition this transition" action.
import { useEffect, useState } from "preact/hooks";
import {
  DEFAULT_TRANSITION_RULE, FADE_CURVES, GRID_EVERY_MAX, GRID_EVERY_MIN, MAX_FADE_BEATS, MAX_FADE_SECONDS, RULE_WILDCARD,
  type FadeCurve, type TransitionEnter, type TransitionExit, type TransitionFade, type TransitionRule,
} from "../../../../engine/audio/musicRules";
import { MUSIC_LIMITS, type MusicContainerNode } from "../../../../engine/audio/musicFormat";
import type { GridSpec } from "../../../../engine/audio/musicTypes";
import { endSegments, type RuleLintIssue } from "./ruleLint";
import "./ruleEditor.css";

// --- pure edits ---------------------------------------------------------------------------------------------------------

/** The next container, or why the edit was refused (shown under the form; nothing changes). */
export type RuleEdit = { readonly container: MusicContainerNode } | { readonly error: string };
const ok = (container: MusicContainerNode): RuleEdit => ({ container });
const fail = (error: string): RuleEdit => ({ error });

const freshRule = (): TransitionRule => ({
  from: RULE_WILDCARD, to: RULE_WILDCARD, exit: DEFAULT_TRANSITION_RULE.exit, enter: DEFAULT_TRANSITION_RULE.enter,
  fadeOut: { ...DEFAULT_TRANSITION_RULE.fadeOut }, fadeIn: { ...DEFAULT_TRANSITION_RULE.fadeIn },
});

function withRule(container: MusicContainerNode, index: number, change: (r: TransitionRule) => TransitionRule | string): RuleEdit {
  const rule = container.transitions[index];
  if (!rule) return fail("that rule does not exist");
  const next = change(rule);
  if (typeof next === "string") return fail(next);
  const transitions = container.transitions.slice();
  transitions[index] = next;
  return ok({ ...container, transitions });
}

/** Append a default rule `*` to `*` (at the end of the list; a later rule never beats an earlier one in its tier). */
export function addRule(container: MusicContainerNode, init: Partial<Pick<TransitionRule, "from" | "to">> = {}): RuleEdit {
  if (container.transitions.length >= MUSIC_LIMITS.rules) return fail(`at most ${MUSIC_LIMITS.rules} rules`);
  const rule = { ...freshRule(), ...init };
  const bad = endProblem(container, rule.from, "from") ?? endProblem(container, rule.to, "to");
  if (bad) return fail(bad);
  return ok({ ...container, transitions: [...container.transitions, rule] });
}

/** Copy rule `index` right after itself (it then repeats the original, which the lint flags until its ends change). */
export function duplicateRule(container: MusicContainerNode, index: number): RuleEdit {
  const rule = container.transitions[index];
  if (!rule) return fail("that rule does not exist");
  if (container.transitions.length >= MUSIC_LIMITS.rules) return fail(`at most ${MUSIC_LIMITS.rules} rules`);
  const copy = structuredClone(rule);
  const transitions = container.transitions.slice();
  transitions.splice(index + 1, 0, copy);
  return ok({ ...container, transitions });
}

export function removeRule(container: MusicContainerNode, index: number): RuleEdit {
  if (!container.transitions[index]) return fail("that rule does not exist");
  return ok({ ...container, transitions: container.transitions.filter((_, i) => i !== index) });
}

/** Move rule `index` by `delta` places (list order breaks ties inside a tier). */
export function moveRule(container: MusicContainerNode, index: number, delta: number): RuleEdit {
  const to = index + delta;
  if (!container.transitions[index]) return fail("that rule does not exist");
  if (to < 0 || to >= container.transitions.length) return fail("the rule is already at that end of the list");
  const transitions = container.transitions.slice();
  const [rule] = transitions.splice(index, 1);
  transitions.splice(to, 0, rule);
  return ok({ ...container, transitions });
}

function endProblem(container: MusicContainerNode, id: string, key: "from" | "to"): string | null {
  if (id === RULE_WILDCARD || container.children.some((c) => c.id === id)) return null;
  return `${key} must be * or the id of a direct child of ${container.id}`;
}

export function setRuleEnds(container: MusicContainerNode, index: number, ends: { from?: string; to?: string }): RuleEdit {
  return withRule(container, index, (r) => {
    const next = { ...r, ...ends };
    const bad = (ends.from !== undefined ? endProblem(container, next.from, "from") : null) ?? (ends.to !== undefined ? endProblem(container, next.to, "to") : null);
    return bad ?? next;
  });
}

/** A grid exit `"beat"`, `"bar"` or `{ every, n }`, validated like the parser (n a whole number 2..64). */
export function gridSpec(every: "beat" | "bar", n: number | null): GridSpec | string {
  if (n === null || n === 1) return every;
  if (!Number.isInteger(n) || n < GRID_EVERY_MIN || n > GRID_EVERY_MAX) return `every needs a whole number ${GRID_EVERY_MIN}..${GRID_EVERY_MAX} (or 1 for each ${every})`;
  return { every, n };
}

export function setExit(container: MusicContainerNode, index: number, exit: TransitionExit): RuleEdit {
  if (typeof exit === "object") {
    if (exit.every !== "beat" && exit.every !== "bar") return fail("exit grid must count beats or bars");
    if (!Number.isInteger(exit.n) || exit.n < GRID_EVERY_MIN || exit.n > GRID_EVERY_MAX) return fail(`exit every needs a whole number ${GRID_EVERY_MIN}..${GRID_EVERY_MAX}`);
  }
  return withRule(container, index, (r) => ({ ...r, exit }));
}

export function setEnter(container: MusicContainerNode, index: number, enter: TransitionEnter): RuleEdit {
  if (typeof enter === "object" && enter.cue.trim() === "") return fail("a cue name is needed");
  return withRule(container, index, (r) => {
    if (typeof enter === "object" && r.to !== RULE_WILDCARD) {
      const targets = endSegments(container, r.to);
      if (targets.length > 0 && !targets.some((s) => s.cues.some((c) => c.name === enter.cue))) return `${r.to} has no cue named “${enter.cue}”`;
    }
    return { ...r, enter };
  });
}

export type FadeSlot = "fadeOut" | "fadeIn" | "bridgeFadeOut" | "bridgeFadeIn";

/** `fade` checked like the parser: amount 0..64 beats or 0..60 s, offset within the same bound either way, a known curve. */
export function checkFade(fade: TransitionFade): string | null {
  const max = fade.unit === "beats" ? MAX_FADE_BEATS : MAX_FADE_SECONDS;
  if (!Number.isFinite(fade.amount) || fade.amount < 0 || fade.amount > max) return `the fade must be 0..${max} ${fade.unit}`;
  if (!Number.isFinite(fade.offset) || fade.offset < -max || fade.offset > max) return `the offset must be -${max}..${max} ${fade.unit}`;
  if (!(FADE_CURVES as readonly string[]).includes(fade.curve)) return `the curve must be one of ${FADE_CURVES.join(", ")}`;
  return null;
}

/** Change part of a fade. Changing the unit keeps the amount and offset numbers (they are re-checked against the new bound). */
export function setFade(container: MusicContainerNode, index: number, slot: FadeSlot, patch: Partial<TransitionFade>): RuleEdit {
  return withRule(container, index, (r) => {
    const current: TransitionFade | undefined = slot === "fadeOut" ? r.fadeOut : slot === "fadeIn" ? r.fadeIn : slot === "bridgeFadeOut" ? r.bridge?.fadeOut : r.bridge?.fadeIn;
    if ((slot === "bridgeFadeOut" || slot === "bridgeFadeIn") && !r.bridge) return "the rule has no bridge";
    const base = current ?? (slot === "bridgeFadeIn" ? r.fadeIn : slot === "bridgeFadeOut" ? r.fadeOut : DEFAULT_TRANSITION_RULE.fadeOut);
    const fade: TransitionFade = { ...base, ...patch };
    const bad = checkFade(fade);
    if (bad) return bad;
    switch (slot) {
      case "fadeOut": return { ...r, fadeOut: fade };
      case "fadeIn": return { ...r, fadeIn: fade };
      case "bridgeFadeOut": return { ...r, bridge: { ...r.bridge!, fadeOut: fade } };
      case "bridgeFadeIn": return { ...r, bridge: { ...r.bridge!, fadeIn: fade } };
    }
  });
}

/** Give the bridge its own fade (copied from the rule's) or take it back to the rule's own. */
export function setBridgeOwnFade(container: MusicContainerNode, index: number, which: "fadeOut" | "fadeIn", own: boolean): RuleEdit {
  return withRule(container, index, (r) => {
    if (!r.bridge) return "the rule has no bridge";
    const bridge = { ...r.bridge };
    if (own) bridge[which] = { ...r[which] };
    else delete bridge[which];
    return { ...r, bridge };
  });
}

/** Set the bridge to a library segment, or remove it with null. */
export function setBridge(container: MusicContainerNode, index: number, segment: string | null): RuleEdit {
  return withRule(container, index, (r) => {
    if (segment === null) {
      const { bridge: _bridge, ...rest } = r;
      return rest;
    }
    if (!container.library.some((s) => s.id === segment)) return `“${segment}” is not in ${container.id}'s library`;
    return { ...r, bridge: { ...(r.bridge ?? {}), segment } };
  });
}

/** One-line summary of an exit, for the list and the form. */
export function exitText(exit: TransitionExit): string {
  return typeof exit === "string" ? exit : `every ${exit.n} ${exit.every}s`;
}

// --- the form -----------------------------------------------------------------------------------------------------------

/** A number that commits on Enter or blur, reverts on Escape. */
function Num(props: { label: string; value: number; onCommit: (n: number) => void; disabled?: boolean }) {
  const shown = String(props.value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() !== shown && draft.trim() !== "" && Number.isFinite(n)) props.onCommit(n);
    setDraft(shown);
  };
  return (
    <input
      type="text" inputMode="decimal" class="narrow" aria-label={props.label} value={draft} disabled={props.disabled}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") { setDraft(shown); (e.currentTarget as HTMLInputElement).blur(); }
      }}
    />
  );
}

const val = (e: Event): string => (e.currentTarget as HTMLSelectElement).value;

export interface RuleEditorProps {
  readonly container: MusicContainerNode;
  readonly index: number;
  /** Lint rows of this rule. */
  readonly issues: readonly RuleLintIssue[];
  readonly readOnly: boolean;
  /** Apply an edit; false when it was refused (the editor shows the reason it was given). */
  readonly apply: (edit: RuleEdit, label: string) => boolean;
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
  const [error, setError] = useState("");
  const [bar, setBar] = useState("");
  if (!rule) return <p class="empty">Choose a rule in the list to edit it.</p>;
  const run = (edit: RuleEdit, label: string): void => setError(apply(edit, label) ? "" : "error" in edit ? edit.error : "");
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
            <Num label="Exit every" value={exitN} disabled={readOnly} onCommit={(n) => {
              const g = gridSpec(exitKind as "beat" | "bar", n);
              run(typeof g === "string" ? fail(g) : setExit(container, index, g), "Set exit grid");
            }} />
            <select aria-label="Exit unit" value={exitKind} disabled={readOnly} onChange={(e) => {
              const g = gridSpec(val(e) as "beat" | "bar", exitN);
              run(typeof g === "string" ? fail(g) : setExit(container, index, g), "Set exit grid");
            }}>
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

      {error && <p class="re-error" role="alert">{error}</p>}

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
