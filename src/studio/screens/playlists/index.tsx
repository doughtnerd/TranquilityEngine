// The Playlists screen's panels (ADR 0343, 0341 "The shell", 0349; the prototype's layout): Playlists (the tree) and
// Library on the left, the Playlist panel in the middle (fixed), the Inspector on the right over Plays now and Voices,
// Parameters (a wide view; they're in the Inspector too), History and Global parameters (the Mixer's panel over
// `audio.json`) on demand. The panels read the screen's state (`playlistsScreen.ts`) and call its actions; the Playlist
// panel also owns what the screen does while it shows: following the route, the Space key and the player bar's slots
// (Trigger / Release, Pause / Resume, Stop, previous and next voice event, the voice log's scrub).
import { audioProject } from "../../shell/audioProject";
import { effect, signal } from "@preact/signals";
import { openCurveEditorDialog } from "../../../editor/ui/curves/openCurveEditorDialog";
import { ContextMenu, SEPARATOR } from "../../../editor/ui/ContextMenu";
import { effectSpec } from "../../../engine/audio/effects/catalogue";
import type { PlaylistBody } from "../../../engine/audio/playlist/types";
import { timeFormat } from "../samples/samplesState";
import { projectPeaks, projectSources } from "./sequence/sequenceSources";
import { copiedCurves, pasteRefusal } from "./curveClipboard";
import { applyEffectAutomationResult, bypassLanes, clearLanes, effectAutomationDialog, lanesOf, pasteLanes } from "./effectAutomation";
import { entryLevels, pathTo, previewCards, typeSummary, usedParameters, voiceCards } from "./liveModel";
import { liveWeights } from "./blendViewModel";
import { changeText } from "./ModeToolbar";
import { replaceLinks } from "./structureEdits";
import { useEffect } from "preact/hooks";
import { deleteAssets } from "../../../editor/assetDelete";
import { docVersion, status } from "../../../editor/state";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Icon } from "../../components/Icon";
import { Panel } from "../../../editor/ui/panel/Panel";
import { Section } from "../../../editor/ui/PanelFields";
import type { Entry } from "../../../engine/audio/playlist/types";
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
import { addEntries, duplicateEntry, removeEntry, setAutomation, setEntryUse, sampleEntry } from "./playlistEdits";
import { breadcrumb, childPath, editAt, effectiveOutput, entryName, filePath, pathTarget, playlistTitle, sampleTitle, whereOf, type PlaylistPath } from "./playlistPaths";
import {
  adding, allParameters, askDelete, busPaths, askDeleteFolder, deleteFolderKeepingContents, deletingFolder, audioNow, auditioning, busNames, confirmDelete, deleting, docFor, duplicatePlaylistFiles, editContext, editFile, editOpen, followRoute,
  linkedBy, loadPlaylist, logCursor, triggerMark, makeShared, moveToFolder, newPlaylist, newPlaylistFolder, newPlaylistFromSamples, newSequence, openBody, openDoc, openFile, openLints, openPath, openPlaylist,
  playingNow, releaseAudition, renameFolder, renamePlaylistFile, removeLinkEntry, runDrop, selectedEntry, setTestValue, stopAudition, target, testValues, trigger, triggerOffReason, unlink, voiceLog, clearLog,
  frozen, lastChange, pauseAudition, renamingOpen, resumeAudition,
} from "./playlistsScreen";
import { newPlaylistParameter } from "./newParameter";
import { contentFolders } from "../../components/projectFolders";
import { isPlaylistPath } from "../../../engine/audio/playlist/format";
import { NewGlobalParameterHost } from "../mixer/newGlobalParameter";
import { PlaylistTreeView, renameFolderRow, type TreeActions } from "./PlaylistTreeView";
import { entryKey, factsOf, fileKey, playlistTree, type PlaylistNode } from "./playlistTree";
import { dropLabel, planDrop } from "./treeDrop";
import { canRelease } from "./voiceLog";
import { playlistPlayerSlots } from "./playlistPlayer";
import { playlistBadge } from "../../components/typeBadgeModel";
import { PlaysNowView, VoicesLogView } from "./VoicesView";
import { isGeneratorPath } from "../../../engine/audio/generators/format";
import { GeneratorLibraryPanel, GeneratorPanel } from "./generator/GeneratorPanel";
import { addGeneratorToOpen, followGeneratorRoute, generatorSpace, generatorTarget, loadGenerator } from "./generator/generatorScreen";
import { SequenceInspectorPanel, SequenceParametersPanel } from "./sequence/SequencePanel";
import { sequenceSpace, stopSequence } from "./sequence/sequenceState";
import { sequencePlayerSlots } from "./sequence/SequenceTransport";
import "./playlists.css";

