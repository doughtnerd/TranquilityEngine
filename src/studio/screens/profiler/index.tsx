// The Profiler screen's panels (ADR 0334 "The Profiler screen", ADR 0327 "The shell"; the prototype's layout): Captures
// (left), the Timeline (the fixed panel), At cursor, Voice and Why it played (right), Messages (bottom). The panels read
// the screen's store (`profilerScreen.ts`); the Timeline panel also owns what the screen does while it shows: opening
// the capture the route names, the cursor keys (← → step, Shift+← → markers) and the player bar's slots (the capture
// playing and the Record button).
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
import { isCapturePath, NO_CAPTURES } from "./captureTree";
import { CURSOR_KEYS } from "./cursorKeys";
import { messageCounts } from "./messagesModel";
import { AtCursor, MessageList, ReplayOrigin, VoiceDetails, WhyItPlayed } from "./ProfilerDetails";
import { deleteCapture, importCaptures, moveCapture, openCapture, profilerRecorder, profilerStore, renameCapture } from "./profilerScreen";
import { ProfilerTimeline } from "./ProfilerTimeline";
import { PluginHealth } from "./PluginHealth";
import { resetPluginEffect, usePluginHealth } from "../../components/EffectChainHealth";
import { RecordButton, whyNotRecord } from "./RecordButton";
import { clockText, valueAt } from "./timelineGeometry";
import type { GroupBy } from "./voiceModel";
import "./profiler.css";

function CapturesPanel() {
  void docVersion.value; // the project's file list grows and shrinks with it
  const project = currentProject.value;
  const state = profilerStore().state.value;
  const openPath = state.kind === "open" || state.kind === "opening" || state.kind === "failed" ? state.path : null;
  return (
    <Panel bodyClass="pf-panel-body">
      <CaptureList
        files={project?.files ?? []}
        folders={project?.folders ?? []}
        openPath={openPath}
        writable={!!project?.canSave && !!project.fileSystem}
        onOpen={openCapture}
        onImport={(files) => void importCaptures(files)}
        onRename={(path, name) => void renameCapture(path, name)}
        onMove={(path, folder) => void moveCapture(path, folder)}
        onDelete={(path) => void deleteCapture(path)}
      />
    </Panel>
  );
}

const GROUPS = [
  { value: "bus" as const, label: "By bus" },
  { value: "clip" as const, label: "By sound" },
];

/** The transport slot: Record while the Studio's runtime plays. */
function ProfilerTransport() {
  const recorder = profilerRecorder();
  const host = audioHost();
  const r = recorder.state.value;
  const recording = r.kind === "recording" || r.kind === "starting";
  return <RecordButton recording={recording} busy={r.kind === "saving"} blocked={whyNotRecord({ playable: host.playable.value, voices: host.stats.value?.voices ?? 0 })} onToggle={() => void recorder.toggle()} />;
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
        if (asset && isCapturePath(asset) && currentProject.value?.files.includes(asset)) void store.openPath(asset);
      }),
      ...CURSOR_KEYS.map((k) => keymap.register({ id: `profiler.${k.action}`, keys: k.keys, label: k.label, scope: { screen: "profiler" }, run: () => store.key(k.action) })),
      effect(() => {
        const s = store.state.value;
        const data = store.data.value;
        const rec = profilerRecorder().state.value;
        void tick.value;
        const live = s.kind === "open" && s.origin === "live";
        setPlayerSlots("profiler", {
          nowPlaying: s.kind === "open" ? { art: "CAP", title: s.title, subtitle: `${s.replayOf ? "Replay capture" : "Capture"} · ${clockText(data?.duration ?? 0)}${live ? " · live" : ""}` } : null,
          transport: <ProfilerTransport />,
          status: recorderStatus(rec, profilerRecorder().seconds, profilerRecorder().replayOf) ?? (s.kind === "open" && data ? `Cursor ${clockText(store.cursor.value)}` : undefined),
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
  const toolbar = (
    <div class="pf-toolbar">
      <button type="button" class={`pf-toggle${store.problemsOnly.value ? " on" : ""}`} aria-pressed={store.problemsOnly.value} onClick={() => (store.problemsOnly.value = !store.problemsOnly.value)} title="Show only voice lanes with a stolen, blocked, missing or refused voice">
        Problems only
      </button>
      <SegmentedControl<GroupBy> size="small" label="Group voices" options={GROUPS} value={store.groupBy.value} onChange={(v) => (store.groupBy.value = v)} />
      {s.kind === "open" && s.replayOf && <ReplayOrigin take={s.replayOf} onOpenTake={(path) => openRoute({ screen: "take", asset: path })} />}
      {data && <span class="pf-counts">{countsText(data.messages)}</span>}
    </div>
  );
  let body;
  if (s.kind === "none") body = <EmptyState title="Profiler" icon="▤" body={<p>Engine performance captures: voices, CPU, buses and loudness over time, and why each sound played. Open a capture from the Captures panel. {NO_CAPTURES.replace(/^No captures yet — /, "Captures come from: ")}</p>} />;
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

function VoicePanel() {
  return (
    <Panel bodyClass="pf-panel-body">
      <VoiceDetails voice={profilerStore().selectedVoice.value} />
    </Panel>
  );
}

function WhyPanel() {
  return (
    <Panel bodyClass="pf-panel-body">
      <WhyItPlayed voice={profilerStore().selectedVoice.value} onOpen={(screen, target) => openRoute(screen === "mixer" ? { screen, select: target } : { screen })} />
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
      />
    </Panel>
  );
}

/** ADR 0338 §9: the running plugin effects' health, live from the runtime, with Reset plugin. */
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
  { id: "profiler-why", title: "Why it played", dock: "right", view: () => <WhyPanel /> },
  { id: "profiler-messages", title: "Messages", dock: "bottom", view: () => <MessagesPanel /> },
  { id: "profiler-plugins", title: "Plugins", dock: "bottom", view: () => <PluginsPanel /> },
];
