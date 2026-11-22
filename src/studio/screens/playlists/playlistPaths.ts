// Where an open playlist sits (ADR 0329; the prototype's breadcrumb `path`): a shared playlist is a file, an embedded
// one an entry inside its parent's body. A path starts at a file and steps down through embedded entries (by index) and
// through linked entries (into the linked file), so the breadcrumb shows how the designer got there and the output
// inheritance follows it. Edits go to the last file on the path, at the entry indices after it. Pure.
import { parsePlaylist, playlistToJson } from "../../../engine/audio/playlist/format";
import type { Entry, PlaylistAsset, PlaylistBody } from "../../../engine/audio/playlist/types";
import { accept, refuse, type EditResult } from "../../../plugins/audio/editor/editResult";

/** One step of a path: a playlist file, or an embedded entry of the playlist before it. */
export type PathStep = { readonly file: string } | { readonly entry: number };

/** A path from a file down to the open playlist. Never empty; the first step is a file. */
export type PlaylistPath = readonly PathStep[];

/** The file the open playlist lives in, and the entry indices from that file's body down to it. */
export interface PathTarget {
  readonly file: string;
  readonly indices: readonly number[];
}

export const isFileStep = (s: PathStep): s is { readonly file: string } => "file" in s;

/** The path of a file opened on its own. */
export const filePath = (file: string): PlaylistPath => [{ file }];

/** The last file of the path and the indices after it. */
export function pathTarget(path: PlaylistPath): PathTarget {
  let at = 0;
  for (let i = path.length - 1; i >= 0; i--) if (isFileStep(path[i]!)) { at = i; break; }
  const file = path[at] && isFileStep(path[at]!) ? (path[at] as { file: string }).file : "";
  return { file, indices: path.slice(at + 1).map((s) => (s as { entry: number }).entry) };
}

/** The body at `indices` under `root` (each step an embedded entry), or null when a step isn't one. */
export function bodyAt(root: PlaylistBody, indices: readonly number[]): PlaylistBody | null {
  let b: PlaylistBody = root;
  for (const i of indices) {
    const e = b.entries[i];
    if (!e || e.kind !== "embedded") return null;
    b = e.embedded;
  }
  return b;
}

/**
 * Lift an edit of the body at `indices` into `root`: refused stays refused, an unchanged body is `root` itself, and a
 * changed one is placed back along the path (copying only the bodies and entries on it).
 */
export function editAt<T extends PlaylistBody>(root: T, indices: readonly number[], edit: (b: PlaylistBody) => EditResult<PlaylistBody>): EditResult<T> {
  const at = bodyAt(root, indices);
  if (!at) return refuse("that playlist isn't there any more");
  const r = edit(at);
  if ("refused" in r) return r;
  if (r.next === at) return accept(root);
  const place = (b: PlaylistBody, depth: number): PlaylistBody => {
    if (depth === indices.length) return r.next;
    const i = indices[depth]!;
    const e = b.entries[i] as Entry & { kind: "embedded" };
    const entries = [...b.entries];
    entries[i] = { ...e, embedded: place(e.embedded, depth + 1) };
    return { ...b, entries };
  };
  return accept(place(root, 0) as T);
}

/** The canonical form of an edited playlist (the parse of its JSON), so a document only ever holds what a file reads as. */
export function canonical(next: PlaylistAsset): PlaylistAsset {
  return parsePlaylist(playlistToJson(next)).playlist;
}

/** Where a body sits in its file, as the parse's and the lint's problem lines name it (`entries[2].embedded`). */
export function whereOf(indices: readonly number[]): string {
  return indices.map((i) => `entries[${i}].embedded`).join(".");
}

/** The route's `select` for a path inside its file ("2.0"), and back. */
export const indicesToSelect = (indices: readonly number[]): string | undefined => (indices.length ? indices.join(".") : undefined);
export function selectToIndices(select: string | undefined): number[] {
  if (!select) return [];
  const parts = select.split(".").map((s) => Number(s));
  return parts.every((n) => Number.isInteger(n) && n >= 0) ? parts : [];
}

/** The file name of a playlist path without the folder or `.playlist.json` ("audio/steps/dirt.playlist.json" → "dirt"). */
export function playlistTitle(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.toLowerCase().endsWith(".playlist.json") ? name.slice(0, -".playlist.json".length) : name;
}

