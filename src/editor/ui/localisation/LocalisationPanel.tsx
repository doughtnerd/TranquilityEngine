// The Localisation panel (ADR 0356 §9, T7): Strings, Report and Exchange tabs over the open project's string tables.
// It connects the pure models (`stringsModel.ts`, `reportModel.ts`, `textFit.ts`, `exchangeModel.ts`) to the project:
// every write goes through the files' asset documents (the `strings` kind), so each edit is one undo step in that
// file's history and Ctrl+Z in the panel undoes the chosen table's last edit. Tables audio data names are the Studio's
// (0357 §1): while the Studio holds the project they show read-only with "Edit in the Studio". The Report adds Svelte
// UI's unkeyed text (dismissals kept in `.myco/localisation-ignore.json`) and, on request, the text fit check over what
// the open scene's views render (ADR 0419 wave F).
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { gatherKeys } from "../../../engine/localisation/exchange/gather";
import type { ImportPreview } from "../../../engine/localisation/exchange/importPreview";
import type { ExchangeProject } from "../../../engine/localisation/exchange/model";
import { languageOf } from "../../../engine/localisation/languages";
import { languagesOf, stringsFiles } from "./projectStrings";
import { stringsPathKind, translationPath, type StringTable } from "../../../engine/localisation/strings/format";
import type { TranslationFile } from "../../../engine/localisation/strings/translation";
import { viewport } from "../../../engine/editor";
import { estimateText } from "../../../engine/ui/layout";
import { openAssetDocument, readAsset } from "../../assetDocuments";
import { openAsset, openIn } from "../../assetKindHost";
import { openScript } from "../../code/codeBuffers";
import { errorStatus } from "../../messages";
import { joinPath } from "../../projectPaths";
import type { EditorProject } from "../../projects";
import { currentProject, docVersion, openScene, status } from "../../state";
import { loadSvelteParser, svelteParserLoaded } from "../../uiEdit/svelteText";
import { fitTargets, unkeyedTextOf, type SizeOf } from "../../uiViewStrings";
import { Panel, usePanelState } from "../panel/Panel";
import type { EditResult } from "../../sdk/editResult";
import { exportFiles, importPreviewOf, importWrites } from "./exchangeModel";
import { ExchangeView, type ExportChoice } from "./ExchangeView";
import { exchangeProjectOf, studioOwnedTables, tableAccess } from "./localisationData";
import { localisationReport } from "./reportModel";
import { refreshStudioLock, studioLock } from "./studioLock";
import { fitCheck, type FitMeasure, type FitResult } from "./textFit";
import { ReportView } from "./ReportView";
import { STRINGS_KIND, stringsFormat, type StringsFile } from "./stringsKind";
import {
  addKey, ALL_STRINGS, deleteKey, duplicateKey, filterRows, renameKey, setMaxLength, setNotes, setReferenceText, setReviewed, setTranslation, stringRows,
  type KeyChange, type StringsQuery,
} from "./stringsModel";
import { StringsView } from "./StringsView";
import "./localisation.css";

type Tab = "strings" | "report" | "exchange";
const TABS: readonly { id: Tab; label: string }[] = [
  { id: "strings", label: "Strings" },
  { id: "report", label: "Report" },
  { id: "exchange", label: "Exchange" },
];

/** Dismissed unkeyed text (`.myco/localisation-ignore.json`), as last read. */
const ignored = signal<readonly string[]>([]);
const IGNORE_FILE = ".myco/localisation-ignore.json";
/** Bumped once Svelte's parser has loaded (the unkeyed-text list reads components through it). */
const parserReady = signal(0);

async function readIgnored(project: EditorProject): Promise<void> {
  const fs = project.fileSystem, root = project.root;
  if (!fs || !root) return;
  try {
    const path = joinPath(root, IGNORE_FILE);
    const raw: unknown = (await fs.exists(path)) ? JSON.parse(await fs.readText(path)) : [];
    ignored.value = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    ignored.value = [];
  }
}

async function dismiss(project: EditorProject, id: string): Promise<void> {
  const next = [...new Set([...ignored.peek(), id])];
  ignored.value = next;
  const fs = project.fileSystem, root = project.root;
  if (!fs || !root || !project.canSave) return;
  try {
    await fs.mkdir(joinPath(root, ".myco"));
    await fs.writeText(joinPath(root, IGNORE_FILE), `${JSON.stringify(next, null, 2)}\n`);
  } catch (err) {
    status.value = errorStatus("Couldn't save the dismissed text", err);
  }
}

/** The fit check's measurer: the engine's canvas text measuring where there's a canvas, else the UI core's estimate. */
async function engineMeasure(): Promise<FitMeasure> {
  try {
    const m = await import("../../../engine/render/babylon/ui");
    return m.measureText;
  } catch {
    return estimateText;
  }
}

/** Open a report row's file: a component or script in the Code panel at its line, anything else as its asset. */
function openRow(path: string, line?: number): void {
  if (line !== undefined && /\.(svelte|ts|tsx|js|mjs)$/i.test(path)) openScript(path, { line, column: 1 });
  else openAsset(path);
}

