// The Playlists panel's tree (the prototype's tree, PL:962–1033; ADR 0329): the project's `*.playlist.json` files by
// folder, each with its entries nested under it: embedded playlists (owned by the file, opened in place) and linked
// ones (another file, drawn dashed with a link icon; not expanded, so a tree never loops). A file other playlists link
// lists them ("linked in …"). Folders show when they hold playlists, or nothing at all (a new folder). Searching lists
// the matching playlists flat, with their paths. Pure.
import { isPlaylistPath } from "../../../engine/audio/playlist/format";
import { referencedPaths } from "../../../engine/audio/playlist/references";
import type { PlaylistBody, PlaylistType } from "../../../engine/audio/playlist/types";
import { entryName, playlistTitle } from "./playlistPaths";

/** What a playlist row shows of its playlist. */
export interface PlaylistFacts {
  readonly type: PlaylistType;
  /** A Blend's axis count (badges 1D / 2D). */
  readonly axes: 1 | 2;
  /** Its own output override. */
  readonly output: string | null;
}

export type PlaylistNode =
  | { readonly kind: "folder"; readonly key: string; readonly path: string; readonly name: string; readonly count: number; readonly children: readonly PlaylistNode[] }
  | ({ readonly kind: "file"; readonly key: string; readonly path: string; readonly name: string; readonly linkedBy: readonly string[]; readonly children: readonly PlaylistNode[]; readonly unreadable: boolean } & PlaylistFacts)
  | ({
      readonly kind: "entry";
      readonly key: string;
      /** The file the entry is in, and the indices from its body down to this entry (the last is the entry's own index). */
      readonly file: string;
      readonly indices: readonly number[];
      readonly name: string;
      /** A linked entry's playlist path; null for an embedded one. */
      readonly link: string | null;
      readonly children: readonly PlaylistNode[];
    } & PlaylistFacts);

export const folderKey = (path: string): string => `f:${path}`;
export const fileKey = (path: string): string => `p:${path}`;
export const entryKey = (file: string, indices: readonly number[]): string => `e:${file}#${indices.join(".")}`;

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export const factsOf = (b: PlaylistBody): PlaylistFacts => ({ type: b.type, axes: b.blend?.axes.length === 2 ? 2 : 1, output: b.output });

/** The entry rows of a body: embedded ones nest their own; linked ones are leaves; a Clip's sample isn't a row. */
export function entryNodes(file: string, body: PlaylistBody, prefix: readonly number[] = []): PlaylistNode[] {
  if (body.type === "clip") return [];
  const out: PlaylistNode[] = [];
  body.entries.forEach((e, i) => {
    if (e.kind === "sample") return;
    const indices = [...prefix, i];
    if (e.kind === "embedded") {
      out.push({ kind: "entry", key: entryKey(file, indices), file, indices, name: entryName(e, i), link: null, children: entryNodes(file, e.embedded, indices), ...factsOf(e.embedded) });
    } else {
      out.push({ kind: "entry", key: entryKey(file, indices), file, indices, name: entryName(e, i), link: e.playlist, children: [], type: "queue", axes: 1, output: null });
    }
  });
  return out;
}

/** Which files link each playlist file (from every file's references). */
export function linkedByIndex(files: readonly string[], load: (path: string) => PlaylistBody | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of files) {
    if (!isPlaylistPath(f)) continue;
    const b = load(f);
    if (!b) continue;
    for (const p of referencedPaths(b, "playlist")) {
      const list = out.get(p) ?? [];
      if (!list.includes(f)) list.push(f);
      out.set(p, list);
    }
  }
  return out;
}

/**
 * The tree of `files`' playlists in `folders`: folders first, then files, each A–Z (numbers in order). A linked entry's
 * facts come from the file it links (`load`), so its badge is right.
 */
