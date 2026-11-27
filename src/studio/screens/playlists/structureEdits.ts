// Edits that change where playlists live (ADR 0343; the prototype's tree moves and deletes, PL:926–957, 1430–1459):
// moving an entry between parents (in one file or across two), taking an embedded entry out to be a file of its own,
// and planning a delete with the prototype's choices (children: move them up or delete them; links: unlink the copies
// or remove them). Multi-file changes come back as one result per file; the screen applies each as an undo step of its
// file's document. Pure.
import { emptyPlaylistBody } from "../../../engine/audio/playlist/format";
import type { Entry, PlaylistBody } from "../../../engine/audio/playlist/types";
import { accept, refuse, type EditResult } from "../../../editor/sdk/editResult";
import { addEntries, moveEntry, removeEntry, spliceUp, type EditContext } from "./playlistEdits";
import { bodyAt, editAt } from "./playlistPaths";
import type { BodyRef } from "./treeDrop";

/** Insert `entries` into the body at `indices` at index `at` (the end when past it); a Blend places them, x/y from elsewhere are dropped. */
export function insertEntries<T extends PlaylistBody>(root: T, indices: readonly number[], at: number, entries: readonly Entry[], ctx: EditContext, keepPosition = false): EditResult<T> {
  return editAt(root, indices, (b) => {
    const clean = keepPosition ? [...entries] : entries.map(({ x: _x, y: _y, ...e }) => e as Entry);
    const added = addEntries(b, clean, ctx);
    if ("refused" in added) return added;
    const n = clean.length;
    const next = added.next;
    const from = next.entries.length - n;
    const to = Math.min(at, from);
    if (to === from) return added;
    const list = [...next.entries];
    const moved = list.splice(from, n);
    list.splice(to, 0, ...moved);
    // A Switch's map points at indices: those at or after `to` shift by n.
    const sw = next.switch && { ...next.switch, map: Object.fromEntries(Object.entries(next.switch.map).map(([l, i]) => [l, i !== null && i >= to ? i + n : i])) };
    return accept({ ...next, entries: list, switch: sw });
  });
}

/** Take entry `index` out of the body at `indices`: the root without it, and the entry. */
export function takeEntry<T extends PlaylistBody>(root: T, indices: readonly number[], index: number): EditResult<{ root: T; entry: Entry }> {
  const parent = bodyAt(root, indices);
  const entry = parent?.entries[index];
  if (!entry) return refuse("that entry isn't there any more");
  const r = editAt(root, indices, (b) => removeEntry(b, index));
  return "refused" in r ? r : accept({ root: r.next, entry });
}

/** Where `indices` (a body path) ends up after entry `index` of the body at `parent` is removed. Null when it was inside it. */
export function shiftAfterRemoval(indices: readonly number[], parent: readonly number[], index: number): number[] | null {
  if (indices.length <= parent.length || !parent.every((p, i) => indices[i] === p)) return [...indices];
  const k = indices[parent.length]!;
  if (k === index) return null;
  const out = [...indices];
  if (k > index) out[parent.length] = k - 1;
  return out;
}

/** Move an entry within one file, from the body at `from` to the body at `into`, at index `at` (in the same parent: its index after the move, so a Switch's map follows it). */
export function moveWithinFile<T extends PlaylistBody>(root: T, from: readonly number[], index: number, into: readonly number[], at: number, ctx: EditContext): EditResult<T> {
  if (into.length === from.length && into.every((x, i) => x === from[i])) return editAt(root, from, (b) => moveEntry(b, index, at));
  const taken = takeEntry(root, from, index);
  if ("refused" in taken) return taken;
  const target = shiftAfterRemoval(into, from, index);
  if (!target) return refuse("a playlist can't go inside itself");
  return insertEntries(taken.next.root, target, at, [taken.next.entry], ctx);
}

/** Move an entry across two files: the source without it and the target with it. */
export function moveAcrossFiles<A extends PlaylistBody, B extends PlaylistBody>(source: A, from: BodyRef, index: number, target: B, into: BodyRef, at: number, ctx: EditContext): EditResult<{ source: A; target: B }> {
  const taken = takeEntry(source, from.indices, index);
  if ("refused" in taken) return taken;
  const placed = insertEntries(target, into.indices, at, [taken.next.entry], ctx);
  return "refused" in placed ? placed : accept({ source: taken.next.root, target: placed.next });
}

// --- links -----------------------------------------------------------------------------------------------------------

