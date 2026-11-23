// Dragging rows in the Playlists tree (the prototype's tree drag, PL:926–957): where a drop lands (the top 28 % of a
// row is before it, the bottom 28 % after it, the middle into it; a folder always takes it in) and what it does, or why
// it can't. A playlist's parent must hold entries (not a Clip, not a Sequence) and a drop never makes a playlist
// contain itself (`wouldContain`). In this project's files:
//
// - a shared playlist (a file) dropped on a folder, or beside a file, moves the file to that folder;
// - a shared playlist dropped into a playlist, or beside one of its entries, is added there as a link (the file stays);
// - an entry (embedded or linked) dropped into a playlist, or beside an entry, moves there (a reorder in its parent);
// - an embedded entry dropped on a folder, or beside a file, becomes a file of its own there and leaves its parent
//   (the prototype's "move to top level"); a linked entry dropped there just leaves its parent;
// - a folder moves into another folder.
// Pure.
import { wouldContain } from "../../../engine/audio/playlist/references";
import type { PlaylistBody } from "../../../engine/audio/playlist/types";
import { bodyAt } from "./playlistPaths";

export type DropZone = "before" | "into" | "after";

/** The zone of a pointer at `fraction` (0 top .. 1 bottom) of a row's height; a folder (or a row that can't hold) has no inside, a folder no edges. */
export function dropZone(fraction: number, row: { folder: boolean }): DropZone {
  if (row.folder) return "into";
  return fraction < 0.28 ? "before" : fraction > 0.72 ? "after" : "into";
}

/** What is dragged. */
export type DragSource =
  | { readonly kind: "folder"; readonly path: string }
  | { readonly kind: "file"; readonly path: string }
  /** An entry of the body at `parent` in `file`, at `index`; `link` for a linked one. */
  | { readonly kind: "entry"; readonly file: string; readonly parent: readonly number[]; readonly index: number; readonly link: string | null };

/** The row it is dropped on. */
export type DropTarget =
  | { readonly kind: "root" }
  | { readonly kind: "folder"; readonly path: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "entry"; readonly file: string; readonly parent: readonly number[]; readonly index: number; readonly link: string | null };

/** A playlist body inside a file (the parent of entries). */
export interface BodyRef {
  readonly file: string;
  readonly indices: readonly number[];
}

export type DropPlan =
  | { readonly kind: "moveFolder"; readonly path: string; readonly to: string }
  | { readonly kind: "moveFile"; readonly path: string; readonly to: string }
  | { readonly kind: "link"; readonly path: string; readonly into: BodyRef; readonly at: number }
  | { readonly kind: "moveEntry"; readonly from: BodyRef; readonly index: number; readonly into: BodyRef; readonly at: number }
  /** An embedded entry to a file of its own in `folder` (or, linked, just out of its parent). */
  | { readonly kind: "extract"; readonly from: BodyRef; readonly index: number; readonly folder: string; readonly linked: boolean }
  | { readonly kind: "refused"; readonly reason: string };

const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
const refused = (reason: string): DropPlan => ({ kind: "refused", reason });

/** Why the body can't hold entries, or null. */
function whyNotHolder(b: PlaylistBody | null): string | null {
  if (!b) return "that playlist can't be read";
  if (b.type === "clip") return "a Clip plays one sample and holds no playlists";
  if (b.type === "sequence") return "a Sequence takes playlists on its timeline (M5)";
  return null;
}

const isPrefix = (a: readonly number[], b: readonly number[]) => a.length <= b.length && a.every((x, i) => b[i] === x);

