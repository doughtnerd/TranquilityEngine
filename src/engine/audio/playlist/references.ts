/**
 * Where a playlist names another asset (ADR 0329 "References", ADR 0314): the one list of those references on a parsed
 * playlist, the one rewrite for moves, and the cycle check the editor runs before adding a linked playlist ("it would
 * contain itself"). A new field that names a path is added here only.
 *
 * Names a playlist holds: linked playlists (entries, Switch transitions, stingers, sequence clips), samples (Clip
 * entries, sequence clips; an audio file or a `*.sample.json`) and attenuation presets (`spatial.attenuation`), in
 * embedded playlists too. Paths are project paths, as written.
 *
 * The parameters a playlist reads have the same pair (the ADR 0299 pattern): `playlistParameterReferences` lists every
 * place one is named, `renamePlaylistParameter` rewrites what it lists, for a global (`audio.json`) or a local rename.
 *
 * Pure: a rewrite copies only the path to what it changes.
 */
import type { Entry, PlaylistBody } from "./types";

export type PlaylistReferenceKind = "playlist" | "sample" | "attenuation";
/** One step from the playlist to a field: a member key or a list index. */
export type PlaylistReferenceStep = string | number;

/** One place a playlist names an asset. */
export interface PlaylistReference {
  readonly kind: PlaylistReferenceKind;
  readonly path: string;
  /** The keys from the playlist to the field holding the path. */
  readonly where: readonly PlaylistReferenceStep[];
}

/** Every reference in `body`, in file order (spatial, entries, stingers, Switch transitions, sequence clips), depth first. */
export function playlistReferences(body: PlaylistBody): PlaylistReference[] {
  const out: PlaylistReference[] = [];
  const add = (kind: PlaylistReferenceKind, path: string | undefined, where: PlaylistReferenceStep[]) => {
    if (typeof path === "string" && path !== "") out.push({ kind, path, where });
  };
  const entry = (e: Entry, where: PlaylistReferenceStep[]) => {
    if (e.kind === "linked") add("playlist", e.playlist, [...where, "playlist"]);
    else if (e.kind === "sample") add("sample", e.sample, [...where, "sample"]);
    else visit(e.embedded, [...where, "embedded"]);
  };
  const visit = (b: PlaylistBody, where: PlaylistReferenceStep[]) => {
    if (typeof b.spatial?.attenuation === "string") add("attenuation", b.spatial.attenuation, [...where, "spatial", "attenuation"]);
    b.entries.forEach((e, i) => entry(e, [...where, "entries", i]));
    b.stingers.forEach((s, i) => entry(s.playlist, [...where, "stingers", i, "playlist"]));
    if (b.switch) {
      if (b.switch.onChange.transition) entry(b.switch.onChange.transition, [...where, "switch", "onChange", "transition"]);
      b.switch.rules.forEach((r, i) => r.transition && entry(r.transition, [...where, "switch", "rules", i, "transition"]));
    }
    b.sequence?.tracks.forEach((t, ti) => t.clips.forEach((c, ci) => {
      const at = [...where, "sequence", "tracks", ti, "clips", ci];
      if (c.sample !== undefined) add("sample", c.sample, [...at, "sample"]);
      else if (typeof c.playlist === "string") add("playlist", c.playlist, [...at, "playlist"]);
      else if (c.playlist) visit(c.playlist, [...at, "playlist"]);
    }));
  };
  visit(body, []);
  return out;
}

/** The paths `body` names (of `kind`, or all), once each, in reference order (for preloading, export and "Used by"). */
export function referencedPaths(body: PlaylistBody, kind?: PlaylistReferenceKind): string[] {
  return [...new Set(playlistReferences(body).filter((r) => !kind || r.kind === kind).map((r) => r.path))];
}

/** Where paths go after a move: a function of the old path, or a map from old to new paths (unlisted paths stay). */
export type PlaylistMoves = ((path: string) => string) | ReadonlyMap<string, string> | Readonly<Record<string, string>>;

const mover = (moves: PlaylistMoves): ((path: string) => string) => {
  if (typeof moves === "function") return moves;
  if (moves instanceof Map) return (p) => moves.get(p) ?? p;
  const record = moves as Readonly<Record<string, string>>;
  return (p) => (Object.prototype.hasOwnProperty.call(record, p) ? record[p] : p);
};

/** `value` with `fn` applied at `path`, copying only the containers along it; `value` itself when nothing changes. */
function updateAt(value: unknown, path: readonly PlaylistReferenceStep[], i: number, fn: (v: unknown) => unknown): unknown {
  if (i === path.length) return fn(value);
  const step = path[i];
  if (Array.isArray(value) && typeof step === "number") {
    const next = updateAt(value[step], path, i + 1, fn);
    if (next === value[step]) return value;
    const copy = [...value];
    copy[step] = next;
    return copy;
  }
  if (typeof value === "object" && value !== null && typeof step === "string" && step in value) {
    const v = (value as Record<string, unknown>)[step];
    const next = updateAt(v, path, i + 1, fn);
    return next === v ? value : { ...value, [step]: next };
  }
  return value;
}

