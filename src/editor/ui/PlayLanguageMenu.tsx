// The Play toolbar's Language menu (ADR 0354 §1, 0356 §9) and Subtitles overlay toggle (ADR 0357 §6). Views only: the
// choices, the preview language and what a pick does come from `playLanguage.ts`; PlayControls connects them.
import type { PlayLanguageChoice } from "../playLanguage";

export interface PlayLanguageMenuProps {
  readonly choices: readonly PlayLanguageChoice[];
  readonly value: string;
  onChange(code: string): void;
}

/** A compact select: the shipped languages, then the pseudo-languages in their own group. */
export function PlayLanguageMenu(props: PlayLanguageMenuProps) {
  const languages = props.choices.filter((c) => !c.pseudo);
  const pseudo = props.choices.filter((c) => c.pseudo);
  const current = props.choices.find((c) => c.code === props.value);
  return (
    <select
      class="play-language"
      aria-label="Preview language"
      title={`Preview language: Play shows text${current?.pseudo ? "" : " and voice"} in ${current?.label ?? props.value}. ${current?.title ?? ""}`.trim()}
      value={props.value}
      onChange={(e) => props.onChange((e.currentTarget as HTMLSelectElement).value)}
    >
      {languages.map((c) => (
        <option key={c.code} value={c.code} title={c.title}>
          {c.label}
        </option>
      ))}
      {pseudo.length > 0 && (
        <optgroup label="Pseudo-languages">
          {pseudo.map((c) => (
            <option key={c.code} value={c.code} title={c.title}>
              {c.label}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

export interface SubtitlesOverlayToggleProps {
  readonly on: boolean;
  /** Why it can't show anything yet (the subtitles display isn't available), or null. */
  readonly unavailable: string | null;
  onToggle(on: boolean): void;
}

/** "Subtitles": overlay a subtitle display in Play for scenes that have none (editor-only, never saved). */
export function SubtitlesOverlayToggle(props: SubtitlesOverlayToggleProps) {
  return (
    <button
      type="button"
      class={`play-subtitles${props.on ? " active" : ""}`}
      aria-pressed={props.on}
      title={props.unavailable ?? (props.on ? "Hide the subtitle overlay" : "Show subtitles over Play for scenes without a subtitle display (editor only, never saved)")}
      onClick={() => props.onToggle(!props.on)}
    >
      Subtitles
    </button>
  );
}