/** A sample path's display name: the file name without its extension ("audio/dirt_02.wav" → "dirt_02"). */
export function sampleTitle(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name.toLowerCase().endsWith(".sample.json")) return name.slice(0, -".sample.json".length);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** ADR 0340 §5, 0341 §3: a line entry's display name: its key, "Line (from play)" for a programmer line, or its dialogue event. */
export function lineTitle(line: string | null | { event: string }): string {
  if (line === null) return "Line (from play)";
  return typeof line === "string" ? `Line ${line}` : `Event ${line.event}`;
}

const TYPE_NAMES: Record<PlaylistBody["type"], string> = { clip: "Clip", queue: "Queue", switch: "Switch", blend: "Blend", layer: "Layer", sequence: "Sequence" };

/** A playlist type's name in the UI. */
export const typeName = (type: PlaylistBody["type"]): string => TYPE_NAMES[type];

/**
 * An entry's name: a linked playlist's file title, a sample's name, and an embedded playlist (which has no name of its
 * own in the file) by its sample when it is a Clip, else by its type and place ("Switch 3").
 */
export function entryName(e: Entry, index: number): string {
  if (e.kind === "linked") return playlistTitle(e.playlist);
  if (e.kind === "sample") return sampleTitle(e.sample);
  if (e.kind === "line") return lineTitle(e.line);
  const b = e.embedded;
  if (b.type === "clip") {
    const s = b.entries[0];
    return s && s.kind === "sample" ? sampleTitle(s.sample) : s && s.kind === "line" ? lineTitle(s.line) : `Clip ${index + 1}`;
  }
  return `${typeName(b.type)} ${index + 1}`;
}

/** One breadcrumb item: its name and the path it opens. */
export interface Crumb {
  readonly name: string;
  readonly path: PlaylistPath;
}

/** The breadcrumb of `path`, given each file's body (`load`). */
export function breadcrumb(path: PlaylistPath, load: (file: string) => PlaylistBody | null): Crumb[] {
  const out: Crumb[] = [];
  let body: PlaylistBody | null = null;
  path.forEach((step, i) => {
    const upTo = path.slice(0, i + 1);
    if (isFileStep(step)) {
      body = load(step.file);
      out.push({ name: playlistTitle(step.file), path: upTo });
    } else {
      const e: Entry | undefined = body?.entries[step.entry];
      out.push({ name: e ? entryName(e, step.entry) : "?", path: upTo });
      body = e?.kind === "embedded" ? e.embedded : null;
    }
  });
  return out;
}

/** The path one level down, into entry `index` of the open playlist: an embedded entry steps in, a linked one opens its file. Null for a sample or a line. */
export function childPath(path: PlaylistPath, open: PlaylistBody, index: number): PlaylistPath | null {
  const e = open.entries[index];
  if (!e || e.kind === "sample" || e.kind === "line") return null;
  return e.kind === "embedded" ? [...path, { entry: index }] : [...path, { file: e.playlist }];
}

/**
 * The output the open playlist's audio goes to: its own, else the nearest one up the path (a linked or embedded
 * playlist with `output: null` plays on its parent's bus), else Master. `own` says whether it is the playlist's own.
 */
export function effectiveOutput(path: PlaylistPath, load: (file: string) => PlaylistBody | null): { bus: string; own: boolean; from: string | null } {
  const bodies: { body: PlaylistBody; name: string }[] = [];
  let body: PlaylistBody | null = null;
  path.forEach((step, i) => {
    if (isFileStep(step)) body = load(step.file);
    else {
      const e: Entry | undefined = body?.entries[step.entry];
      body = e && e.kind === "embedded" ? e.embedded : null;
    }
    if (body) bodies.push({ body, name: breadcrumbName(path, i, bodies, step) });
  });
  const last = bodies[bodies.length - 1];
  if (last?.body.output) return { bus: last.body.output, own: true, from: null };
  for (let i = bodies.length - 2; i >= 0; i--) if (bodies[i]!.body.output) return { bus: bodies[i]!.body.output!, own: false, from: bodies[i]!.name };
  return { bus: "Master", own: false, from: null };
}

function breadcrumbName(_path: PlaylistPath, i: number, bodies: { body: PlaylistBody }[], step: PathStep): string {
  if (isFileStep(step)) return playlistTitle(step.file);
  const parent = bodies[bodies.length - 1]?.body;
  const e = parent?.entries[step.entry];
  return e ? entryName(e, step.entry) : `entry ${i}`;
}
