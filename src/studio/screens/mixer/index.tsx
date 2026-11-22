// The Mixer screen's panels (ADR 0330, 0327 "The shell"; the prototype's layout): Snapshots and Gain lanes (left),
// Buses (the fixed panel), the Inspector, Game parameters (test values) and Global parameters (their definitions) on the
// right, Loudness (bottom) and History on demand. They
// share one session over `audio.json`'s document (`mixerScreen.ts`), made here for the open project with the real
// confirm dialog, toasts, status bar, project-wide renames and the Studio's runtime (`mixerRuntime.ts`).
import { effect } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { AssetDocument } from "../../../editor/assetDocuments";
import { persisted } from "../../../editor/preferences";
import { editProjectFiles, projectFileUsers } from "../../../editor/projectFileEdits";
import { currentProject, status } from "../../../editor/state";
import { confirmInEditor } from "../../../editor/ui/ConfirmDialog";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import { AUDIO_PROJECT_FILE, type AudioProject } from "../../../engine/audio/project/types";
import type { StudioPanel } from "../../shell/studioPanels";
import { studioRouter, toasts } from "../../shell/studioServices";
import { historyPanel } from "../placeholder";
import { BusesPanel } from "./BusesPanel";
import { DEFAULT_PINS } from "./boardModel";
import { MixerInspector } from "./MixerInspector";
import { openMixDocument } from "./mixerDocument";
import { auditionSnapshot, liveMixHost, readBus, readLoudness, setLoudnessTarget, setRuntimeParameter } from "./mixerRuntime";
import { createMixerSession, type MixerSession } from "./mixerScreen";
import { busRenameEdit } from "./renameReferences";
import { GainLanesPanel, LoudnessPanel, ParametersPanel } from "./SidePanels";
import { GlobalParametersPanel } from "./GlobalParametersPanel";
import { sessionParametersHost } from "./globalParametersHost";
import { renameParameterOutside } from "./globalParametersPanels";
import { SnapshotsPanel } from "./SnapshotsPanel";
import { TriggerDialogHost } from "./TriggerDialog";
import "./mixer.css";

/** Per user: the live board's pins, whether it's open, and List or Strips. */
const prefs = {
  pins: persisted<string[]>("myco.studio.mixer.pins", [...DEFAULT_PINS]),
  boardOpen: persisted<boolean>("myco.studio.mixer.board", false),
  view: persisted<"list" | "strips">("myco.studio.mixer.view", "list"),
};

let cached: { doc: AssetDocument<AudioProject>; session: MixerSession; stopRoute: () => void } | null = null;

/** The session for the open project's `audio.json` (one per document; a new project makes a new one). */
function mixerSession(): MixerSession | null {
  const project = currentProject.value;
  const doc = openMixDocument(project);
  if (!doc || !project) {
    if (cached) { cached.stopRoute(); cached.session.dispose(); cached = null; }
    return null;
  }
  if (cached?.doc === doc) return cached.session;
  if (cached) { cached.stopRoute(); cached.session.dispose(); }
  const session = createMixerSession({
    doc,
    path: AUDIO_PROJECT_FILE,
    confirm: (q) => confirmInEditor(q).then((r) => r.ok),
    toast: (t) => void toasts.show(t),
    report: (kind, text) => void (status.value = { kind, text }),
    usersOf: (name) => projectFileUsers(project, busRenameEdit(name, `${name}\u0000`)),
    renameOutside: (from, to) => editProjectFiles(project, busRenameEdit(from, to), `Rename bus ${from} to ${to}`),
    live: liveMixHost,
    readBus,
    readLoudness,
    setParameter: setRuntimeParameter,
    auditionSnapshot,
    setLoudnessTarget,
    prefs,
  });
  // The route's selection (a hand-off from Playlists, "#/mixer?select=Music") picks the bus.
  let stopRoute = () => {};
  try {
    stopRoute = effect(() => {
      const r = studioRouter().route.value;
      if (r.screen === "mixer" && r.select) session.select(r.select);
    });
  } catch {
    // no router (a story)
  }
  cached = { doc, session, stopRoute };
  return session;
}

function NoProject() {
  return <EmptyState compact title="No project open" body="Open a project to mix its buses, returns, VCAs and snapshots." />;
}

/** A panel's frame around `view` with the session, or the no-project state. */
const mixPanel = (id: string, title: string, dock: StudioPanel["dock"], view: (s: MixerSession) => preact.JSX.Element, extra: Partial<StudioPanel> = {}): StudioPanel => ({
  id,
  title,
  dock,
  ...extra,
  view: () => {
    const session = mixerSession();
    return <Panel bodyClass={`mx-panel-body ${id}`}>{session ? view(session) : <NoProject />}</Panel>;
  },
});

function BoardView(props: { session: MixerSession }) {
  // Leaving the screen ends a solo (monitor controls are never kept).
  useEffect(() => () => { if (props.session.soloed.peek() !== null) props.session.toggleSolo(props.session.soloed.peek()!); }, [props.session]);
  return (
    <>
      <BusesPanel session={props.session} />
      <TriggerDialogHost />
    </>
  );
}

export const MIXER_PANELS: readonly StudioPanel[] = [
  mixPanel("mixer-snapshots", "Snapshots", "left", (s) => <SnapshotsPanel session={s} />),
  mixPanel("mixer-gain", "Gain lanes", "left", (s) => <GainLanesPanel session={s} />),
  mixPanel("mixer-board", "Buses", "fill", (s) => <BoardView session={s} />, { fixed: true }),
  mixPanel("mixer-inspector", "Inspector", "right", (s) => <MixerInspector session={s} />),
  mixPanel("mixer-parameters", "Game parameters", "right", (s) => <ParametersPanel session={s} />),
  mixPanel("mixer-global-parameters", "Global parameters", "right", (s) => <GlobalParametersPanel host={sessionParametersHost(s, renameParameterOutside)} />),
  mixPanel("mixer-loudness", "Loudness · Master", "bottom", (s) => <LoudnessPanel session={s} />),
  historyPanel("mixer"),
];
