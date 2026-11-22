// The Dialogue screen's documents (ADR 0340 §9, 0341 §7, 0343 §1; ADR 0327 "the engine's undo tree"): line tables,
// string tables, translations, dialogue files and `project.json` open as asset documents (the editor's machinery over
// the engine's lenient parses and writers), so every edit is a labelled step of the file's persistent history, Ctrl+Z
// and the History panel follow it, and outside changes are followed. The kinds are registered by id with no file
// endings, so the editor's own classification of these files is unchanged. Also `dialogueData`: the project as the
// screen's pure models read it (lengths from the shared peaks, sidecar facts from the Samples screen's sidecar kind).
import { openAssetDocument, readAsset, type AssetDocument } from "../../../editor/assetDocuments";
import type { EditorProject } from "../../../editor/projects";
import { assetKinds, type AssetFormat } from "../../../editor/sdk/contributions";
import { emptyDialogue, formatDialogue, isDialoguePath, parseDialogue } from "../../../engine/audio/dialogue/format";
import type { DialogueAsset } from "../../../engine/audio/dialogue/types";
import { defaultAudioLocalisation } from "../../../engine/audio/localisation/format";
import { emptyLineTable, formatLineTable, isLineTablePath, parseLineTable } from "../../../engine/audio/localisation/lines/format";
import type { LineTable } from "../../../engine/audio/localisation/types";
import { sampleEditsFromSidecar } from "../../../engine/audio/sample/format";
import { parseLanguages, type LanguageSettings } from "../../../engine/localisation/languages";
import { emptyStringTable, formatStringTable, parseStringTable, stringsPathKind, translationPath, type StringTable } from "../../../engine/localisation/strings/format";
import { emptyTranslation, formatTranslation, parseTranslation, type TranslationFile } from "../../../engine/localisation/strings/translation";
import { parseSubtitleSettings } from "../../../engine/localisation/subtitleSettings";
import { sidecarPath, type ImportSettings } from "../../../engine/scene/importSettings";
import type { EditResult } from "../../../plugins/audio/editor/editResult";
import { applyEdit } from "../../../plugins/audio/editor/editResult";
import { openMixDocument } from "../mixer/mixerDocument";
import { lengthOf, registerSampleKinds, SIDECAR_KIND } from "../samples/sampleSession";
import type { DialogueData, FileFacts } from "./dialogueData";
import type { DialogueDoc } from "./events/eventsModel";
import type { DocEdit } from "./scriptCsv";

export const LINES_KIND = "studio.lineTable";
export const STRINGS_KIND = "studio.stringTable";
export const TRANSLATION_KIND = "studio.translation";
export const DIALOGUE_KIND = "studio.dialogue";
export const PROJECT_FILE_KIND = "studio.projectFile";
export const PROJECT_FILE = "project.json";

type Json = Record<string, unknown>;

const problems = (list: readonly string[]) => list.map((message) => ({ message }));

function register<T>(id: string, label: string, format: AssetFormat<T>): void {
  if (!assetKinds.get(id)) assetKinds.register({ id, extensions: [], label, icon: "M4 6h16M4 12h10M4 18h13", format });
}

/** Register the screen's document kinds (once). */
export function registerDialogueKinds(): void {
  registerSampleKinds();
  register<LineTable>(LINES_KIND, "Line table", {
    parse: (raw, path) => (raw === undefined ? { value: emptyLineTable(), problems: [] } : ((r) => ({ value: r.table, problems: problems(r.problems) }))(parseLineTable(raw, path))),
    format: formatLineTable, empty: emptyLineTable, writeDelay: 300,
  });
  register<StringTable>(STRINGS_KIND, "String table", {
    parse: (raw, path) => (raw === undefined ? { value: emptyStringTable(), problems: [] } : ((r) => ({ value: r.table, problems: problems(r.problems) }))(parseStringTable(raw, path))),
    format: formatStringTable, empty: () => emptyStringTable(), writeDelay: 300,
  });
  register<TranslationFile>(TRANSLATION_KIND, "Translation", {
    parse: (raw, path) => {
      if (raw === undefined) {
        const k = stringsPathKind(path);
        return { value: emptyTranslation(k?.kind === "translation" ? k.code : "en"), problems: [] };
      }
      const r = parseTranslation(raw, path);
      return { value: r.translation, problems: problems(r.problems) };
    },
    format: formatTranslation, empty: () => emptyTranslation("en"), writeDelay: 300,
  });
  register<DialogueAsset>(DIALOGUE_KIND, "Dialogue events", {
    parse: (raw, path) => (raw === undefined ? { value: emptyDialogue(), problems: [] } : ((r) => ({ value: r.dialogue, problems: problems(r.problems) }))(parseDialogue(raw, path))),
    format: formatDialogue, empty: emptyDialogue, writeDelay: 300,
  });
  // project.json as a whole: the Studio writes only `languages` into it (and only without an editor lock, 0340 §1).
  register<Json>(PROJECT_FILE_KIND, "Project settings", {
    parse: (raw) => ({ value: raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Json) : {}, problems: [] }),
    format: (v) => `${JSON.stringify(v, null, 2)}\n`, empty: () => ({}), writeDelay: 300,
  });
}

