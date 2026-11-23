// The Take screen's panels (ADR 0348 "The Take screen", ADR 0341 "The shell"; the prototype's Take): Takes and
// Playlists in this take (left), the Timeline (the fixed panel), the Inspector (right), the Mixer strip (bottom) and
// History (on demand: the notes' undo tree). The panels read the screen's store (`takeScreen.ts`) and the Studio's
// replay (`shell/replay.ts`); the Timeline panel also owns what the screen does while it shows: opening the take the
// route names, the keys (Space, Home, M, Delete, Escape) and the player bar's slots (the take, its transport and scrub).
import { effect } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { TakeNotes } from "../../../engine/audio/take/types";
import { emptyTakeNotes } from "../../../engine/audio/take/notes";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import { currentProject, docVersion } from "../../../editor/state";
import { Icon } from "../../components/Icon";
import { TransportButton } from "../../components/PlayerBar";
import { formatClock } from "../../components/replayControlsModel";
import { replayStore } from "../../shell/replay";
import type { StudioPanel } from "../../shell/studioPanels";
import { audioHost, keymap, openRoute, setPlayerSlots, studioRouter } from "../../shell/studioServices";
import { historyPanel } from "../placeholder";
import { addMarker, addRegion, deleteNote, editNote, moveNote, setRegionSpan } from "./notesEdits";
import { InstanceDetails, MixerStrip, NoteDetails, PlayheadValues } from "./TakeInspector";
import { busStrip, instanceParametersAt, parameterRows, type BusStrip } from "./takeInspectorModel";
import { isTakePath } from "./takeFiles";
import { PlaylistsInTake } from "./PlaylistsInTake";
import { TakeList } from "./TakeList";
import { openSource, openTake, takeFileKind, takeScreen } from "./takeScreen";
import { contentFolders } from "../../components/projectFolders";
import { runTreeFolders } from "../profiler/captureTree";
import { deleteFile, deleteFolder, duplicateFile, importInto, moveItems, newRunFolder, renameFile, renameFolder } from "../profiler/runFileActions";
import { durationsVersion, fileDuration } from "../profiler/runFileDurations";
import { findInstance, parameterText, playlistsInTake } from "./takeTimeline";
import { TakeTimelineView } from "./TakeTimelineView";
import "./take.css";

const notesOf = (): TakeNotes => takeScreen().notes.value?.value.value ?? emptyTakeNotes();

/** The open take's notes document scope: focus or a press inside makes it the active history (Undo, Redo, History). */
function DocScope(props: { children: ComponentChildren }) {
  return (
    <div class="tk-doc" data-asset-document={takeScreen().notes.value?.path}>
      {props.children}
    </div>
  );
}

function TakesPanel() {
  void docVersion.value; // the project's file list grows and shrinks with it
  void durationsVersion.value; // a take's duration arrived
  const project = currentProject.value;
  const files = project?.files ?? [];
  const folders = project?.folders ?? [];
  const k = takeFileKind;
  return (
    <Panel bodyClass="tk-panel-body">
      <TakeList
        files={files}
        // A new project's scenes/, scripts/ and the sample and playlist folders aren't take folders (UI pass T5).
        folders={runTreeFolders(folders, files, isTakePath)}
        moveFolders={contentFolders(folders, files, isTakePath)}
        rootName={project?.name}
        openPath={replayStore().open.value?.path ?? null}
        writable={!!project?.canSave && !!project.fileSystem}
        duration={(p) => fileDuration(project, p)}
        onFolder={(f) => (takeScreen().folder.value = f)}
        onOpen={openTake}
        onImport={(chosen, folder) => void importInto(k, chosen, folder)}
        onNewFolder={newRunFolder}
        onRename={(path, name) => void renameFile(k, path, name)}
        onRenameFolder={(folder, name) => void renameFolder(k, folder, name)}
        onMove={(items, folder) => void moveItems(k, items, folder)}
        onDuplicate={(path) => void duplicateFile(k, path)}
        onDelete={(path) => void deleteFile(k, path)}
        onDeleteFolder={(folder) => void deleteFolder(k, folder)}
      />
    </Panel>
  );
}

function PlaylistsPanel() {
  const timeline = takeScreen().timeline.value;
  return (
    <Panel bodyClass="tk-panel-body">
      <PlaylistsInTake rows={timeline ? playlistsInTake(timeline) : null} onOpen={openSource} />
    </Panel>
  );
}

