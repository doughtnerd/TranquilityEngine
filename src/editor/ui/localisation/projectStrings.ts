// The open project's string tables as the Localisation panel and the Inspector's Localise control read them: every
// strings file's current value (an open asset document's, unwritten edits included, else the file's), with the
// project's languages, as an `ExchangeProject`.
import type { ExchangeProject } from "../../../engine/localisation/exchange/model";
import { parseLanguages, type LanguageSettings } from "../../../engine/localisation/languages";
import { stringsPathKind } from "../../../engine/localisation/strings/format";
import { readAsset } from "../../assetDocuments";
import type { EditorProject } from "../../projects";
import { exchangeProjectOf } from "./localisationData";
import { STRINGS_KIND, type StringsFile } from "./stringsKind";

/** The project's languages (`project.json`'s `languages`, English only when absent). */
export const languagesOf = (project: EditorProject): LanguageSettings => parseLanguages(project.settings.languages).languages;

/** The project's strings files with their current values. */
export function stringsFiles(project: EditorProject): [string, StringsFile][] {
  return project.files.filter((f) => stringsPathKind(f) !== null).map((f) => [f, readAsset<StringsFile>(project, f, STRINGS_KIND).value]);
}

/** The project's tables and translations. */
export const projectStrings = (project: EditorProject): ExchangeProject => exchangeProjectOf(languagesOf(project), stringsFiles(project));
