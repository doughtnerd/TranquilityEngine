// The Dialogue screen (ADR 0354 §9, 0355 §7, 0357 §6; Wwise's Voice Profiler and dialogue events, FMOD's audio tables):
// the fixed panel with the Lines, Languages, Report and Events tabs, the Line inspector (right) and History. Every edit
// is a labelled step of its file's asset document — line tables, string tables, translations, dialogue files,
// `audio.json` and `project.json` (languages, only while no editor holds the project) — and sidecars through the Samples
// screen's sessions; the panels carry `data-asset-document` so Ctrl+Z and the History panel act on the document in
// focus. Auditions play the line's file on the table's bus through the Studio's audio host; the test bench decides with
// the engine's pure `decide` over a seeded generator (the audio runtime's `Audio.line`/`Audio.say` aren't public yet).
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import type { EditorProject } from "../../../editor/projects";
import { otherAppHolds } from "../../../editor/projectLocks";
import { currentProject, docVersion, status } from "../../../editor/state";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import { emptyDialogue } from "../../../engine/audio/dialogue/format";
import type { DialogueAsset } from "../../../engine/audio/dialogue/types";
import { parseRhubarb } from "../../../engine/audio/localisation/lipsync";
import { subtitleKeyOf } from "../../../engine/audio/localisation/lines/format";
import type { LineTable } from "../../../engine/audio/localisation/types";
import { measureLoudness } from "../../../engine/audio/loudness/integrated";
import { AUDIO_PROJECT_FILE, type AudioProject } from "../../../engine/audio/project/types";
import { fallbackChain, languagesToJson, type LanguageSettings } from "../../../engine/localisation/languages";
import { isTauri } from "../../../engine/platform/FileSystem";
import { applyEdit, type EditResult } from "../../../editor/sdk/editResult";
import type { StudioPanel } from "../../shell/studioPanels";
import { audioHost, openRoute } from "../../shell/studioServices";
import { openMixDocument } from "../mixer/mixerDocument";
import { historyPanel } from "../placeholder";
import { setNormalize } from "../samples/sampleEditing";
import { decodeAudio, pcmOf, sampleSession } from "../samples/sampleSession";
import { reimportSample } from "../samples/sampleVersions";
import { copiedRows, importedBlock, previewBatch, rowsToCreate, voBlock } from "./batchImport";
import { BatchImportDialog } from "./BatchImportDialog";
import { findLine, heardFile, keyIndex, textThrough, type DialogueData, type LineRef } from "./dialogueData";
import {
  applyDocEdit, commitTo, dialogueData, dialogueDocs, DIALOGUE_KIND, LINES_KIND, openDoc, PROJECT_FILE, PROJECT_FILE_KIND,
} from "./dialogueProject";
import {
  auditioning, batch, benchMemory, benchSeed, benchValues, dialogueTab, editorLock, eventSearch, linesQuery, pendingScript, previewLanguage, rollBars, selectedEvent, selectedLine,
  type DialogueTab,
} from "./dialogueState";
import { coverageCsv, eventCoverage, unnamedEvents, unusedLines } from "./events/coverage";
import { CoverageView } from "./events/CoverageView";
import {
  addEvent, addPath, applyArgumentChange, changeArgument, deleteEvent, duplicateEvent, eventList, pathLints, removePath, renameEvent, renameEventReferences, renameLineInDialogue,
  setEventSettings, setPathEntry, setPathLines, setPathNumbers, usedEventNames, type DialogueDoc, type EventContext, type EventRef,
} from "./events/eventsModel";
import { EventsView } from "./events/EventsView";
import { PathTableView } from "./events/PathTableView";
import { bench, benchAvailable, EMPTY_MEMORY, rememberSaid, roll } from "./events/testBench";
import { TestBenchView } from "./events/TestBenchView";
import { inspectorLanguages } from "./inspectorModel";
import { languagesAccess, previewLanguageOf } from "./languagesModel";
import { LanguagesView } from "./LanguagesView";
import { LineInspectorView } from "./LineInspectorView";
import {
  addLine, deleteLine, duplicateLine, filterOptions, filterRows, lineRows, renameLine, setCooldown, setNotes, setOnce, setSpeaker, setSubtitled, setTags, textEdit, usedKeys,
} from "./linesModel";
import { LinesView } from "./LinesView";
import { dialogueReport, reportCsv } from "./reportModel";
import { ReportView } from "./ReportView";
import { applyScript, linesWithOldText, moveSubtitles, readScriptCsv, scriptCsv } from "./scriptCsv";
import { duckMusicUnder, duckOffer, tableOutput, unnormalised } from "./voiceMix";
import "../samples/samples.css";
import "./dialogue.css";