// --- the timeline, the screen's keys and the player bar -----------------------------------------------------------------

function goToStart(): void {
  const open = replayStore().open.peek();
  if (open) open.replay.seek(open.replay.loop.peek()?.from ?? 0);
}

function addMarkerAt(t: number): void {
  const take = takeScreen().take.peek();
  if (take) takeScreen().commitNotes(addMarker(notesOf(), t, take.duration), { select: true });
}

function deleteSelectedNote(): boolean {
  const sel = takeScreen().selected.peek();
  if (sel?.kind !== "note") return false;
  if (takeScreen().commitNotes(deleteNote(notesOf(), sel.id))) takeScreen().selected.value = null;
  return true;
}

/** Loop the selected region, else the whole take; again to stop looping. */
function toggleLoop(): void {
  const open = replayStore().open.peek();
  if (!open) return;
  if (open.replay.loop.peek()) {
    open.replay.setLoop(null);
    return;
  }
  const sel = takeScreen().selected.peek();
  const region = sel?.kind === "note" ? notesOf().regions.find((r) => r.id === sel.id) : undefined;
  open.replay.setLoop(region ? { from: region.from, to: region.to } : { from: 0, to: open.take.duration });
}

function TakeTransport() {
  const open = replayStore().open.value;
  if (!open) return null;
  const r = open.replay;
  const playing = r.playing.value;
  const loop = r.loop.value;
  return (
    <>
      <TransportButton icon="skipBack" label="Go to start" title="Go to start (Home)" onClick={goToStart} />
      <TransportButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Replay"} title={playing ? "Pause (Space)" : "Replay the take against your current audio (Space)"} primary pressed={playing} onClick={() => r.toggle()} />
      <TransportButton icon="loop" label="Loop" pressed={!!loop} title={loop ? `Looping ${formatClock(loop.from)}–${formatClock(loop.to)}: click to stop` : "Loop the selected region, or the whole take"} onClick={toggleLoop} />
      <TransportButton icon="redo" label="Restart instances" title="Restart the playing instances so they use your latest edits" disabled={!playing} onClick={() => r.restartInstances()} />
    </>
  );
}

function TakeScrub() {
  const open = replayStore().open.value;
  if (!open) return null;
  const t = open.replay.time.value;
  return (
    <>
      <span>{formatClock(t)}</span>
      <input type="range" aria-label="Take position" aria-valuetext={`${formatClock(t)} of ${formatClock(open.take.duration)}`} min={0} max={Math.max(0.001, open.take.duration)} step={0.01} value={t} style={{ flex: 1 }} onInput={(e) => open.replay.seek(Number((e.currentTarget as HTMLInputElement).value))} />
      <span>{formatClock(open.take.duration)}</span>
    </>
  );
}

/** What the screen does while it shows: the route's take, the keys and the player bar. */
function useScreen(): void {
  useEffect(() => {
    const store = takeScreen();
    const replay = replayStore();
    const scope = { screen: "take" as const };
    let slotsKey = "";
    const keys: [string, string[], string, () => boolean | void][] = [
      ["play", ["Space"], "Replay or pause the take", () => (replay.open.peek() ? replay.toggle() : false)],
      ["start", ["Home"], "Go to the start (of the loop)", () => (replay.open.peek() ? goToStart() : false)],
      ["marker", ["M"], "Add a note marker at the playhead", () => (replay.open.peek() ? addMarkerAt(replay.time.peek()) : false)],
      ["delete", ["Delete", "Backspace"], "Delete the selected note", deleteSelectedNote],
      ["deselect", ["Escape"], "Clear the selection", () => (store.selected.peek() ? ((store.selected.value = null), true) : false)],
    ];
    const stops = [
      ...keys.map(([id, combos, label, run]) => keymap.register({ id: `take.${id}`, keys: combos, label, scope, run })),
      // The route names the take to open (a click in Takes, a hand-off, a reload).
      effect(() => {
        void docVersion.value;
        const asset = studioRouter().route.value.asset;
        if (asset && isTakePath(asset) && currentProject.value?.files.includes(asset)) void store.openPath(asset);
      }),
      effect(() => {
        const open = replay.open.value;
        const note = open?.replay.note.value;
        const playing = open?.replay.playing.value;
        // The transport and scrub follow the replay themselves; the slots change only when their words do.
        // The status bar shows the playhead itself (`playhead`), so the slots don't change as the time does.
        const key = `${open?.path}|${open?.title}|${note}|${playing}`;
        if (key === slotsKey) return;
        slotsKey = key;
        setPlayerSlots("take", {
          nowPlaying: open ? { art: "TAKE", title: open.title, subtitle: `Recorded take · ${open.take.duration.toFixed(1)} s` } : null,
          transport: <TakeTransport />,
          scrub: open ? <TakeScrub /> : undefined,
          status: note ?? (open ? (playing ? "Replaying the take" : "Replay, or edit and hear it against the take") : undefined),
          playhead: open ? replay.time : null,
          replay: null,
        });
      }),
    ];
    return () => {
      for (const stop of stops) stop();
      setPlayerSlots("take", null);
    };
  }, []);
}

