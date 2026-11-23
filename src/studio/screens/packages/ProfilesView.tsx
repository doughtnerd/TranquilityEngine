// The Packages screen's Profiles and rules tab (ADR 0351 §2, §6): the profiles (Wwise's Conversion Settings ShareSets)
// with the default marked, the selected profile's keys for every platform or for one (each a value or "Inherit", which
// leaves it to the next layer: a platform's own value falls back to the profile's, the profile's to the next profile or
// the built-in default), and the folder rules in order (first match wins) with what each catches. A view over props.
import { useState } from "preact/hooks";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { Icon } from "../../components/Icon";
import type { EncodingConfig, EncodingKey, EncodingSettings } from "../../../engine/audio/encoding/types";
import type { ImportPlatform } from "../../../engine/scene/importSettings";
import { KEY_LABELS, keyChoices, parseChoice, PLATFORM_LABELS, PLATFORM_OPTIONS } from "../samples/encodingModel";
import { profileKeyRows, type RulePreview } from "./profilesModel";

/** Where a profile key is edited: every platform, or one. */
export type ProfileScope = "all" | ImportPlatform;

export interface ProfilesViewProps {
  readonly config: EncodingConfig;
  readonly previews: readonly RulePreview[];
  readonly selected: string | null;
  readonly scope: ProfileScope;
  readonly readOnly?: boolean;
  onSelect(name: string): void;
  onScope(scope: ProfileScope): void;
  onAdd(): void;
  onRename(from: string, to: string): void;
  onDelete(name: string): void;
  onDefault(name: string | null): void;
  onKey(profile: string, platform: ImportPlatform | null, key: EncodingKey, value: EncodingSettings[EncodingKey] | undefined): void;
  onAddRule(path: string, profile: string): void;
  onUpdateRule(index: number, patch: { path?: string; profile?: string }): void;
  onMoveRule(index: number, delta: number): void;
  onRemoveRule(index: number): void;
}

const INHERIT = "";

