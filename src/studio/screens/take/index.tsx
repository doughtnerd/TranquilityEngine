// The Take screen's panels (ADR 0348 "The Take screen", ADR 0341 "The shell"; the prototype's Take): Takes and
// Playlists in this take (left), the Timeline (the fixed panel), the Inspector (right), the Mixer strip (bottom) and
// History (on demand: the notes' undo tree). The panels read the screen's store (`takeScreen.ts`) and the Studio's
// replay (`shell/replay.ts`); the Timeline panel also owns what the screen does while it shows: opening the take the
// route names, the keys (Space, Home, M, Delete, Escape) and the player bar's slots (the take, its transport and scrub).
import { effect } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { TakeNotes } from "../../../engine/audio/take/types";
import { emptyTakeNotes } from "../../../engine/audio/take/notes";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import { currentProject, docVersion } from "../../../editor/state";
import { Icon } from "../../components/Icon";
import { HeatmapToggle, heatmapOn } from "../../components/heatmapToggle";
import { TransportButton } from "../../components/PlayerBar";
import { formatClock } from "../../components/replayControlsModel";
import { replayStore } from "../../shell/replay";
import type { StudioPanel } from "../../shell/studioPanels";
import { audioHost, keymap, openRoute, setPlayerSlots, studioRouter } from "../../shell/studioServices";
import { historyPanel } from "../placeholder";
import { addMarker, addRegion, deleteNote, editNote, moveNote, setRegionSpan } from "./notesEdits";
import { InstanceDetails, MixerStrip, NoteDetails, PlayheadValues } from "./TakeInspector";
import { instanceParametersAt, mixerStripRows, parameterRows, playheadSummary, type BusGains, type StripSource } from "./takeInspectorModel";
import { isTakePath, takeEmptyCopy, takeFiles } from "./takeFiles";
import { PlaylistsInTake } from "./PlaylistsInTake";
import { TakeList } from "./TakeList";
import { globalParameters, openSource, openTake, takeFileKind, takePlaylist, takeScreen } from "./takeScreen";
import { runMoveFolders, runTreeFolders } from "../profiler/captureTree";
import { deleteFile, deleteFolder, duplicateFile, importInto, moveItems, newRunFolder, renameFile, renameFolder } from "../profiler/runFileActions";
import { durationsVersion, fileDuration } from "../profiler/runFileDurations";
import { findInstance, laneValueAt, parameterText, pathTitle, playlistsInTake, takeTimeline, type TakeInstance, type TakeTimeline } from "./takeTimeline";
import { buildSession, takeOnShow, type LiveTake } from "../../runtime/buildSession";
import { openMixer } from "../../shell/openMixer";
import { drivesText, playlistSummary, playsText, propertyCards, typeName, type PropertyCard } from "./takePlaylists";
import type { Take } from "../../../engine/audio/take/reader";
import type { Effect } from "../../../engine/audio/effects/types";
import { EFFECT_CATALOGUE, isBuiltinEffectType } from "../../../engine/audio/effects/catalogue";
import { openMixDocument } from "../mixer/mixerDocument";
import { recordedBus } from "../mixer/recordedBus";
import { dbToGain } from "../../../engine/audio/project/gain";
import { TakeTimelineView } from "./TakeTimelineView";
import { whyNotImportable } from "../../../editor/assetImportFiles";
import { BuildTakeControls } from "./BuildTakeControls";
import { asksWhereToSaveTakes } from "./buildTakes";
import { mountedBuildAudio } from "../../runtime/buildAudioSets";
import { isTakesFolder } from "../../../editor/projects";
import { changeTakesFolder } from "../../shell/liveConnect";
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

/** Record from a build, above the Takes list: offered only while a build is connected (or to show why its take failed). */
/** Where a browser with no project saves a take (ADR 0408): each one where the user says. */
const ASK_WHERE = "a file you choose on Save";