/** How many entries, at any depth, link `path`. */
export function countLinks(body: PlaylistBody, path: string): number {
  let n = 0;
  for (const e of body.entries) {
    if (e.kind === "linked" && e.playlist === path) n++;
    else if (e.kind === "embedded") n += countLinks(e.embedded, path);
  }
  return n;
}

/**
 * `body` with every entry linking `path` (at any depth) unlinked into an embedded copy of `linked` ("unlink copies:
 * each keeps its own playlist"), or removed ("remove from all"; a Switch's labels that played one then play nothing).
 * `body` itself when nothing links it.
 */
export function replaceLinks<T extends PlaylistBody>(body: T, path: string, mode: "unlink" | "remove", linked: PlaylistBody | null): T {
  if (countLinks(body, path) === 0) return body;
  let b: PlaylistBody = body;
  for (let i = b.entries.length - 1; i >= 0; i--) {
    const e = b.entries[i]!;
    if (e.kind === "linked" && e.playlist === path) {
      if (mode === "remove" || !linked) {
        const r = removeEntry(b, i);
        if ("next" in r) b = r.next;
      } else {
        const { format: _f, ...copy } = linked as PlaylistBody & { format?: string };
        const { kind: _k, playlist: _p, ...use } = e;
        const entries = [...b.entries];
        entries[i] = { ...use, kind: "embedded", embedded: structuredClone(copy) };
        b = { ...b, entries };
      }
    } else if (e.kind === "embedded") {
      const inner = replaceLinks(e.embedded, path, mode, linked);
      if (inner !== e.embedded) {
        const entries = [...b.entries];
        entries[i] = { ...e, embedded: inner };
        b = { ...b, entries };
      }
    }
  }
  return b as T;
}

// --- deletes ---------------------------------------------------------------------------------------------------------

export type DeleteTarget =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "entry"; readonly file: string; readonly parent: readonly number[]; readonly index: number };

/** What deleting a playlist touches, and the choices the confirmation offers. */
export interface DeletePlan {
  readonly target: DeleteTarget;
  readonly name: string;
  /** Playlists inside it (embedded or linked entries); a choice when there are any. */
  readonly children: number;
  /** Embedded ones among them (the ones "move them up" keeps as files or entries). */
  readonly embedded: number;
  /** Files linking it (only a file can be linked); a choice when there are any. */
  readonly linkedBy: readonly string[];
}

export type ChildrenChoice = "up" | "all";
export type LinksChoice = "unlink" | "remove";

/** The plan for deleting `target`, given each file's body and who links which file. */
export function planDelete(target: DeleteTarget, name: string, load: (path: string) => PlaylistBody | null, linkedBy: (path: string) => readonly string[]): DeletePlan | null {
  const body = target.kind === "file" ? load(target.path) : (() => {
    const root = load(target.file);
    const e = root ? bodyAt(root, target.parent)?.entries[target.index] : undefined;
    return e && e.kind === "embedded" ? e.embedded : null;
  })();
  if (!body) return target.kind === "file" ? { target, name, children: 0, embedded: 0, linkedBy: linkedBy(target.path).filter((f) => f !== target.path) } : null;
  const inner = body.type === "clip" ? [] : body.entries.filter((e) => e.kind !== "sample");
  return {
    target, name,
    children: inner.length,
    embedded: inner.filter((e) => e.kind === "embedded").length,
    linkedBy: target.kind === "file" ? linkedBy(target.path).filter((f) => f !== target.path) : [],
  };
}

/** Deleting an embedded entry: remove it, or (children "up") put its entries in its place in the parent. */
export function deleteEntry<T extends PlaylistBody>(root: T, parent: readonly number[], index: number, children: ChildrenChoice, ctx: EditContext): EditResult<T> {
  return editAt(root, parent, (b) => {
    const e = b.entries[index];
    if (!e) return refuse("that entry isn't there any more");
    if (children === "up" && e.kind === "embedded" && e.embedded.type !== "clip" && e.embedded.entries.length) return spliceUp(b, index, ctx);
    return removeEntry(b, index);
  });
}

/** The embedded children of a file being deleted with "move them up": each as a body for a file of its own beside it. */
export function childrenToKeep(body: PlaylistBody): { body: PlaylistBody; index: number }[] {
  if (body.type === "clip") return [];
  return body.entries.flatMap((e, index) => (e.kind === "embedded" ? [{ body: e.embedded, index }] : []));
}

/** A new playlist body of the open project's default type (an empty Queue, as the prototype's New playlist). */
export const newPlaylistBody = (): PlaylistBody => emptyPlaylistBody("queue");