/**
 * `asset` with every referenced path moved by `moves` (an asset kind's rewrite for a move, ADR 0314). Returns `asset`
 * itself when no path changes; otherwise a copy that shares every untouched part.
 */
export function rewritePlaylistReferences<T extends PlaylistBody>(asset: T, moves: PlaylistMoves): T {
  const to = mover(moves);
  let out: unknown = asset;
  for (const ref of playlistReferences(asset)) {
    const next = to(ref.path);
    if (next !== ref.path && next !== "") out = updateAt(out, ref.where, 0, (v) => (v === ref.path ? next : v));
  }
  return out as T;
}

// --- parameter references ------------------------------------------------------------------------------------------------

/**
 * How a playlist reads a parameter (ADR 0329; the ADR 0299 pattern: one walker lists, the rename rewrites what it lists):
 * a local parameter's `definition`, a Switch's `switch` parameter, a Blend `axis`, an entry's voice `curve` input, an
 * `automation` input (the instance's own, a Sequence track's or clip's), a loop's `binding` (a sequence loop or a clip's
 * loop override).
 */
export type PlaylistParameterUse = "definition" | "switch" | "axis" | "curve" | "automation" | "binding";

/** One place a playlist names a parameter. */
export interface PlaylistParameterReference {
  readonly use: PlaylistParameterUse;
  readonly name: string;
  /** The keys from the playlist to the field holding the name (a curve input or Blend axis may be the bare name). */
  readonly where: readonly PlaylistReferenceStep[];
}

/** Curve inputs that are times, not parameters (ADR 0332). */
const TIME_INPUTS: readonly string[] = ["voiceTime", "clipTime", "sequenceTime"];
/** How deep embedded playlists are walked (the runtime's local parameter walk stops there too). */
const MAX_DEPTH = 16;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/**
 * Every parameter `body` names, in file order, embedded playlists included. Works on a parsed playlist and on its file
 * JSON alike (the same keys; a field the file leaves out has nothing to list, and the shorthand forms, a bare name for a
 * curve input or a Blend axis, are listed with `where` ending at that string).
 */
export function playlistParameterReferences(body: PlaylistBody | unknown): PlaylistParameterReference[] {
  const out: PlaylistParameterReference[] = [];
  const add = (use: PlaylistParameterUse, name: unknown, where: PlaylistReferenceStep[]) => {
    if (typeof name === "string" && name !== "") out.push({ use, name, where });
  };
  /** A curve input or Blend axis: a bare name or `{ parameter }` (times are not parameters). */
  const input = (use: PlaylistParameterUse, v: unknown, where: PlaylistReferenceStep[]) => {
    if (typeof v === "string") {
      if (!TIME_INPUTS.includes(v)) add(use, v, where);
    } else if (isRecord(v)) add(use, own(v, "parameter"), [...where, "parameter"]);
  };
  const automation = (v: unknown, where: PlaylistReferenceStep[]) => list(v).forEach((a, i) => isRecord(a) && input("automation", own(a, "input"), [...where, i, "input"]));
  const binding = (v: unknown, where: PlaylistReferenceStep[]) => {
    if (isRecord(v) && isRecord(own(v, "binding"))) add("binding", own(own(v, "binding") as Record<string, unknown>, "parameter"), [...where, "binding", "parameter"]);
  };
  const entry = (e: unknown, where: PlaylistReferenceStep[], depth: number) => {
    if (!isRecord(e)) return;
    const curves = own(e, "curves");
    if (isRecord(curves)) for (const k of Object.keys(curves)) if (isRecord(curves[k])) input("curve", own(curves[k] as Record<string, unknown>, "input"), [...where, "curves", k, "input"]);
    // A parsed entry says `kind`; a file entry is embedded when it has `embedded`.
    if (isRecord(own(e, "embedded"))) visit(own(e, "embedded"), [...where, "embedded"], depth + 1);
  };
  const visit = (b: unknown, where: PlaylistReferenceStep[], depth: number) => {
    if (!isRecord(b) || depth > MAX_DEPTH) return;
    list(own(b, "parameters")).forEach((p, i) => isRecord(p) && add("definition", own(p, "name"), [...where, "parameters", i, "name"]));
    automation(own(b, "automation"), [...where, "automation"]);
    list(own(b, "entries")).forEach((e, i) => entry(e, [...where, "entries", i], depth));
    list(own(b, "stingers")).forEach((s, i) => isRecord(s) && entry(own(s, "playlist"), [...where, "stingers", i, "playlist"], depth));
    const sw = own(b, "switch");
    if (isRecord(sw)) {
      add("switch", own(sw, "parameter"), [...where, "switch", "parameter"]);
      const onChange = own(sw, "onChange");
      if (isRecord(onChange)) entry(own(onChange, "transition"), [...where, "switch", "onChange", "transition"], depth);
      list(own(sw, "rules")).forEach((r, i) => isRecord(r) && entry(own(r, "transition"), [...where, "switch", "rules", i, "transition"], depth));
    }
    const blend = own(b, "blend");
    if (isRecord(blend)) list(own(blend, "axes")).forEach((a, i) => input("axis", a, [...where, "blend", "axes", i]));
    const seq = own(b, "sequence");
    if (isRecord(seq)) {
      list(own(seq, "tracks")).forEach((t, ti) => {
        if (!isRecord(t)) return;
        const at = [...where, "sequence", "tracks", ti];
        automation(own(t, "automation"), [...at, "automation"]);
        list(own(t, "clips")).forEach((c, ci) => {
          if (!isRecord(c)) return;
          const cw = [...at, "clips", ci];
          automation(own(c, "automation"), [...cw, "automation"]);
          const loops = own(c, "loops");
          if (isRecord(loops)) for (const id of Object.keys(loops)) binding(loops[id], [...cw, "loops", id]);
          if (isRecord(own(c, "playlist"))) visit(own(c, "playlist"), [...cw, "playlist"], depth + 1);
        });
      });
      list(own(seq, "loops")).forEach((l, i) => binding(l, [...where, "sequence", "loops", i]));
    }
  };
  visit(body, [], 0);
  return out;
}