function TimelinePanel() {
  useScreen();
  const store = takeScreen();
  const s = store.state.value;
  const open = replayStore().open.value;
  const timeline = store.timeline.value;
  const doc = store.notes.value;
  const sel = store.selected.value;
  const instance = sel?.kind === "instance" && timeline ? findInstance(timeline, sel.key) : null;
  const writable = !!doc && !doc.readOnly;
  const toolbar = open ? (
    <div class="tk-toolbar">
      {instance ? (
        <>
          <strong class="tk-toolbar-title" title={instance.path}>{instance.path}</strong>
          <button type="button" class="tk-tool" onClick={() => open.replay.seek(instance.start)}>
            <Icon name="skipBack" size={14} /> Go to start
          </button>
          <button type="button" class="tk-link" onClick={() => openSource(instance.path)}>Open playlist ›</button>
        </>
      ) : (
        <strong class="tk-toolbar-title">{open.title}</strong>
      )}
      <span class="tk-toolbar-gap" />
      <button type="button" class="tk-tool" disabled={!writable} aria-label="Add marker" title="Add a note marker at the playhead (M)" onClick={() => addMarkerAt(open.replay.time.peek())}>
        <Icon name="plus" size={14} /> Marker
      </button>
      <button type="button" class="tk-tool" disabled={!writable} aria-label="Add region" title="Add a note region from the playhead" onClick={() => store.commitNotes(addRegion(notesOf(), open.replay.time.peek(), open.replay.time.peek(), open.take.duration), { select: true })}>
        <Icon name="plus" size={14} /> Region
      </button>
      <button type="button" class="tk-tool" title="Record the Studio's runtime in the Profiler while this take replays" onClick={() => store.profileReplay()}>
        <Icon name="profiler" size={14} /> Profile this replay
      </button>
    </div>
  ) : undefined;
  let body;
  if (s.kind === "opening") body = <p class="tk-note" role="status">Opening {s.path}…</p>;
  else if (s.kind === "failed") body = <p class="tk-error" role="alert">Can't open {s.path}: {s.message}</p>;
  else if (!open || !timeline)
    body = <EmptyState title="Take" icon={<Icon name="take" size={28} />} body={<p>Recordings of what a game asked of audio, replayed against your current audio so edits are heard in context, and annotated. Open a take from the Takes panel.</p>} />;
  else
    body = (
      <>
        {open.replay.note.value && <p class="tk-hint" role="status">{open.replay.note.value}</p>}
        <TakeTimelineView
          timeline={timeline}
          time={open.replay.time.value}
          playing={open.replay.playing.value}
          selected={sel}
          notes={notesOf()}
          notesWritable={writable}
          onSeek={(t) => open.replay.seek(t)}
          onSelectInstance={(key) => (store.selected.value = { kind: "instance", key })}
          onOpenInstance={(key) => {
            const i = findInstance(timeline, key);
            if (i) openSource(i.path);
          }}
          onSelectNote={(id) => (store.selected.value = { kind: "note", id })}
          onMoveNote={(id, at, done) => store.commitNotes(moveNote(notesOf(), id, at, timeline.duration), { coalesce: !done })}
          onAddMarker={addMarkerAt}
        />
      </>
    );
  return (
    <Panel toolbar={toolbar} bodyClass="tk-panel-body tk-timeline-body">
      {body}
    </Panel>
  );
}

