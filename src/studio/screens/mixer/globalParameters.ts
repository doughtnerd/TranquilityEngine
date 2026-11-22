// The game's global parameters (`audio.json` `parameters`, ADR 0330; decision log D19: their authoring home in the
// Studio): the ADR 0304 parameter list over the mix, with what a rename and a remove carry along.
//
// - In `audio.json` (one undo step with the list edit): a rename renames the automation lanes and snapshot conditions
//   that read the parameter; a remove drops them (as the settings holder of ADR 0304 dropped bus automation).
// - Outside it (`parameterRenameEdit`, applied by the editor's project file module like a bus rename): playlists'
//   Switch parameter, Blend axes, voice-curve and automation inputs, and loop bindings, in embedded playlists too;
//   legacy audio events through the engine's event reference module. A playlist (or an embedded one) that defines a
//   local parameter of either name is left alone: its references read the local one. A remove leaves playlists alone
//   (their lints say what's missing), as an event parameter's remove keeps its uses.
// Pure.
import { AUDIO_EVENT_SUFFIX, MAX_PARAMETERS, type ParameterDef } from "../../../engine/audio/eventFormat";
import { renameEventName } from "../../../engine/audio/eventReferences";
import { PLAYLIST_SUFFIX } from "../../../engine/audio/playlist/types";
import { AUDIO_PROJECT_FILE, type AudioProject, type Snapshot } from "../../../engine/audio/project/types";
import type { ProjectFileEdit } from "../../../editor/projectFileEdits";
import { parameterList, type ParameterList } from "../../../plugins/audio/editor/parameterList";

const mapConditions = (s: Snapshot, fn: (c: Extract<Snapshot["start"], { kind: "conditions" }>["conditions"]) => Extract<Snapshot["start"], { kind: "conditions" }>["conditions"]): Snapshot =>
  s.start.kind === "conditions" ? { ...s, start: { ...s.start, conditions: fn(s.start.conditions) } } : s;

/** `p` with global parameter `from` named `to`, in its list and in the automation and snapshot conditions reading it. */
export function renameParameterInMix(p: AudioProject, from: string, to: string): AudioProject {
  const n = (name: string) => (name === from ? to : name);
  return {
    ...p,
    parameters: p.parameters.map((q) => (q.name === from ? { ...q, name: to } : q)),
    automation: p.automation.map((a) => (a.parameter === from ? { ...a, parameter: to } : a)),
    snapshots: p.snapshots.map((s) => (s.start.kind === "conditions" && s.start.conditions.some((c) => c.parameter === from) ? mapConditions(s, (cs) => cs.map((c) => ({ ...c, parameter: n(c.parameter) }))) : s)),
  };
}

/** `p` without global parameter `name`, the automation lanes it drives and the snapshot conditions on it. */
export function removeParameterFromMix(p: AudioProject, name: string): AudioProject {
  return {
    ...p,
    parameters: p.parameters.filter((q) => q.name !== name),
    automation: p.automation.filter((a) => a.parameter !== name),
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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const TIME_INPUTS = ["voiceTime", "clipTime", "sequenceTime"];

/** `o` with `o[key]` replaced by `fn(o[key])` when `o` has it; `o` itself when nothing changes. */
function at<T>(o: T, key: string, fn: (v: unknown) => unknown): T {
  if (!isRecord(o) || !(key in o)) return o;
  const v = o[key];
  const next = fn(v);
  return next === v ? o : ({ ...o, [key]: next } as T);
}
/** Each item of a list through `fn`; the list itself when nothing changes. */
function each(v: unknown, fn: (item: unknown) => unknown): unknown {
  if (!Array.isArray(v)) return v;
  const next = v.map(fn);
  return next.some((x, i) => x !== v[i]) ? next : v;
}
/** Each value of a record through `fn`; the record itself when nothing changes. */
function values(v: unknown, fn: (item: unknown) => unknown): unknown {
  if (!isRecord(v)) return v;
  let out = v;
  for (const [k, x] of Object.entries(v)) {
    const next = fn(x);
    if (next !== x) out = out === v ? { ...v, [k]: next } : { ...out, [k]: next };
  }
  return out;
}

/** A playlist's references to global parameter `from` renamed `to` (file JSON, or a parsed playlist: the same keys). */
export function renameParameterInPlaylist<T>(json: T, from: string, to: string): T {
  const named = (v: unknown) => (v === from ? to : v);
  /** A curve input: a parameter name (shorthand) or `{ parameter }`; time inputs stay. Blend axes have the same shorthand. */
  const input = (v: unknown) => (typeof v === "string" ? (TIME_INPUTS.includes(v) ? v : named(v)) : at(v, "parameter", named));
  const binding = (v: unknown) => at(v, "parameter", named);
  const automation = (list: unknown) => each(list, (a) => at(a, "input", input));
  const entry = (e: unknown): unknown => {
    let out = at(e, "curves", (cs) => values(cs, (c) => at(c, "input", input)));
    out = at(out, "embedded", body);
    return out;
  };
  const clip = (c: unknown): unknown => {
    let out = at(c, "automation", automation);
    out = at(out, "loops", (ls) => values(ls, (l) => at(l, "binding", binding)));
    out = at(out, "playlist", (p) => (isRecord(p) ? body(p) : p));
    return out;
  };
  const body = (b: unknown): unknown => {
    if (!isRecord(b)) return b;
    // A local parameter of either name: the references in here read it, before and after.
    if (Array.isArray(b.parameters) && b.parameters.some((q) => isRecord(q) && (q.name === from || q.name === to))) return b;
    let out = at(b, "entries", (es) => each(es, entry));
    out = at(out, "stingers", (ss) => each(ss, (s) => at(s, "playlist", entry)));
    out = at(out, "switch", (s) => {
      let sw = at(s, "parameter", named);
      sw = at(sw, "onChange", (c) => at(c, "transition", entry));
      sw = at(sw, "rules", (rs) => each(rs, (r) => at(r, "transition", entry)));
      return sw;
    });
    out = at(out, "blend", (bl) => at(bl, "axes", (axes) => each(axes, (a) => (typeof a === "string" ? named(a) : at(a, "parameter", named)))));
    out = at(out, "sequence", (sq) => {
      let s = at(sq, "tracks", (ts) => each(ts, (t) => at(at(t, "automation", automation), "clips", (cs) => each(cs, clip))));
      s = at(s, "loops", (ls) => each(ls, (l) => at(l, "binding", binding)));
      return s;
    });
    return out;
  };
  return body(json) as T;
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