export function playlistTree(files: readonly string[], folders: readonly string[], load: (path: string) => PlaylistBody | null): PlaylistNode[] {
  const playlists = files.filter(isPlaylistPath);
  const linkedBy = linkedByIndex(playlists, load);
  const holds = new Set<string>();
  for (const p of playlists) for (let f = folderOf(p); f; f = folderOf(f)) holds.add(f);
  const hidden = (f: string) => f.split("/").some((part) => part.startsWith("."));
  const emptyFolders = folders.filter((f) => !hidden(f) && !files.some((x) => x.startsWith(`${f}/`)));
  const shown = new Set([...holds, ...emptyFolders]);
  for (const f of [...shown]) for (let p = folderOf(f); p; p = folderOf(p)) shown.add(p);

  const withLinkFacts = (nodes: PlaylistNode[]): PlaylistNode[] =>
    nodes.map((n) => {
      if (n.kind !== "entry") return n;
      if (n.link) {
        const b = load(n.link);
        return b ? { ...n, ...factsOf(b), output: null } : n;
      }
      return { ...n, children: withLinkFacts([...n.children]) };
    });

  const build = (folder: string): PlaylistNode[] => {
    const dirs = [...shown].filter((d) => folderOf(d) === folder).sort((a, b) => collator.compare(nameOf(a), nameOf(b)));
    const here = playlists.filter((p) => folderOf(p) === folder).sort((a, b) => collator.compare(nameOf(a), nameOf(b)));
    return [
      ...dirs.map((d): PlaylistNode => {
        const children = build(d);
        return { kind: "folder", key: folderKey(d), path: d, name: nameOf(d), count: countFiles(children), children };
      }),
      ...here.map((p): PlaylistNode => {
        const b = load(p);
        return {
          kind: "file", key: fileKey(p), path: p, name: playlistTitle(p), linkedBy: linkedBy.get(p) ?? [], unreadable: !b,
          children: b ? withLinkFacts(entryNodes(p, b)) : [], ...(b ? factsOf(b) : { type: "queue" as const, axes: 1 as const, output: null }),
        };
      }),
    ];
  };
  return build("");
}

function countFiles(nodes: readonly PlaylistNode[]): number {
  let n = 0;
  for (const x of nodes) n += x.kind === "file" ? 1 : x.kind === "folder" ? x.count : 0;
  return n;
}

/** A search hit: a node and the path it is shown with ("audio/steps/dirt › Switch 2"). */
export interface SearchHit {
  readonly node: PlaylistNode;
  readonly where: string;
}

/** The playlists (files and nested entries) whose name or path holds every word of `query`, in tree order. */
export function searchTree(nodes: readonly PlaylistNode[], query: string): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: SearchHit[] = [];
  const walk = (list: readonly PlaylistNode[], trail: string) => {
    for (const n of list) {
      if (n.kind === "folder") { walk(n.children, n.path); continue; }
      const where = n.kind === "file" ? n.path.replace(/\.playlist\.json$/i, "") : `${trail} › ${n.name}`;
      if (words.length && words.every((w) => where.toLowerCase().includes(w))) out.push({ node: n, where });
      walk(n.children, where);
    }
  };
  walk(nodes, "");
  return out;
}

/** Every key in the tree (for "open all"), and a node by key. */
export function findNode(nodes: readonly PlaylistNode[], key: string): PlaylistNode | null {
  for (const n of nodes) {
    if (n.key === key) return n;
    const inner = findNode(n.children, key);
    if (inner) return inner;
  }
  return null;
}

/** The keys of the rows above `key` (to open them so it shows). */
export function ancestorKeys(nodes: readonly PlaylistNode[], key: string): string[] {
  const trail: string[] = [];
  const walk = (list: readonly PlaylistNode[]): boolean => {
    for (const n of list) {
      if (n.key === key) return true;
      trail.push(n.key);
      if (walk(n.children)) return true;
      trail.pop();
    }
    return false;
  };
  return walk(nodes) ? trail : [];
}

/** The rows a key opens: a folder none; a file its own path; an entry its file and indices (a linked one its own file). */
export function nodePath(n: PlaylistNode): { file: string; indices: number[] } | null {
  if (n.kind === "file") return { file: n.path, indices: [] };
  if (n.kind === "entry") return n.link ? { file: n.link, indices: [] } : { file: n.file, indices: [...n.indices] };
  return null;
}
