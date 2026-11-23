// The Inspector's Localise control, connected (ADR 0356 §9): for a selected UI document element's text field, the key
// it's bound to (with its text in the Play toolbar's preview language), or pick a key / Extract to string table. Writes
// go through `uiDocumentEdits.ts` as one undo step on the scene's history (the markup and, for Extract, the table).
// Tables audio data names are the Studio's (0357 §1), so Extract only writes the editor's own tables.
import type { UIDocumentElement } from "../../../engine/ui/UIDocument";
import { formatStringTable } from "../../../engine/localisation/strings/format";
import { readAsset } from "../../assetDocuments";
import { playLanguageOf, previewLanguage } from "../../playLanguage";
import { currentProject, docVersion, status } from "../../state";
import { extractUIElementText, localiseUIElement, uiElementKey, uiElementLiteral } from "../../uiDocumentEdits";
import type { UIElementRef } from "../../uiDocuments";
import { studioOwnedTables } from "./localisationData";
import { extractToTable, keyMatches, keyPreview, suggestKey, suggestTable } from "./localiseModel";
import { LocaliseControl } from "./LocaliseControl";
import { projectStrings } from "./projectStrings";
import { STRINGS_KIND, stringsFormat, type StringsFile } from "./stringsKind";

/** True for the text fields a key can bind in a document: a Text's (or a button label's) text, an InputField's value and placeholder. */
export function isLocalisableField(el: UIDocumentElement, field: string, synthetic: boolean): boolean {
  if (synthetic || el.tag === "Text") return field === "text";
  return el.tag === "InputField" && (field === "value" || field === "placeholder");
}

export function UIFieldLocalise(props: { el: UIDocumentElement; uiRef: UIElementRef; field: string; documentFile: string; disabled: string | null }) {
  docVersion.value;
  const project = currentProject.value;
  if (!project) return null;
  const { el, uiRef, field } = props;
  const data = projectStrings(project);
  const language = playLanguageOf(previewLanguage.value, data.languages);
  const key = uiElementKey(el, field);
  const literal = uiElementLiteral(el, field);
  const owned = studioOwnedTables(project.files.filter((f) => f.endsWith(".lines.json") || f === "audio.json").map((f) => [f, project.assets.get(f)] as const));
  const extract = (table: string, newKey: string) => {
    if (owned.has(table)) return void (status.value = { kind: "info", text: `Can't extract to ${table}: it holds subtitles or captions, which are the Audio Studio's. Choose another table.` });
    const json = project.files.includes(table) ? JSON.parse(stringsFormat.format(readAsset<StringsFile>(project, table, STRINGS_KIND).value)) : undefined;
    const r = extractToTable(data, table, json, newKey, literal ?? "");
    if ("refused" in r) return void (status.value = { kind: "info", text: `Can't extract the text: ${r.refused}.` });
    extractUIElementText(uiRef, field, newKey.trim(), table, formatStringTable(r.next));
  };
  return (
    <LocaliseControl
      key={`${uiRef.path}|${field}`}
      field={field}
      boundKey={key}
      boundPreview={key === null ? null : keyPreview(data, key, language)}
      previewLanguage={language}
      literal={literal}
      findKeys={(search) => keyMatches(data, search, language)}
      tables={data.tables.map((t) => t.path).filter((t) => !owned.has(t))}
      suggestedTable={suggestTable({ ...data, tables: data.tables.filter((t) => !owned.has(t.path)) }, props.documentFile)}
      suggestedKey={suggestKey(data, props.documentFile, el.id ?? null, el.tag, field)}
      disabled={props.disabled}
      onPick={(k) => localiseUIElement(uiRef, field, k)}
      onUnlink={() => localiseUIElement(uiRef, field, null)}
      onExtract={extract}
    />
  );
}