/** Open a document of one of the screen's kinds. */
export function openDoc<T>(project: EditorProject, path: string, kind: string): AssetDocument<T> {
  registerDialogueKinds();
  return openAssetDocument<T>(project, path, kind);
}

/** Read a file of one of the screen's kinds (its open document's value, else the file; tracked when open). */
export function readDoc<T>(project: EditorProject, path: string, kind: string): T {
  registerDialogueKinds();
  return readAsset<T>(project, path, kind).value;
}

/** Commit an edit to a document as one labelled undo step (a refusal goes to the status bar and the log). */
export function commitTo<T>(doc: AssetDocument<T>, result: EditResult<T>, label: string): boolean {
  return applyEdit(result, label, (next) => doc.edit(next, { label }), doc.value.peek());
}

/** Apply one document edit from the script import or a text edit (one undo step of its document). */
export function applyDocEdit(project: EditorProject, e: DocEdit, label: string): void {
  const kind = e.kind === "lines" ? LINES_KIND : e.kind === "strings" ? STRINGS_KIND : TRANSLATION_KIND;
  openDoc<typeof e.next>(project, e.path, kind).edit(e.next, { label });
}

/** The project's languages (`project.json`). */
export function projectLanguages(project: EditorProject): LanguageSettings {
  return parseLanguages(readDoc<Json>(project, PROJECT_FILE, PROJECT_FILE_KIND).languages).languages;
}

/** The line tables of the project, in path order. */
export const lineTablePaths = (project: EditorProject): string[] => project.files.filter(isLineTablePath);
/** The dialogue files of the project, in path order. */
export const dialoguePaths = (project: EditorProject): string[] => project.files.filter(isDialoguePath);

/** The dialogue files as the Events tab reads them. */
export const dialogueDocs = (project: EditorProject): DialogueDoc[] => dialoguePaths(project).map((path) => ({ path, asset: readDoc<DialogueAsset>(project, path, DIALOGUE_KIND) }));

/** The project as the screen's models read it. */
export function dialogueData(project: EditorProject): DialogueData {
  const projectJson = readDoc<Json>(project, PROJECT_FILE, PROJECT_FILE_KIND);
  const mix = openMixDocument(project)?.value.value;
  const files = new Set(project.files);
  return {
    languages: parseLanguages(projectJson.languages).languages,
    localisation: mix?.localisation ?? defaultAudioLocalisation(),
    subtitles: parseSubtitleSettings(projectJson.subtitles).subtitles,
    tables: lineTablePaths(project).map((path) => ({ path, table: readDoc<LineTable>(project, path, LINES_KIND) })),
    strings: (path) => (files.has(path) ? readDoc<StringTable>(project, path, STRINGS_KIND) : null),
    translation: (path, code) => {
      const t = translationPath(path, code);
      return files.has(t) ? readDoc<TranslationFile>(project, t, TRANSLATION_KIND) : null;
    },
    exists: (path) => files.has(path),
    duration: (path) => lengthOf(project, path),
    facts: (path): FileFacts | null => {
      const side = sidecarPath(path);
      if (!files.has(side)) return null;
      const e = sampleEditsFromSidecar(readAsset<ImportSettings>(project, side, SIDECAR_KIND).value);
      return { vo: e.vo ?? null, normalize: e.normalize, markers: e.markers, lipsync: e.lipsync ? e.lipsync.keys.length : null };
    },
  };
}
