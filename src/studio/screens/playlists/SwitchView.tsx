// A Switch's labels and change rules (the prototype's Switch view; ADR 0343 "Switch"; its parameter and "When it
// changes" sit in the toolbar row above, `ModeToolbar.tsx`). One row per label: the label, what it plays (a chip that
// opens the plays menu: Nothing, then every entry with its badge, "also <label>" where another label plays it, ✓ on the
// current one), its voice (the label's gain, and the curves of the entry it plays), a bar of its live level and Open.
// The label of the test value is highlighted. Then the change rules: the default row (Any → Any, set by When it
// changes) that always exists, and one compact row per rule (From, To, When, How, its length or transition playlist,
// its fades in a popover, Remove), the rule that fired last lit. Entries no label plays are listed under them. A view
// over props.
import { useState } from "preact/hooks";
import type { ChangeHow, ChangeRule, Entry, PlaylistBody } from "../../../engine/audio/playlist/types";
import type { PlaylistLint } from "../../../engine/audio/playlist/lint";
import { isLabelled, type ParameterDef } from "../../../engine/audio/parameters";
import { defaultEntryUse } from "../../../engine/audio/playlist/format";
import { ContextMenu, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { NumberBox, SelectBox } from "../../../editor/ui/PanelFields";
import { Icon } from "../../components/Icon";
import { TypeBadge } from "../../components/TypeBadge";
import { EntryList, type EntryListProps } from "./EntryList";
import { dbText, pct } from "./entryRowModel";
import { CurveGlyph } from "./glyphs";
import { MiniPopover } from "./MiniPopover";
import { ChangeExtras, changeText, unitOf } from "./ModeToolbar";
import { addRule, changeLength, removeRule, setLabelEntry, setLabelGain, setRule } from "./playlistEdits";
import { entryName, playlistTitle } from "./playlistPaths";
import { EmptyState } from "../../../editor/ui/EmptyState";

export interface SwitchViewProps extends EntryListProps {
  /** The parameter's test value (a label's index), when one is set. */
  readonly testValue?: number;
  /** Lints of this body (`where` relative to the file; `rulePrefix` is this body's `switch.rules`). */
  readonly lints: readonly PlaylistLint[];
  readonly rulePrefix: string;
  /** Playlist files a transition can play. */
  readonly playlists: readonly string[];
  /** The rule that fired at the last label change while auditioning (-1: the default), null for none. */
  readonly fired?: number | null;
}

const WHEN: { value: ChangeHow["when"]; label: string }[] = [
  { value: "now", label: "Now" },
  { value: "beat", label: "Next beat" },
  { value: "bar", label: "Next bar" },
  { value: "exit", label: "Next Exit marker" },
  { value: "nextTrigger", label: "Next trigger" },
];
const HOW: { value: ChangeHow["how"]; label: string }[] = [
  { value: "crossfade", label: "Crossfade" },
  { value: "cut", label: "Cut" },
  { value: "transition", label: "Transition clip" },
];

const lengthOf = (c: ChangeHow) => ("ms" in c.length ? c.length.ms : c.length.beats);

/** Badge props of an entry. */
function badgeOf(e: Entry, facts: EntryListProps["facts"]) {
  if (e.kind === "embedded") return <TypeBadge playlist={e.embedded.type} axes={e.embedded.blend?.axes.length === 2 ? 2 : 1} />;
  const f = e.kind === "linked" ? facts(e) : null;
  return f ? <TypeBadge playlist={f.type} axes={f.axes} /> : <TypeBadge sample />;
}

export function SwitchView(props: SwitchViewProps) {
  const { body, writable, onEdit } = props;
  const [plays, setPlays] = useState<{ label: string; at: Element } | null>(null);
  const [transition, setTransition] = useState<{ rule: number; at: Element } | null>(null);
  const s = body.switch;
  if (!s) return null;
  const def = props.ctx.parameters.filter(isLabelled).find((p) => p.name === s.parameter) as (ParameterDef & { labels: string[] }) | undefined;
  const labels = def?.labels ?? Object.keys(s.map);
  const current = def ? (props.testValue !== undefined ? labels[Math.round(props.testValue)] : def.default) : undefined;
  const sideOptions = [{ value: "*", label: "Any" }, ...labels.map((l) => ({ value: l, label: l }))];
  const usedBy = (i: number) => labels.filter((l) => s.map[l] === i);
  const unused = body.entries.map((_, i) => i).filter((i) => usedBy(i).length === 0);

  const playsMenu = (label: string): MenuEntry[] => {
    const cur = s.map[label] ?? null;
    return [
      { kind: "group", label: `${label} plays` },
      { id: "none", label: "— Nothing", checked: cur === null, disabled: !writable, run: () => onEdit(`${label} plays nothing`, (b) => setLabelEntry(b, label, null)) },
      ...body.entries.map((e, i): MenuEntry => {
        const also = usedBy(i).filter((l) => l !== label);
        return { id: `e${i}`, label: entryName(e, i), checked: cur === i, note: also.length ? `also ${also.join(", ")}` : undefined, disabled: !writable, run: () => onEdit(`${label} plays ${entryName(e, i)}`, (b) => setLabelEntry(b, label, i)) };
      }),
    ];
  };
  const transitionMenu = (rule: number): MenuEntry[] => {
    const r = s.rules[rule]!;
    const cur = r.transition?.kind === "linked" ? r.transition.playlist : "";
    return [
      { kind: "group", label: "Transition clip" },
      { id: "none", label: "— None", checked: !cur, disabled: !writable, run: () => onEdit(`Change rule ${rule + 1} transition clip`, (b) => setRule(b, rule, { transition: undefined })) },
      ...props.playlists.map((p): MenuEntry => ({ id: p, label: playlistTitle(p), checked: p === cur, disabled: !writable, run: () => onEdit(`Change rule ${rule + 1} transition clip`, (b) => setRule(b, rule, { transition: { kind: "linked", playlist: p, ...defaultEntryUse() } })) })),
    ];
  };

  return (
    <div class="pl-switch">
      <div class="pl-lh pl-srow" aria-hidden="true">
        <span title={s.parameter || undefined}>{s.parameter || "Label"}</span>
        <span>Plays</span>
        <span title="The label's gain, and the voice curves of the entry it plays. Gain is relative to the level prepared in Samples (0 dB = unchanged).">Voice</span>
        <span class="pl-right">Now</span>
        <span />
      </div>
      <div role="table" aria-label="Labels" class="pl-srows">
        {labels.map((l) => {
          const i = s.map[l] ?? null;
          const e = i !== null ? body.entries[i] : undefined;
          const hot = l === current;
          const w = hot && i !== null ? Math.max(0, Math.min(1, props.weights?.[i] ?? 0)) : 0;
          const gain = s.labelGain[l] ?? 0;
          return (
            <div key={l} role="row" class={`pl-srow${hot ? " hot" : ""}`} aria-current={hot ? "true" : undefined} title={hot ? "The test value: this label plays now" : undefined}>
              <span role="cell" class="pl-lbl" title={l}>{l}</span>
              <span role="cell" class="pl-cell">
                <button type="button" class={`pl-chip swc${e ? "" : " none"}`} aria-haspopup="menu" aria-expanded={plays?.label === l} aria-label={`${l} plays ${e ? entryName(e, i!) : "nothing"}`} title={`What ${l} plays`} disabled={!writable && !e}
                  onClick={(ev) => setPlays({ label: l, at: ev.currentTarget as Element })}>
                  {e ? badgeOf(e, props.facts) : <TypeBadge placeholder />}
                  <span class="pl-nm">{e ? entryName(e, i!) : "Nothing"}</span>
                  <Icon name="chevronDown" size={10} />
                </button>
              </span>
              <span role="cell" class="pl-cell">
                <MiniPopover title={`${l} voice`} buttonClass={`pl-cvw${gain ? " set" : ""}${e && Object.values(e.curves).some((c) => c && !c.bypass) ? " shp" : ""}`} buttonLabel={`${l} voice: ${dbText(gain)}`}
                  buttonTitle={`${l}: ${dbText(gain)}${e ? `, playing ${entryName(e, i!)}` : ""}. Click for its gain and the entry's curves.`}
                  button={<><CurveGlyph /><span>{dbText(gain)}</span></>}>
                  <div class="pl-pop-grid">
                    <span class="pl-faint">Gain</span>
                    <span class="pl-inline">
                      <NumberBox class="pl-n56" label={`${l} gain`} value={gain} min={-24} max={12} step={0.5} digits={1} disabled={!writable} onValue={(v) => onEdit(`${l} gain`, (b) => setLabelGain(b, l, v))} />
                      <span class="pl-unit">dB</span>
                    </span>
                  </div>
                  {e && <button type="button" class="pl-small" disabled={!writable} onClick={() => props.onEditCurves(i!)}>Edit {entryName(e, i!)} curves…</button>}
                </MiniPopover>
              </span>
              <span role="cell" class="pl-wb" title={`Now ${pct(w)}`}><em style={{ width: `${w * 100}%` }} /></span>
              <span role="cell" class="pl-entry-actions">
                {e && e.kind !== "sample" && <button type="button" class="pl-ib" aria-label={`Open ${l} entry`} title="Open" onClick={() => props.onOpen(i!)}><Icon name="chevronRight" size={12} /></button>}
              </span>
            </div>
          );
        })}
        {labels.length === 0 && <EmptyState compact title="Pick a labelled parameter with By to map its labels." />}
      </div>

      <div class="pl-subcap">Change rules</div>
      <div class="pl-lh pl-rrow" aria-hidden="true"><span>From</span><span>To</span><span>When</span><span>How</span><span>Fade / clip</span><span /></div>
      <div role="table" aria-label="Change rules" class="pl-rrows">
        <div role="row" class={`pl-rrow def${props.fired === -1 ? " hot" : ""}`} title="Set by When it changes above">
          <span role="cell" class="pl-faint">Any</span>
          <span role="cell" class="pl-faint">Any</span>
          <span role="cell" class="pl-faint pl-dt">{changeText(s.onChange)} (default)</span>
          <span />
        </div>
        {s.rules.map((r, i) => {
          const lint = props.lints.filter((x) => x.where === `${props.rulePrefix}[${i}]` || x.where.startsWith(`${props.rulePrefix}[${i}].`));
          const set = (patch: Partial<ChangeRule>, label = `Change rule ${i + 1} fades`) => onEdit(label, (b) => setRule(b, i, patch));
          const tr = r.transition?.kind === "linked" ? r.transition.playlist : "";
          return (
            <div key={i} role="row" class={`pl-rrow${props.fired === i ? " hot" : ""}${lint.length ? " pl-has-lint" : ""}`}>
              <SelectBox label={`Rule ${i + 1}: from`} value={r.from} disabled={!writable} options={sideOptions} onValue={(v) => set({ from: v }, `Change rule ${i + 1} From`)} />
              <SelectBox label={`Rule ${i + 1}: to`} value={r.to} disabled={!writable} options={sideOptions} onValue={(v) => set({ to: v }, `Change rule ${i + 1} To`)} />
              <SelectBox label={`Rule ${i + 1}: when`} value={r.when} disabled={!writable} options={WHEN} onValue={(v) => set({ when: v }, `Change rule ${i + 1} When`)} />
              <SelectBox label={`Rule ${i + 1}: how`} value={r.how} disabled={!writable} options={HOW} onValue={(v) => set({ how: v }, `Change rule ${i + 1} How`)} />
              <span class="pl-inline pl-fadecell">
                {r.how === "transition" ? (
                  <button type="button" class="pl-small pl-menu-btn" aria-haspopup="menu" aria-expanded={transition?.rule === i} aria-label={`Rule ${i + 1}: transition clip`} title="Transition clip" disabled={!writable}
                    onClick={(ev) => setTransition({ rule: i, at: ev.currentTarget as Element })}>
                    <span class="pl-nm">{tr ? playlistTitle(tr) : "Choose…"}</span>
                    <Icon name="chevronDown" size={10} />
                  </button>
                ) : r.how === "crossfade" ? (
                  <>
                    <NumberBox class="pl-n56" label={`Rule ${i + 1}: fade length`} value={lengthOf(r)} min={0} max={9999} step={unitOf(r) === "ms" ? 10 : 0.25} digits={unitOf(r) === "ms" ? 0 : 2} disabled={!writable} onValue={(v) => set({ length: changeLength(r, v) }, `Change rule ${i + 1} fade length`)} />
                    <span class="pl-unit">{unitOf(r)}</span>
                  </>
                ) : null}
                <ChangeExtras change={r} writable={writable} playlists={props.playlists} name={`Rule ${i + 1}`} set={set} />
              </span>
              <button type="button" class="pl-ib" aria-label={`Remove rule ${i + 1}`} title="Remove rule" disabled={!writable} onClick={() => onEdit(`Remove rule ${i + 1}`, (b) => removeRule(b, i))}>
                <Icon name="trash" size={12} />
              </button>
              {lint.map((l) => (
                <p key={l.code} class="pl-lint" role="note">
                  <Icon name="warning" size={14} /> {l.message}
                </p>
              ))}
            </div>
          );
        })}
      </div>
      <div>
        <button type="button" class="pl-small" aria-label="Add rule" title="A change rule: From one label To another, When and How" disabled={!writable} onClick={() => onEdit("Add rule", (b) => addRule(b, labels))}>
          <Icon name="plus" size={12} /> Rule
        </button>
      </div>
      {unused.length > 0 && body.entries.length > 0 && (
        <>
          <div class="pl-subcap" title="Entries in this Switch that no label plays: pick one in a label's plays menu, or remove it">Not played by any label</div>
          <EntryList {...props} only={unused} />
        </>
      )}
      {plays && <ContextMenu at={plays.at} label={`${plays.label} plays`} entries={playsMenu(plays.label)} onClose={() => setPlays(null)} />}
      {transition && <ContextMenu at={transition.at} label="Transition clip" entries={transitionMenu(transition.rule)} onClose={() => setTransition(null)} />}
    </div>
  );
}
