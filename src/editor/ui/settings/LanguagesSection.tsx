// Project Settings > Languages (ADR 0354 §1 L7, 0356 §3 T7, 0357 §2 S5): the project's language list (code, name, own
// fallback chain, shipped, voice, direction, fonts), the reference and start languages, the project's fallback chain,
// the start-language choices (system language, remembered choice) and whether voice follows the text language. Edits
// go through the Project panel's undo history; a refused edit says why in the status bar.
import { useState } from "preact/hooks";
import { fallbackChain, type LanguageSettings } from "../../../engine/localisation/languages";
import { stringsPathKind } from "../../../engine/localisation/strings/format";
import type { SettingsDraft } from "../../projectSettingsModel";
import type { ProjectSettingsSectionProps } from "../../sdk/contributions";
import { status } from "../../state";
import { showPanel } from "../../layout/store";
import { Chip } from "../Chip";
import { ProblemList, TextField } from "../settingsControls";
import { SegmentedControl } from "../SegmentedControl";
import { refusalOf, type EditResult } from "../../sdk/editResult";
import {
  addFont, addLanguage, codesOf, fontFiles, languagesSettings, moveLanguage, removeFont, removeLanguage, renameLanguage, setDefault,
  setDirection, setLanguageCode, setLanguageFallback, setLanguageVoice, setProjectFallback, setReference, setRemember, setShip,
  setUseSystemLanguage, setVoiceMode,
} from "./languagesSettingsModel";
import "./settingsSections.css";

/** What the section needs: the Project panel's section props, minus what it doesn't read. */
export type LanguagesSectionProps = Pick<ProjectSettingsSectionProps, "draft" | "problems" | "set" | "refresh"> & { readonly files: readonly string[] };

/** Apply a refused-or-next edit: one undo step, or the reason in the status bar (and text fields put back). */
export function applySettingsEdit(props: Pick<ProjectSettingsSectionProps, "set" | "refresh">, label: string, result: EditResult<SettingsDraft>): void {
  if ("refused" in result) {
    status.value = { kind: "info", text: `Can't ${label.charAt(0).toLowerCase()}${label.slice(1)}: ${result.refused}.` };
    props.refresh();
    return;
  }
  props.set(label, result.next);
}

/** The Project panel's section view (`ProjectSettingsSectionContribution.view`). */
export function LanguagesSettingsSection(props: ProjectSettingsSectionProps) {
  return <LanguagesSection draft={props.draft} problems={props.problems} set={props.set} refresh={props.refresh} files={props.project.files} />;
}

