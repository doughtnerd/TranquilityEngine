// The Inspector's Localise controls for an element a UIView rendered (ADR 0356 §9, ADR 0423 wave F): for its text
// content and each text attribute it has (`placeholder`, `title`, `alt`, `aria-label`…), the key it's written with
// (with its text in the Play toolbar's preview language), or pick a key / Extract to string table for literal text, or
// why it can't be localised as written (expressions, elements inside). Writes go through `uiViewEdits.ts` as one undo
// step on the scene's history (the `.svelte` source and, for Extract, the table). Extract writes only a table the
// editor may write now (the strings ownership rule, `localisationData.ts` `tableAccess`, with the Studio's lock).
// Restored for Svelte UI from UI documents' `UIFieldLocalise.tsx` (retired with them by ADR 0423 wave D).
import { useEffect } from "preact/hooks";
import { formatStringTable } from "../../../engine/localisation/strings/format";
import { readAsset } from "../../assetDocuments";
import { playLanguageOf, previewLanguage } from "../../playLanguage";
import { currentProject, docVersion, openScene, status } from "../../state";
import type { UIViewRef } from "../../uiViews";
import { extractUIViewText, localiseUIViewText, uiViewElementTexts, unlinkUIViewText, whyNotEditViewElement } from "../../uiViewEdits";
import { studioOwnedTables, tableAccess } from "./localisationData";
import { extractToTable, keyMatches, keyPreview, suggestKey, suggestTable, unlinkText } from "./localiseKeys";
import { LocaliseControl } from "./LocaliseControl";
import { projectStrings } from "./projectStrings";
import { refreshStudioLock, studioLock } from "./studioLock";
import { STRINGS_KIND, stringsFormat, type StringsFile } from "./stringsKind";

const FIELD_LABEL: Readonly<Record<string, string>> = { text: "Text", placeholder: "Placeholder", title: "Title", alt: "Alt text", "aria-label": "ARIA label", label: "Label", value: "Label (value)" };

export function UIViewLocalise(props: { uiRef: UIViewRef; id: string | null; tag: string }) {
  docVersion.value;
  const project = currentProject.value;
  useEffect(() => {
    if (project) void refreshStudioLock(project);
  }, [project]);
  const scene = openScene.value;
  const parts = uiViewElementTexts(scene, props.uiRef);
  if (!project || parts.length === 0) return null;
  const { uiRef } = props;
  const data = projectStrings(project);
  const language = playLanguageOf(previewLanguage.value, data.languages);
  const disabled = whyNotEditViewElement(scene, uiRef);
  const owned = studioOwnedTables(project.files.filter((f) => f.endsWith(".lines.json") || f === "audio.json").map((f) => [f, project.assets.get(f)] as const));
  const accessOf = (table: string) => tableAccess({ canSave: project.canSave, studioOwned: owned.has(table), studioLock: studioLock.value });
  const writable = data.tables.filter((t) => accessOf(t.path).editable);
  const extract = (field: string, literal: string, table: string, key: string) => {
    const access = accessOf(table);
    if (!access.editable) return void (status.value = { kind: "info", text: `Can't extract to ${table}: ${access.reason}` });
    const json = project.files.includes(table) ? JSON.parse(stringsFormat.format(readAsset<StringsFile>(project, table, STRINGS_KIND).value)) : undefined;
    const r = extractToTable(data, table, json, key, literal);
    if ("refused" in r) return void (status.value = { kind: "info", text: `Can't extract the text: ${r.refused}.` });
    extractUIViewText(uiRef, field, key.trim(), table, formatStringTable(r.next));
  };
  return (
    <section class="component ui-view-localise" aria-label="Localisation">
      <h3>Localisation</h3>
      <dl class="node-meta">
        {parts.map((part) => {
          const s = part.state;
          const label = FIELD_LABEL[part.field] ?? part.field;
          if (s.kind === "dynamic") {
            return [<dt key={`${part.field}-t`}>{label}</dt>, <dd key={`${part.field}-d`} class="localise-preview">{`Can't localise it here: ${s.reason}.`}</dd>];
          }
          const key = s.kind === "keyed" ? s.call.key : null;
          const unlink = s.kind === "keyed" ? (s.call.args ? "it passes message arguments" : s.call.name === "tHtml" ? "it's rich text (tHtml)" : (() => { const u = unlinkText(data, s.call.key); return "refused" in u ? u.refused : null; })()) : null;
          return [
            <dt key={`${part.field}-t`}>{label}</dt>,
            <dd key={`${part.field}-d`}>
              <LocaliseControl
                key={`${uiRef.line}:${uiRef.column}|${part.field}`}
                field={part.field}
                boundKey={key}
                boundPreview={key === null ? null : keyPreview(data, key, language)}
                previewLanguage={language}
                literal={s.kind === "literal" ? s.text : null}
                findKeys={(search) => keyMatches(data, search, language)}
                tables={writable.map((t) => t.path)}
                suggestedTable={suggestTable({ ...data, tables: writable }, uiRef.file)}
                suggestedKey={suggestKey(data, uiRef.file, props.id, props.tag, part.field)}
                disabled={disabled}
                unlinkRefusal={unlink}
                onPick={(k) => localiseUIViewText(uiRef, part.field, k)}
                onUnlink={() => {
                  const u = key === null ? null : unlinkText(data, key);
                  if (u && "next" in u) unlinkUIViewText(uiRef, part.field, u.next);
                }}
                onExtract={(table, k) => s.kind === "literal" && extract(part.field, s.text, table, k)}
              />
            </dd>,
          ];
        })}
      </dl>
    </section>
  );
}
