// The game's global parameters (`audio.json` `parameters`, ADR 0344; decision log D19: their authoring home in the
// Studio): the ADR 0304 parameter list over the mix, with what a rename and a remove carry along.
//
// - In `audio.json` (one undo step with the list edit): a rename renames the automation lanes and snapshot conditions
//   that read the parameter; a remove drops them (as the settings holder of ADR 0304 dropped bus automation).
// - Outside it (`parameterRenameEdit`, applied by the editor's project file module like a bus rename): every parameter
//   reference of a playlist (the engine's walk, `engine/audio/playlist/references.ts`: Switch parameter, Blend axes,
//   voice-curve inputs, instance, track and clip automation inputs, loop bindings, in embedded playlists too); legacy
//   audio events through the engine's event reference module. A playlist whose instance has a local parameter of either
//   name is left alone: its references read the local one (the runtime's rule). A remove leaves playlists alone
//   (their lints say what's missing), as an event parameter's remove keeps its uses.
// Pure.
import { isLabelled, MAX_PARAMETERS, type ParameterDef } from "../../../engine/audio/parameters";
import { AUDIO_EVENT_SUFFIX } from "../../../engine/audio/retiredAudioEvent";
import { renameEventName } from "../../../engine/audio/migrate/legacy/eventReferences";
import { renamePlaylistParameter } from "../../../engine/audio/playlist/references";
import { PLAYLIST_SUFFIX } from "../../../engine/audio/playlist/types";
import { AUDIO_PROJECT_FILE, type AudioProject, type Snapshot } from "../../../engine/audio/project/types";
import type { ProjectFileEdit } from "../../../editor/projectFileEdits";
import type { EditResult } from "../../../editor/sdk/editResult";
import { parameterList, type ParameterList } from "../../../editor/sdk/parameterList";

const mapConditions = (s: Snapshot, fn: (c: Extract<Snapshot["start"], { kind: "conditions" }>["conditions"]) => Extract<Snapshot["start"], { kind: "conditions" }>["conditions"]): Snapshot =>
  s.start.kind === "conditions" ? { ...s, start: { ...s.start, conditions: fn(s.start.conditions) } } : s;

/** `p` with global parameter `from` named `to`, in its list and in the automation and snapshot conditions reading it. */
export function renameParameterInMix(p: AudioProject, from: string, to: string): AudioProject {
  const n = (name: string) => (name === from ? to : name);
  return {
    ...p,
    parameters: p.parameters.map((q) => (q.name === from ? { ...q, name: to } : q)),
    automation: p.automation.map((a) => (a.parameter === from || a.by?.input === from ? { ...a, parameter: n(a.parameter), ...(a.by ? { by: { ...a.by, input: n(a.by.input) } } : {}) } : a)),
    snapshots: p.snapshots.map((s) => (s.start.kind === "conditions" && s.start.conditions.some((c) => c.parameter === from) ? mapConditions(s, (cs) => cs.map((c) => ({ ...c, parameter: n(c.parameter) }))) : s)),
  };
}

/** `p` without global parameter `name`, the automation lanes it drives and the snapshot conditions on it. */
export function removeParameterFromMix(p: AudioProject, name: string): AudioProject {
  return {
    ...p,
    parameters: p.parameters.filter((q) => q.name !== name),
    // A lane that also followed it (ADR 0362 §5) keeps its own parameter and follows nothing else.
    automation: p.automation.filter((a) => a.parameter !== name).map((a) => (a.by?.input === name ? (({ by: _, ...rest }) => rest)(a) : a)),
    snapshots: p.snapshots.map((s) => (s.start.kind === "conditions" && s.start.conditions.some((c) => c.parameter === name) ? mapConditions(s, (cs) => cs.filter((c) => c.parameter !== name)) : s)),
  };
}

/** The global parameter list (ADR 0304) over `audio.json`. */
export const globalParameterList: ParameterList<AudioProject> = parameterList<AudioProject>({
  read: (p) => p.parameters,
  write: (p, parameters) => ({ ...p, parameters }),
  limit: MAX_PARAMETERS,
  rename: renameParameterInMix,
  remove: removeParameterFromMix,
});

/**
 * `p` with global parameter `def` added last ("+ New parameter…", UI pass J4.1/J5.1/J6.5): refused past the limit or on a
 * name taken. Made through the list's own edits (add, rename, then the kind's range or labels), so it is valid as
 * `parseParameters` reads it back.
 */
export function addGlobalParameter(p: AudioProject, def: ParameterDef): EditResult<AudioProject> {
  const list = globalParameterList;
  const name = def.name.trim();
  if (list.parameters(p).some((q) => q.name === name)) return { refused: `another parameter is named "${name}"` };
  const added = list.add(p, isLabelled(def) ? "labelled" : "numeric");
  if ("refused" in added) return added;
  const placeholder = list.parameters(added.next).at(-1)!.name;
  const steps: ((h: AudioProject) => EditResult<AudioProject>)[] = [
    (h) => list.rename(h, placeholder, name),
    (h) => (isLabelled(def) ? list.setLabels(h, name, def.labels.join(", ")) : list.setRange(h, name, { min: def.min, max: def.max, default: def.default, seekSpeed: def.seekSpeed })),
    (h) => (isLabelled(def) ? list.setDefaultLabel(h, name, def.default) : { next: h }),
  ];
  let h = added.next;
  for (const step of steps) {
    const r = step(h);
    if ("refused" in r) return r;
    h = r.next;
  }
  return { next: h };
}

/** What in `p` reads parameter `name`: its automation lanes and snapshot conditions, counted (for the remove button's tooltip). */
export function parameterUsesInMix(p: AudioProject, name: string): { automation: number; conditions: number } {
  let conditions = 0;
  for (const s of p.snapshots) if (s.start.kind === "conditions") conditions += s.start.conditions.filter((c) => c.parameter === name).length;
  return { automation: p.automation.filter((a) => a.parameter === name).length, conditions };
}

/** The rename `before` → `after` made, when the lists differ only by one parameter's name; else null. */
export function renamedParameter(before: readonly ParameterDef[], after: readonly ParameterDef[]): { from: string; to: string } | null {
  if (before.length !== after.length) return null;
  let found: { from: string; to: string } | null = null;
  for (let i = 0; i < before.length; i++) {
    if (before[i]!.name === after[i]!.name) continue;
    if (found) return null;
    found = { from: before[i]!.name, to: after[i]!.name };
  }
  return found;
}

// --- playlists -------------------------------------------------------------------------------------------------------

/** A playlist's references to global parameter `from` renamed `to` (file JSON, or a parsed playlist: the same keys); the engine's walk. */
export function renameParameterInPlaylist<T>(json: T, from: string, to: string): T {
  return renamePlaylistParameter(json, from, to, "global");
}

/** The project-wide edit renaming global parameter `from` to `to` outside `audio.json`: playlists and audio events. */
export function parameterRenameEdit(from: string, to: string): ProjectFileEdit {
  return {
    mentioned: (text) => text.includes(JSON.stringify(from)),
    scene: () => null,
    settings: () => null,
    json: (json, path) => {
      const lower = path.toLowerCase();
      if (lower === AUDIO_PROJECT_FILE) return null;
      const next = lower.endsWith(PLAYLIST_SUFFIX) ? renameParameterInPlaylist(json, from, to) : lower.endsWith(AUDIO_EVENT_SUFFIX) ? renameEventName(json, "parameter", "global", from, to) : json;
      return next === json ? null : next;
    },
  };
}