type Json = Record<string, unknown>;

/** What every panel reads. */
function screen() {
  const project = currentProject.value;
  void docVersion.value; // files added or changed outside follow
  const mixDoc = openMixDocument(project);
  if (!project || !mixDoc) return null;
  const data = dialogueData(project);
  const preview = previewLanguageOf(previewLanguage.value, data.languages);
  return { project, mixDoc, audio: mixDoc.value.value, data, preview, readOnly: !project.canSave };
}
type Screen = NonNullable<ReturnType<typeof screen>>;

function noProject() {
  return <Panel bodyClass="studio-panel-body"><EmptyState compact title="No project" body="Open a project to see its voice-over lines." /></Panel>;
}

const linesDoc = (s: Screen, path: string) => openDoc<LineTable>(s.project, path, LINES_KIND);
const dialogueDoc = (s: Screen, path: string) => openDoc<DialogueAsset>(s.project, path, DIALOGUE_KIND);

/** Commit an edit to the table holding `key`. */
function editLine(s: Screen, key: string, label: string, edit: (t: LineTable, ref: LineRef) => EditResult<LineTable>): boolean {
  const ref = findLine(s.data, key);
  if (!ref) return false;
  return commitTo(linesDoc(s, ref.doc.path), edit(ref.doc.table, ref), label);
}