const writable = () => !!audioProject.value?.canSave;

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
  newFolder: (parent) => newPlaylistFolder(parent),
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
  const project = audioProject.value;
  const files = project?.files ?? [];
  // A new project's scenes/ and scripts/ aren't playlist folders (T5).
  const folders = contentFolders(project?.folders ?? [], files, isPlaylistPath);
  const nodes = playlistTree(files, folders, loadPlaylist);
  const open = openBody.value;
  const nestInto = open && open.type !== "clip" && open.type !== "sequence" ? lastCrumbName() : null;
  return (
    <Panel bodyClass="pl-panel-body">
      <PlaylistHistoryScope doc={openDoc.value}>
      <PlaylistTreeView nodes={nodes} folders={folders} openKey={openKey()} writable={writable()} hasSamples={files.some(isSamplePath)} nestInto={nestInto} actions={treeActions} />
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
  const files = audioProject.value?.files ?? [];
  const sources = projectSources();
  const body = openBody.value;
  const addTo = body && body.type !== "sequence" ? lastCrumbName() : null;
  return (
    <Panel bodyClass="pl-panel-body">
      <PlaylistHistoryScope doc={openDoc.value}>
      <LibraryList files={files} addTo={addTo} previewing={previewing.value?.path ?? null} onPreview={preview} onAdd={addSample} onOpenSamples={(sample) => openRoute({ screen: "samples", ...(sample ? { asset: sample } : {}) })}
        onCreatePlaylist={(paths) => void newPlaylistFromSamples(paths)} writable={writable()} extra={(query) => <GeneratorLibraryPanel query={query} />}
        playlists={files.filter((f) => { const b = isPlaylistPath(f) ? loadPlaylist(f) : null; return !!b && b.type !== "sequence" && b.type !== "clip"; })}
        onAddTo={(playlist, sample) => editFile(playlist, `Add ${sampleTitle(sample)}`, (r) => editAt(r, [], (b) => addEntries(b, [sampleEntry(b, sample)], editContext.peek())))}
        factsOf={(path) => { const f = sources({ sample: path } as never); return { peaks: projectPeaks(path), length: f?.length ?? null, loops: (f?.loops.length ?? 0) > 0 }; }} />
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

/** The body whose effects an Automate button edits: the open playlist's (entry null) or its embedded clip entry's. */
const automationOwner = (b: PlaylistBody, entry: number | null): PlaylistBody | null => {
  if (entry === null) return b;
  const e = b.entries[entry];
  return e?.kind === "embedded" ? e.embedded : null;
};
const editOwner = (entry: number | null, label: string, edit: (x: PlaylistBody) => ReturnType<typeof setAutomation>) => editOpen(label, (b) => (entry === null ? edit(b) : editAt(b, [entry], edit)));

/** An effect's Automate button (W11.3): its parameters and On in the curve editor, over voice time or a parameter. */
function automateEffect(effectId: string, entry: number | null): void {
  const b = openBody.peek();
  const owner = b ? automationOwner(b, entry) : null;
  const effect = owner?.effects.find((f) => f.id === effectId);
  if (!owner || !effect) return;
  const dialog = effectAutomationDialog(effect, owner.automation, allParameters.peek(), testValues.peek());
  openCurveEditorDialog(document, {
    ...dialog.spec,
    title: "Effect automation",
    target: effectSpec(effect.type).label,
    context: lastCrumbName(),
    onCancel: () => {},
    onApply(result) {
      const r = applyEffectAutomationResult(dialog, owner.automation, result);
      if (r) editOwner(entry, r.label, (x) => setAutomation(x, r.automation));
    },
  });
}

/** The Automate button's curve menu: Edit curves…, Copy, Paste, Turn automation off/on, Clear all automation. */
const automateMenu = signal<{ effectId: string; entry: number | null; at: { x: number; y: number } } | null>(null);

function AutomateMenu() {
  const m = automateMenu.value;
  const b = openBody.value;
  const owner = m && b ? automationOwner(b, m.entry) : null;
  const effect = owner?.effects.find((f) => f.id === m!.effectId);
  if (!m || !owner || !effect) return null;
  const label = effectSpec(effect.type).label;
  const lanes = lanesOf(owner.automation, effect.id);
  const off = lanes.length > 0 && lanes.every((a) => a.bypass);
  const refusal = pasteRefusal("effect");
  const w = writable();
  return (
    <ContextMenu at={m.at} label={`${label} automation`} onClose={() => (automateMenu.value = null)} entries={[
      { kind: "group", label: `${label} automation` },
      { id: "edit", label: "Edit curves…", hint: "Click", run: () => automateEffect(effect.id, m.entry) },
      SEPARATOR,
      { id: "copy", label: "Copy curves", disabled: lanes.length === 0, title: lanes.length ? undefined : "No automation to copy", run: () => (copiedCurves.value = { kind: "effect", from: label, curves: { lanes } }) },
      { id: "paste", label: copiedCurves.value && !refusal ? `Paste curves from ${copiedCurves.value.from}` : "Paste curves", disabled: !w || refusal !== null, title: refusal ?? undefined,
        run: () => {
          const next = pasteLanes(owner.automation, (copiedCurves.peek()!.curves as { lanes: PlaylistBody["automation"] }).lanes, effect);
          if (next) editOwner(m.entry, `Paste curves · ${label}`, (x) => setAutomation(x, next));
          else status.value = { kind: "info", text: `The copied curves don't fit ${label}'s parameters.` };
        } },
      { id: "off", label: off ? "Turn automation on" : "Turn automation off", disabled: !w || lanes.length === 0, title: lanes.length ? "Keeps the curves; the effect uses its set values" : "No automation yet", run: () => editOwner(m.entry, `${off ? "Automation on" : "Automation off"} · ${label}`, (x) => setAutomation(x, bypassLanes(x.automation, effect.id, !off))) },
      { id: "clear", label: "Clear all automation", danger: true, disabled: !w || lanes.length === 0, run: () => editOwner(m.entry, `Clear automation · ${label}`, (x) => setAutomation(x, clearLanes(x.automation, effect.id))) },
    ]} />
  );
}

const factsOfEntry = (e: Entry) => {
  if (e.kind !== "linked") return null;
  const b = loadPlaylist(e.playlist);
  return b ? factsOf(b) : null;
};
const bodyOfEntry = (e: Entry): PlaylistBody | null => (e.kind === "embedded" ? e.embedded : e.kind === "linked" ? loadPlaylist(e.playlist) : null);

/** A sample's length in seconds (its playable part), null until its peaks are read. Tracks the project. */
function sampleLength(): (sample: string) => number | null {
  const of = projectSources();
  return (sample) => of({ sample } as never)?.length ?? null;
}

/** The Inspector's Playback section is open (Voices' "Rule ›" opens it). */
const playbackOpen = signal(false);

/** The views read the frozen copies while paused (W14.2). */
const shownLog = () => frozen.value?.log ?? voiceLog.value;
const shownNow = () => frozen.value?.now ?? playingNow.value;
const shownTime = () => frozen.value?.time ?? audioNow.value;

/** Seconds since the current trigger's first voice, null with none playing. */
function voiceTime(): number | null {
  const log = shownLog();
  const live = log.filter((r) => r.kind === "voice");
  if (!auditioning.value || live.length === 0) return null;
  return Math.max(0, shownTime() - Math.min(...live.map((r) => r.start)));
}

/** The next trigger's resolution in a few words (the player bar's status at rest). */
function nextText(): string {
  const b = openBody.value;
  if (!b) return "";
  const cards = previewCards(lastCrumbName(), b, allParameters.value, testValues.value, loadPlaylist);
  return cards.length === 0 ? "nothing plays with these values" : cards.map((c) => c.name).join(" + ");
}

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
          if (auditioning.peek() && !frozen.peek()) {
            if (canRelease(openBody.peek()!, loadPlaylist)) releaseAudition();
            else stopAudition();
          } else trigger();
        },
      }),
      keymap.register({ id: "playlists.stop", keys: ["Shift+Space"], label: "Stop the audition", scope: { screen: "playlists" }, run: () => (openBody.peek()?.type === "sequence" ? stopSequence() : stopAudition()) }),
      effect(() => {
        const body = openBody.value;
        const path = openPath.value;
        const log = shownLog();
        const cursor = logCursor.value;
        const busy = auditioning.value;
        const now = shownTime();
        const paused = !!frozen.value;
        if (!body || !path) return setPlayerSlots("playlists", null);
        const t = pathTarget(path);
        if (body.type === "sequence") return setPlayerSlots("playlists", sequencePlayerSlots(lastCrumbName(), `Sequence · ${t.file}`));
        setPlayerSlots("playlists", playlistPlayerSlots(
          { title: lastCrumbName(), art: playlistBadge(body.type, factsOf(body).axes).code, subtitle: typeSummary(body), busy, paused, release: canRelease(body, loadPlaylist), triggerOff: triggerOffReason(), next: nextText(), log, mark: triggerMark.value, cursor, now },
          { trigger, stop: stopAudition, release: releaseAudition, pause: pauseAudition, resume: resumeAudition, seek: (at) => (logCursor.value = at) },
        ));
      }),
    ];
    return () => {
      for (const stop of stops) stop();
      setPlayerSlots("playlists", null);
    };
  }, []);
}

