// The audio names other settings rename (ADR 0262): `audio.json`'s occlusion layers name the Physics section's layers,
// so renaming a physics layer renames it there (the shell's settings names module asks first and rewrites the file).
// Pure: the rename works on the file's JSON as written, changing only the layer names.
import { AUDIO_PROJECT_FILE, AUDIO_PROJECT_FORMAT } from "../../../engine/audio/project/types";
import type { NameReferencesContribution } from "../../../editor/sdk";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `audio.json` (parsed) with physics layer `from` named `to` in `settings.occlusion.layers`; the same value when it isn't listed. */
function renameOcclusionLayer(json: unknown, from: string, to: string): unknown {
  if (!isRecord(json) || json.format !== AUDIO_PROJECT_FORMAT || !isRecord(json.settings) || !isRecord(json.settings.occlusion)) return json;
  const settings = json.settings;
  const occlusion = json.settings.occlusion;
  const layers = occlusion.layers;
  if (!Array.isArray(layers) || !layers.includes(from)) return json;
  return { ...json, settings: { ...settings, occlusion: { ...occlusion, layers: layers.map((l) => (l === from ? to : l)) } } };
}

/** `audio.json`'s `settings.occlusion.layers` names physics layers (as written: a list, or absent for every layer). */
export const occlusionLayerReferences: NameReferencesContribution = {
  id: "myco.audio.occlusion-layers",
  list: "physics.layers",
  assets: [{ extensions: [AUDIO_PROJECT_FILE], rename: renameOcclusionLayer }],
};