function InspectorPanel() {
  const store = takeScreen();
  const open = replayStore().open.value;
  const timeline = store.timeline.value;
  const sel = store.selected.value;
  const t = open?.replay.time.value ?? 0;
  void open?.replay.instances.value; // the live instances change as the take replays
  let body;
  if (open && timeline && sel?.kind === "instance") {
    const i = findInstance(timeline, sel.key);
    if (i) {
      const live = open.replay.instance(i.instance);
      const sounding = !!live && Math.abs(live.started - i.start) < 1e-6 && !!live.handle?.playing;
      const handle = sounding ? live!.handle : null;
      const rows = parameterRows(instanceParametersAt(open.take, i, t), handle?.getParameter ? (n) => handle.getParameter!(n) : null);
      body = (
        <InstanceDetails
          instance={i}
          emitterName={i.emitter === null ? null : (open.take.meta.emitters[i.emitter] ?? null)}
          emitterPose={i.emitter === null ? null : open.replay.poseAt(i.emitter, t)}
          rows={rows}
          live={sounding}
          onGoToStart={() => open.replay.seek(i.start)}
          onOpenSource={() => openSource(i.path)}
        />
      );
    }
  } else if (open && sel?.kind === "note") {
    const notes = notesOf();
    const marker = notes.markers.find((m) => m.id === sel.id);
    const region = notes.regions.find((r) => r.id === sel.id);
    const doc = store.notes.value;
    const d = open.take.duration;
    if (marker || region)
      body = (
        <NoteDetails
          note={marker ? { kind: "marker", ...marker } : { kind: "region", ...region! }}
          writable={!!doc && !doc.readOnly}
          onText={(text) => store.commitNotes(editNote(notesOf(), sel.id, { text }))}
          onColour={(color) => store.commitNotes(editNote(notesOf(), sel.id, { color }))}
          onTime={(at) => store.commitNotes(moveNote(notesOf(), sel.id, at, d))}
          onSpan={(from, to) => store.commitNotes(setRegionSpan(notesOf(), sel.id, from, to, d))}
          onDelete={deleteSelectedNote}
          onGoTo={() => open.replay.seek(marker ? marker.at : region!.from)}
        />
      );
  }
  body ??= <PlayheadValues open={!!timeline} time={t} picture={open?.take.frameAt(t) ?? open?.take.frames[0] ?? null} values={(timeline?.parameters ?? []).filter((p) => p.path === null).map((p) => ({ name: p.name, text: parameterText(p, t) }))} />;
  return <Panel bodyClass="tk-panel-body">{body}</Panel>;
}

/** Bus readings at 10 Hz while the panel shows and the runtime is up. */
function useBusStrips(): { running: boolean; strips: BusStrip[] } {
  const host = audioHost();
  const running = host.playable.value;
  const [strips, setStrips] = useState<BusStrip[]>([]);
  useEffect(() => {
    if (!running) return;
    const read = () => {
      const a = host.audio;
      setStrips(
        a.buses
          .map((name) => a.bus(name))
          .filter((b) => b.exists)
          .map((b) => busStrip({ name: b.name, authored: b.authoredVolume, runtime: b.volume, duck: b.duckGain, peak: b.peak })),
      );
    };
    read();
    const timer = setInterval(read, 100);
    return () => clearInterval(timer);
  }, [running]);
  return { running, strips: running ? strips : [] };
}

function MixerPanel() {
  const { running, strips } = useBusStrips();
  return (
    <Panel bodyClass="tk-panel-body">
      <MixerStrip running={running} strips={strips} onOpenMixer={() => openRoute({ screen: "mixer" })} />
    </Panel>
  );
}

const inDoc = (body: () => ComponentChildren) => () => <DocScope>{body()}</DocScope>;

/** The screen's panels, in the prototype's places. */
export const TAKE_PANELS: readonly StudioPanel[] = [
  { id: "take-list", title: "Takes", dock: "left", view: () => <TakesPanel /> },
  // "In this take": short enough that both tabs of the left dock show at its default width (the full name is too long).
  { id: "take-playlists", title: "In this take", dock: "left", view: () => <PlaylistsPanel /> },
  { id: "take-timeline", title: "Timeline", dock: "fill", fixed: true, view: inDoc(() => <TimelinePanel />) },
  { id: "take-inspector", title: "Inspector", dock: "right", view: inDoc(() => <InspectorPanel />) },
  { id: "take-mixer", title: "Mixer", dock: "bottom", view: () => <MixerPanel /> },
  historyPanel("take"),
];