/** The centre with nothing open: the spec's card (New playlist / New sequence / New folder), and the no-samples line. */
function NothingOpen() {
  const project = audioProject.value;
  const files = project?.files ?? [];
  const none = !files.some(isPlaylistPath);
  const w = writable();
  return (
    <EmptyState
      title={none ? "No playlists yet" : "No playlist open"}
      icon={<Icon name="playlists" size={28} />}
      body={
        <>
          <p>{none ? "A playlist decides which sample plays: pick at random, step through in order, layer, blend by a game parameter, or switch by a label. For a timeline of samples and playlists, make a sequence." : "Pick a playlist in the Playlists panel, or make one."}</p>
          {!files.some(isSamplePath) && (
            <p>
              This project has no samples yet. <button type="button" class="pl-link" onClick={() => openRoute({ screen: "samples" })}>Import some in Samples</button> first, or make an empty playlist now and fill it later.
            </p>
          )}
        </>
      }
      action={{ label: "New playlist", disabled: !w, run: () => void newPlaylist("", false) }}
    >
      <button type="button" class="pl-small" disabled={!w} onClick={() => void newSequence("")}>New sequence</button>
      <button type="button" class="pl-small" disabled={!w} onClick={() => void newPlaylistFolder("").then((path) => path && renameFolderRow(path))}>New folder</button>
    </EmptyState>
  );
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
        <NothingOpen />
      </Panel>
    );
  }
  const crumbs = breadcrumb(path, loadPlaylist);
  const files = audioProject.value?.files ?? [];
  const title = crumbs[crumbs.length - 1]?.name ?? "";
  const linkedIn = t.indices.length ? [] : (linkedBy.value.get(t.file) ?? []);
  const levels = body.type === "blend" ? liveWeights(body, ctx.parameters, testValues.value, voiceTime() ?? 0) : entryLevels(body, shownNow(), loadPlaylist);
  const change = lastChange.value;
  const clipSample = body.type === "clip" && body.entries[0]?.kind === "sample" ? body.entries[0].sample : null;
  const facts = clipSample ? projectSources()({ sample: clipSample } as never) : null;
  return (
    <Panel bodyClass="pl-panel-body">
      <PlaylistHistoryScope doc={openDoc.value}>
      <div class="pl-doc" data-asset-document={doc.path} tabIndex={-1}>
        <PlaylistEditor
          body={body}
          crumbs={crumbs}
          title={title}
          renamable={t.indices.length === 0}
          renaming={renamingOpen.value}
          onRenaming={(on) => (renamingOpen.value = on)}
          linkedIn={linkedIn.map(playlistTitle)}
          usedIn={linkedIn.map(playlistTitle)}
          writable={writable() && !doc.readOnly}
          ctx={ctx}
          lints={openLints.value}
          where={whereOf(t.indices)}
          selected={selectedEntry.value}
          values={testValues.value}
          playlists={files.filter((f) => f.toLowerCase().endsWith(".playlist.json") && f !== t.file)}
          facts={factsOfEntry}
          bodyOf={bodyOfEntry}
          lengthOf={sampleLength()}
          levels={levels}
          fired={change && auditioning.value ? change.rule : null}
          clipSource={clipSample ? { peaks: projectPeaks(clipSample), start: facts?.start ?? 0, length: facts?.length ?? null, loops: facts?.loops ?? [] } : null}
          timeFormat={timeFormat.value}
          onTimeFormat={(f) => (timeFormat.value = f)}
          embedded={t.indices.length > 0}
          onMakeSharedOpen={() => void makeShared(t.file, t.indices.slice(0, -1), t.indices[t.indices.length - 1]!)}
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
      <AutomateMenu />
      </PlaylistHistoryScope>
    </Panel>
  );
}