function KeyControl(props: { k: EncodingKey; value: EncodingSettings[EncodingKey] | undefined; disabled: boolean; onChange(v: EncodingSettings[EncodingKey] | undefined): void }) {
  const choices = keyChoices(props.k);
  const label = KEY_LABELS[props.k];
  if (choices) {
    return (
      <select aria-label={label} value={props.value === undefined ? INHERIT : String(props.value)} disabled={props.disabled}
        onChange={(e) => {
          const raw = (e.currentTarget as HTMLSelectElement).value;
          props.onChange(raw === INHERIT ? undefined : parseChoice(props.k, raw));
        }}>
        <option value={INHERIT}>Inherit</option>
        {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
    );
  }
  const quality = props.k === "quality";
  return (
    <span class="pk-num">
      <input type="number" aria-label={label} placeholder="Inherit" disabled={props.disabled} min={0} max={quality ? 1 : 2000} step={quality ? 0.05 : 50}
        value={props.value === undefined ? "" : String(props.value)}
        onChange={(e) => {
          const raw = (e.currentTarget as HTMLInputElement).value.trim();
          if (raw === "") return props.onChange(undefined);
          const n = Number(raw);
          if (Number.isFinite(n)) props.onChange(n);
        }} />
      {props.value !== undefined && <button class="smp-link" disabled={props.disabled} aria-label={`Inherit ${label.toLowerCase()}`} onClick={() => props.onChange(undefined)}>Inherit</button>}
    </span>
  );
}

export function ProfilesView(props: ProfilesViewProps) {
  const { config } = props;
  const ro = props.readOnly === true;
  const names = Object.keys(config.profiles);
  const sel = props.selected !== null && Object.hasOwn(config.profiles, props.selected) ? props.selected : (names[0] ?? null);
  const profile = sel ? config.profiles[sel]! : null;
  const platform = props.scope === "all" ? null : props.scope;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newRule, setNewRule] = useState("");
  return (
    <div class="pk-profiles">
      <section class="pk-profile-list" aria-label="Profiles">
        <div class="pk-toolbar">
          <button class="pk-icon-text" disabled={ro} onClick={props.onAdd}>
            <Icon name="plus" />
            New profile
          </button>
        </div>
        <ul role="listbox" aria-label="Encoding profiles">
          {names.map((n) => (
            <li key={n} role="option" aria-selected={n === sel} class={`pk-row${n === sel ? " selected" : ""}`} tabIndex={n === sel ? 0 : -1} onClick={() => props.onSelect(n)} onDblClick={() => !ro && setRenaming(n)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return; // keys typed in the rename field
                if (e.key === "F2" && !ro) setRenaming(n);
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  // Arrows select the next or previous profile and take the focus with it.
                  e.preventDefault();
                  const next = names[names.indexOf(n) + (e.key === "ArrowDown" ? 1 : -1)];
                  if (!next) return;
                  props.onSelect(next);
                  ((e.currentTarget as HTMLElement)[e.key === "ArrowDown" ? "nextElementSibling" : "previousElementSibling"] as HTMLElement | null)?.focus();
                }
              }}>
              {renaming === n ? (
                <input aria-label={`Rename profile ${n}`} value={n} ref={(el) => el?.focus()} onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(null); }}
                  onBlur={(e) => { const to = (e.currentTarget as HTMLInputElement).value; setRenaming(null); if (to !== n) props.onRename(n, to); }} />
              ) : (
                <span class="pk-name" title={n}>{n}</span>
              )}
              {config.default === n && <span class="pk-badge">Default</span>}
            </li>
          ))}
        </ul>
        {names.length === 0 && <p class="smp-muted">No profiles: every sound uses the built-in defaults (lossless sources ship as Vorbis, the rest as they are).</p>}
        <label class="fld">
          <span>Default</span>
          <select aria-label="Default profile" value={config.default ?? ""} disabled={ro} onChange={(e) => props.onDefault((e.currentTarget as HTMLSelectElement).value || null)}>
            <option value="">None (built-in)</option>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </section>
      {profile && sel && (
        <section class="pk-profile" aria-label={`${sel} profile`}>
          <div class="pk-profile-head">
            <h3>{sel}</h3>
            <button class="smp-link" disabled={ro} onClick={() => setRenaming(sel)}>Rename</button>
            <button class="smp-link danger" disabled={ro} onClick={() => props.onDelete(sel)}>Delete</button>
          </div>
          <SegmentedControl size="small" label="Edit for" value={props.scope} options={[{ value: "all", label: "All platforms" }, ...PLATFORM_OPTIONS]} onChange={props.onScope} />
          <div class="pk-keys" role="table" aria-label={`${sel} for ${platform ? PLATFORM_LABELS[platform] : "every platform"}`}>
            {(platform ? profileKeyRows(profile, platform) : profileKeyRows({ ...profile, platforms: undefined }, "web")).map((r) => {
              const own = platform ? profile.platforms?.[platform]?.[r.key] : profile[r.key];
              return (
                <div key={r.key} class="pk-key" role="row">
                  <span role="rowheader" class={own !== undefined ? "set" : undefined}>{KEY_LABELS[r.key]}</span>
                  <span role="cell"><KeyControl k={r.key} value={own} disabled={ro} onChange={(v) => props.onKey(sel, platform, r.key, v)} /></span>
                  <span role="cell" class="smp-muted">{platform && own === undefined && profile[r.key] !== undefined ? `profile: ${String(profile[r.key])}` : ""}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
      <section class="pk-rules" aria-label="Folder rules">
        <h4 class="smp-insp-section">Folder rules · first match wins</h4>
        <div class="pk-scroll">
        <table class="pk-table" aria-label="Rules">
          <thead><tr><th scope="col">Path or glob</th><th scope="col">Profile</th><th scope="col">Catches</th><th scope="col" aria-label="Order and delete" /></tr></thead>
          <tbody>
            {config.rules.map((r, i) => {
              const pv = props.previews[i];
              return (
                <tr key={`${i}:${r.path}`}>
                  <td><input aria-label={`Rule ${i + 1} path`} value={r.path} disabled={ro} onChange={(e) => props.onUpdateRule(i, { path: (e.currentTarget as HTMLInputElement).value })} /></td>
                  <td>
                    <select aria-label={`Rule ${i + 1} profile`} value={r.profile} disabled={ro} onChange={(e) => props.onUpdateRule(i, { profile: (e.currentTarget as HTMLSelectElement).value })}>
                      {!names.includes(r.profile) && <option value={r.profile}>{r.profile} (missing)</option>}
                      {names.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </td>
                  <td title={pv?.catches.join("\n")}>{pv ? `${pv.catches.length} file${pv.catches.length === 1 ? "" : "s"}${pv.shadowed ? ` · ${pv.shadowed} taken by an earlier rule` : ""}` : ""}</td>
                  <td class="pk-rule-actions">
                    <button class="pk-icon-button" aria-label={`Move rule ${i + 1} up`} title="Move up" disabled={ro || i === 0} onClick={() => props.onMoveRule(i, -1)}><Icon name="chevronUp" /></button>
                    <button class="pk-icon-button" aria-label={`Move rule ${i + 1} down`} title="Move down" disabled={ro || i === config.rules.length - 1} onClick={() => props.onMoveRule(i, 1)}><Icon name="chevronDown" /></button>
                    <button class="pk-icon-button" aria-label={`Delete rule ${i + 1}`} title="Delete rule" disabled={ro} onClick={() => props.onRemoveRule(i)}><Icon name="trash" /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        <form class="pk-add-rule" onSubmit={(e) => { e.preventDefault(); if (sel && newRule.trim()) { props.onAddRule(newRule, sel); setNewRule(""); } }}>
          <input aria-label="New rule path" placeholder="audio/music/**" value={newRule} disabled={ro || !sel} onInput={(e) => setNewRule((e.currentTarget as HTMLInputElement).value)} />
          <button type="submit" disabled={ro || !sel || newRule.trim() === ""}>Add rule{sel ? ` for ${sel}` : ""}</button>
        </form>
      </section>
    </div>
  );
}
