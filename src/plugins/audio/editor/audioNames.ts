// The Audio section's named lists (ADR 0262): buses, acoustic materials and global parameters, and what names them in
// scenes and audio event files, so renaming one in Project Settings > Audio renames its users (the shell's settings
// names module asks first and rewrites them). Also the occlusion layers' references to the Physics section's layers.
// Pure: the event file renames work on the file's JSON as written, changing only the names, at the places the event
// references module lists (ADR 0299).
import { AUDIO_EVENT_SUFFIX } from "../../../engine/audio/eventFormat";
import { renameEventName, type EventNameKind } from "../../../engine/audio/eventReferences";
import type { NamedList, NameReferencesContribution, SettingsDraft } from "../../../editor/sdk";
import { audioSettings } from "./audioDraft";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Audio event files follow a rename of a bus or a global parameter wherever they name it (ADR 0299). An event whose own
 * parameter has the old name reads that one (ADR 0158 §2), so it keeps it; one whose own parameter has the new name is
 * left alone, so its reads don't move to the local one.
 */
const events = (kind: EventNameKind) => [{ extensions: [AUDIO_EVENT_SUFFIX], rename: (json: unknown, from: string, to: string) => renameEventName(json, kind, "global", from, to) }];

/** The section's named lists: renaming a bus, a custom material or a parameter renames what names it. */
export const audioNamedLists: readonly NamedList[] = [
  {
    id: "audio.buses",
    noun: "bus",
    names: (d) => audioSettings.read(d).buses.map((b) => b.name),
    fields: [{ component: ["engine.AudioSource", "engine.AudioReverbZone"], field: "output" }],
    assets: events("bus"),
  },
  {
    id: "audio.materials",
    noun: "acoustic material",
    names: (d) => audioSettings.read(d).occlusion.materials.map((m) => m.name),
    fields: [{ component: "engine.AudioOccluder", field: "material" }],
  },
  {
    id: "audio.parameters",
    noun: "parameter",
    names: (d) => audioSettings.read(d).parameters.map((p) => p.name),
    assets: events("parameter"),
  },
];

/** `audio.occlusion.layers` names physics layers (as written: a list, or absent for every layer). */
export const occlusionLayerReferences: NameReferencesContribution = {
  id: "myco.audio.occlusion-layers",
  list: "physics.layers",
  settings(draft: SettingsDraft, from: string, to: string): SettingsDraft {
    const audio = draft.audio;
    if (!isRecord(audio) || !isRecord(audio.occlusion)) return draft;
    const occlusion = audio.occlusion;
    const layers = occlusion.layers;
    if (!Array.isArray(layers) || !layers.includes(from)) return draft;
    return { ...draft, audio: { ...audio, occlusion: { ...occlusion, layers: layers.map((l) => (l === from ? to : l)) } } };
  },
};