/** Unlink the open playlist in `file`: every link to it there becomes a copy of its own (one undo step of that file). */
function unlinkIn(file: string): void {
  const t = target.peek();
  const body = openBody.peek();
  if (!t || !body || t.indices.length) return;
  editFile(file, `Unlink ${playlistTitle(t.file)} in ${playlistTitle(file)}`, (r) => ({ next: replaceLinks(r, t.file, "unlink", body) }));
}

function InspectorPanel() {
  void docVersion.value;
  const path = openPath.value;
  const body = openBody.value;
  const t = target.value;
  const doc = openDoc.value;
  const project = audioProject.value;
  if (!path || !body || !t || !doc) {
    return (
      <Panel bodyClass="pl-panel-body">
        <EmptyState compact title="Select a playlist to edit it here." body="The open playlist's playback rules, output, effects and spatial settings, and the selected entry's." />
      </Panel>
    );
  }
  const usedBy = t.indices.length ? [t.file] : (linkedBy.value.get(t.file) ?? []);
  const captions = project ? captionTable(project) : null; // ADR 0357 §6: the Caption field's keys
  const name = lastCrumbName();
  const inspector = (
        <PlaylistInspector
          body={body}
          name={name}
          selected={selectedEntry.value}
          writable={writable() && !doc.readOnly}
          ctx={editContext.value}
          buses={busNames.value}
          busPath={(b) => busPaths.value.get(b) ?? b}
          output={effectiveOutput(path, loadPlaylist)}
          presets={(project?.files ?? []).filter((f) => f.toLowerCase().endsWith(".attenuation.json"))}
          usedBy={usedBy}
          linkedIn={t.indices.length ? [] : (linkedBy.value.get(t.file) ?? [])}
          cards={voiceCards(name, body, allParameters.value, testValues.value, voiceTime())}
          parameters={body.type === "sequence" ? undefined : <TestValues />}
          values={testValues.value}
          bodyOf={bodyOfEntry}
          lengthOf={sampleLength()}
          onEdit={(label, edit, drag) => editOpen(label, edit, drag)}
          onEditCurves={editCurves}
          onOpenBus={(bus) => openRoute({ screen: "mixer", select: bus })}
          onOpenPlaylist={(p) => openPlaylist(filePath(p))}
          onOpenEntry={(i) => {
            const next = childPath(path, body, i);
            if (next) openPlaylist(next);
          }}
          onAutomate={automateEffect}
          onAutomateMenu={(effectId, entry, at) => (automateMenu.value = { effectId, entry, at })}
          onUnlinkIn={unlinkIn}
          playbackOpen={playbackOpen.value}
          onPlaybackOpen={(on) => (playbackOpen.value = on)}
          captionKeys={captions?.keys}
          captionTable={captions?.path}
          onCreateCaptionKey={(key) => project && createCaptionKey(project, key, captionPlaceholder(key))}
        />
  );
  return (
    <Panel bodyClass="pl-panel-body">
      <PlaylistHistoryScope doc={openDoc.value}>
      <div class="pl-doc" data-asset-document={doc.path} tabIndex={-1}>
        {body.type === "sequence" ? (
          <SequenceInspectorPanel body={body} writable={writable() && !doc.readOnly} lints={openLints.value} where={whereOf(t.indices)} title={lastCrumbName()} onEdit={(label, edit) => editOpen(label, edit)}>
            {inspector}
            <Section title="Parameters" open={allParameters.value.length > 0}>
              <TestValues />
            </Section>
          </SequenceInspectorPanel>
        ) : (
          inspector
        )}
      </div>
      <AutomateMenu />
      </PlaylistHistoryScope>
    </Panel>
  );
}