export function LanguagesSection(props: LanguagesSectionProps) {
  const s: LanguageSettings = languagesSettings.read(props.draft);
  const apply = (label: string, r: EditResult<SettingsDraft>) => applySettingsEdit(props, label, r);
  const tables = props.files.filter((f) => stringsPathKind(f)?.kind === "table").length;
  const fonts = fontFiles(props.files);
  const [adding, setAdding] = useState("");
  const add = () => {
    if (adding.trim() === "") return;
    const r = addLanguage(props.draft, adding);
    apply(`Add language ${adding.trim()}`, r);
    if ("next" in r) setAdding("");
  };
  return (
    <div class="settings-languages">
      {props.problems.length > 0 && <ProblemList list={props.problems} label="Language problems" />}
      <table class="settings-table languages-table" aria-label="Languages">
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th title="Languages tried after this one, before the project's chain">Falls back to</th>
            <th title="Shipped languages are exported and offered by Locale.languages">Ship</th>
            <th title="Recorded voice-over: off for a language that is translated but not recorded (voice follows its chain)">Voice</th>
            <th>Direction</th>
            <th title="Font files tried after a text's own font and before the built-in one">Fonts</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {s.list.map((l, i) => {
            const removal = refusalOf(removeLanguage(props.draft, l.code));
            return (
            <tr key={l.code} data-language={l.code}>
              <td>
                <TextField class="lang-code" label={`${l.code} code`} value={l.code} onCommit={(v) => apply(`Change ${l.code}'s code`, setLanguageCode(props.draft, l.code, v))} />
                {l.code === s.reference && <Chip tone="accent" title="Tables' text is written in it">reference</Chip>}
                {l.code === s.default && <Chip tone="success" title="The start language when nothing else picks one">start</Chip>}
              </td>
              <td>
                <TextField label={`${l.code} name`} value={l.name} onCommit={(v) => apply(`Rename ${l.code}`, renameLanguage(props.draft, l.code, v))} />
              </td>
              <td>
                <TextField
                  label={`${l.code} falls back to`}
                  value={l.fallback.join(", ")}
                  placeholder={fallbackChain(s, l.code).slice(1).join(", ") || "nothing"}
                  onCommit={(v) => apply(`Set ${l.code}'s fallback`, setLanguageFallback(props.draft, l.code, codesOf(v)))}
                />
              </td>
              <td>
                <input type="checkbox" aria-label={`Ship ${l.code}`} checked={l.ship} onChange={(e) => apply(`${(e.currentTarget as HTMLInputElement).checked ? "Ship" : "Don't ship"} ${l.code}`, setShip(props.draft, l.code, (e.currentTarget as HTMLInputElement).checked))} />
              </td>
              <td>
                <input type="checkbox" aria-label={`${l.code} has voice-over`} checked={l.voice} onChange={(e) => apply(`Set ${l.code}'s voice-over`, setLanguageVoice(props.draft, l.code, (e.currentTarget as HTMLInputElement).checked))} />
              </td>
              <td>
                <select aria-label={`${l.code} direction`} value={l.direction} onChange={(e) => apply(`Set ${l.code}'s direction`, setDirection(props.draft, l.code, (e.currentTarget as HTMLSelectElement).value as "ltr" | "rtl"))}>
                  <option value="ltr">Left to right</option>
                  <option value="rtl">Right to left</option>
                </select>
              </td>
              <td class="lang-fonts">
                {l.fonts.map((f) => (
                  <Chip key={f} title={f} onRemove={() => apply(`Remove ${l.code}'s font`, removeFont(props.draft, l.code, f))} removeLabel={`Remove ${f} from ${l.code}`}>
                    {f.split("/").pop()}
                  </Chip>
                ))}
                {fonts.some((f) => !l.fonts.includes(f)) && (
                  <select aria-label={`Add a font to ${l.code}`} value="" onChange={(e) => apply(`Add a font to ${l.code}`, addFont(props.draft, l.code, (e.currentTarget as HTMLSelectElement).value))}>
                    <option value="">+ Font</option>
                    {fonts.filter((f) => !l.fonts.includes(f)).map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                )}
              </td>
              <td class="lang-actions">
                <button type="button" class="kit-icon-button" aria-label={`Move ${l.code} up`} disabled={i === 0} onClick={() => apply(`Move ${l.code} up`, moveLanguage(props.draft, l.code, -1))}>
                  ↑
                </button>
                <button type="button" class="kit-icon-button" aria-label={`Move ${l.code} down`} disabled={i === s.list.length - 1} onClick={() => apply(`Move ${l.code} down`, moveLanguage(props.draft, l.code, 1))}>
                  ↓
                </button>
                <button type="button" class="kit-icon-button" aria-label={`Remove ${l.code}`} disabled={removal !== null} title={removal ?? `Remove ${l.name}`} onClick={() => apply(`Remove ${l.code}`, removeLanguage(props.draft, l.code))}>
                  ✕
                </button>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
      <div class="settings-add-row">
        <input type="text" aria-label="New language code" placeholder="Code, e.g. fr or pt-BR" value={adding} onInput={(e) => setAdding((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button type="button" onClick={add} disabled={adding.trim() === ""}>
          + Language
        </button>
      </div>

      <div class="settings-grid">
        <label for="lang-reference">Reference</label>
        <select id="lang-reference" value={s.reference} title={tables > 0 ? "The language string tables are written in" : "The language references are authored in"} onChange={(e) => apply("Set the reference language", setReference(props.draft, (e.currentTarget as HTMLSelectElement).value, tables))}>
          {s.list.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name} ({l.code})
            </option>
          ))}
        </select>
        <label for="lang-default">Start language</label>
        <select id="lang-default" value={s.default} onChange={(e) => apply("Set the start language", setDefault(props.draft, (e.currentTarget as HTMLSelectElement).value))}>
          {s.list.filter((l) => l.ship).map((l) => (
            <option key={l.code} value={l.code}>
              {l.name} ({l.code})
            </option>
          ))}
        </select>
        <label>Every language falls back to</label>
        <TextField label="Project fallback chain" value={s.fallback.join(", ")} placeholder={s.reference} onCommit={(v) => apply("Set the project's fallback", setProjectFallback(props.draft, codesOf(v)))} />
        <label for="lang-system">Use the system language</label>
        <input id="lang-system" type="checkbox" checked={s.useSystemLanguage} onChange={(e) => apply("Set use the system language", setUseSystemLanguage(props.draft, (e.currentTarget as HTMLInputElement).checked))} />
        <label for="lang-remember">Remember the player's choice</label>
        <input id="lang-remember" type="checkbox" checked={s.remember} onChange={(e) => apply("Set remember the player's choice", setRemember(props.draft, (e.currentTarget as HTMLInputElement).checked))} />
        <label>Voice language</label>
        <SegmentedControl
          label="Voice language"
          size="small"
          value={s.voice}
          options={[
            { value: "followText", label: "Follows text", title: "Locale.setLanguage also switches the voice-over, in one step" },
            { value: "separate", label: "Separate", title: "Voice and text switch independently (a game with Voice and Text menus)" },
          ]}
          onChange={(v) => apply("Set the voice language", setVoiceMode(props.draft, v))}
        />
      </div>
      <p class="settings-note">
        Text lives in string tables; translate it in the{" "}
        <button type="button" class="link-button" onClick={() => showPanel("localisation")}>
          Localisation panel
        </button>
        . The Play toolbar's language menu previews any shipped language.
      </p>
    </div>
  );
}
