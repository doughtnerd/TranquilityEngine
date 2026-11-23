// The Studio header's preview-language chip (ADR 0354 §1, §9): per user, the language every screen's auditions and
// subtitle previews start in (remembered and system languages are ignored there). Hidden while the project has a single
// language. A view over props; `ProjectPreviewChip` wires it to the open project and the stored preference.
import { currentProject } from "../../../editor/state";
import { parseLanguages, type LanguageDef } from "../../../engine/localisation/languages";
import { previewLanguageOf } from "./languagesModel";
import { previewLanguage } from "./dialogueState";

export interface PreviewLanguageChipProps {
  readonly languages: readonly LanguageDef[];
  readonly value: string;
  onChange(code: string): void;
}

export function PreviewLanguageChip(props: PreviewLanguageChipProps) {
  if (props.languages.length < 2) return null;
  const current = props.languages.find((l) => l.code === props.value);
  return (
    <label class="kit-chip tone-accent dl-chip-lang" title={`Preview language: ${current?.name ?? props.value}. Auditions and subtitle previews start in it (only you see this choice).`}>
      <span aria-hidden="true">Aa</span>
      <select aria-label="Preview language" value={props.value} onChange={(e) => props.onChange((e.currentTarget as HTMLSelectElement).value)} style={{ background: "transparent", color: "inherit", border: "none", font: "inherit" }}>
        {props.languages.map((l) => <option key={l.code} value={l.code}>{l.code}{l.ship ? "" : " (not shipped)"}</option>)}
      </select>
    </label>
  );
}

/** The chip over the open project's `project.json` languages and the stored preference. */
export function ProjectPreviewChip() {
  const project = currentProject.value;
  if (!project) return null;
  const languages = parseLanguages((project.settings as { languages?: unknown }).languages).languages;
  return <PreviewLanguageChip languages={languages.list} value={previewLanguageOf(previewLanguage.value, languages)} onChange={(code) => (previewLanguage.value = code)} />;
}