function PlaysNowPanel() {
  void docVersion.value;
  const host = audioHost();
  const state = host.state.value;
  const body = openBody.value;
  const name = lastCrumbName();
  const change = lastChange.value;
  const nowVoices = shownNow().map((v) => ({ ...v, path: body ? pathTo(name, body, v.clip, loadPlaylist) : [] }));
  return (
    <Panel bodyClass="pl-panel-body">
      <PlaylistHistoryScope doc={openDoc.value}>
      <PlaysNowView
        now={nowVoices}
        preview={body ? previewCards(name, body, allParameters.value, testValues.value, loadPlaylist) : []}
        empty={!body ? "Make a playlist, then press Trigger" : body.type !== "sequence" && body.entries.length === 0 ? "Add entries, then press Trigger" : undefined}
        transition={change && auditioning.value ? { playlist: change.playlist, from: change.from, to: change.to, how: changeText(change.change) } : null}
        paused={!!frozen.value}
        blocked={state.kind === "failed" ? state.reason : state.kind === "idle" ? "The audio runtime isn't running." : undefined}
      />
      </PlaylistHistoryScope>
    </Panel>
  );
}

function VoicesLogPanel() {
  void docVersion.value;
  const body = openBody.value;
  const name = lastCrumbName();
  const lengthOf = sampleLength();
  return (
    <Panel bodyClass="pl-panel-body">
      <PlaylistHistoryScope doc={openDoc.value}>
      <VoicesLogView
        log={shownLog()}
        cursor={logCursor.value}
        time={shownTime()}
        lengthOf={lengthOf}
        pathOf={(clip) => (body ? pathTo(name, body, clip, loadPlaylist) : [])}
        onClear={clearLog}
        onSeek={(t) => (logCursor.value = t)}
        onRule={() => (playbackOpen.value = true) /* Rule ›: Playback opens in the Inspector, where the refusing rule is */}
      />
      </PlaylistHistoryScope>
    </Panel>
  );
}