/** The files gathering reads: every project file's value (strings files as their documents hold them), and the scripts' text. */
function gatherFiles(project: EditorProject): [string, unknown][] {
  const out: [string, unknown][] = project.files.map((f) => [f, stringsPathKind(f) ? JSON.parse(stringsFormat.format(readAsset<StringsFile>(project, f, STRINGS_KIND).value)) : project.assets.get(f)]);
  for (const [f, text] of project.scripts) out.push([f, text]);
  return out;
}

const report = (verb: string, r: { refused: string }) => void (status.value = { kind: "info", text: `Can't ${verb}: ${r.refused}.` });

function writeTable(project: EditorProject, path: string, table: StringTable, label: string): void {
  openAssetDocument<StringsFile>(project, path, STRINGS_KIND).edit({ kind: "table", table }, { label });
}

function writeTranslation(project: EditorProject, tablePath: string, translation: TranslationFile, label: string): void {
  openAssetDocument<StringsFile>(project, translationPath(tablePath, translation.language), STRINGS_KIND).edit({ kind: "translation", translation }, { label });
}

export function LocalisationPanel() {
  docVersion.value;
  const project = currentProject.value;
  const tab = usePanelState<Tab>("tab", "strings");
  const query = usePanelState<StringsQuery>("query", ALL_STRINGS);
  const fit = usePanelState<FitResult | null>("fit", null);
  const fitting = usePanelState("fitting", false);
  const choice = usePanelState<ExportChoice>("export", { format: "xliff", tables: [], languages: [], onlyNeedsWork: false });
  const pending = usePanelState<{ preview: ImportPreview; names: string[] } | null>("import", null);
  useEffect(() => {
    if (!project) return;
    void refreshStudioLock(project);
    void readIgnored(project);
    const timer = setInterval(() => void refreshStudioLock(project), 5000);
    return () => clearInterval(timer);
  }, [project]);
  // A table opened from the Assets panel (double-click) becomes the Strings tab's table.
  const opened = openIn("localisation");
  useEffect(() => {
    if (opened && stringsPathKind(opened)?.kind === "table") {
      query.value = { ...query.peek(), table: opened };
      tab.value = "strings";
    }
  }, [opened]);
  if (!project) return <Panel><p class="empty">No project open</p></Panel>;

  const languages = languagesOf(project);
  const data: ExchangeProject = exchangeProjectOf(languages, stringsFiles(project));
  const owned = studioOwnedTables(project.files.filter((f) => f.endsWith(".lines.json") || f === "audio.json").map((f) => [f, project.assets.get(f)] as const));
  const accessOf = (table: string) => tableAccess({ canSave: project.canSave, studioOwned: owned.has(table), studioLock: studioLock.value });
  const writable = (table: string) => accessOf(table).editable;
  const named = (code: string) => ({ code, name: languageOf(languages, code)?.name ?? code, direction: languageOf(languages, code)?.direction ?? ("ltr" as const) });
  const targets = languages.list.map((l) => l.code).filter((c) => c !== languages.reference);

  /** Apply a table edit: refused says why; a read-only table says so. */
  const onTable = (table: string, verb: string, r: EditResult<StringTable>) => {
    if ("refused" in r) return report(verb, r);
    const access = accessOf(table);
    if (!access.editable) return report(verb, { refused: access.reason });
    writeTable(project, table, r.next, verb.charAt(0).toUpperCase() + verb.slice(1));
  };
  const onKeyChange = (table: string, verb: string, r: EditResult<KeyChange>) => {
    if ("refused" in r) return report(verb, r);
    const access = accessOf(table);
    if (!access.editable) return report(verb, { refused: access.reason });
    const label = verb.charAt(0).toUpperCase() + verb.slice(1);
    writeTable(project, table, r.next.table, label);
    for (const tr of Object.values(r.next.translations)) writeTranslation(project, table, tr, label);
  };
  const onTranslation = (table: string, verb: string, r: EditResult<TranslationFile>) => {
    if ("refused" in r) return report(verb, r);
    const access = accessOf(table);
    if (!access.editable) return report(verb, { refused: access.reason });
    writeTranslation(project, table, r.next, verb.charAt(0).toUpperCase() + verb.slice(1));
  };

  const doExport = () => {
    const c = choice.value;
    const files = exportFiles(data, c.format, { tables: c.tables, languages: c.languages, onlyNeedsWork: c.onlyNeedsWork }, (project.name || "strings").replace(/[^\w-]+/g, "-"));
    for (const f of files) {
      const url = URL.createObjectURL(new Blob([f.text], { type: f.mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    status.value = { kind: "info", text: `Exported ${files.map((f) => f.name).join(", ")}.` };
  };

  const apply = () => {
    const p = pending.value;
    if (!p) return;
    const { files, blocked } = importWrites(data, p.preview, writable);
    for (const f of files) writeTranslation(project, f.table, f.translation, `Import translations (${f.language})`);
    pending.value = null;
    status.value = { kind: "info", text: `Imported into ${files.length} translation file${files.length === 1 ? "" : "s"}${blocked.length ? `; left out ${blocked.join(", ")} (the Studio's, while it runs)` : ""}.` };
  };

  const runFit = async () => {
    fitting.value = true;
    try {
      const measure = await engineMeasure();
      await loadSvelteParser();
      const scene = openScene.value;
      const sizeOf: SizeOf = (c) => (scene ? (viewport(scene.sync.world).uiElementBox(c)?.size ?? null) : null);
      const { targets, unrendered } = fitTargets(scene?.sync.sceneNode ?? null, sizeOf, project.files);
      fit.value = fitCheck({ project: data, targets, unrendered, measure });
    } catch (err) {
      status.value = errorStatus("Couldn't check the text fit", err);
    } finally {
      fitting.value = false;
    }
  };

  const selectedTable = query.value.table;
  const rows = stringRows(data);
  const gathered = tab.value === "report" ? gatherKeys({ files: gatherFiles(project), languages }) : null;
  parserReady.value;
  if (gathered && !svelteParserLoaded()) void loadSvelteParser().then(() => parserReady.value++, () => {});
  const unkeyed = gathered && svelteParserLoaded() ? unkeyedTextOf(project.files) : [];

  return (
    <Panel class="localisation">
      <div class="loc-root" tabIndex={-1} data-asset-document={selectedTable ?? data.tables[0]?.path}>
        <div class="loc-tabs" role="tablist" aria-label="Localisation views">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`loc-tab-${t.id}`}
              aria-selected={tab.value === t.id}
              tabIndex={tab.value === t.id ? 0 : -1}
              onClick={() => (tab.value = t.id)}
              onKeyDown={(e) => {
                const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                if (!step) return;
                e.preventDefault();
                tab.value = TABS[(TABS.findIndex((x) => x.id === tab.value) + step + TABS.length) % TABS.length].id;
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div class="loc-tabpanel" role="tabpanel" aria-labelledby={`loc-tab-${tab.value}`}>
          {tab.value === "strings" && (
            <StringsView
              tables={data.tables.map((t) => {
                const a = accessOf(t.path);
                return { path: t.path, keys: t.table.strings.length, readOnly: a.editable ? null : a.reason, editInStudio: !a.editable && a.editInStudio };
              })}
              reference={named(languages.reference)}
              languages={targets.map(named)}
              rows={filterRows(rows, query.value)}
              total={rows.length}
              query={query.value}
              onQuery={(q) => (query.value = q)}
              onAddKey={(t, k) => onTable(t, `add ${k}`, addKey(data, t, k))}
              onRenameKey={(t, k, n) => onKeyChange(t, `rename ${k}`, renameKey(data, t, k, n))}
              onDuplicateKey={(t, k) => onTable(t, `duplicate ${k}`, duplicateKey(data, t, k))}
              onDeleteKey={(t, k) => onKeyChange(t, `delete ${k}`, deleteKey(data, t, k))}
              onReferenceText={(t, k, v) => onTable(t, `edit ${k}`, setReferenceText(data, t, k, v))}
              onNotes={(t, k, v) => onTable(t, `edit ${k}'s notes`, setNotes(data, t, k, v))}
              onMaxLength={(t, k, v) => onTable(t, `set ${k}'s length limit`, v !== null && !Number.isFinite(v) ? { refused: "a length limit is a number" } : setMaxLength(data, t, k, v))}
              onTranslation={(t, k, c, v) => onTranslation(t, `translate ${k} (${c})`, setTranslation(data, t, k, c, v))}
              onReviewed={(t, k, c, on) => onTranslation(t, `${on ? "mark" : "unmark"} ${k} (${c}) reviewed`, setReviewed(data, t, k, c, on))}
              onCreateTable={project.canSave ? () => void import("../../assetKindHost").then((m) => m.kindCreators().find((k) => k.kind === STRINGS_KIND)?.create("")) : undefined}
              onEditInStudio={(t) => void import("../../studioLaunch").then((m) => m.openAudioStudio(m.studioRequest(project, { asset: t })))}
            />
          )}
          {tab.value === "report" && gathered && (
            <ReportView
              report={localisationReport(gathered, { unkeyed, ignore: ignored.value, fit: fit.value })}
              fitting={fitting.value}
              fitted={fit.value !== null}
              onRunFit={() => void runFit()}
              onOpen={openRow}
              onDismiss={(id) => void dismiss(project, id)}
            />
          )}
          {tab.value === "exchange" && (
            <ExchangeView
              tables={data.tables.map((t) => t.path)}
              languages={targets.map(named)}
              choice={choice.value}
              onChoice={(c) => (choice.value = c)}
              onExport={doExport}
              preview={pending.value?.preview ?? null}
              importing={pending.value?.names ?? []}
              blocked={pending.value ? [...new Set(pending.value.preview.changes.map((c) => c.table).filter((t) => !writable(t)))] : []}
              onPickFiles={(files) => (pending.value = { preview: importPreviewOf(data, files), names: files.map((f) => f.name) })}
              onApply={apply}
              onCancel={() => (pending.value = null)}
              canImport={project.canSave}
            />
          )}
        </div>
      </div>
    </Panel>
  );
}