/** What dropping `source` on `target` in `zone` does. `load` reads a playlist file's body (null when it can't). */
export function planDrop(source: DragSource, target: DropTarget, zone: DropZone, load: (path: string) => PlaylistBody | null): DropPlan {
  // Where it goes: a folder, or a playlist body and an index in it.
  let folder: string | null = null;
  let into: BodyRef | null = null;
  let at = 0;
  if (target.kind === "root") folder = "";
  else if (target.kind === "folder") folder = target.path;
  else if (target.kind === "file") {
    if (zone === "into") {
      into = { file: target.path, indices: [] };
      at = Number.POSITIVE_INFINITY;
    } else folder = folderOf(target.path);
  } else if (zone === "into") {
    into = target.link ? { file: target.link, indices: [] } : { file: target.file, indices: [...target.parent, target.index] };
    at = Number.POSITIVE_INFINITY;
  } else {
    into = { file: target.file, indices: target.parent };
    at = zone === "before" ? target.index : target.index + 1;
  }

  if (source.kind === "folder") {
    if (folder === null) return refused("a folder goes into another folder");
    if (within(folder, source.path)) return refused(`${source.path} can't go inside itself`);
    if (folderOf(source.path) === folder) return refused("it's in that folder already");
    return { kind: "moveFolder", path: source.path, to: folder };
  }

  if (folder !== null) {
    if (source.kind === "file") {
      if (folderOf(source.path) === folder) return refused("it's in that folder already");
      return { kind: "moveFile", path: source.path, to: folder };
    }
    return { kind: "extract", from: { file: source.file, indices: source.parent }, index: source.index, folder, linked: source.link !== null };
  }

  const ref = into!;
  const holder = load(ref.file);
  const parentBody = holder ? bodyAt(holder, ref.indices) : null;
  const why = whyNotHolder(parentBody);
  if (why) return refused(why);
  const end = parentBody!.entries.length;
  const index = Math.min(at, end);

  if (source.kind === "file") {
    if (source.path === ref.file) return refused("a playlist can't contain itself");
    if (wouldContain(ref.file, source.path, load)) return refused(`it would contain itself: ${source.path} already holds ${ref.file}`);
    return { kind: "link", path: source.path, into: ref, at: index };
  }

  // An entry.
  const fromRef: BodyRef = { file: source.file, indices: source.parent };
  const sameFile = source.file === ref.file;
  const own = [...source.parent, source.index];
  if (sameFile && isPrefix(own, ref.indices)) return refused("a playlist can't go inside itself");
  if (sameFile && ref.indices.length === source.parent.length && isPrefix(source.parent, ref.indices)) {
    // A reorder in the same parent.
    const to = index > source.index ? index - 1 : index;
    if (to === source.index) return refused("it's there already");
    return { kind: "moveEntry", from: fromRef, index: source.index, into: ref, at: to };
  }
  if (!sameFile) {
    const fromBody = load(source.file);
    const entry = fromBody ? bodyAt(fromBody, source.parent)?.entries[source.index] : undefined;
    if (!entry) return refused("that entry isn't there any more");
    const candidate = entry.kind === "linked" ? entry.playlist : entry.kind === "embedded" ? entry.embedded : null;
    if (candidate && wouldContain(ref.file, candidate, load)) return refused(`it would contain itself: it holds ${ref.file}`);
  } else if (source.link && wouldContain(ref.file, source.link, load)) return refused(`it would contain itself: ${source.link} holds ${ref.file}`);
  return { kind: "moveEntry", from: fromRef, index: source.index, into: ref, at: index };
}

/** The undo label of a plan (the prototype's words). */
export function dropLabel(plan: DropPlan, name: string, intoName: string): string {
  switch (plan.kind) {
    case "moveFolder": return `Move folder ${name}`;
    case "moveFile": return `Move to ${plan.to || "the top level"}`;
    case "link": return `Move ${name} into ${intoName}`;
    case "moveEntry": return plan.from.file === plan.into.file && plan.from.indices.join() === plan.into.indices.join() ? "Reorder entries" : `Move ${name} into ${intoName}`;
    case "extract": return `Move ${name} to top level`;
    case "refused": return `Move ${name}`;
  }
}