/** The test values of the parameters the open playlist uses (all of them when it uses none), inside the panel's gutter (I3). */
function TestValues() {
  // A sequence lists only the parameters it uses, with use chips and Held (spec §4.2.9).
  const body = openBody.value;
  if (body?.type === "sequence" && body.sequence) return <div class="pl-test-values"><SequenceParametersPanel body={body} writable={writable()} /></div>;
  const used = body ? usedParameters(body, loadPlaylist) : new Set<string>();
  const shown = allParameters.value.filter((p) => used.has(p.name));
  return (
    <div class="pl-test-values">
      <ParameterPanel parameters={shown.length ? shown : allParameters.value} values={testValues.value} empty="No game parameters yet." onValue={(name, v) => setTestValue(name, v)} onNewParameter={writable() ? () => void newPlaylistParameter() : undefined} />
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

/** The screen's panels, in the prototype's places (the right column: Inspector over Plays now | Voices). */
export const PLAYLISTS_PANELS: readonly StudioPanel[] = [
  { id: "playlists-library", title: "Playlists", dock: "left", view: () => <TreePanel /> },
  { id: "playlists-samples", title: "Library", dock: "left", view: () => <LibraryPanel /> },
  // The New parameter dialog ("+ New parameter…" in this screen's parameter selects) renders into the body from here.
  { id: "playlists-editor", title: "Playlist", dock: "fill", fixed: true, view: () => <><EditorPanel /><NewGlobalParameterHost /></> },
  { id: "playlists-inspector", title: "Inspector", dock: "right", view: () => <InspectorPanel /> },
  { id: "playlists-voices", title: "Plays now", dock: "right", view: () => <PlaysNowPanel /> },
  { id: "playlists-voice-log", title: "Voices", dock: "right", view: () => <VoicesLogPanel /> },
  // Parameters live in the Inspector (spec 4.2.7); a wide view of them is on demand.
  { id: "playlists-parameters", title: "Parameters", dock: "bottom", onDemand: true, view: () => <ParametersPanel /> },
  globalParametersPanel({ id: "playlists-global-parameters", dock: "right", onDemand: true, renamed: (from, to) => void (testValues.value = renameTestValue(testValues.peek(), from, to)) }),
  historyPanel("playlists"),
];
