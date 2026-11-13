// The Audio plugin's editor half (ADR 0097, 0157): the Audio category of Project settings (buses and their
// effects and voice limits, snapshots, ducking, voices, playback options and the backend, with bus meters while
// playing), the Play Stats panel's audio underruns count, and the Audio Debug panel.
import { editor, type EditorPlugin } from "../../../editor/sdk";
import { audioManifest } from "../manifest";
import { Audio } from "../runtime";
import { AUDIO_EVENT_SUFFIX, emptyAudioEvent, formatAudioEvent } from "../../../engine/audio/eventFormat";
import { createEventFromClips } from "./createEventFromClips";
import { audioEventFormat, audioEventReferences } from "./eventAsset";
import { EVENT_EDITOR_PANEL, openEventEditor } from "./event/openEventEditor";
import { zoneTool } from "./AudioReverbZoneGizmo";
import { editZoneAction } from "./EditZoneButton";
import { occluderTool } from "./AudioOccluderGizmo";
import { occlusionTool } from "./OcclusionOverlay";
import { registerMusicPanels } from "./music";
import { registerMixPanels } from "./mix";
import { mixer } from "../../../engine/audio/mixer";
import { startOpLog, type OpLog, type OpLogEntry } from "./mix/opLog";
import { setCaptureProject } from "../runtime/capture/capture";

/** ADR 0171 (Hk1, Ma1): the audio op log, started once per page (the plugin context has no dispose hook); it hands live
 * edits of the project's audio section to the running mixer while Play runs. */
let opLog: OpLog | null = null;

/** The op log's entries so far (every batch handed to the mixer, with its answers), empty before the plugin activates. The Mixer panel's restart banner reads it. */
export const opLogEntries = (): readonly OpLogEntry[] => opLog?.entries ?? [];

/** A speaker with waves over a page corner: an event is a sound that plays one of several. */
const EVENT_ICON = "M5 9v6h4l5 4V5L9 9zM17.5 8.5a5 5 0 0 1 0 7M20 6a8.5 8.5 0 0 1 0 12";

/** Where New Event goes by default: `audio/` if the project has it, else the folder given. */
const eventFolder = (folder: string): string => (folder === "" && editor.project.current?.folders.includes("audio") ? "audio" : folder);

/** Create `New Event.audioevent.json`: a valid, empty event (a layer with no children, which plays nothing) to fill in the Event editor. */
const createEvent = (folder: string): Promise<string | null> =>
  editor.project.createFile({
    folder: eventFolder(folder),
    name: `New Event${AUDIO_EVENT_SUFFIX}`,
    what: "audio events",
    write: (project, path) => project.writeText(path, formatAudioEvent(emptyAudioEvent())),
  });

export const audioEditorPlugin: EditorPlugin = {
  manifest: audioManifest,
  activate(context) {
    opLog ??= startOpLog(() => mixer);
    // G7b: a capture's META names the open project (the page title stands in otherwise). `project.json` has no version key
    // of its own yet, so the version is whatever string a project keeps there, else empty.
    setCaptureProject(() => {
      const project = editor.project.current;
      const version = (project?.settings as { version?: unknown } | undefined)?.version;
      return { name: project?.name ?? "", version: typeof version === "string" ? version : "" };
    });
    // Project settings > Audio, after Graphics as it has always been. `audio` is a core key (the panel's own parse reports
    // its problems), so the section owns no extra keys.
    context.registerProjectSettingsSection({
      id: "audio",
      title: "Audio",
      after: "Graphics",
      keys: [],
      view: () => import("./AudioSettingsSection").then((m) => m.AudioSettingsSection),
    });
    // Play Stats: the audio thread's underruns since the page loaded, on every World's Nodes row (the audio core is shared).
    context.registerPlayStatsCounter({ id: "myco.audio.underruns", label: "audio underruns", count: () => Audio.debug().counters.underruns });
    // The Audio Debug panel (A2.5): a 4 Hz copy of `Audio.debug()` while playing (status, counters, buses, voices).
    context.registerPanel({
      id: "audiodebug",
      title: "Audio Debug",
      view: () => import("./AudioDebugPanel").then((m) => m.AudioDebugPanel),
    });
    // The audio event asset (ADR 0158 §1): `AudioSource.clip` accepts it beside clips; its clips are references (ADR 0148).
    context.registerAssetKind({
      id: "audioEvent",
      extensions: [AUDIO_EVENT_SUFFIX],
      label: "Audio Event",
      icon: EVENT_ICON,
      open: (path) => openEventEditor(path),
      create: { label: "New Event", create: createEvent },
      referencedAs: ["audioEvent"],
      references: { ...audioEventReferences, extensions: [AUDIO_EVENT_SUFFIX] },
    });
    context.registerAssetFormat(audioEventFormat);
    // A clip's (or several clips') context menu: one event playing one of them per play.
    context.registerAssetAction({
      id: "myco.audio.event-from-clips",
      label: "Create event from clips",
      writes: true,
      appliesTo: (_project, targets) => targets.length > 0 && targets.every((t) => t.slice === undefined && editor.assets.kindOf(t.path) === "audio"),
      run: async (_project, targets) => {
        const { name, event } = createEventFromClips(targets.map((t) => t.path));
        const made = await editor.project.createFile({
          folder: editor.assets.folderOf(targets[0]!.path),
          name: `${name}${AUDIO_EVENT_SUFFIX}`,
          what: "audio events",
          write: (project, path) => project.writeText(path, formatAudioEvent(event)),
        });
        return made ? [made] : [];
      },
    });
    // The Event editor (ADR 0158 §7, contract C4): opened by double-clicking an audio event; a placeholder until E6.3.
    context.registerPanel({
      id: EVENT_EDITOR_PANEL,
      title: "Audio Event",
      onDemand: true,
      view: () => import("./event/EventEditorPanel").then((m) => m.EventEditorPanel),
    });
    registerMusicPanels(context); // the segment view, its properties and the rules table (M4, H6)
    registerMixPanels(context); // the Profiler now, the Mixer later (M5, one registration point)
    // The reverb zone gizmo (E1): volume and blend shell in the scene view, face, radius and blend handles under Edit Zone.
    context.registerViewportTool(zoneTool);
    context.registerComponentHeaderAction(editZoneAction);
    // The occluder gizmo and the Inspector sections under the zone, occluder and audio source cards (E2).
    context.registerViewportTool(occluderTool);
    // The occlusion overlay (E4): rays to occluded sources while playing, switched on in the Audio Debug panel.
    context.registerViewportTool(occlusionTool);
    context.registerInspectorSection("engine.AudioReverbZone", () => import("./ZoneInspector").then((m) => m.ZoneSection), { single: true });
    context.registerInspectorSection("engine.AudioOccluder", () => import("./OccluderInspector").then((m) => m.OccluderSection), { single: true });
    context.registerInspectorSection("engine.AudioSource", () => import("./AudioSourceSections").then((m) => m.AudioSourceSection), { single: true });
  },
};
