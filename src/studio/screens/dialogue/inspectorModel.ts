// The Line inspector's model (ADR 0354 §9, §7, 0357 §6): per language, its status cell, its own subtitle text, the file
// it plays (its own or by fallback) with its length and normalisation, lip-sync keys, and the subtitle strip timed
// against that file. Pure.
import type { LanguageDef } from "../../../engine/localisation/languages";
import { heardFile, textIn, textThrough, type DialogueData, type LineRef } from "./dialogueData";
import { languageCell, type LanguageCell } from "./lineStatus";
import { subtitleStrip, type SubtitleStrip } from "./subtitleStrip";

export interface InspectorLanguage {
  readonly def: LanguageDef;
  readonly cell: LanguageCell;
  /** The subtitle written in exactly this language (null: none; the strip may show a fallback's). */
  readonly text: string | null;
  /** The file heard in this language, own or by fallback. */
  readonly file: string | null;
  readonly duration: number | null;
  readonly lipsync: number | null;
  /** The sidecar's normalisation, as text ("−23 LUFS", "off"). */
  readonly loudness: string | null;
  readonly strip: SubtitleStrip | null;
}

/** Every language's part of the inspector, in list order. */
export function inspectorLanguages(data: DialogueData, ref: LineRef): InspectorLanguage[] {
  return data.languages.list.map((def) => {
    const cell = languageCell(data, ref, def.code);
    const heard = heardFile(data, ref, def.code);
    const file = heard?.path ?? null;
    const duration = file ? data.duration(file) : null;
    const facts = file ? data.facts(file) : null;
    const shown = textThrough(data, ref, def.code);
    const n = facts?.normalize ?? null;
    return {
      def, cell, text: textIn(data, ref, def.code), file, duration, lipsync: facts?.lipsync ?? null,
      loudness: n === null ? null : n.mode === "off" ? "off" : `${n.target} ${n.mode === "peak" ? "dBFS peak" : "LUFS"}`,
      strip: shown ? subtitleStrip(shown.text, def.code, duration, data.languages, data.subtitles, facts?.markers ?? []) : null,
    };
  });
}
