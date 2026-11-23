// A Switch's settings (the prototype's Switch view; ADR 0343 "Switch"): the labelled parameter it follows, what each
// label plays (an entry, or nothing) and its gain, the default "When it changes", and the change rules (From / To /
// When / How / Length / Transition) with the lint for rules waiting for a beat, bar or Exit marker with no tempo to
// wait on. The label playing now (its test value) is marked. A view over props.
import type { ChangeHow, PlaylistBody } from "../../../engine/audio/playlist/types";
import type { PlaylistLint } from "../../../engine/audio/playlist/lint";
import { isLabelled, type ParameterDef } from "../../../engine/audio/parameters";
import { defaultEntryUse } from "../../../engine/audio/playlist/format";
import { NumberBox, SelectBox, Section } from "../../../editor/ui/PanelFields";
import type { BodyEdit } from "./EntryList";
import { addRule, changeLength, removeRule, setLabelEntry, setLabelGain, setOnChange, setRule, setSwitchParameter, withParameter, type EditContext } from "./playlistEdits";
import { isNewParameter, NEW_PARAMETER, NEW_PARAMETER_LABEL } from "../../components/newParameterModel";
import { entryName, playlistTitle } from "./playlistPaths";
import { FadeShapeSelect } from "../../components/FadeShapeSelect";
import { Fragment } from "preact";
import { Icon } from "../../components/Icon";

export interface SwitchViewProps {
  readonly body: PlaylistBody;
  readonly ctx: EditContext;
  readonly writable: boolean;
  /** The parameter's test value (a label's index), when one is set. */
  readonly testValue?: number;
  /** Lints of this body (`where` relative to the file; `rulePrefix` is this body's `switch.rules`). */
  readonly lints: readonly PlaylistLint[];
  readonly rulePrefix: string;
  /** Playlist files a transition can play. */
  readonly playlists: readonly string[];
  onEdit(label: string, edit: BodyEdit): void;
}

const WHEN: { value: ChangeHow["when"]; label: string }[] = [
  { value: "now", label: "Immediately" },
  { value: "beat", label: "Next beat" },
  { value: "bar", label: "Next bar" },
  { value: "exit", label: "Next Exit marker" },
  { value: "nextTrigger", label: "Next trigger" },
];
const HOW: { value: ChangeHow["how"]; label: string }[] = [
  { value: "crossfade", label: "Crossfade" },
  { value: "cut", label: "Cut" },
  { value: "transition", label: "Transition playlist" },
];

const lengthOf = (c: ChangeHow) => ("ms" in c.length ? c.length.ms : c.length.beats);
const unitOf = (c: ChangeHow) => ("ms" in c.length ? "ms" : "beats");