function BuildTakeSection() {
  const session = buildSession.value;
  const rec = session?.recorder ?? null;
  // While the build is connected; after it left, only to show why its take failed (until dismissed).
  if (!session || !rec || (session.show.value.kind !== "live" && rec.state.value.kind !== "failed")) return null;
  const project = currentProject.value;
  const takesOnly = isTakesFolder(project);
  const asks = asksWhereToSaveTakes();
  return (
    <BuildTakeControls
      build={rec.build.name}
      state={rec.state.value}
      whyNotSave={asks ? null : whyNotImportable(project)}
      into={asks ? ASK_WHERE : takesOnly && project?.root ? project.root : undefined}
      onChangeFolder={takesOnly && !asks && project?.fileSystem ? () => void changeTakesFolder(project.fileSystem!) : undefined}
      onStart={() => void session.start()}
      onMark={(text) => void session.mark(text)}
      onStop={() => void session.stop()}
      onSave={() => void rec.save()}
      onDismiss={() => rec.dismiss()}
    />
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
      <BuildTakeSection />
      <TakeList
        files={files}
        // A new project's scenes/, scripts/ and the sample and playlist folders aren't take folders (UI pass T5).
        folders={runTreeFolders(folders, files, isTakePath, [])}
        moveFolders={runMoveFolders(folders, files, isTakePath, [])}
        rootName={project?.name}
        openPath={takeScreen().shownPath()}
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
  const rows = timeline ? playlistsInTake(timeline).map((r) => ({ ...r, summary: playlistSummary(takePlaylist(r.path)) })) : null;
  return (
    <Panel bodyClass="tk-panel-body">
      <PlaylistsInTake rows={rows} onOpen={openSource} />
    </Panel>
  );
}

/** A bus's effects as the Mixer card's FX line: "Low-pass · Comp". */
function effectsLine(effects: readonly Effect[]): string {
  return effects.filter((e) => e.on).map((e) => (isBuiltinEffectType(e.type) ? EFFECT_CATALOGUE[e.type].label : e.type)).join(" · ");
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

/**
 * The open take's replay controls: go to start, replay or pause, loop, restart instances. The Take screen's transport,
 * and the Profiler's (ADR 0408: one recording for both screens), where a running recording makes them inactive.
 */
export function ReplayTransport(props: { readonly disabled?: boolean }) {
  const open = replayStore().open.value;
  if (!open) return null;
  const r = open.replay;
  const playing = r.playing.value;
  const loop = r.loop.value;
  const off = !!props.disabled;
  return (
    <>
      <TransportButton icon="skipBack" label="Go to start" title="Go to start (Home)" disabled={off} onClick={goToStart} />
      <TransportButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Replay"} title={off ? "Inactive while a recording runs" : playing ? "Pause (Space)" : "Replay the take against your current audio (Space)"} primary pressed={playing} disabled={off} onClick={() => r.toggle()} />
      <TransportButton icon="loop" label="Loop" pressed={!!loop} title={loop ? `Looping ${formatClock(loop.from)}–${formatClock(loop.to)}: click to stop` : "Loop the selected region, or the whole take"} disabled={off} onClick={toggleLoop} />
      <TransportButton icon="redo" label="Restart instances" title="Changed during Play: restart the playing copies with the new version" disabled={off || !playing} onClick={() => r.restartInstances()} />
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
        // While a build is connected the timeline is live (ADR 0408): the routed take waits, and opens once it leaves.
        if (takeOnShow.value.kind === "live") return;
        store.follow(asset, !!asset && isTakePath(asset) && !!currentProject.value?.files.includes(asset));
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
          transport: <ReplayTransport />,
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

/** What a lane's playlist plays like, and what a game parameter drives, from the project's playlists now. */
function useLaneWords(timeline: TakeTimeline | null) {
  const lanes = timeline?.lanes ?? [];
  const playlists = lanes.map((l) => ({ path: l.path, label: l.label, body: takePlaylist(l.path) }));
  return {
    plays: (path: string) => {
      const p = playlists.find((x) => x.path === path);
      const lane = lanes.find((l) => l.path === path);
      return playsText(p?.body ?? null, !!lane?.instances.some((i) => i.release !== null));
    },
    drives: (parameter: string) => drivesText(parameter, playlists),
  };
}

function TimelinePanel() {
  useScreen();
  const store = takeScreen();
  const importPick = useRef<HTMLInputElement>(null);
  const s = store.state.value;
  const open = replayStore().open.value;
  const timeline = store.timeline.value;
  const doc = store.notes.value;
  const sel = store.selected.value;
  const instance = sel?.kind === "instance" && timeline ? findInstance(timeline, sel.key) : null;
  const writable = !!doc && !doc.readOnly;
  const words = useLaneWords(timeline);
  const toolbar = open ? (
    <div class="tk-toolbar">
      <strong class="tk-toolbar-title" title={instance ? instance.path : "Scrub to audition the whole mix · click an instance to inspect it"}>
        {instance ? pathTitle(instance.path) : open.title}
      </strong>
      <span class="tk-toolbar-gap" />
      <button type="button" class="tk-icon-btn" disabled={!writable} aria-label="Add marker" title="Add a note marker at the playhead (M)" onClick={() => addMarkerAt(open.replay.time.peek())}>
        <Icon name="marker" size={14} />
      </button>
      <button type="button" class="tk-icon-btn" disabled={!writable} aria-label="Add region" title="Add a note region from the playhead" onClick={() => store.commitNotes(addRegion(notesOf(), open.replay.time.peek(), open.replay.time.peek(), open.take.duration), { select: true })}>
        <Icon name="region" size={14} />
      </button>
      <HeatmapToggle class="tk-icon-btn" />
      <button type="button" class="tk-icon-btn" aria-label="Show profile" title="Show profile: the engine's profile this take recorded in the game, on the Profiler at the playhead" onClick={() => store.showProfile()}>
        <Icon name="profiler" size={14} />
      </button>
    </div>
  ) : undefined;
  let body;
  // ADR 0408: while a game build is connected the Take screen is live: the take recording on the build grows here, and
  // between recordings the last one shows; saved recordings open once it disconnects.
  const show = takeOnShow.value;
  if (show.kind === "live") {
    const build = { name: show.build };
    const live = show.take;
    body = live ? (
      <LiveTakeView live={live} />
    ) : (
      <EmptyState
        title={`Live from ${build.name}`}
        icon={<Icon name="take" size={28} />}
        body={<p>Press Record session in the player bar (or F10 in the game) to record a take. It shows here as it records.</p>}
      />
    );
    return (
      <Panel toolbar={live ? <div class="tk-toolbar"><strong class="tk-toolbar-title">{live.state === "recording" ? `● Recording on ${build.name}` : `Last take from ${build.name}`}</strong><span class="tk-toolbar-gap" /><HeatmapToggle class="tk-icon-btn" /></div> : undefined} bodyClass="tk-panel-body tk-timeline-body">
        {body}
      </Panel>
    );
  }
  if (s.kind === "opening") body = <p class="tk-note" role="status">Opening {s.path}…</p>;
  else if (s.kind === "failed") body = <p class="tk-error" role="alert">Can't open {s.path}: {s.message}</p>;
  else if (s.kind === "noTake")
    body = (
      <EmptyState
        title="No take data in this capture"
        body={`${s.path} holds the engine's profile only, not what the game asked of audio, so there's nothing to replay. The Profiler shows it.`}
        action={{ label: "Open in Profiler", run: () => openRoute({ screen: "profiler", asset: s.path }) }}
      />
    );
  else if (!open || !timeline) {
    const project = currentProject.value;
    const copy = takeEmptyCopy(takeFiles(project?.files ?? []).length > 0);
    const writable = !!project?.canSave && !!project.fileSystem;
    body = (
      <EmptyState
        title={copy.title}
        icon={<Icon name="take" size={28} />}
        body={<p>{copy.line}</p>}
        action={{ label: "Open take file…", title: writable ? "Copy a .sporesample into the project's recordings folder and open it" : "This project is read-only", disabled: !writable, run: () => importPick.current?.click() }}
      >
        <input
          ref={importPick}
          type="file"
          accept=".sporesample"
          hidden
          aria-label="Take file to open"
          onChange={(e) => {
            const input = e.currentTarget as HTMLInputElement;
            const chosen = [...(input.files ?? [])];
            input.value = "";
            if (chosen.length) void importInto(takeFileKind, chosen, store.folder.peek());
          }}
        />
      </EmptyState>
    );
  } else
    body = (
      <>
        {open.replay.note.value && <p class="tk-hint" role="status">{open.replay.note.value}</p>}
        <TakeTimelineView
          timeline={timeline}
          heatmap={heatmapOn.value}
          name={open.title}
          viewKey={open.path}
          onPicture={(t) => {
            // A picture shows the game at its moment: the Inspector's playhead view (not a selected instance) shows it large.
            open.replay.seek(t);
            store.selected.value = null;
          }}
          time={open.replay.time.value}
          playing={open.replay.playing.value}
          selected={sel}
          notes={notesOf()}
          notesWritable={writable}
          plays={words.plays}
          drives={words.drives}
          muted={open.replay.muted.value}
          soloed={open.replay.soloed.value}
          onMute={(path, on) => open.replay.setMuted(path, on)}
          onSolo={(path, on) => open.replay.setSoloed(path, on)}
          hovered={store.hovered.value}
          onHover={(p) => (store.hovered.value = p)}
          onSeek={(t) => open.replay.seek(t)}
          onSelectInstance={(key) => {
            store.selected.value = { kind: "instance", key };
            const i = findInstance(timeline, key);
            if (i) store.focusPath.value = i.path;
          }}
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

const NO_NOTES = emptyTakeNotes();
const NONE: ReadonlySet<string> = new Set();

/**
 * ADR 0408: the take recording on the connected build, as it grows (the build session's live take): the timeline with its playhead at the
 * newest moment, read-only (no replay, no notes). Instances can still be selected for the Inspector.
 */
function LiveTakeView(props: { readonly live: LiveTake }) {
  const take = props.live.take;
  const timeline = useMemo(() => takeTimeline(take, () => null), [take]);
  const store = takeScreen();
  return (
    <TakeTimelineView
      timeline={timeline}
      heatmap={heatmapOn.value}
      name={props.live.state === "recording" ? "Recording…" : "Last take"}
      time={take.duration}
      playing={props.live.state === "recording"}
      selected={store.selected.value}
      notes={NO_NOTES}
      notesWritable={false}
      muted={NONE}
      soloed={NONE}
      hovered={store.hovered.value}
      onHover={(p) => (store.hovered.value = p)}
      onSeek={() => {}}
      onSelectInstance={(key) => (store.selected.value = { kind: "instance", key })}
      onOpenInstance={(key) => {
        const i = findInstance(timeline, key);
        if (i) openSource(i.path);
      }}
      onSelectNote={() => {}}
      onMoveNote={() => {}}
      onAddMarker={() => {}}
    />
  );
}

/** The game's value of each parameter at `t` for an instance: its own parameters first, then the take's globals. */
function valuesAt(take: Take, timeline: TakeTimeline, t: number, instance: TakeInstance | null): (name: string) => number | null {
  const own = instance ? instanceParametersAt(take, instance, t) : {};
  return (name) => {
    if (name in own) return own[name]!;
    const lane = timeline.parameters.find((p) => p.path === null && p.name === name);
    return lane ? laneValueAt(lane, t) : null;
  };
}

/** The badge and cards of the playlist at `path` at the playhead. */
function trackCards(path: string, valueOf: (name: string) => number | null): { kind: string | null; cards: PropertyCard[] } {
  const body = takePlaylist(path);
  return body ? { kind: typeName(body), cards: propertyCards(body, valueOf, globalParameters()) } : { kind: null, cards: [] };
}

function InspectorPanel() {
  // ADR 0411: while a build is connected the Take screen is live; the Inspector shows its take at the newest moment.
  const show = takeOnShow.value;
  if (show.kind === "live") return <LiveInspector live={show.take} />;
  return <ReplayInspector />;
}

/** The live take's newest moment: the latest picture of the game, what sounds now, and the game's values. */
function LiveInspector(props: { readonly live: LiveTake | null }) {
  const store = takeScreen();
  const take = props.live?.take ?? null;
  const timeline = useMemo(() => (take ? takeTimeline(take, () => null) : null), [take]);
  if (!take || !timeline) {
    return (
      <Panel bodyClass="tk-panel-body">
        <EmptyState compact title="No take recording" body="Press Record session in the player bar (or F10 in the game). The game's picture and what sounds show here as it records." />
      </Panel>
    );
  }
  const t = take.duration;
  return (
    <Panel bodyClass="tk-panel-body">
      <PlayheadValues
        open
        time={t}
        picture={take.frames.at(-1) ?? null}
        values={timeline.parameters.filter((p) => p.path === null).map((p) => ({ name: p.name, text: parameterText(p, t) }))}
        track={null}
        summary={playheadSummary(timeline, take.meta, t)}
        recorded={{ project: take.meta.project, engine: take.meta.engine, device: take.meta.device }}
        hovered={store.hovered.value}
        onHover={(p) => (store.hovered.value = p)}
        onOpenSource={openSource}
      />
    </Panel>
  );
}

function ReplayInspector() {
  const store = takeScreen();
  const open = replayStore().open.value;
  const timeline = store.timeline.value;
  const sel = store.selected.value;
  const t = open?.replay.time.value ?? 0;
  void open?.replay.instances.value; // the live instances change as the take replays
  const hover = { hovered: store.hovered.value, onHover: (p: string | null) => (store.hovered.value = p) };
  let body;
  if (open && timeline && sel?.kind === "instance") {
    const i = findInstance(timeline, sel.key);
    if (i) {
      const live = open.replay.instance(i.instance);
      const sounding = !!live && Math.abs(live.started - i.start) < 1e-6 && !!live.handle?.playing;
      const handle = sounding ? live!.handle : null;
      const rows = parameterRows(instanceParametersAt(open.take, i, t), handle?.getParameter ? (n) => handle.getParameter!(n) : null);
      const track = trackCards(i.path, valuesAt(open.take, timeline, t, i));
      body = (
        <InstanceDetails
          instance={i}
          kind={track.kind}
          cards={track.cards}
          emitterName={i.emitter === null ? null : (open.take.meta.emitters[i.emitter] ?? null)}
          emitterPose={i.emitter === null ? null : open.replay.poseAt(i.emitter, t)}
          rows={rows}
          live={sounding}
          {...hover}
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
  // The picture and the take at the playhead stay in view under a selected instance or note.
  const playhead = (below: boolean, track: Parameters<typeof PlayheadValues>[0]["track"]) => (
    <PlayheadValues
      open={!!timeline}
      below={below}
      time={t}
      picture={open?.take.frameAt(t) ?? open?.take.frames[0] ?? null}
      values={(timeline?.parameters ?? []).filter((p) => p.path === null).map((p) => ({ name: p.name, text: parameterText(p, t) }))}
      track={track}
      summary={open && timeline ? playheadSummary(timeline, open.take.meta, t) : null}
      recorded={below ? null : open ? { project: open.take.meta.project, engine: open.take.meta.engine, device: open.take.meta.device } : null}
      {...hover}
      onOpenSource={openSource}
      onSelectInstance={(key) => (store.selected.value = { kind: "instance", key })}
      onSeek={(at) => open?.replay.seek(at)}
    />
  );
  if (body) body = (
    <>
      {body}
      {playhead(true, null)}
    </>
  );
  else {
    const focus = timeline ? (timeline.lanes.find((l) => l.path === store.focusPath.value) ?? timeline.lanes[0] ?? null) : null;
    const track = open && timeline && focus ? { path: focus.path, ...trackCards(focus.path, valuesAt(open.take, timeline, t, null)) } : null;
    body = playhead(false, track && track.kind ? track : null);
  }
  return <Panel bodyClass="tk-panel-body">{body}</Panel>;
}

/** A bus as the runtime reports it: its authored level and its gains now. */
interface LiveBus {
  readonly name: string;
  readonly authored: number;
  readonly gains: BusGains;
}

/** The runtime's bus readings at 10 Hz while the panel shows and the runtime is up. */
function useLiveBuses(running: boolean): readonly LiveBus[] {
  const host = audioHost();
  const [buses, setBuses] = useState<readonly LiveBus[]>([]);
  useEffect(() => {
    if (!running) return;
    const read = () => {
      const a = host.audio;
      setBuses(
        a.buses
          .map((name) => a.bus(name))
          .filter((b) => b.exists)
          .map((b) => ({ name: b.name, authored: b.authoredVolume, gains: { runtime: b.volume, duck: b.duckGain, peak: b.peak } })),
      );
    };
    read();
    const timer = setInterval(read, 100);
    return () => clearInterval(timer);
  }, [running]);
  return running ? buses : [];
}

/**
 * The Mixer strip: while the open take's replay plays, the runtime's levels; paused (or with no runtime), each bus's level
 * as the take recorded it at the playhead, read from the take's profile (`recordedBus`), so a scrub moves the meters.
 */
function MixerPanel() {
  const running = audioHost().playable.value;
  const live = useLiveBuses(running);
  const replay = replayStore();
  const open = replay.open.value;
  const atPlayhead = !!open && (!replay.playing.value || !running);
  const mix = openMixDocument()?.value.value;
  const names = running ? live.map((b) => b.name) : (mix?.buses ?? []).map((b) => b.name);
  const sources: StripSource[] = names.map((name) => {
    const now = live.find((b) => b.name === name);
    const authoredDb = mix?.buses.find((b) => b.name === name)?.volumeDb;
    const then = atPlayhead ? recordedBus(name) : null;
    return {
      name,
      authored: now?.authored ?? (authoredDb === undefined ? 1 : dbToGain(authoredDb)),
      live: now?.gains ?? null,
      recorded: then ? { runtime: then.volume, duck: then.duckGain, peak: then.peak } : null,
    };
  });
  const rows = mixerStripRows(sources, atPlayhead);
  const fx = (name: string) => effectsLine(mix?.buses.find((x) => x.name === name)?.effects ?? []);
  return (
    <Panel bodyClass="tk-panel-body">
      <MixerStrip
        running={running}
        at={rows.some((r) => r.recorded) ? replay.time.value : null}
        strips={rows.map((r) => ({ ...r, fx: fx(r.name) }))}
        onOpenMixer={() => openMixer()}
      />
    </Panel>
  );
}

const inDoc = (body: () => ComponentChildren) => () => <DocScope>{body()}</DocScope>;

/** The screen's panels, in the prototype's places. */
export const TAKE_PANELS: readonly StudioPanel[] = [
  { id: "take-list", title: "Takes", dock: "left", view: () => <TakesPanel /> },
  // "In this take": short enough that both tabs of the left dock show at its default width (the full name is too long).
  { id: "take-playlists", title: "In this take", dock: "left", view: () => <PlaylistsPanel /> },
  { id: "take-timeline", title: "Take", dock: "fill", fixed: true, view: inDoc(() => <TimelinePanel />) },
  { id: "take-inspector", title: "Inspector", dock: "right", view: inDoc(() => <InspectorPanel />) },
  { id: "take-mixer", title: "Mixer", dock: "bottom", view: () => <MixerPanel /> },
  historyPanel("take"),
];
