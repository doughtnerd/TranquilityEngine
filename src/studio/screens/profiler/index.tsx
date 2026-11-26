// The Profiler screen's panels (ADR 0348 "The Profiler screen", ADR 0341 "The shell"; the prototype's layout): Captures
// (left), the Timeline (the fixed panel), At cursor and Voice (right), Messages and Why it played (bottom). The panels read
// the screen's store (`profilerScreen.ts`); the Timeline panel also owns what the screen does while it shows: opening
// the capture the route names, the cursor keys (← → step, Shift+← → markers) and the player bar's slots (the capture
// playing and the Record button).
import { HeatmapToggle, heatmapOn } from "../../components/heatmapToggle";
import { effect, signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { Panel } from "../../../editor/ui/panel/Panel";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { currentProject, docVersion } from "../../../editor/state";
import type { StudioPanel } from "../../shell/studioPanels";
import { audioHost, keymap, openRoute, setPlayerSlots, studioRouter } from "../../shell/studioServices";
import { CaptureList } from "./CaptureList";
import { recorderStatus } from "./captureRecorder";
import { durationText, isCaptureFile, isCapturePath, NO_CAPTURES, runMoveFolders, runTreeFolders } from "./captureTree";
import { TAKES_FOLDER } from "../take/takeFiles";
import { openMixDocument } from "../mixer/mixerDocument";
import { CURSOR_KEYS } from "./cursorKeys";
import { messageCounts } from "./messagesModel";
import { AtCursor, MessageList, OpenInTake, ReplayOrigin, VoiceDetails, WhyItPlayed } from "./ProfilerDetails";
import { buildFollow, captureFileKind, captureFolder, openCapture, openInTake, profilerRecorder, profilerStore, startPendingFollow } from "./profilerScreen";
import { takeScreen } from "../take/takeScreen";
import { openMixer } from "../../shell/openMixer";
import { ReplayTransport } from "../take/index";
import { deleteFile, deleteFolder, duplicateFile, importInto, moveItems, newRunFolder, renameFile, renameFolder } from "./runFileActions";
import { durationsVersion, fileDuration } from "./runFileDurations";
import { takeOfCapture } from "./reviewLink";
import { ProfilerTimeline } from "./ProfilerTimeline";
import { PluginHealth } from "./PluginHealth";
import { resetPluginEffect, usePluginHealth } from "../../components/EffectChainHealth";
import { Icon } from "../../components/Icon";
import { RecordButton, whyNotRecord } from "./RecordButton";
import { TransportButton } from "../../components/PlayerBar";
import { studioBuild } from "../../debugLink/studioLink";
import { BuildFollow, buildFollowStatus } from "./remoteLiveHost";
import { replayStore } from "../../shell/replay";
import { clockText, valueAt } from "./timelineGeometry";
import type { GroupBy } from "./voiceModel";
import "./profiler.css";

function CapturesPanel() {
  void docVersion.value; // the project's file list grows and shrinks with it
  void durationsVersion.value; // a capture's duration arrived
  const project = currentProject.value;
  const files = project?.files ?? [];
  const folders = project?.folders ?? [];
  const state = profilerStore().state.value;
  const openPath = state.kind === "open" || state.kind === "opening" || state.kind === "failed" ? state.path : null;
  const k = captureFileKind;
  return (
    <Panel bodyClass="pf-panel-body">
      <CaptureList
        files={files}
        // A new project's scenes/, scripts/ and the sample and playlist folders aren't capture folders (UI pass T5).
        folders={runTreeFolders(folders, files, isCaptureFile, [])}
        moveFolders={runMoveFolders(folders, files, isCaptureFile, [])}
        rootName={project?.name}
        openPath={openPath}
        writable={!!project?.canSave && !!project.fileSystem}
        duration={(p) => fileDuration(project, p)}
        onFolder={(f) => (captureFolder.value = f)}
        onOpen={openCapture}
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

const FILTERS = [
  { value: "all" as const, label: "All voices" },
  { value: "problems" as const, label: "Problems only", title: "Show only voice lanes with a stolen, blocked, missing or refused voice" },
];

const GROUPS = [
  { value: "bus" as const, label: "By bus" },
  { value: "clip" as const, label: "By sound" },
];

/**
 * ADR 0408: the Profiler is always live while a game build is connected, on every screen: one `BuildFollow` per chosen
 * build, started at once (a build whose link closed ends its follow with why). Installed for the page's life.
 */
export function installProfilerLive(): () => void {
  return effect(() => {
    const build = studioBuild.value;
    const current = buildFollow.peek();
    if (current && current.build.peer === build?.peer) return startPendingFollow();
    if (current && current.build.peer.state === "closed") current.linkClosed(current.build.peer.closedReason);
    if (build || current?.state.peek().kind !== "ended") current?.dispose();
    const next = build ? new BuildFollow(build, { store: profilerStore() }) : current?.state.peek().kind === "ended" ? current : null;
    buildFollow.value = next;
    if (build && next) void next.start();
  });
}

/**
 * The transport slot. While a game build is connected the Profiler is live (ADR 0408): the live label, with Rejoin when
 * the feed ended. Otherwise the open take's replay controls (the Take screen's, ADR 0408: one recording for both
 * screens; inactive while a recording runs) and Record, which records the Studio's own runtime.
 */
function ProfilerTransport() {
  const follow = buildFollow.value;
  const build = studioBuild.value;
  const recorder = profilerRecorder();
  const r = recorder.state.value;
  const recording = r.kind === "recording" || r.kind === "starting" || r.kind === "saving";
  if (follow && build) {
    const k = follow.state.value.kind;
    const on = k === "starting" || k === "following";
    return (
      <span class={`pf-record${on ? " on" : ""}`}>
        {on ? (
          <span class="studio-live on" title={`The Profiler shows ${build.name}'s live capture while it is connected`}>
            Live
          </span>
        ) : (
          <TransportButton icon="profiler" text label="Rejoin" title={`Join ${build.name}'s live capture again`} onClick={() => void follow.start()} />
        )}
      </span>
    );
  }
  const host = audioHost();
  return (
    <>
      <ReplayTransport disabled={recording} />
      <RecordButton recording={r.kind === "recording" || r.kind === "starting"} busy={r.kind === "saving"} blocked={whyNotRecord({ playable: host.playable.value, voices: host.stats.value?.voices ?? 0, replaying: replayStore().playing.value })} onToggle={() => void recorder.toggle()} />
    </>
  );
}

/** Bumped twice a second while recording, so the player bar's elapsed time moves. */
const tick = signal(0);

/** What the screen does while it shows: the route's capture, the cursor keys and the player bar. */
function useScreen(): void {
  useEffect(() => {
    const store = profilerStore();
    const timer = setInterval(() => {
      if (profilerRecorder().recording) tick.value++;
    }, 500);
    const stops = [
      () => clearInterval(timer),
      // The route names the capture to open (a click in Captures, a hand-off, a reload).
      effect(() => {
        void docVersion.value;
        const asset = studioRouter().route.value.asset;
        if (!asset || !isCapturePath(asset) || !currentProject.value?.files.includes(asset)) return;
        // While a build is connected both screens are live (ADR 0408): a saved recording waits, and opens once it leaves.
        if (studioBuild.value) return;
        void store.openPath(asset);
        // One recording for both screens: the Take screen opens it too (or says it has no take data).
        void takeScreen().openPath(asset);
      }),
      ...CURSOR_KEYS.map((k) => keymap.register({ id: `profiler.${k.action}`, keys: k.keys, label: k.label, scope: { screen: "profiler" }, run: () => store.key(k.action) })),
      effect(() => {
        const s = store.state.value;
        const data = store.data.value;
        const rec = profilerRecorder().state.value;
        const follow = buildFollow.value;
        const followed = follow ? buildFollowStatus(follow.state.value, follow.build.name) : null;
        void tick.value;
        const live = s.kind === "open" && s.origin === "live";
        setPlayerSlots("profiler", {
          nowPlaying: s.kind === "open" ? { art: "CAP", title: s.title, subtitle: `${s.replayOf ? "Replay capture" : "Capture"} · ${clockText(data?.duration ?? 0)}${live ? " · live" : ""}` } : null,
          transport: <ProfilerTransport />,
          status: followed ?? recorderStatus(rec, profilerRecorder().seconds, profilerRecorder().replayOf) ?? (s.kind === "open" && data ? `Cursor ${clockText(store.cursor.value)}` : undefined),
        });
      }),
    ];
    return () => {
      for (const stop of stops) stop();
      setPlayerSlots("profiler", null);
      profilerRecorder().dispose();
    };
  }, []);
}

function TimelinePanel() {
  useScreen();
  const store = profilerStore();
  const s = store.state.value;
  const data = store.data.value;
  const take = useCaptureTake();
  const toolbar = (
    <div class="pf-toolbar">
      {s.kind === "open" && (
        <span class="pf-title">
          <strong title={s.path ?? s.title}>{s.title}</strong>
          {data && <span class="pf-title-meta">{durationText(data.duration)}</span>}
        </span>
      )}
      <span class="pf-toolbar-gap" />
      <SegmentedControl<"all" | "problems"> size="small" look="fill" label="Voices shown" options={FILTERS} value={store.problemsOnly.value ? "problems" : "all"} onChange={(v) => (store.problemsOnly.value = v === "problems")} />
      <SegmentedControl<GroupBy> size="small" label="Group voices" options={GROUPS} value={store.groupBy.value} onChange={(v) => (store.groupBy.value = v)} />
      <HeatmapToggle class="pf-icon-btn" />
      {s.kind === "open" && s.replayOf ? <ReplayOrigin take={s.replayOf} onOpenTake={take ? openInTake : undefined} /> : take && <OpenInTake take={take} onOpen={openInTake} />}
      {data && <span class="pf-counts" role="status">{countsText(data.messages)}</span>}
    </div>
  );
  let body;
  if (s.kind === "none") body = <EmptyState title="No capture open" icon={<Icon name="profiler" size={28} />} body={<p>Open one from the Captures panel, or {NO_CAPTURES.charAt(0).toLowerCase() + NO_CAPTURES.slice(1)}</p>} />;
  else if (s.kind === "opening") body = <p class="pf-note" role="status">Opening {s.path}…</p>;
  else if (s.kind === "failed") body = <p class="pf-error" role="alert">Can't open {s.path}: {s.message}</p>;
  else if (!data || data.tracks.length === 0) body = <EmptyState compact title="Nothing to draw" body="This capture holds no voices, buses, loudness or STATUS samples." />;
  else
    body = (
      <ProfilerTimeline
        data={data}
        cursor={store.cursor.value}
        readouts={store.readouts.value}
        selected={store.selected.value}
        problemsOnly={store.problemsOnly.value}
        groupBy={store.groupBy.value}
        heatmap={heatmapOn.value}
        busChains={busChains()}
        viewKey={s.kind === "open" && s.origin === "file" ? s.path : null}
        onSeek={(t) => store.seekTo(t)}
        onSelect={(key) => store.select(key, true)}
      />
    );
  return (
    <Panel toolbar={toolbar} bodyClass="pf-panel-body">
      {body}
    </Panel>
  );
}

function countsText(messages: Parameters<typeof messageCounts>[0]): string {
  const c = messageCounts(messages);
  const parts = [c.error && `${c.error} error${c.error === 1 ? "" : "s"}`, c.warning && `${c.warning} warning${c.warning === 1 ? "" : "s"}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No problems";
}

function CursorPanel() {
  const store = profilerStore();
  const data = store.data.value;
  const t = store.cursor.value;
  const l = data?.loudness;
  return (
    <Panel bodyClass="pf-panel-body">
      <AtCursor open={!!data} time={t} readouts={store.readouts.value} loudness={l ? { name: l.name, lufs: valueAt(l.shortTerm, t), target: l.target } : null} />
    </Panel>
  );
}

/** "Open in Mixer ›" from a voice or a message: the Mixer with the bus selected (its route's `select`). */
const openBusInMixer = (bus: string): void => openMixer(bus);

/** How many buses run an effect chain in the project's mix (the Effects track's Bus chip). */
function busChains(): number {
  return openMixDocument()?.value.value.buses.filter((b) => b.effects.some((e) => e.on)).length ?? 0;
}

function VoicePanel() {
  const store = profilerStore();
  const voice = store.selectedVoice.value;
  const take = useCaptureTake();
  return (
    <Panel bodyClass="pf-panel-body">
      <VoiceDetails
        voice={voice}
        decision={voice ? (store.data.value?.decisions.get(voice.key) ?? null) : null}
        bus={voice ? (store.readouts.value.find((r) => r.name === voice.busName) ?? null) : null}
        onOpenBus={openBusInMixer}
        onOpenPlaylist={(path) => openRoute({ screen: "playlists", asset: path })}
        take={take}
        onOpenTake={openInTake}
      />
    </Panel>
  );
}

/** The take the open capture is backed by, when the project has it (`reviewLink.ts`): "Open in Take" is offered for it. */
function useCaptureTake(): string | null {
  void docVersion.value; // the project's file list grows and shrinks with it
  const take = takeOfCapture(profilerStore().state.value);
  return take && currentProject.value?.files.includes(take) ? take : null;
}

function WhyPanel() {
  const take = useCaptureTake();
  return (
    <Panel bodyClass="pf-panel-body">
      <WhyItPlayed
        voice={profilerStore().selectedVoice.value}
        decision={profilerStore().selectedVoice.value ? (profilerStore().data.value?.decisions.get(profilerStore().selectedVoice.value!.key) ?? null) : null}
        onOpen={(screen, target) => openRoute(screen === "mixer" ? { screen, select: target } : screen === "playlists" ? { screen, asset: target } : { screen })}
      />
      {take && (
        <p class="pf-why-take">
          <OpenInTake take={take} onOpen={openInTake} />
        </p>
      )}
    </Panel>
  );
}

function MessagesPanel() {
  const store = profilerStore();
  const data = store.data.value;
  return (
    <Panel bodyClass="pf-panel-body">
      <MessageList
        open={!!data}
        messages={data?.messages ?? []}
        selected={store.selected.value}
        onPick={(m) => {
          if (m.voice) store.select(m.voice);
          store.seekTo(m.time);
        }}
        onOpenBus={openBusInMixer}
      />
    </Panel>
  );
}

/** ADR 0352 §9: the running plugin effects' health, live from the runtime, with Reset plugin. */
function PluginsPanel() {
  const rows = usePluginHealth(true);
  return (
    <Panel bodyClass="pf-panel-body">
      <PluginHealth rows={rows} onReset={(type) => void resetPluginEffect(type)} />
    </Panel>
  );
}

/** The screen's panels, in the prototype's places. */
export const PROFILER_PANELS: readonly StudioPanel[] = [
  { id: "profiler-captures", title: "Captures", dock: "left", view: () => <CapturesPanel /> },
  { id: "profiler-timeline", title: "Timeline", dock: "fill", fixed: true, view: () => <TimelinePanel /> },
  { id: "profiler-cursor", title: "At cursor", dock: "right", view: () => <CursorPanel /> },
  { id: "profiler-voice", title: "Voice", dock: "right", view: () => <VoicePanel /> },
  // Spec §4.6.1: Why it played sits below, with Messages, so Voice and Why show together (the right dock keeps At cursor
  // and Voice, whose tabs fit it).
  { id: "profiler-messages", title: "Messages", dock: "bottom", view: () => <MessagesPanel /> },
  { id: "profiler-why", title: "Why it played", dock: "bottom", view: () => <WhyPanel /> },
  { id: "profiler-plugins", title: "Plugins", dock: "bottom", view: () => <PluginsPanel /> },
];