/**
 * The local parameters one playing instance of `body` has, by name: the root's, then those of embedded entries (at any
 * depth) the root doesn't name, as the runtime collects them (`runtime/playlists/instance.ts` `localDefsOf`). Every
 * reference in the playlist to one of these names reads the local parameter; any other reads the global one.
 */
export function playlistLocalParameterNames(body: PlaylistBody | unknown): Set<string> {
  const out = new Set<string>();
  const walk = (b: unknown, depth: number) => {
    if (!isRecord(b)) return;
    for (const p of list(own(b, "parameters"))) if (isRecord(p) && typeof own(p, "name") === "string") out.add(own(p, "name") as string);
    if (depth > MAX_DEPTH) return;
    for (const e of list(own(b, "entries"))) if (isRecord(e) && isRecord(own(e, "embedded"))) walk(own(e, "embedded"), depth + 1);
  };
  walk(body, 0);
  return out;
}

/**
 * `json` (a parsed playlist or its file JSON) with parameter `from` renamed `to` wherever the playlist reads it, copying
 * only what changes (`json` itself when nothing does).
 *
 * - `"global"`: a rename of a global parameter (`audio.json`). The playlist is left alone when its instance has a local
 *   parameter of either name: its references read the local one, before and after (the runtime's rule).
 * - `"local"`: a rename of one of the playlist's own local parameters: its definition and every reference.
 */
export function renamePlaylistParameter<T>(json: T, from: string, to: string, scope: "global" | "local"): T {
  if (from === to || from === "") return json;
  const locals = playlistLocalParameterNames(json);
  if (scope === "global" ? locals.has(from) || locals.has(to) : !locals.has(from)) return json;
  let out: unknown = json;
  for (const ref of playlistParameterReferences(json)) {
    if (ref.name !== from) continue;
    out = updateAt(out, ref.where, 0, (v) => (v === from ? to : v));
  }
  return out as T;
}

/**
 * True when adding `candidate` to the playlist at `target` would make `target` contain itself: `candidate` is `target`,
 * or `candidate` (a path, or a body about to be embedded) links, through any chain of linked playlists, to `target`.
 * `load` gives the parsed playlist at a path, or null/undefined when it can't be read (a missing playlist links
 * nowhere). Each playlist is loaded at most once.
 */
export function wouldContain(target: string, candidate: string | PlaylistBody, load: (path: string) => PlaylistBody | null | undefined): boolean {
  const seen = new Set<string>();
  const stack: PlaylistBody[] = [];
  const push = (path: string): boolean => {
    if (path === target) return true;
    if (seen.has(path)) return false;
    seen.add(path);
    const body = load(path);
    if (body) stack.push(body);
    return false;
  };
  if (typeof candidate === "string") {
    if (push(candidate)) return true;
  } else stack.push(candidate);
  while (stack.length) {
    const body = stack.pop()!;
    for (const path of referencedPaths(body, "playlist")) if (push(path)) return true;
  }
  return false;
}
