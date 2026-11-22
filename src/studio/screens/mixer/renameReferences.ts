// What outside `audio.json` names a bus or return (ADR 0330 "Names are identities"; ADR 0262, 0302): playlists'
// `output` (the playlist itself, embedded entries, Sequence tracks), legacy audio events' bus references (the engine's
// event reference module) and scenes' and prefabs' `AudioSource.output` and `AudioReverbZone.output` (component data
// and prefab overrides). `busRenameEdit` turns a rename into the project-wide edit the editor's project file module
// applies through each file's owner (`editProjectFiles`); `audio.json` itself is left to the Mixer's own edit.
// Pure: each rename returns the same value when nothing in it names `from`.
import { AUDIO_EVENT_SUFFIX } from "../../../engine/audio/eventFormat";
import { renameEventName } from "../../../engine/audio/eventReferences";
import { PLAYLIST_SUFFIX } from "../../../engine/audio/playlist/types";
import { AUDIO_PROJECT_FILE } from "../../../engine/audio/project/types";
import type { ProjectFileEdit } from "../../../editor/projectFileEdits";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Map every object in `value` (depth first) through `fn`, keeping identity where nothing changed. */
function mapObjects(value: unknown, fn: (o: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    const next = value.map((v) => mapObjects(v, fn));
    return next.some((v, i) => v !== value[i]) ? next : value;
  }
  if (!isRecord(value)) return value;
  let out = value;
  for (const [k, v] of Object.entries(value)) {
    const nv = mapObjects(v, fn);
    if (nv !== v) {
      if (out === value) out = { ...value };
      out[k] = nv;
    }
  }
  return fn(out);
}

/**
 * A playlist file's JSON with every `output` naming `from` renamed `to`: the playlist's own, embedded entries' and
 * Sequence tracks' (in a playlist, `output` only ever names a bus).
 */
export function renameBusInPlaylist(json: unknown, from: string, to: string): unknown {
  return mapObjects(json, (o) => (o.output === from ? { ...o, output: to } : o));
}

/** The components whose `output` field names a bus. */
export const BUS_OUTPUT_COMPONENTS: readonly string[] = ["engine.AudioSource", "engine.AudioReverbZone"];

/** A scene or prefab file's JSON with those components' `output` (and prefab overrides of it) renamed. */
export function renameBusInScene(json: unknown, from: string, to: string): unknown {
  return mapObjects(json, (o) => {
    // A component entry: { type, data }.
    if (typeof o.type === "string" && BUS_OUTPUT_COMPONENTS.includes(o.type) && isRecord(o.data) && o.data.output === from) return { ...o, data: { ...o.data, output: to } };
    // A prefab override: { target, component, field, value }.
    if (typeof o.component === "string" && BUS_OUTPUT_COMPONENTS.includes(o.component) && o.field === "output" && o.value === from) return { ...o, value: to };
    return o;
  });
}

/** An audio event file's JSON with its bus references renamed (the engine's event reference module). */
export const renameBusInEvent = (json: unknown, from: string, to: string): unknown => renameEventName(json, "bus", "global", from, to);

/** The project-wide edit renaming bus or return `from` to `to` outside `audio.json`. */
export function busRenameEdit(from: string, to: string): ProjectFileEdit {
  return {
    mentioned: (text) => text.includes(JSON.stringify(from)),
    scene: (file) => {
      const next = renameBusInScene(file, from, to);
      return next === file ? null : (next as typeof file);
    },
    settings: () => null,
    json: (json, path) => {
      const lower = path.toLowerCase();
      if (lower === AUDIO_PROJECT_FILE) return null;
      const next = lower.endsWith(PLAYLIST_SUFFIX) ? renameBusInPlaylist(json, from, to) : lower.endsWith(AUDIO_EVENT_SUFFIX) ? renameBusInEvent(json, from, to) : json;
      return next === json ? null : next;
    },
  };
}

/** The files outside `audio.json` that route to `name` (for the delete confirm): playlists, events, scenes. */
export function busUsers(files: readonly { path: string; json: unknown }[], name: string): string[] {
  const probe = (path: string, json: unknown): boolean => {
    const lower = path.toLowerCase();
    if (lower === AUDIO_PROJECT_FILE) return false;
    if (lower.endsWith(PLAYLIST_SUFFIX)) return renameBusInPlaylist(json, name, `${name}\u0000`) !== json;
    if (lower.endsWith(AUDIO_EVENT_SUFFIX)) return renameBusInEvent(json, name, `${name}\u0000`) !== json;
    return renameBusInScene(json, name, `${name}\u0000`) !== json;
  };
  return files.filter((f) => probe(f.path, f.json)).map((f) => f.path);
}
