// The Audio plugin's editor half (ADR 0097, 0157): the scene editor's audio parts that stay beside the Audio Studio
// (ADR 0341): the audio components' Inspector sections and gizmos, the occlusion overlay (ADR 0416: no Play toolbar record
// toggles; the Studio records), the Play Stats panel's audio underruns count, the audio asset kinds (the Studio edits them; the
// editor lists and moves them, and opens them in the Studio) (Project Settings has no Audio section: the Studio owns `audio.json`).
import { editor, type EditorPlugin } from "../../../editor/sdk";
import { audioManifest } from "../manifest";
import { Audio } from "../runtime";
import { AUDIO_EVENT_SUFFIX } from "../../../engine/audio/retiredAudioEvent";
import { audioEventReferences } from "./eventAsset";
import { registerStudioAssetKinds } from "./studioAssets";
import { occlusionLayerReferences } from "./audioNames";
import { zoneTool } from "./AudioReverbZoneGizmo";
import { occluderTool } from "./AudioOccluderGizmo";
import { audioZoneTool } from "./AudioZoneGizmo";
import { occlusionTool } from "./OcclusionOverlay";
import { setCaptureProject } from "../runtime/capture/capture";

/** A speaker with waves over a page corner: an event is a sound that plays one of several. */
const EVENT_ICON = "M5 9v6h4l5 4V5L9 9zM17.5 8.5a5 5 0 0 1 0 7M20 6a8.5 8.5 0 0 1 0 12";

export const audioEditorPlugin: EditorPlugin = {
  manifest: audioManifest,
  activate(context) {
    // G7b: a capture's META names the open project (the page title stands in otherwise). `project.json` has no version key
    // of its own yet, so the version is whatever string a project keeps there, else empty.
    setCaptureProject(() => {
      const project = editor.project.current;
      const version = (project?.settings as { version?: unknown } | undefined)?.version;
      return { name: project?.name ?? "", version: typeof version === "string" ? version : "" };
    });
    // Renaming a physics layer renames it in `audio.json`'s occlusion layers.
    context.registerNameReferences(occlusionLayerReferences);
    // Play Stats: the audio thread's underruns since the page loaded, on every World's Nodes row (the audio core is shared).
    context.registerPlayStatsCounter({ id: "myco.audio.underruns", label: "audio underruns", count: () => Audio.debug().counters.underruns });
    // The retired audio event asset (ADR 0158 §1, replaced by playlists, ADR 0343): listed as the old format to migrate,
    // its clips still counted as used (ADR 0148). Nothing plays or edits it (no format, no field accepts it); opening one
    // opens the Audio Studio, which offers the migration, as the editor does when the project opens.
    context.registerAssetKind({
      id: "audioEvent",
      extensions: [AUDIO_EVENT_SUFFIX],
      label: "Audio Event (old format: migrate)",
      icon: EVENT_ICON,
      folder: "audio",
      references: { ...audioEventReferences, extensions: [AUDIO_EVENT_SUFFIX] },
    });
    // The Audio Studio's assets (ADR 0343, 0342, 0347): playlists, derived samples, attenuation presets. Listed, moved and
    // their references followed here; the Studio edits them.
    registerStudioAssetKinds(context);
    // The reverb zone gizmo (E1): volume and blend shell in the scene view, face, radius and blend handles under Edit Zone (the toggle comes with the tool, ADR 0266).
    context.registerViewportTool(zoneTool);
    // The occluder gizmo and the Inspector sections under the zone, occluder and audio source cards (E2).
    context.registerViewportTool(occluderTool);
    // The occlusion overlay (E4): rays to occluded sources while playing, switched on from the Scene toolbar's Audio popover.
    context.registerViewportTool(occlusionTool);
    context.registerSceneToolbarItem({
      id: "myco.audio.overlay",
      label: "Audio overlay",
      buttonText: "Audio",
      buttonClass: "audio-overlay",
      title: "Draw the occlusion rays of playing sources in the scene view",
      view: () => import("./AudioOverlayForm").then((m) => m.AudioOverlayForm),
    });
    context.registerInspectorSection("engine.AudioReverbZone", () => import("./ZoneInspector").then((m) => m.ZoneSection), { single: true });
    // ADR 0347: the audio zone's outline in the scene view and its Inspector section.
    context.registerViewportTool(audioZoneTool);
    context.registerInspectorSection("engine.AudioZone", () => import("./AudioZoneInspector").then((m) => m.AudioZoneSection), { single: true });
    context.registerInspectorSection("engine.AudioOccluder", () => import("./OccluderInspector").then((m) => m.OccluderSection), { single: true });
    context.registerInspectorSection("engine.AudioSource", () => import("./AudioSourceSections").then((m) => m.AudioSourceSection), { single: true });
  },
};
