// The Audio section's named lists (ADR 0262): buses, acoustic materials and global parameters, and what names them in
// scenes and audio event files, so renaming one in Project Settings > Audio renames its users (the shell's settings
// names module asks first and rewrites them). Also the occlusion layers' references to the Physics section's layers.
// Pure: the event file renames work on the file's JSON as written, changing only the names.
import { AUDIO_EVENT_SUFFIX, REVERB_SEND_KEY } from "../../../engine/audio/eventFormat";
import type { NamedList, NameReferencesContribution, SettingsDraft } from "../../../editor/sdk";
import { audioSettings } from "./audioDraft";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `json` with every string `key` member equal to `from` set to `to`, at any depth; the same value when none is. */
function renamedMember(json: unknown, key: string, from: string, to: string): unknown {
  if (Array.isArray(json)) {
    const next = json.map((v) => renamedMember(v, key, from, to));
    return next.some((v, i) => v !== json[i]) ? next : json;
  }
  if (!isRecord(json)) return json;
  let out = json;
  for (const [k, v] of Object.entries(json)) {
    const next = k === key ? (v === from ? to : v) : renamedMember(v, key, from, to);
    if (next !== v) {
      if (out === json) out = { ...json };
      out[k] = next;
    }
  }
  return out;
}

/**
 * An audio event file with the bus `from` renamed `to`: the event's `bus`, a music track's or stinger's `bus`, and an
 * aux send's key in `sends` (keeping the keys' order; `reverb` is the event's own send, never a bus).
 */
export function renameBusInEvent(json: unknown, from: string, to: string): unknown {
  const out = renamedMember(json, "bus", from, to);
  if (!isRecord(out) || !isRecord(out.sends) || !(from in out.sends) || from === REVERB_SEND_KEY || to === REVERB_SEND_KEY) return out;
  const sends = Object.fromEntries(Object.entries(out.sends).map(([k, v]) => [k === from ? to : k, v]));
  return { ...out, sends };
}

/**
 * An audio event file with the global parameter `from` renamed `to` wherever it names it: automation, `switch` and
 * `blend` nodes, a `musicSwitch`, a region's `while`. An event with a local parameter of either name is left alone: a
 * local parameter hides a global one of its name (ADR 0158 §2).
 */
export function renameParameterInEvent(json: unknown, from: string, to: string): unknown {
  if (!isRecord(json)) return json;
  const local = Array.isArray(json.parameters) ? json.parameters.map((p) => (isRecord(p) ? p.name : undefined)) : [];
  if (local.includes(from) || local.includes(to)) return json;
  return renamedMember(json, "parameter", from, to);
}

const events = (rename: (json: unknown, from: string, to: string) => unknown) => [{ extensions: [AUDIO_EVENT_SUFFIX], rename }];

/** The section's named lists: renaming a bus, a custom material or a parameter renames what names it. */
export const audioNamedLists: readonly NamedList[] = [
  {
    id: "audio.buses",
    noun: "bus",
    names: (d) => audioSettings.read(d).buses.map((b) => b.name),
    fields: [{ component: ["engine.AudioSource", "engine.AudioReverbZone"], field: "output" }],
    assets: events(renameBusInEvent),
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
    assets: events(renameParameterInEvent),
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
