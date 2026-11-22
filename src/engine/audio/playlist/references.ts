/**
 * Where a playlist names another asset (ADR 0329 "References", ADR 0314): the one list of those references on a parsed
 * playlist, the one rewrite for moves, and the cycle check the editor runs before adding a linked playlist ("it would
 * contain itself"). A new field that names a path is added here only.
 *
 * Names a playlist holds: linked playlists (entries, Switch transitions, stingers, sequence clips), samples (Clip
 * entries, sequence clips; an audio file or a `*.sample.json`) and attenuation presets (`spatial.attenuation`), in
 * embedded playlists too. Paths are project paths, as written.
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
