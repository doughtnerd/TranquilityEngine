// The Audio plugin's editor half (ADR 0097, 0157): the Audio category of Project settings (buses and their
// effects and voice limits, snapshots, ducking, voices, playback options and the backend, with bus meters while
// playing) and the Play Stats panel's audio underruns count.
import type { EditorPlugin } from "../../../editor/sdk";
import { audioManifest } from "../manifest";
import { Audio } from "../runtime";

export const audioEditorPlugin: EditorPlugin = {
  manifest: audioManifest,
  activate(context) {
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
  },
};