export function SwitchView(props: SwitchViewProps) {
  const { body, writable, onEdit } = props;
  const s = body.switch;
  if (!s) return null;
  const labelled = props.ctx.parameters.filter(isLabelled);
  const def = labelled.find((p) => p.name === s.parameter) as (ParameterDef & { labels: string[] }) | undefined;
  const labels = def?.labels ?? Object.keys(s.map);
  const current = def ? (props.testValue !== undefined ? labels[Math.round(props.testValue)] : def.default) : undefined;
  const entryOptions = [{ value: "-1", label: "plays nothing" }, ...body.entries.map((e, i) => ({ value: String(i), label: entryName(e, i) }))];
  const sideOptions = [{ value: "*", label: "Any" }, ...labels.map((l) => ({ value: l, label: l }))];
  const transitionOptions = [{ value: "", label: "Choose…" }, ...props.playlists.map((p) => ({ value: p, label: playlistTitle(p) }))];
  const transitionOf = (c: ChangeHow) => (c.transition?.kind === "linked" ? c.transition.playlist : "");
  const asTransition = (path: string) => (path ? { kind: "linked" as const, playlist: path, ...defaultEntryUse() } : undefined);

  const changeRow = (c: ChangeHow, set: (patch: Partial<ChangeHow>, label: string) => void, name: string) => (
    <>
      <SelectBox label={`${name}: when`} value={c.when} disabled={!writable} options={WHEN} onValue={(v) => set({ when: v }, "Change setting")} />
      <SelectBox label={`${name}: how`} value={c.how} disabled={!writable} options={HOW} onValue={(v) => set({ how: v }, "Change setting")} />
      <span class="pl-inline">
        <NumberBox label={`${name}: length`} value={lengthOf(c)} min={0} max={9999} step={unitOf(c) === "ms" ? 10 : 0.25} digits={unitOf(c) === "ms" ? 0 : 2} disabled={!writable || c.how === "cut"} onValue={(v) => set({ length: changeLength(c, v) }, "Change setting")} />
        <span class="pl-unit">{unitOf(c)}</span>
      </span>
      {c.how === "transition" ? (
        <SelectBox label={`${name}: transition playlist`} value={transitionOf(c)} disabled={!writable} options={transitionOptions} onValue={(v) => set({ transition: asTransition(v) }, "Change setting")} />
      ) : (
        <span class="pl-faint">—</span>
      )}
    </>
  );

  /** ADR 0350: a bridge fade's controls: its length (the rule's unit) and shape; "rule's" when unset. */
  const bridgeFade = (c: ChangeHow, which: "transitionIn" | "transitionOut", set: (patch: Partial<ChangeHow>, label: string) => void, name: string) => {
    const f = c[which];
    const what = which === "transitionIn" ? "fade in" : "fade out";
    const unit = unitOf(c);
    return (
      <span class="pl-inline">
        <span class="pl-faint">Bridge {what}</span>
        <input type="checkbox" aria-label={`${name}: bridge ${what} of its own`} checked={!!f} disabled={!writable}
          title={`Off: the bridge uses the rule's length and ${which === "transitionIn" ? "fade-in" : "fade-out"} shape`}
          onChange={(e) => set({ [which]: (e.currentTarget as HTMLInputElement).checked ? { length: unit === "ms" ? { ms: lengthOf(c) } : { beats: lengthOf(c) }, shape: (which === "transitionIn" ? c.shapeIn : c.shapeOut) ?? "equalPower" } : undefined }, "Change setting")} />
        {f && (
          <>
            <NumberBox label={`${name}: bridge ${what} length`} value={"ms" in f.length ? f.length.ms : f.length.beats} min={0} max={9999} step={"ms" in f.length ? 10 : 0.25} digits={"ms" in f.length ? 0 : 2} disabled={!writable}
              onValue={(v) => set({ [which]: { ...f, length: "ms" in f.length ? { ms: Math.round(v) } : { beats: v } } }, "Change setting")} />
            <span class="pl-unit">{"ms" in f.length ? "ms" : "beats"}</span>
            <FadeShapeSelect label={`${name}: bridge ${what} shape`} out={which === "transitionOut"} value={f.shape} disabled={!writable} onValue={(v) => set({ [which]: { ...f, shape: v } }, "Change setting")} />
          </>
        )}
      </span>
    );
  };

  /** ADR 0350: a change's fade shapes, its post-exit tail and (a transition) the bridge's own fades. */
  const fadesRow = (c: ChangeHow, set: (patch: Partial<ChangeHow>, label: string) => void, name: string) => (
    <div class="pl-tr pl-fades" role="row">
      <span class="pl-fades-cell" role="cell">
        <span class="pl-inline"><span class="pl-faint">Fade out</span><FadeShapeSelect label={`${name}: fade-out shape`} out value={c.shapeOut ?? "equalPower"} disabled={!writable || c.how === "cut"} onValue={(v) => set({ shapeOut: v === "equalPower" ? undefined : v }, "Change setting")} /></span>
        <span class="pl-inline"><span class="pl-faint">Fade in</span><FadeShapeSelect label={`${name}: fade-in shape`} value={c.shapeIn ?? "equalPower"} disabled={!writable || c.how === "cut"} onValue={(v) => set({ shapeIn: v === "equalPower" ? undefined : v }, "Change setting")} /></span>
        <label class="pl-inline" title="When the playing entry has an Exit marker and the change lands on it, the audio after the marker rings on under the next entry instead of being cut (a crossfade still fades it)">
          <input type="checkbox" aria-label={`${name}: let the tail ring`} checked={c.tail !== false} disabled={!writable || c.when === "now" || c.when === "nextTrigger"} onChange={(e) => set({ tail: (e.currentTarget as HTMLInputElement).checked ? undefined : false }, "Change setting")} />
          <span class="pl-faint">Let the tail ring</span>
        </label>
        {c.how === "transition" && bridgeFade(c, "transitionIn", set, name)}
        {c.how === "transition" && bridgeFade(c, "transitionOut", set, name)}
      </span>
    </div>
  );

  return (
    <div class="pl-switch">
      <Section title="Labels" note="A labelled game parameter picks what plays. Several labels may share an entry.">
        <div class="pl-kv">
          <span class="pl-field-label">Parameter</span>
          <SelectBox
            label="Switch parameter"
            value={s.parameter}
            disabled={!writable || (labelled.length === 0 && !props.ctx.newParameter)}
            title={labelled.length === 0 ? "No labelled parameters yet: make one with + New parameter…, or a local one in the Inspector" : undefined}
            options={[
              ...(s.parameter && !def ? [{ value: s.parameter, label: `${s.parameter} (missing)` }] : []),
              ...(s.parameter ? [] : [{ value: "", label: "Choose a parameter…" }]),
              ...labelled.map((p) => ({ value: p.name, label: p.name })),
              ...(props.ctx.newParameter ? [{ value: NEW_PARAMETER, label: NEW_PARAMETER_LABEL }] : []),
            ]}
            onValue={(v) => {
              if (!isNewParameter(v)) return onEdit("Change setting", (b) => setSwitchParameter(b, v, props.ctx));
              // "+ New parameter…" (J5.1): a labelled global parameter (Wood, Metal, Water), then the Switch follows it.
              void props.ctx.newParameter?.("labelled").then((d) => d && onEdit("Change setting", (b) => setSwitchParameter(b, d.name, withParameter(props.ctx, d))));
            }}
          />
        </div>
        <div class="pl-table pl-labels" role="table" aria-label="Labels">
          <div class="pl-tr pl-th" role="row">
            <span role="columnheader">Label</span>
            <span role="columnheader">Plays</span>
            <span role="columnheader">Gain</span>
          </div>
          {labels.map((l) => {
            const i = s.map[l] ?? null;
            return (
              <div key={l} class={`pl-tr${l === current ? " pl-current" : ""}`} role="row">
                <span role="cell" title={l === current ? "The test value: playing now" : undefined}>{l === current && <Icon name="play" size={10} label="Playing now" />} {l}</span>
                <SelectBox
                  label={`${l} plays`}
                  value={String(i ?? -1)}
                  disabled={!writable}
                  options={entryOptions}
                  onValue={(v) => {
                    const n = Number(v);
                    onEdit(n < 0 ? `${l} plays nothing` : `${l} plays ${entryName(body.entries[n]!, n)}`, (b) => setLabelEntry(b, l, n < 0 ? null : n));
                  }}
                />
                <span class="pl-inline">
                  <NumberBox label={`${l} gain`} value={s.labelGain[l] ?? 0} min={-24} max={12} step={0.5} digits={1} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setLabelGain(b, l, v))} />
                  <span class="pl-unit">dB</span>
                </span>
              </div>
            );
          })}
          {labels.length === 0 && <p class="pl-note">Pick a labelled parameter to map its labels.</p>}
        </div>
      </Section>
      <Section title="When it changes" note="What happens when the label changes while the Switch plays, unless a rule below says otherwise.">
        <div class="pl-table pl-rules" role="table" aria-label="Default change">
          <div class="pl-tr pl-th" role="row">
            <span role="columnheader">When</span>
            <span role="columnheader">How</span>
            <span role="columnheader">Length</span>
            <span role="columnheader">Transition</span>
          </div>
          <div class="pl-tr" role="row">{changeRow(s.onChange, (patch, label) => onEdit(label, (b) => setOnChange(b, patch)), "Default")}</div>
          {fadesRow(s.onChange, (patch, label) => onEdit(label, (b) => setOnChange(b, patch)), "Default")}
        </div>
      </Section>
      <Section
        title="Rules"
        note="The most specific rule wins (an exact label beats Any); the first listed breaks ties."
        actions={
          <button type="button" class="pl-small" aria-label="Add rule" disabled={!writable} onClick={() => onEdit("Change setting", (b) => addRule(b, labels))}>
            <Icon name="plus" size={12} /> Rule
          </button>
        }
      >
        {s.rules.length === 0 ? (
          <p class="pl-note">No rules: every change uses “When it changes”.</p>
        ) : (
          <div class="pl-table pl-rules pl-rules-full" role="table" aria-label="Change rules">
            <div class="pl-tr pl-th" role="row">
              <span role="columnheader">From</span>
              <span role="columnheader">To</span>
              <span role="columnheader">When</span>
              <span role="columnheader">How</span>
              <span role="columnheader">Length</span>
              <span role="columnheader">Transition</span>
              <span />
            </div>
            {s.rules.map((r, i) => {
              const lint = props.lints.filter((x) => x.where === `${props.rulePrefix}[${i}]` || x.where.startsWith(`${props.rulePrefix}[${i}].`));
              return (
                <Fragment key={i}>
                <div class={`pl-tr${lint.length ? " pl-has-lint" : ""}`} role="row">
                  <SelectBox label={`Rule ${i + 1}: from`} value={r.from} disabled={!writable} options={sideOptions} onValue={(v) => onEdit("Change setting", (b) => setRule(b, i, { from: v }))} />
                  <SelectBox label={`Rule ${i + 1}: to`} value={r.to} disabled={!writable} options={sideOptions} onValue={(v) => onEdit("Change setting", (b) => setRule(b, i, { to: v }))} />
                  {changeRow(r, (patch, label) => onEdit(label, (b) => setRule(b, i, patch)), `Rule ${i + 1}`)}
                  <button type="button" class="pl-icon" aria-label={`Remove rule ${i + 1}`} title="Remove rule" disabled={!writable} onClick={() => onEdit("Change setting", (b) => removeRule(b, i))}>
                    <Icon name="close" />
                  </button>
                  {lint.map((l) => (
                    <p key={l.code} class="pl-lint" role="note">
                      <Icon name="warning" size={14} /> {l.message}
                    </p>
                  ))}
                </div>
                {fadesRow(r, (patch, label) => onEdit(label, (b) => setRule(b, i, patch)), `Rule ${i + 1}`)}
                </Fragment>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
