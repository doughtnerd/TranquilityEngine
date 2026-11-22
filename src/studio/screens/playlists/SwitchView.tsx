// A Switch's settings (the prototype's Switch view; ADR 0329 "Switch"): the labelled parameter it follows, what each
// label plays (an entry, or nothing) and its gain, the default "When it changes", and the change rules (From / To /
// When / How / Length / Transition) with the lint for rules waiting for a beat, bar or Exit marker with no tempo to
// wait on. The label playing now (its test value) is marked. A view over props.
import type { ChangeHow, PlaylistBody } from "../../../engine/audio/playlist/types";
import type { PlaylistLint } from "../../../engine/audio/playlist/lint";
import { isLabelled, type ParameterDef } from "../../../engine/audio/parameters";
import { defaultEntryUse } from "../../../engine/audio/playlist/format";
import { NumberBox, SelectBox, Section } from "./fields";
import type { BodyEdit } from "./EntryList";
import { addRule, changeLength, removeRule, setLabelEntry, setLabelGain, setOnChange, setRule, setSwitchParameter, type EditContext } from "./playlistEdits";
import { entryName, playlistTitle } from "./playlistPaths";

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

  return (
    <div class="pl-switch">
      <Section title="Labels" note="A labelled game parameter picks what plays. Several labels may share an entry.">
        <div class="pl-kv">
          <span class="pl-field-label">Parameter</span>
          <SelectBox
            label="Switch parameter"
            value={s.parameter}
            disabled={!writable || labelled.length === 0}
            title={labelled.length === 0 ? "No labelled parameters yet: add one in the Inspector's Local parameters, or in audio.json" : undefined}
            options={[...(s.parameter && !def ? [{ value: s.parameter, label: `${s.parameter} (missing)` }] : []), ...(s.parameter ? [] : [{ value: "", label: "Choose a parameter…" }]), ...labelled.map((p) => ({ value: p.name, label: p.name }))]}
            onValue={(v) => onEdit("Change setting", (b) => setSwitchParameter(b, v, props.ctx))}
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
                <span role="cell" title={l === current ? "The test value: playing now" : undefined}>{l === current ? "▸ " : ""}{l}</span>
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
        </div>
      </Section>
      <Section
        title="Rules"
        note="The most specific rule wins (an exact label beats Any); the first listed breaks ties."
        actions={
          <button type="button" class="pl-small" disabled={!writable} onClick={() => onEdit("Change setting", (b) => addRule(b, labels))}>
            + Rule
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
                <div key={i} class={`pl-tr${lint.length ? " pl-has-lint" : ""}`} role="row">
                  <SelectBox label={`Rule ${i + 1}: from`} value={r.from} disabled={!writable} options={sideOptions} onValue={(v) => onEdit("Change setting", (b) => setRule(b, i, { from: v }))} />
                  <SelectBox label={`Rule ${i + 1}: to`} value={r.to} disabled={!writable} options={sideOptions} onValue={(v) => onEdit("Change setting", (b) => setRule(b, i, { to: v }))} />
                  {changeRow(r, (patch, label) => onEdit(label, (b) => setRule(b, i, patch)), `Rule ${i + 1}`)}
                  <button type="button" class="pl-icon" aria-label={`Remove rule ${i + 1}`} disabled={!writable} onClick={() => onEdit("Change setting", (b) => removeRule(b, i))}>
                    ×
                  </button>
                  {lint.map((l) => (
                    <p key={l.code} class="pl-lint" role="note">
                      ⚠ {l.message}
                    </p>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