/** A file offered to the user: saved in the project's `exports/` on the desktop, else downloaded. */
function offerFile(project: EditorProject, name: string, text: string): void {
  if (isTauri() && project.canSave) {
    void project.writeFile(`exports/${name}`, text).then(() => (status.value = { kind: "info", text: `Saved exports/${name}.` }));
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- audition --------------------------------------------------------------------------------------------------------

function stopAudition(): void {
  auditioning.peek()?.handle.stop(0.05);
  auditioning.value = null;
}

/** Play `key`'s file in `code` (through its chain) on its table's bus. */
function audition(s: Screen, key: string, code: string): void {
  stopAudition();
  const ref = findLine(s.data, key);
  const file = ref ? heardFile(s.data, ref, code) : null;
  if (!ref || !file) return void (status.value = { kind: "info", text: `${key} has no file in ${code} or its fallbacks.` });
  const handle = audioHost().playClip(file.path, { bus: tableOutput(s.audio, ref.doc.table.output) });
  if (!handle) return void (status.value = { kind: "info", text: "The Studio's audio isn't running." });
  auditioning.value = { key, code, handle };
  if (file.language !== code) status.value = { kind: "info", text: `${key} plays in ${file.language} (no ${code} recording).` };
}

// --- Lines -----------------------------------------------------------------------------------------------------------

function renameEverywhere(s: Screen, key: string, to: string): void {
  if (!editLine(s, key, `Rename line ${key} to ${to}`, (t) => renameLine(t, key, to, usedKeys(s.data)))) return;
  if (selectedLine.peek() === key) selectedLine.value = to;
  let files = 0;
  for (const d of dialogueDocs(s.project)) {
    const next = renameLineInDialogue(d.asset, key, to);
    if (next) { dialogueDoc(s, d.path).edit(next, { label: `Rename line ${key} to ${to}` }); files++; }
  }
  if (files) status.value = { kind: "info", text: `Renamed ${key} to ${to} in ${files} dialogue file${files === 1 ? "" : "s"}.` };
}

function writeText(s: Screen, key: string, code: string, text: string): void {
  const ref = findLine(s.data, key);
  if (!ref) return;
  const r = textEdit(s.data, ref, code, text);
  applyEdit(r, `${code} text of ${key}`, (e) => applyDocEdit(s.project, e, `${code} text of ${key}`));
}

function LinesTab(s: Screen) {
  const rows = lineRows(s.data, s.preview);
  const q = linesQuery.value;
  const tables = s.data.tables.map((t) => t.path);
  const sel = selectedLine.value;
  const target = () => q.table ?? findLine(s.data, sel ?? "")?.doc.path ?? tables[0];
  return (
    <div
      class="dl-fill"
      onKeyDown={(e) => {
        if (e.key !== " " || (e.target as HTMLElement).closest("input, textarea, select, button")) return;
        e.preventDefault();
        if (auditioning.peek()) stopAudition();
        else if (sel) audition(s, sel, s.preview);
      }}
      tabIndex={-1}
    >
      <LinesView
        rows={filterRows(rows, q)}
        total={rows.length}
        filters={filterOptions(s.data, rows)}
        tables={tables}
        speakers={Object.fromEntries(s.data.tables.map((t) => [t.path, t.table.speakers]))}
        languages={s.data.languages.list}
        preview={s.preview}
        query={q}
        selected={sel}
        readOnly={s.readOnly}
        onQuery={(next) => (linesQuery.value = next)}
        onSelect={(key) => (selectedLine.value = key)}
        onAdd={() => {
          const path = target();
          if (!path) return;
          const doc = linesDoc(s, path);
          const r = addLine(doc.value.peek(), usedKeys(s.data), sel && findLine(s.data, sel)?.doc.path === path ? sel : null, findLine(s.data, sel ?? "")?.line.speaker ?? null);
          if (commitTo(doc, r, "Add line") && "next" in r) selectedLine.value = r.next.lines.find((l) => !s.data.tables.some((t) => t.table.lines.some((x) => x.key === l.key)))?.key ?? sel;
        }}
        onDuplicate={(key) => editLine(s, key, `Duplicate ${key}`, (t) => duplicateLine(t, key, usedKeys(s.data)))}
        onDelete={(key) => {
          if (editLine(s, key, `Delete line ${key}`, (t) => deleteLine(t, key)) && selectedLine.peek() === key) selectedLine.value = null;
        }}
        onRename={(key, to) => renameEverywhere(s, key, to)}
        onSpeaker={(key, v) => editLine(s, key, `Speaker of ${key}`, (t) => setSpeaker(t, key, v))}
        onText={(key, text) => writeText(s, key, s.preview, text)}
        onBatchImport={() => (batch.value = { files: [], pattern: "{lang}/{key}", language: s.data.languages.reference, createIn: null, busy: null })}
      />
      {batch.value && BatchTab(s)}
    </div>
  );
}

// --- batch import ----------------------------------------------------------------------------------------------------

const relOf = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;

async function applyBatch(s: Screen): Promise<void> {
  const b = batch.peek();
  if (!b) return;
  const preview = previewBatch(s.data, b.files.map(relOf), b.pattern, { language: b.language, createIn: b.createIn });
  if ("refused" in preview) return;
  // New rows first (one step of the table), so the copies' `vo` names known keys.
  if (b.createIn) {
    const doc = linesDoc(s, b.createIn);
    commitTo(doc, rowsToCreate(doc.value.peek(), preview.rows, b.createIn), "Batch import: new lines");
  }
  const rows = copiedRows(preview.rows);
  const byRel = new Map(b.files.map((f) => [relOf(f), f]));
  let done = 0;
  const failed: string[] = [];
  for (const r of rows) {
    batch.value = { ...batch.peek()!, busy: { done, total: rows.length } };
    try {
      const file = byRel.get(r.rel)!;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const dest = r.dest!;
      if (r.status === "replace") {
        const res = await reimportSample(sampleSession(s.project, dest), bytes, file.name, "seconds", { label: `Batch import · ${r.key}` });
        if ("refused" in res) throw new Error(res.refused);
      } else {
        await s.project.writeBinary(dest, bytes);
        docVersion.value++;
      }
      const measured = measureLoudness(await decodeAudio(s.project, bytes, dest));
      // ADR 0354 §7: Rhubarb output picked beside the file goes into its sidecar in the same step.
      const rider = r.lipsync ? byRel.get(r.lipsync) : undefined;
      const lipsync = rider ? parseRhubarb(await rider.text(), rider.name) : null;
      if (lipsync && !lipsync.lipsync) failed.push(`${r.lipsync}: ${lipsync.problems[0] ?? "no mouth cues"}`);
      const session = sampleSession(s.project, dest);
      const data = dialogueData(s.project);
      session.commit({ next: importedBlock(session.edits.peek(), voBlock(data, r.key!), data.localisation.loudness, measured, lipsync?.lipsync ?? null), label: `Voice-over ${r.key} (${r.lang})` });
    } catch (err) {
      failed.push(`${r.rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
    done++;
  }
  batch.value = null;
  status.value = failed.length
    ? { kind: "error", text: `Imported ${done - failed.length} of ${rows.length}; ${failed.length} failed (${failed[0]}).` }
    : { kind: "info", text: `Imported ${rows.length} voice-over file${rows.length === 1 ? "" : "s"}.` };
}

function BatchTab(s: Screen) {
  const b = batch.value!;
  const rels = b.files.map(relOf);
  const set = (patch: Partial<typeof b>) => (batch.value = { ...batch.peek()!, ...patch });
  return (
    <BatchImportDialog
      files={rels}
      pattern={b.pattern}
      language={b.language}
      createIn={b.createIn}
      preview={previewBatch(s.data, rels, b.pattern, { language: b.language, createIn: b.createIn })}
      tables={s.data.tables.map((t) => t.path)}
      languages={s.data.languages.list}
      busy={b.busy}
      onPick={(files) => set({ files: [...files] })}
      onPattern={(pattern) => set({ pattern })}
      onLanguage={(language) => set({ language })}
      onCreateIn={(createIn) => set({ createIn })}
      onApply={() => void applyBatch(s)}
      onCancel={() => !batch.peek()?.busy && (batch.value = null)}
    />
  );
}

// --- Languages -------------------------------------------------------------------------------------------------------

/** Read whether the editor holds the project (0354 §1); a project in memory has no editor. */
async function refreshEditorLock(project: EditorProject): Promise<void> {
  if (!project.fileSystem || !project.root) return void (editorLock.value = "none");
  try {
    editorLock.value = (await otherAppHolds(project.fileSystem, project.root, "studio")) ? "held" : "none";
  } catch {
    editorLock.value = "unknown";
  }
}

async function normaliseLanguage(s: Screen, code: string): Promise<void> {
  const files = unnormalised(s.data, code);
  const { mode, target } = s.data.localisation.loudness;
  let done = 0;
  const refused: string[] = [];
  for (const path of files) {
    try {
      const m = measureLoudness(await pcmOf(s.project, path));
      const session = sampleSession(s.project, path);
      const r = setNormalize(session.edits.peek(), mode, target, m);
      if ("refused" in r) refused.push(`${path}: ${r.refused}`);
      else if (session.commit({ next: r.next, label: `Normalise ${code}` })) done++;
    } catch (err) {
      refused.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  status.value = refused.length ? { kind: "error", text: `Normalised ${done} ${code} file${done === 1 ? "" : "s"}; ${refused.length} not (${refused[0]}).` } : { kind: "info", text: `Normalised ${done} ${code} file${done === 1 ? "" : "s"} to ${target}.` };
}

function LanguagesTab(s: Screen) {
  const projectDoc = openDoc<Json>(s.project, PROJECT_FILE, PROJECT_FILE_KIND);
  const access = languagesAccess({ canSave: s.project.canSave && !projectDoc.readOnly, editorLock: editorLock.value });
  return (
    <LockWatch project={s.project}>
      <div data-asset-document={PROJECT_FILE}>
        <LanguagesView
          languages={s.data.languages}
          access={access}
          localisation={s.data.localisation}
          audioReadOnly={s.mixDoc.readOnly}
          preview={s.preview}
          unnormalised={Object.fromEntries(s.data.languages.list.map((l) => [l.code, unnormalised(s.data, l.code).length]))}
          duckOffer={duckOffer(s.audio, s.data)}
          onLanguages={(label, edit) => {
            if (!access.editable) return void (status.value = { kind: "info", text: access.reason });
            const r: EditResult<LanguageSettings> = edit(s.data.languages);
            applyEdit(r, label, (next) => projectDoc.edit({ ...projectDoc.value.peek(), languages: languagesToJson(next) }, { label }));
          }}
          onAudio={(label, edit) => applyEdit(edit(s.audio), label, (next: AudioProject) => s.mixDoc.edit(next, { label }), s.audio)}
          onPreview={(code) => (previewLanguage.value = code)}
          onNormalise={(code) => void normaliseLanguage(s, code)}
          onDuck={(bus) => applyEdit(duckMusicUnder(s.audio, bus), `Duck Music under ${bus}`, (next) => s.mixDoc.edit(next, { label: `Duck Music under ${bus}` }), s.audio)}
          onEditInEditor={() => (status.value = { kind: "info", text: "Open Project Settings > Languages in the editor's window: it owns project.json while it has the project open." })}
        />
      </div>
    </LockWatch>
  );
}

/** Reads the editor's lock when the tab shows and whenever the window gets the focus. */
function LockWatch(props: { project: EditorProject; children: ComponentChildren }) {
  useEffect(() => {
    void refreshEditorLock(props.project);
    const onFocus = () => void refreshEditorLock(props.project);
    globalThis.addEventListener?.("focus", onFocus);
    return () => globalThis.removeEventListener?.("focus", onFocus);
  }, [props.project]);
  return <>{props.children}</>;
}

// --- Report ----------------------------------------------------------------------------------------------------------

function ReportTab(s: Screen) {
  const report = dialogueReport(s.data, keyIndex(s.data).duplicates);
  return (
    <ReportView
      report={report}
      readOnly={s.readOnly}
      pending={pendingScript.value}
      onExportReport={() => offerFile(s.project, "dialogue-report.csv", reportCsv(report))}
      onExportScript={() => offerFile(s.project, "dialogue-script.csv", scriptCsv(s.data))}
      onImportScript={(text) => (pendingScript.value = readScriptCsv(s.data, text))}
      onApplyScript={(remove) => {
        const diff = pendingScript.peek();
        if (!diff) return;
        const { edits, problems } = applyScript(s.data, diff, { remove });
        for (const e of edits) applyDocEdit(s.project, e, "Import script CSV");
        pendingScript.value = null;
        status.value = { kind: problems.length ? "error" : "info", text: `Script imported into ${edits.length} file${edits.length === 1 ? "" : "s"}${problems.length ? `; ${problems.length} skipped (${problems[0]})` : ""}.` };
      }}
      onCancelScript={() => (pendingScript.value = null)}
      oldText={linesWithOldText(s.data).length}
      onMoveSubtitles={() => {
        const { edits, problems } = moveSubtitles(s.data);
        for (const e of edits) applyDocEdit(s.project, e, "Move subtitles to the string table");
        status.value = { kind: problems.length ? "error" : "info", text: `Moved subtitles in ${edits.length} file${edits.length === 1 ? "" : "s"}${problems.length ? `; ${problems.length} not (${problems[0]})` : ""}.` };
      }}
    />
  );
}

// --- Events ----------------------------------------------------------------------------------------------------------

const NEW_DIALOGUE_FILE = "dialogue/events.dialogue.json";

function eventContext(audio: AudioProject): EventContext {
  return { parameterLabels: (name) => { const p = audio.parameters.find((x) => x.name === name); return p && "labels" in p ? p.labels : null; } };
}

/** Whether `key` has a file in `code`'s chain. */
const recordedIn = (data: DialogueData, key: string, code: string) => {
  const ref = findLine(data, key);
  return ref ? heardFile(data, ref, code) !== null : false;
};

function EventsTab(s: Screen) {
  const docs: DialogueDoc[] = dialogueDocs(s.project);
  const ctx = eventContext(s.audio);
  const used = usedEventNames(docs);
  const events = eventList(docs, eventSearch.value);
  const want = selectedEvent.value;
  const sel: EventRef | null = (want && eventList(docs).find((r) => r.path === want.path && r.event.name === want.name)) ?? null;
  const commitAsset = (path: string, r: EditResult<DialogueAsset>, label: string) => commitTo(dialogueDoc(s, path), r, label);
  const lineKeys = [...keyIndex(s.data).keys.keys()];
  const now = performance.now() / 1000;
  const memory = benchMemory.value;
  const rules = (k: string) => findLine(s.data, k)?.line ?? null;
  const benchCtx = sel ? {
    seed: benchSeed.value,
    history: memory.history[sel.event.name] ?? [],
    available: benchAvailable(memory, rules, now),
    recorded: (k: string) => recordedIn(s.data, k, s.preview),
    parameter: (name: string) => { const p = s.audio.parameters.find((x) => x.name === name); return p && "labels" in p ? p.default : null; },
    parameterLabels: ctx.parameterLabels,
  } : null;
  const view = sel && benchCtx ? bench(sel.event, benchValues.value, benchCtx) : null;
  const picked = view && "key" in view.result ? findLine(s.data, view.result.key) : null;
  const coverage = docs.flatMap((d) => d.asset.events.map((e) => eventCoverage(e, ctx, s.data.languages.list.map((l) => l.code), (k, c) => recordedIn(s.data, k, c))));
  const unused = unusedLines(lineKeys, docs);
  const unnamed = unnamedEvents(docs, s.project.scripts);
  return (
    <div data-asset-document={sel?.path ?? docs[0]?.path}>
      <EventsView
        events={events}
        files={docs.map((d) => d.path)}
        selected={sel}
        search={eventSearch.value}
        readOnly={s.readOnly}
        onSearch={(q) => (eventSearch.value = q)}
        onSelect={(r) => { selectedEvent.value = { path: r.path, name: r.event.name }; rollBars.value = null; }}
        onAdd={(file) => {
          const path = file ?? NEW_DIALOGUE_FILE;
          const doc = dialogueDoc(s, path);
          const r = addEvent(file ? doc.value.peek() : emptyDialogue(), used);
          if (commitTo(doc, r, "Add event") && "next" in r) selectedEvent.value = { path, name: r.next.events.at(-1)!.name };
          if (!file) docVersion.value++;
        }}
        onDuplicate={(r) => commitAsset(r.path, duplicateEvent(dialogueDoc(s, r.path).value.peek(), r.event.name, used), `Duplicate ${r.event.name}`)}
        onRename={(r, to) => {
          if (!commitAsset(r.path, renameEvent(dialogueDoc(s, r.path).value.peek(), r.event.name, to, used), `Rename event ${r.event.name} to ${to}`)) return;
          selectedEvent.value = { path: r.path, name: to };
          for (const d of docs) {
            if (d.path === r.path) continue;
            const next = renameEventReferences(d.asset, r.event.name, to);
            if (next) dialogueDoc(s, d.path).edit(next, { label: `Rename event ${r.event.name} to ${to}` });
          }
        }}
        onDelete={(r) => { if (commitAsset(r.path, deleteEvent(dialogueDoc(s, r.path).value.peek(), r.event.name), `Delete event ${r.event.name}`)) selectedEvent.value = null; }}
        onSettings={(r, patch, label) => commitAsset(r.path, setEventSettings(dialogueDoc(s, r.path).value.peek(), r.event.name, patch), `${label} · ${r.event.name}`)}
      >
        {sel && view && benchCtx && (
          <>
            <PathTableView
              event={sel.event}
              ctx={ctx}
              parameters={s.audio.parameters.filter((p) => "labels" in p).map((p) => p.name)}
              lints={pathLints(sel.event, ctx, new Set(lineKeys))}
              bench={view.rows}
              lineKeys={lineKeys}
              recorded={(k) => recordedIn(s.data, k, s.preview)}
              preview={s.preview}
              readOnly={s.readOnly}
              impactOf={(change) => { const r = changeArgument(sel.event, change, ctx); return "refused" in r ? r : { next: { impact: r.next.impact } }; }}
              onArgument={(change, label) => commitAsset(sel.path, applyArgumentChange(dialogueDoc(s, sel.path).value.peek(), sel.event.name, change, ctx), `${label} · ${sel.event.name}`)}
              onEntry={(i, a, v) => commitAsset(sel.path, setPathEntry(dialogueDoc(s, sel.path).value.peek(), sel.event.name, i, a, v), "Edit path")}
              onLines={(i, lines) => commitAsset(sel.path, setPathLines(dialogueDoc(s, sel.path).value.peek(), sel.event.name, i, lines), "Path lines")}
              onNumbers={(i, patch) => commitAsset(sel.path, setPathNumbers(dialogueDoc(s, sel.path).value.peek(), sel.event.name, i, patch), patch.probability !== undefined ? "Path probability" : "Path weight")}
              onAddPath={() => commitAsset(sel.path, addPath(dialogueDoc(s, sel.path).value.peek(), sel.event.name), "Add path")}
              onRemovePath={(i) => commitAsset(sel.path, removePath(dialogueDoc(s, sel.path).value.peek(), sel.event.name, i), "Remove path")}
            />
            <TestBenchView
              event={sel.event}
              ctx={ctx}
              values={benchValues.value}
              seed={benchSeed.value}
              view={view}
              subtitle={picked ? textThrough(s.data, picked, s.preview)?.text ?? null : null}
              preview={s.preview}
              bars={rollBars.value}
              memory={Object.values(memory.history).flat()}
              onValue={(n, v) => { benchValues.value = { ...benchValues.peek(), [n]: v }; rollBars.value = null; }}
              onSeed={(seed) => (benchSeed.value = seed)}
              onSay={() => {
                if ("key" in view.result) {
                  audition(s, view.result.key, s.preview);
                  benchMemory.value = rememberSaid(benchMemory.peek(), sel.event.name, view.result.key, now);
                } else status.value = { kind: "info", text: view.summary };
                benchSeed.value = benchSeed.peek() + 1; // the next say draws afresh, as the World's generator moves on
              }}
              onRoll={() => (rollBars.value = roll(sel.event, benchValues.value, benchCtx))}
              onResetMemory={() => (benchMemory.value = EMPTY_MEMORY)}
            />
          </>
        )}
      </EventsView>
      <CoverageView events={coverage} unusedLines={unused} unnamedEvents={unnamed} onExport={() => offerFile(s.project, "dialogue-coverage.csv", coverageCsv(coverage, unused, unnamed))} />
    </div>
  );
}

// --- panels ----------------------------------------------------------------------------------------------------------

const TABS: { id: DialogueTab; label: string }[] = [
  { id: "lines", label: "Lines" },
  { id: "languages", label: "Languages" },
  { id: "report", label: "Report" },
  { id: "events", label: "Events" },
];

function MainPanel() {
  const s = screen();
  if (!s) return noProject();
  const tab = dialogueTab.value;
  const move = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = TABS[(to + TABS.length) % TABS.length]!.id;
    dialogueTab.value = next;
    // The focus follows the selected tab (roving tabindex).
    queueMicrotask(() => document.getElementById(`dl-tab-${next}`)?.focus());
  };
  const sel = findLine(s.data, selectedLine.value ?? "");
  // The document Ctrl+Z acts on: the selected line's table on the Lines tab.
  const docPath = tab === "lines" ? sel?.doc.path ?? s.data.tables[0]?.path : tab === "languages" ? AUDIO_PROJECT_FILE : undefined;
  return (
    <Panel bodyClass="studio-panel-body dl-main">
      <div class="dl-doc" data-asset-document={docPath}>
        <div class="dl-tabs" role="tablist" aria-label="Dialogue views" onKeyDown={move}>
          {TABS.map((t) => (
            <button key={t.id} role="tab" id={`dl-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="dl-tabpanel" tabIndex={tab === t.id ? 0 : -1} class={tab === t.id ? "on" : undefined} onClick={() => (dialogueTab.value = t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div id="dl-tabpanel" role="tabpanel" aria-labelledby={`dl-tab-${tab}`} class="dl-tabpanel">
          {tab === "lines" ? LinesTab(s) : tab === "languages" ? LanguagesTab(s) : tab === "report" ? ReportTab(s) : EventsTab(s)}
        </div>
      </div>
    </Panel>
  );
}

function InspectorPanel() {
  const s = screen();
  if (!s) return noProject();
  const ref = findLine(s.data, selectedLine.value ?? "");
  const playing = auditioning.value;
  const edit = (label: string, e: (t: LineTable) => EditResult<LineTable>) => ref && commitTo(linesDoc(s, ref.doc.path), e(ref.doc.table), `${label} · ${ref.line.key}`);
  return (
    <Panel class="dl-inspector-panel" bodyClass="smp-insp-body">
      <div class="dl-doc" data-asset-document={ref?.doc.path}>
        <LineInspectorView
          line={ref?.line ?? null}
          table={ref?.doc.path ?? null}
          languages={ref ? inspectorLanguages(s.data, ref) : []}
          preview={s.preview}
          auditioning={playing && ref && playing.key === ref.line.key && playing.handle.playing ? playing.code : null}
          readOnly={s.readOnly}
          onAudition={(code) => ref && audition(s, ref.line.key, code)}
          onStop={stopAudition}
          onOpenFile={(path) => openRoute({ screen: "samples", asset: path })}
          onText={(code, text) => ref && writeText(s, ref.line.key, code, text)}
          onNotes={(notes) => edit("Notes", (t) => setNotes(t, ref!.line.key, notes))}
          onTags={(tags) => edit("Tags", (t) => setTags(t, ref!.line.key, tags))}
          onCooldown={(v) => edit("Cooldown", (t) => setCooldown(t, ref!.line.key, v))}
          onOnce={(v) => edit(v ? "Once" : "Not once", (t) => setOnce(t, ref!.line.key, v))}
          onSubtitled={(v) => edit(v ? "Subtitled" : "Never subtitled", (t) => setSubtitled(t, ref!.line.key, v))}
        />
        {ref && subtitleKeyOf(ref.line) !== null && <p class="dl-note" style={{ padding: "0 8px" }}>Chain for {s.preview}: {fallbackChain(s.data.languages, s.preview).join(" → ")}</p>}
      </div>
    </Panel>
  );
}

export const DIALOGUE_PANELS: readonly StudioPanel[] = [
  { id: "dialogue-main", title: "Dialogue", dock: "fill", fixed: true, view: () => <MainPanel /> },
  { id: "dialogue-inspector", title: "Line", dock: "right", view: () => <InspectorPanel /> },
  historyPanel("dialogue"),
];
