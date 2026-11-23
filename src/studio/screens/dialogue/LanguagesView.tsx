// The Dialogue screen's Languages tab (ADR 0354 §1, §2, §8): `project.json`'s languages — code, name, ship, own
// fallback, reference and start language, the chain every language ends with — editable only while no editor holds the
// project (else read-only with "Edit in the editor"); `audio.json`'s localisation settings (roots, loudness, duration
// tolerance, what a missing line does); Normalise language per language; and "Duck Music under Voice" while no rule is
// triggered by the voice bus. A view over props: edits are labelled pure edits.
import { useState } from "preact/hooks";
import { FieldRow, NumberBox, SelectBox } from "../../../editor/ui/PanelFields";
import type { AudioLocalisation } from "../../../engine/audio/localisation/types";
import type { AudioProject } from "../../../engine/audio/project/types";
import { fallbackChain, type LanguageSettings } from "../../../engine/localisation/languages";
import type { EditResult } from "../../../plugins/audio/editor/editResult";
import {
  addLanguage, codesOf, removeLanguage, renameLanguage, setDefault, setLanguageFallback, setLoudness, setMissing, setProjectFallback, setReference, setRoots, setShip, setTolerance,
  type LanguagesAccess,
} from "./languagesModel";
import { InlineText } from "./LinesView";

export interface LanguagesViewProps {
  readonly languages: LanguageSettings;
  readonly access: LanguagesAccess;
  readonly localisation: AudioLocalisation;
  /** `audio.json` can't be edited (a read-only project). */
  readonly audioReadOnly?: boolean;
  readonly preview: string;
  /** Per language, how many recorded files aren't normalised to the setting. */
  readonly unnormalised: Readonly<Record<string, number>>;
  /** The bus "Duck Music under Voice" would use, or null when there's nothing to offer. */
  readonly duckOffer: string | null;
  onLanguages(label: string, edit: (s: LanguageSettings) => EditResult<LanguageSettings>): void;
  onAudio(label: string, edit: (p: AudioProject) => EditResult<AudioProject>): void;
  onPreview(code: string): void;
  onNormalise(code: string): void;
  onDuck(bus: string): void;
  onEditInEditor(): void;
}

