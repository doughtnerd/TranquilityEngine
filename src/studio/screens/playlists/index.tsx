// The Playlists screen's panels (ADR 0343, 0341 "The shell", 0349; the prototype's layout): Playlists (the tree) and
// Library on the left, the Playlist panel in the middle (fixed), the Inspector on the right, Plays now and Parameters at
// the bottom, History and Global parameters (the Mixer's panel over `audio.json`) on demand. The panels read the screen's state (`playlistsScreen.ts`) and call its actions; the
// Playlist panel also owns what the screen does while it shows: following the route, the Space key and the player
// bar's slots (Trigger / Stop / Release, previous and next voice event, the voice log's scrub).
import { effect, signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { deleteAssets } from "../../../editor/assetDelete";
import { currentProject, docVersion } from "../../../editor/state";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import { Section } from "../../../editor/ui/PanelFields";
import type { Entry } from "../../../engine/audio/playlist/types";
import { Icon } from "../../components/Icon";
import { ParameterPanel } from "../../components/ParameterPanel";
import type { StudioPanel } from "../../shell/studioPanels";
import { audioHost, keymap, openRoute, setPlayerSlots, studioRouter, toasts } from "../../shell/studioServices";
import { historyPanel } from "../placeholder";
import { renameTestValue } from "../mixer/globalParametersHost";
import { globalParametersPanel } from "../mixer/globalParametersPanels";
import { captionTable, createCaptionKey } from "../dialogue/dialogueProject";
import { AddDialog } from "./AddDialog";
import { captionPlaceholder } from "./captionEdit";
import { addItems, addLabel, entriesFor } from "./addDialogModel";
import { openCurveEditor, openWeightCurveEditor } from "./curveEditorAdapter";
import { LibraryList } from "./LibraryList";
import { isSamplePath } from "./libraryModel";
import { DeleteDialog, FolderDeleteDialog } from "./PlaylistDialogs";
import { PlaylistHistoryScope } from "./PlaylistHistoryScope";
import { PlaylistEditor } from "./PlaylistEditor";
import { PlaylistInspector } from "./PlaylistInspector";
import { addEntries, duplicateEntry, removeEntry, setEntryUse, sampleEntry } from "./playlistEdits";
import { breadcrumb, childPath, editAt, effectiveOutput, entryName, filePath, pathTarget, playlistTitle, whereOf, type PlaylistPath } from "./playlistPaths";
import {
  adding, allParameters, askDelete, askDeleteFolder, deleteFolderKeepingContents, deletingFolder, audioNow, auditioning, busNames, confirmDelete, deleting, docFor, duplicatePlaylistFiles, editContext, editFile, editOpen, followRoute,
  linkedBy, loadPlaylist, logCursor, makeShared, moveToFolder, newPlaylist, newPlaylistFolder, newPlaylistFromSamples, newSequence, openBody, openDoc, openFile, openLints, openPath, openPlaylist,
  playingNow, releaseAudition, renameFolder, renamePlaylistFile, removeLinkEntry, runDrop, selectedEntry, setTestValue, stopAudition, target, testValues, trigger, triggerOffReason, unlink, voiceLog, clearLog,
} from "./playlistsScreen";
import { newPlaylistParameter } from "./newParameter";
import { NewGlobalParameterHost } from "../mixer/newGlobalParameter";
import { PlaylistTreeView, type TreeActions } from "./PlaylistTreeView";
import { entryKey, factsOf, fileKey, playlistTree, type PlaylistNode } from "./playlistTree";
import { dropLabel, planDrop } from "./treeDrop";
import { canRelease } from "./voiceLog";
import { playlistPlayerSlots } from "./playlistPlayer";
import { playlistBadge } from "../../components/typeBadgeModel";
import { VoicesView } from "./VoicesView";
import { isGeneratorPath } from "../../../engine/audio/generators/format";
import { GeneratorLibraryPanel, GeneratorPanel } from "./generator/GeneratorPanel";
import { addGeneratorToOpen, followGeneratorRoute, generatorSpace, generatorTarget, loadGenerator } from "./generator/generatorScreen";
import { SequenceInspectorPanel } from "./sequence/SequencePanel";
import { sequenceSpace, stopSequence } from "./sequence/sequenceState";
import { sequencePlayerSlots } from "./sequence/SequenceTransport";
import "./playlists.css";

const writable = () => !!currentProject.value?.canSave;

/** The path a tree row opens: a file alone, an embedded entry down its indices, a linked entry through its parent into its file. */
function pathOf(n: PlaylistNode): PlaylistPath | null {
  if (n.kind === "file") return filePath(n.path);
  if (n.kind !== "entry") return null;
  const down = n.indices.map((entry) => ({ entry }));
  return n.link ? [...filePath(n.file), ...down.slice(0, -1), { file: n.link }] : [...filePath(n.file), ...down];
}

/** The open playlist's row key in the tree. */
function openKey(): string | null {
  const t = target.value;
  if (!t) return null;
  return t.indices.length ? entryKey(t.file, t.indices) : fileKey(t.file);
}

const treeActions: TreeActions = {
  open: (n) => {
    const p = pathOf(n);
    if (p) openPlaylist(p);
  },
  newPlaylist: (folder) => void newPlaylist(folder, false),
  newPlaylistInside: () => void newPlaylist(null, true),
  newSequence: (folder) => void newSequence(folder),
  newFolder: (parent) => void newPlaylistFolder(parent),
  renameFile: (path, name) => void renamePlaylistFile(path, name),
  renameFolder: (path, name) => void renameFolder(path, name),
  duplicate: (nodes) => {
    const files = nodes.filter((n) => n.kind === "file").map((n) => (n as { path: string }).path);
    if (files.length) void duplicatePlaylistFiles(files);
    for (const n of nodes) {
      if (n.kind !== "entry") continue;
      const i = n.indices[n.indices.length - 1]!;
      editFile(n.file, "Duplicate entry", (r) => editAt(r, n.indices.slice(0, -1), (b) => duplicateEntry(b, i, editContext.peek())));
    }
  },
  remove: (n) => {
    if (n.kind === "file") askDelete({ kind: "file", path: n.path }, n.name);
    else if (n.kind === "entry") askDelete({ kind: "entry", file: n.file, parent: n.indices.slice(0, -1), index: n.indices[n.indices.length - 1]! }, n.name);
  },
  removeMany: (nodes) => {
    // Entries first, the last of each parent first so indices stay right; links lose only the link; then the files.
    const entries = nodes.filter((n): n is PlaylistNode & { kind: "entry" } => n.kind === "entry").sort((a, b) => b.indices.join(".").localeCompare(a.indices.join("."), undefined, { numeric: true }));
    for (const n of entries) {
      const parent = n.indices.slice(0, -1), i = n.indices[n.indices.length - 1]!;
      if (n.link) removeLinkEntry(n.file, parent, i);
      else editFile(n.file, `Delete ${n.name}`, (r) => editAt(r, parent, (b) => removeEntry(b, i)));
    }
    // Files are deleted; a folder keeps what's inside, which moves up a level (W2.14), each with its Undo.
    const files = nodes.filter((n) => n.kind === "file").map((n) => (n as { path: string }).path);
    const folders = nodes.filter((n) => n.kind === "folder").map((n) => n.path).sort((a, b) => b.length - a.length); // inner ones first
    void (async () => {
      if (files.length && !(await deleteAssets(files))) return;
      for (const f of folders) await deleteFolderKeepingContents(f);
    })();
  },
  deleteFolder: (path) => askDeleteFolder(path),
  unlink: (n) => n.kind === "entry" && unlink(n.file, n.indices.slice(0, -1), n.indices[n.indices.length - 1]!),
  makeShared: (n) => void (n.kind === "entry" && makeShared(n.file, n.indices.slice(0, -1), n.indices[n.indices.length - 1]!)),
  moveTo: (paths, folder) => void moveToFolder(paths, folder),
  planDrop: (source, t, zone) => planDrop(source, t, zone, loadPlaylist),
  drop: (plan, source, t) => {
    const intoName = plan.kind === "link" || plan.kind === "moveEntry" ? (plan.into.indices.length ? `${playlistTitle(plan.into.file)} › ${plan.into.indices.join(".")}` : playlistTitle(plan.into.file)) : t.kind === "folder" ? t.path : "";
    void runDrop(plan, dropLabel(plan, source.name, intoName));
  },
  openSamples: () => openRoute({ screen: "samples" }),
};

function TreePanel() {
  void docVersion.value;
  const project = currentProject.value;
  const files = project?.files ?? [];
  const nodes = playlistTree(files, project?.folders ?? [], loadPlaylist);
  const open = openBody.value;
  const nestInto = open && open.type !== "clip" && open.type !== "sequence" ? lastCrumbName() : null;
  return (
    <Panel bodyClass="pl-panel-body">
      <PlaylistHistoryScope doc={openDoc.value}>
      <PlaylistTreeView nodes={nodes} folders={project?.folders ?? []} openKey={openKey()} writable={writable()} hasSamples={files.some(isSamplePath)} nestInto={nestInto} actions={treeActions} />
      {deletingFolder.value && <FolderDeleteDialog folder={deletingFolder.value} onCancel={() => (deletingFolder.value = null)} onConfirm={() => void deleteFolderKeepingContents(deletingFolder.value!.path)} />}
      </PlaylistHistoryScope>
    </Panel>
  );
}

/** The sample previewing in the Library, and its stop. */
const previewing = signal<{ path: string; stop(): void } | null>(null);
function preview(path: string): void {
  const was = previewing.peek();
  was?.stop();
  previewing.value = null;
  if (was?.path === path) return;
  const h = audioHost().playClip(path);
  if (!h) return;
  const timer = setTimeout(() => stopPreview(), 30_000);
  const watch = setInterval(() => !h.playing && stopPreview(), 250);
  const stopPreview = () => {
    clearTimeout(timer);
    clearInterval(watch);
    h.stop(0.05);
    if (previewing.peek()?.path === path) previewing.value = null;
  };
  previewing.value = { path, stop: stopPreview };
}

function addSample(path: string): void {
  editOpen("Add entry", (b) => addEntries(b, [sampleEntry(b, path)], editContext.peek()));
}

function LibraryPanel() {
  void docVersion.value;
  const body = openBody.value;
  const addTo = body && body.type !== "sequence" ? lastCrumbName() : null;
  return (
    <Panel bodyClass="pl-panel-body">
      <PlaylistHistoryScope doc={openDoc.value}>
      <LibraryList files={currentProject.value?.files ?? []} addTo={addTo} previewing={previewing.value?.path ?? null} onPreview={preview} onAdd={addSample} onOpenSamples={() => openRoute({ screen: "samples" })} onCreatePlaylist={(paths) => void newPlaylistFromSamples(paths)} writable={writable()} extra={(query) => <GeneratorLibraryPanel query={query} />} />
      </PlaylistHistoryScope>
    </Panel>
  );
}

function lastCrumbName(): string {
  const path = openPath.value;
  if (!path) return "";
  const crumbs = breadcrumb(path, loadPlaylist);
  return crumbs[crumbs.length - 1]?.name ?? "";
}

function removeAt(i: number): void {
  const t = target.peek();
  const b = openBody.peek();
  const e = b?.entries[i];
  if (!t || !b || !e) return;
  if (e.kind === "linked") return removeLinkEntry(t.file, t.indices, i);
  if (e.kind === "embedded" && e.embedded.type !== "clip" && e.embedded.entries.length) return askDelete({ kind: "entry", file: t.file, parent: t.indices, index: i }, entryName(e, i));
  const name = entryName(e, i);
  if (editOpen("Remove entry", (x) => removeEntry(x, i))) {
    selectedEntry.value = null;
    toasts.show({ text: `Removed ${name}.`, undo: () => docFor(t.file)?.undo() });
  }
}

function editCurves(i: number): void {
  const e = openBody.peek()?.entries[i];
  if (!e) return;
  openCurveEditor({
    entry: entryName(e, i),
    context: lastCrumbName(),
    curves: e.curves,
    parameters: allParameters.peek(),
    values: testValues.peek(),
    newParameter: newPlaylistParameter,
    apply: (curves, label) => editOpen(label, (b) => setEntryUse(b, i, { curves })),
  });
}

/** ADR 0350: a Blend entry's weight curve in the shared curve editor (one undo step). */
function editWeightCurve(i: number): void {
  const e = openBody.peek()?.entries[i];
  if (!e) return;
  openWeightCurveEditor({
    entry: entryName(e, i),
    context: lastCrumbName(),
    curve: e.weightCurve,
    apply: (curve) => editOpen(curve ? `Weight curve · ${entryName(e, i)}` : `Reset weight curve · ${entryName(e, i)}`, (b) => setEntryUse(b, i, { weightCurve: curve })),
  });
}

const factsOfEntry = (e: Entry) => {
  if (e.kind !== "linked") return null;
  const b = loadPlaylist(e.playlist);
  return b ? factsOf(b) : null;
};

/** What the screen does while it shows: the route, the Space key, the player bar. */
function useScreen(): void {
  useEffect(() => {
    const stops = [
      followRoute(studioRouter().route),
      followGeneratorRoute(studioRouter().route),
      keymap.register({
        id: "playlists.trigger", keys: ["Space"], label: "Trigger / stop (release a held loop)", scope: { screen: "playlists" },
        run: () => {
          if (generatorTarget.peek()) return generatorSpace(); // ADR 0360: held Space gates the open generator
          if (!openBody.peek()) return false;
          if (openBody.peek()!.type === "sequence") return sequenceSpace();
          if (auditioning.peek()) {
            if (canRelease(openBody.peek()!, loadPlaylist)) releaseAudition();
            else stopAudition();
          } else trigger();
        },
      }),
      keymap.register({ id: "playlists.stop", keys: ["Shift+Space"], label: "Stop the audition", scope: { screen: "playlists" }, run: () => (openBody.peek()?.type === "sequence" ? stopSequence() : stopAudition()) }),
      effect(() => {
        const body = openBody.value;
        const path = openPath.value;
        const log = voiceLog.value;
        const cursor = logCursor.value;
        const busy = auditioning.value;
        const now = audioNow.value;
        if (!body || !path) return setPlayerSlots("playlists", null);
        const t = pathTarget(path);
        if (body.type === "sequence") return setPlayerSlots("playlists", sequencePlayerSlots(lastCrumbName(), `Sequence · ${t.file}`));
        setPlayerSlots("playlists", playlistPlayerSlots(
          { title: lastCrumbName(), art: playlistBadge(body.type, factsOf(body).axes).code, subtitle: `${body.type === "clip" ? "Clip" : body.type.charAt(0).toUpperCase() + body.type.slice(1)} · ${t.file}`, busy, release: canRelease(body, loadPlaylist), triggerOff: triggerOffReason(), log, cursor, now },
          { trigger, stop: stopAudition, release: releaseAudition, seek: (at) => (logCursor.value = at) },
        ));
      }),
    ];
    return () => {
      for (const stop of stops) stop();
      setPlayerSlots("playlists", null);
    };
  }, []);
}

function EditorPanel() {
  useScreen();
  void docVersion.value;
  const path = openPath.value;
  const body = openBody.value;
  const t = target.value;
  const doc = openDoc.value;
  const ctx = editContext.value;
  // ADR 0360 §9: a generator (a `*.generator.json`, or the one a Clip plays) opens the Generator editor here.
  if (generatorTarget.value) {
    return (
      <Panel bodyClass="pl-panel-body">
        <GeneratorPanel />
      </Panel>
    );
  }
  if (!path || !t || !body || !doc) {
    return (
      <Panel bodyClass="pl-panel-body">
        <EmptyState title="Playlists" icon={<Icon name="playlists" size={28} />} body={<p>What the game plays: clips, queues, switches, blends, layers and sequences, auditioned with test parameters. Pick a playlist in the Playlists panel, or make one with its New button.</p>}
          action={{ label: "New playlist", disabled: !writable(), run: () => void newPlaylist("", false) }} />
      </Panel>
    );
  }
  const crumbs = breadcrumb(path, loadPlaylist);
  const files = currentProject.value?.files ?? [];
  const title = crumbs[crumbs.length - 1]?.name ?? "";
  return (
    <Panel bodyClass="pl-panel-body">
      <PlaylistHistoryScope doc={openDoc.value}>
      <div class="pl-doc" data-asset-document={doc.path} tabIndex={-1}>
        <PlaylistEditor
          body={body}
          crumbs={crumbs}
          title={title}
          renamable={t.indices.length === 0}
          writable={writable() && !doc.readOnly}
          ctx={ctx}
          lints={openLints.value}
          where={whereOf(t.indices)}
          selected={selectedEntry.value}
          values={testValues.value}
          playlists={files.filter((f) => f.toLowerCase().endsWith(".playlist.json") && f !== t.file)}
          facts={factsOfEntry}
          onEdit={(label, edit, drag) => editOpen(label, edit, drag)}
          onSelect={(i) => (selectedEntry.value = i)}
          onOpen={(i) => {
            const next = childPath(path, body, i);
            if (next) openPlaylist(next);
          }}
          onRemove={removeAt}
          onMakeShared={(i) => void makeShared(t.file, t.indices, i)}
          onUnlink={(i) => unlink(t.file, t.indices, i)}
          onEditCurves={editCurves}
          onEditWeightCurve={editWeightCurve}
          onCrumb={openPlaylist}
          onRename={(name) => void renamePlaylistFile(t.file, name)}
          onAdd={() => (adding.value = true)}
          onDropSample={addSample}
          onTestValue={(name, v) => setTestValue(name, v)}
          onOpenSamples={(sample) => openRoute({ screen: "samples", asset: sample })}
        />
      </div>
      {adding.value && (
        <AddDialog
          items={addItems(files, t.file, body.type, loadPlaylist, loadGenerator)}
          single={body.type === "clip"}
          title={body.type === "clip" ? (body.entries.length ? "Replace sample…" : "Choose sample…") : `Add to ${title}`}
          onClose={() => (adding.value = false)}
          onAdd={(paths, mode) => {
            adding.value = false;
            // ADR 0360: a Clip plays a picked generator as its source.
            if (body.type === "clip" && paths[0] && isGeneratorPath(paths[0])) return void addGeneratorToOpen(paths[0], body.entries.length ? "Replace with generator" : "Choose generator");
            const items = addItems(files, t.file, body.type, loadPlaylist, loadGenerator);
            const entries = entriesFor(paths, items, mode, loadPlaylist);
            editOpen(body.type === "clip" ? (body.entries.length ? "Replace sample" : "Choose sample") : addLabel(entries.length), (b) => addEntries(b, entries, editContext.peek()));
          }}
        />
      )}
      {deleting.value && <DeleteDialog plan={deleting.value} onCancel={() => (deleting.value = null)} onConfirm={(c, l) => void confirmDelete(deleting.value!, c, l)} />}
      </PlaylistHistoryScope>
    </Panel>
  );
}

function InspectorPanel() {
  void docVersion.value;
  const path = openPath.value;
  const body = openBody.value;
  const t = target.value;
  const doc = openDoc.value;
  const project = currentProject.value;
  if (!path || !body || !t || !doc) {
    return (
      <Panel bodyClass="pl-panel-body">
        <EmptyState compact title="Nothing selected" body="The open playlist's playback rules, output, effects and spatial settings, and the selected entry's." />
      </Panel>
    );
  }
  const usedBy = t.indices.length ? [t.file] : (linkedBy.value.get(t.file) ?? []);
  const captions = project ? captionTable(project) : null; // ADR 0357 §6: the Caption field's keys
  const inspector = (
        <PlaylistInspector
          body={body}
          selected={selectedEntry.value}
          writable={writable() && !doc.readOnly}
          ctx={editContext.value}
          buses={busNames.value}
          output={effectiveOutput(path, loadPlaylist)}
          presets={(project?.files ?? []).filter((f) => f.toLowerCase().endsWith(".attenuation.json"))}
          usedBy={usedBy}
          onEdit={(label, edit, drag) => editOpen(label, edit, drag)}
          onEditCurves={editCurves}
          onOpenBus={(bus) => openRoute({ screen: "mixer", select: bus })}
          onOpenPlaylist={(p) => openPlaylist(filePath(p))}
          captionKeys={captions?.keys}
          captionTable={captions?.path}
          onCreateCaptionKey={(key) => project && createCaptionKey(project, key, captionPlaceholder(key))}
        />
  );
  // Spec 4.2.7: the parameters' test values are an Inspector section too (the bottom Parameters tab stays for a wide view).
  const parameters = (
    <Section title="Parameters" open={allParameters.value.length > 0}>
      <TestValues />
    </Section>
  );
  return (
    <Panel bodyClass="pl-panel-body">
      <PlaylistHistoryScope doc={openDoc.value}>
      <div class="pl-doc" data-asset-document={doc.path} tabIndex={-1}>
        {body.type === "sequence" ? (
          <SequenceInspectorPanel body={body} writable={writable() && !doc.readOnly} lints={openLints.value} where={whereOf(t.indices)} title={lastCrumbName()} onEdit={(label, edit) => editOpen(label, edit)}>
            {inspector}
            {parameters}
          </SequenceInspectorPanel>
        ) : (
          <>
            {inspector}
            {parameters}
          </>
        )}
      </div>
      </PlaylistHistoryScope>
    </Panel>
  );
}

function VoicesPanel() {
  const host = audioHost();
  const state = host.state.value;
  return (
    <Panel bodyClass="pl-panel-body">
      <PlaylistHistoryScope doc={openDoc.value}>
      <VoicesView
        now={playingNow.value}
        log={voiceLog.value}
        cursor={logCursor.value}
        time={audioNow.value}
        blocked={state.kind === "failed" ? state.reason : state.kind === "idle" ? "The audio runtime isn't running." : undefined}
        onClear={clearLog}
        onSeek={(t) => (logCursor.value = t)}
      />
      </PlaylistHistoryScope>
    </Panel>
  );
}

/** The test values of the open playlist's parameters, inside the panel's gutter with token-styled fields (I3). */
function TestValues() {
  return (
    <div class="pl-test-values">
      <ParameterPanel parameters={allParameters.value} values={testValues.value} empty="No game parameters yet." onValue={(name, v) => setTestValue(name, v)} onNewParameter={writable() ? () => void newPlaylistParameter() : undefined} />
    </div>
  );
}

function ParametersPanel() {
  void openFile.value;
  return (
    <Panel bodyClass="pl-panel-body">
      <PlaylistHistoryScope doc={openDoc.value}>
      <TestValues />
      </PlaylistHistoryScope>
    </Panel>
  );
}

/** The screen's panels, in the prototype's places. */
export const PLAYLISTS_PANELS: readonly StudioPanel[] = [
  { id: "playlists-library", title: "Playlists", dock: "left", view: () => <TreePanel /> },
  { id: "playlists-samples", title: "Library", dock: "left", view: () => <LibraryPanel /> },
  // The New parameter dialog ("+ New parameter…" in this screen's parameter selects) renders into the body from here.
  { id: "playlists-editor", title: "Playlist", dock: "fill", fixed: true, view: () => <><EditorPanel /><NewGlobalParameterHost /></> },
  { id: "playlists-inspector", title: "Inspector", dock: "right", view: () => <InspectorPanel /> },
  { id: "playlists-voices", title: "Plays now", dock: "bottom", view: () => <VoicesPanel /> },
  { id: "playlists-parameters", title: "Parameters", dock: "bottom", view: () => <ParametersPanel /> },
  globalParametersPanel({ id: "playlists-global-parameters", dock: "right", onDemand: true, renamed: (from, to) => void (testValues.value = renameTestValue(testValues.peek(), from, to)) }),
  historyPanel("playlists"),
];