export function LanguagesView(props: LanguagesViewProps) {
  const s = props.languages;
  const ro = !props.access.editable;
  const loc = props.localisation;
  const [code, setCode] = useState("");
  const lang = (label: string, edit: (x: LanguageSettings) => EditResult<LanguageSettings>) => props.onLanguages(label, edit);
  return (
    <div class="dl-languages">
      {!props.access.editable && (
        <div class="dl-banner" role="note" aria-label="Languages are read-only">
          <span>{props.access.reason}</span>
          {props.access.editInEditor && <button onClick={props.onEditInEditor}>Edit in the editor</button>}
        </div>
      )}
      <section class="dl-section" aria-label="Project languages">
        <h3>Languages</h3>
        <table class="dl-table" aria-label="Languages">
          <thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Ship</th><th scope="col">Falls back to</th><th scope="col">Chain</th><th scope="col">Reference</th><th scope="col">Start</th><th scope="col" /></tr></thead>
          <tbody>
            {s.list.map((l) => (
              <tr key={l.code}>
                <th scope="row" class="dl-key">{l.code}{l.code === props.preview ? " ·" : ""}</th>
                <td><InlineText value={l.name} label={`Name of ${l.code}`} disabled={ro} onCommit={(v) => lang(`Rename ${l.code}`, (x) => renameLanguage(x, l.code, v))} /></td>
                <td><input type="checkbox" aria-label={`Ship ${l.code}`} checked={l.ship} disabled={ro} onChange={(e) => lang(`${(e.currentTarget as HTMLInputElement).checked ? "Ship" : "Don't ship"} ${l.code}`, (x) => setShip(x, l.code, (e.currentTarget as HTMLInputElement).checked))} /></td>
                <td><InlineText value={l.fallback.join(", ")} label={`Fallback of ${l.code}`} placeholder="none" disabled={ro} onCommit={(v) => lang(`Fallback of ${l.code}`, (x) => setLanguageFallback(x, l.code, codesOf(v)))} /></td>
                <td class="dl-muted" title="The language, its own fallback, then the project's chain">{fallbackChain(s, l.code).join(" → ")}</td>
                <td><input type="radio" name="dl-reference" aria-label={`Reference ${l.code}`} checked={s.reference === l.code} disabled={ro} onChange={() => lang(`Reference language ${l.code}`, (x) => setReference(x, l.code))} /></td>
                <td><input type="radio" name="dl-default" aria-label={`Start in ${l.code}`} checked={s.default === l.code} disabled={ro} onChange={() => lang(`Start language ${l.code}`, (x) => setDefault(x, l.code))} /></td>
                <td>
                  <button class="smp-link" onClick={() => props.onPreview(l.code)} disabled={l.code === props.preview} title="Hear and read the Studio in this language (per user)">Preview</button>{" "}
                  <button class="smp-link" disabled={ro || l.code === s.reference || l.code === s.default} onClick={() => lang(`Remove ${l.code}`, (x) => removeLanguage(x, l.code))}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div class="dl-row" style={{ marginTop: "6px" }}>
          <input type="text" aria-label="New language code" placeholder="fr-CA" value={code} disabled={ro} onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)} />
          <button disabled={ro || code.trim() === ""} onClick={() => { lang(`Add language ${code.trim()}`, (x) => addLanguage(x, code)); setCode(""); }}>Add language</button>
          <FieldRow label="Every chain ends with">
            <InlineText value={s.fallback.join(", ")} label="Project fallback" disabled={ro} onCommit={(v) => lang("Project fallback", (x) => setProjectFallback(x, codesOf(v)))} />
          </FieldRow>
        </div>
      </section>
      <section class="dl-section" aria-label="Localised audio">
        <h3>Localised audio</h3>
        <FieldRow label="Localised roots" title="Under each root the first folder is a language code: audio/vo/fr/…">
          <InlineText value={loc.roots.join(", ")} label="Localised roots" placeholder="audio/vo" disabled={props.audioReadOnly} onCommit={(v) => props.onAudio("Localised roots", (p) => setRoots(p, codesOf(v)))} />
        </FieldRow>
        <FieldRow label="Normalise to" unit={loc.loudness.mode === "peak" ? "dBFS" : "LUFS"}>
          <SelectBox label="Normalise mode" value={loc.loudness.mode} disabled={props.audioReadOnly} options={[{ value: "loudness", label: "Loudness" }, { value: "peak", label: "Peak" }, { value: "off", label: "Off" }]}
            onValue={(m) => props.onAudio("Voice loudness", (p) => setLoudness(p, m, m === "peak" ? -1 : -23))} />
          {loc.loudness.mode !== "off" && <NumberBox label="Normalise target" value={loc.loudness.target} min={-60} max={0} step={0.5} digits={1} disabled={props.audioReadOnly} onValue={(t) => props.onAudio("Voice loudness", (p) => setLoudness(p, loc.loudness.mode, t))} />}
        </FieldRow>
        <FieldRow label="Duration tolerance" unit="%" title="A language's file is flagged when it differs from the reference by more than this (and 0.5 s)">
          <NumberBox label="Duration tolerance" value={loc.durationTolerance * 100} min={0} max={400} step={5} digits={0} disabled={props.audioReadOnly} onValue={(v) => props.onAudio("Duration tolerance", (p) => setTolerance(p, v / 100))} />
        </FieldRow>
        <FieldRow label="Missing in every language">
          <SelectBox label="Missing lines" value={loc.missing} disabled={props.audioReadOnly} options={[{ value: "subtitleOnly", label: "Show the subtitle for its reading time" }, { value: "silent", label: "Say nothing" }]}
            onValue={(m) => props.onAudio("Missing lines", (p) => setMissing(p, m))} />
        </FieldRow>
        <ul class="dl-list" aria-label="Normalisation per language">
          {s.list.map((l) => (
            <li key={l.code}>
              {l.code}: {props.unnormalised[l.code] ? `${props.unnormalised[l.code]} file${props.unnormalised[l.code] === 1 ? "" : "s"} not normalised to the setting ` : "every file normalised "}
              <button class="smp-link" disabled={props.audioReadOnly || !props.unnormalised[l.code] || loc.loudness.mode === "off"} onClick={() => props.onNormalise(l.code)}>Normalise {l.code}</button>
            </li>
          ))}
        </ul>
        {props.duckOffer && (
          <p class="dl-row">
            <span class="dl-muted">Nothing ducks Music while {props.duckOffer} plays.</span>
            <button disabled={props.audioReadOnly} onClick={() => props.onDuck(props.duckOffer!)}>Duck Music under {props.duckOffer}</button>
          </p>
        )}
      </section>
    </div>
  );
}
