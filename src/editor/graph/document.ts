// The graph document (ADR 0228): the edits every graph editor makes the same way, whatever its
// nodes are. Properties on the Blackboard, groups, sticky notes, copy, paste and duplicate are
// written once here; a graph kind (the Shader Graph's, the Particle Graph's) plugs in only what is
// its own through a `GraphDocumentKind`: where its groups and notes are stored, which nodes read a
// property, what a copy holds and how a paste gives the copied items new ids.
//
// Every edit is a pure function from one graph to the next, so a panel's undo history is a list of
// graphs. None changes its input, and an edit that changes nothing returns the graph it was given
// (so it adds no undo step).
import { readClipboard, type ClipboardPayload } from "../clipboard";
import type { NoteData } from "./canvas";
import { uniqueName } from "../../engine/core/uniqueName";

/** A position or size on the canvas, in graph units. */
export type GraphVec = [number, number];

/** A group as the graph document reads and writes it: a titled box around items. */
export interface GraphGroupData {
  id: string;
  title: string;
  /** The ids of the items in it. */
  members: string[];
}

/** A sticky note as the graph document reads and writes it. */
export interface GraphNoteData extends NoteData {
  id: string;
}

/** A Blackboard property: a named, typed value that property nodes read. */
export interface GraphPropertyData {
  name: string;
  type: string;
  value: unknown;
}

/** How a graph kind stores a list the document edits (its groups or its notes). */
export interface GraphListAccess<G, T> {
  get(graph: G): readonly T[];
  /** Store `list` in `graph` (a copy the document is changing). */
  set(graph: G, list: T[]): void;
}

/** What a graph kind plugs into the graph document. */
export interface GraphDocumentKind<G extends { nodes: N[]; properties: P[] }, N extends { id: string }, P extends GraphPropertyData, C extends ClipboardPayload> {
  /** The ids of the canvas items a selection, a group and a copy can hold, in drawing order. */
  items(graph: G): readonly string[];
  /** Remove items with everything wired to them and their group memberships (unchanged if none is there). */
  remove(graph: G, ids: Iterable<string>): G;
  /** A new group or note id the graph doesn't use. */
  newId(graph: G, of: "group" | "note"): string;
  groups: GraphListAccess<G, GraphGroupData>;
  notes: GraphListAccess<G, GraphNoteData>;
  property: {
    /** A property type's name, which a new property is named after: `Color`, `Color 2`… */
    label(type: P["type"]): string;
    /** A new property of `type` with its default value. */
    create(name: string, type: P["type"]): P;
    /** Whether `node` is a property node reading the property `name`. */
    reads(node: N, name: string): boolean;
    /** Point a property node at the property `name` (on a copy the document is changing). */
    retarget(node: N, name: string): void;
  };
  clipboard: {
    /** The clipboard text's format tag (ADR 0226), such as `myco.shadergraph.clipboard@1`. */
    format: C["format"];
    /** What a copy of the items `ids` holds, without its format tag; null if it holds nothing. */
    copy(graph: G, ids: ReadonlySet<string>): Omit<C, "format"> | null;
    /** A payload read from clipboard text (its format already checked), well formed; null if it isn't. May throw. */
    read(raw: C): C | null;
    /** The positions of the copied items, whose top-left corner a paste puts where it lands. */
    positions(clip: C): readonly (readonly [number, number])[];
    /** Add the copied items to `graph` (a copy the document is changing) with new ids, moved `by`; the new ids. */
    paste(graph: G, clip: C, by: GraphVec): string[];
  };
}

/** The edits a graph kind gets from `graphDocument`. */
export interface GraphDocument<G, P extends GraphPropertyData, C extends ClipboardPayload> {
  /** The format tag of this kind's clipboard text. */
  readonly clipboardFormat: C["format"];
  /** The ids of the canvas items, as the kind lists them (what Select All selects). */
  items(graph: G): readonly string[];
  /** Remove items with everything wired to them (the kind's rules). */
  remove(graph: G, ids: Iterable<string>): G;
  /** The graph's groups, as the document reads them (find and group drags read their members). */
  groups(graph: G): readonly GraphGroupData[];
  /** The graph's sticky notes. */
  notes(graph: G): readonly GraphNoteData[];

  /** Add a property of `type`, named after it (`Number`, `Number 2`…). */
  addProperty(graph: G, type: P["type"]): { graph: G; name: string };
  /** Why the property `from` (null: a new one) can't be named `name`, or null if it can. */
  whyNotPropertyName(graph: G, from: string | null, name: string): string | null;
  /** Rename a property and the property nodes reading it (unchanged if the name isn't allowed). */
  renameProperty(graph: G, from: string, to: string): G;
  /** Remove a property and the property nodes reading it, with their wires. */
  removeProperty(graph: G, name: string): G;
  /** Move a property up (-1) or down (1) the Blackboard. */
  moveProperty(graph: G, name: string, by: -1 | 1): G;
  /** Set a property's value. */
  setPropertyValue(graph: G, name: string, value: P["value"]): G;

  /** Put items in a new group, taking them out of any other; null id if none of them is there. */
  group(graph: G, ids: Iterable<string>, title?: string): { graph: G; id: string | null };
  /** Remove a group (its items stay). */
  ungroup(graph: G, id: string): G;
  setGroupTitle(graph: G, id: string, title: string): G;

  /** Add a sticky note at `position`. */
  addNote(graph: G, position: readonly [number, number], text?: string): { graph: G; id: string };
  /** Change a note's text, position or size (positions round to whole units; a note is at least 80 × 40). */
  updateNote(graph: G, id: string, patch: Partial<NoteData>): G;
  removeNote(graph: G, id: string): G;

  /** Copy items with what they need (the wires among them, the properties they read…); null if none is copyable. */
  copy(graph: G, ids: Iterable<string>): C | null;
  /** The copied items in system clipboard text (ADR 0226), or null if it holds none or they're malformed. */
  clipboardFromText(text: string): C | null;
  /** Paste copied items with new ids, their top-left corner at `at`, keeping the wires among them. */
  paste(graph: G, clip: C, at: readonly [number, number]): { graph: G; ids: string[] };
  /** Copies of items, `offset` from where they are. */
  duplicate(graph: G, ids: Iterable<string>, offset?: GraphVec): { graph: G; ids: string[] };
}

/** How far Duplicate (Ctrl+D) puts the copies from the originals, in graph units. */
export const DUPLICATE_OFFSET: GraphVec = [40, 40];

/** The smallest a note can be resized to. */
const NOTE_MIN: GraphVec = [80, 40];

/** The first of `prefix1`, `prefix2`… that `taken` doesn't hold (never the bare prefix, unlike `uniqueName`). */
export function freeId(prefix: string, taken: (id: string) => boolean): string {
  for (let i = 1; ; i++) if (!taken(`${prefix}${i}`)) return `${prefix}${i}`;
}

const clone = <T>(v: T): T => structuredClone(v);
const round = (p: readonly number[]): GraphVec => [Math.round(p[0]), Math.round(p[1])];

/**
 * Add to `properties` (a graph's Blackboard, changed in place) the properties a paste carries, as
 * Unity's VFX Graph does when nodes reading Blackboard properties are pasted. A property the graph
 * already has with the same name and type is the one the pasted nodes read (its value is kept). One
 * it lacks is added. One whose name the graph uses for a property of another type is added under a
 * free name (`Speed 2`), never one the paste also carries. Returns those renames (copied name → name
 * in the graph), for the paste to point its property nodes at.
 */
export function pasteProperties<P extends GraphPropertyData>(properties: P[], carried: readonly P[] | undefined): Map<string, string> {
  const renames = new Map<string, string>();
  const taken = new Set([...properties, ...(carried ?? [])].map((p) => p.name));
  for (const p of carried ?? []) {
    const same = properties.find((q) => q.name === p.name);
    if (same?.type === p.type) continue;
    const name = same ? uniqueName(p.name, taken) : p.name;
    taken.add(name);
    if (name !== p.name) renames.set(p.name, name);
    properties.push({ ...clone(p), name });
  }
  return renames;
}


/** The graph document edits for one kind of graph. */
export function graphDocument<G extends { nodes: N[]; properties: P[] }, N extends { id: string }, P extends GraphPropertyData, C extends ClipboardPayload>(
  kind: GraphDocumentKind<G, N, P, C>,
): GraphDocument<G, P, C> {
  const editProperty = (graph: G, name: string, edit: (p: P, g: G) => void): G => {
    const i = graph.properties.findIndex((p) => p.name === name);
    if (i < 0) return graph;
    const g = clone(graph);
    edit(g.properties[i], g);
    return g;
  };

  const whyNotPropertyName = (graph: G, from: string | null, name: string): string | null => {
    if (!name.trim()) return "a property needs a name";
    if (name !== name.trim()) return "a name can't start or end with a space";
    if (name !== from && graph.properties.some((p) => p.name === name)) return `there's already a property named "${name}"`;
    return null;
  };

  const copy = (graph: G, ids: Iterable<string>): C | null => {
    const body = kind.clipboard.copy(graph, new Set(ids));
    return body ? ({ format: kind.clipboard.format, ...body } as C) : null;
  };

  const topLeft = (clip: C): GraphVec | null => {
    const at = kind.clipboard.positions(clip);
    return at.length ? [Math.min(...at.map((p) => p[0])), Math.min(...at.map((p) => p[1]))] : null;
  };

  const paste = (graph: G, clip: C, at: readonly [number, number]): { graph: G; ids: string[] } => {
    const corner = topLeft(clip);
    if (!corner) return { graph, ids: [] };
    const g = clone(graph);
    const ids = kind.clipboard.paste(g, clip, [at[0] - corner[0], at[1] - corner[1]]);
    return ids.length ? { graph: g, ids } : { graph, ids: [] };
  };

  return {
    clipboardFormat: kind.clipboard.format,
    items: (graph) => kind.items(graph),
    remove: (graph, ids) => kind.remove(graph, ids),
    groups: (graph) => kind.groups.get(graph),
    notes: (graph) => kind.notes.get(graph),

    // --- properties -------------------------------------------------------------------------------------

    addProperty(graph, type) {
      const name = uniqueName(kind.property.label(type), graph.properties.map((p) => p.name)); // `Color`, `Color 2`…
      const g = clone(graph);
      g.properties.push(kind.property.create(name, type));
      return { graph: g, name };
    },
    whyNotPropertyName,
    renameProperty(graph, from, to) {
      if (from === to || whyNotPropertyName(graph, from, to)) return graph;
      return editProperty(graph, from, (p, g) => {
        p.name = to;
        for (const n of g.nodes) if (kind.property.reads(n, from)) kind.property.retarget(n, to);
      });
    },
    removeProperty(graph, name) {
      if (!graph.properties.some((p) => p.name === name)) return graph;
      const readers = graph.nodes.filter((n) => kind.property.reads(n, name)).map((n) => n.id);
      const g = clone(kind.remove(graph, readers));
      g.properties = g.properties.filter((p) => p.name !== name);
      return g;
    },
    moveProperty(graph, name, by) {
      const i = graph.properties.findIndex((p) => p.name === name);
      const j = i + by;
      if (i < 0 || j < 0 || j >= graph.properties.length) return graph;
      const g = clone(graph);
      [g.properties[i], g.properties[j]] = [g.properties[j], g.properties[i]];
      return g;
    },
    setPropertyValue: (graph, name, value) => editProperty(graph, name, (p) => (p.value = clone(value))),

    // --- groups -----------------------------------------------------------------------------------------

    group(graph, ids, title = "Group") {
      const items = new Set(kind.items(graph));
      const members = [...new Set(ids)].filter((id) => items.has(id));
      if (members.length === 0) return { graph, id: null };
      const id = kind.newId(graph, "group");
      const g = clone(graph);
      const groups = kind.groups
        .get(g)
        .map((gr) => ({ ...gr, members: gr.members.filter((m) => !members.includes(m)) }))
        .filter((gr) => gr.members.length > 0);
      groups.push({ id, title, members });
      kind.groups.set(g, groups);
      return { graph: g, id };
    },
    ungroup(graph, id) {
      if (!kind.groups.get(graph).some((gr) => gr.id === id)) return graph;
      const g = clone(graph);
      kind.groups.set(g, kind.groups.get(g).filter((gr) => gr.id !== id));
      return g;
    },
    setGroupTitle(graph, id, title) {
      const at = kind.groups.get(graph).find((gr) => gr.id === id);
      if (!at || at.title === title) return graph;
      const g = clone(graph);
      kind.groups.set(g, kind.groups.get(g).map((gr) => (gr.id === id ? { ...gr, title } : gr)));
      return g;
    },

    // --- notes ------------------------------------------------------------------------------------------

    addNote(graph, position, text = "") {
      const id = kind.newId(graph, "note");
      const g = clone(graph);
      kind.notes.set(g, [...kind.notes.get(g), { id, position: round(position), size: [200, 100], text }]);
      return { graph: g, id };
    },
    updateNote(graph, id, patch) {
      const before = kind.notes.get(graph).find((n) => n.id === id);
      if (!before) return graph;
      const n: GraphNoteData = clone(before);
      if (patch.position) n.position = round(patch.position);
      if (patch.size) n.size = [Math.max(NOTE_MIN[0], Math.round(patch.size[0])), Math.max(NOTE_MIN[1], Math.round(patch.size[1]))];
      if (patch.text !== undefined) n.text = patch.text;
      if (JSON.stringify(n) === JSON.stringify(before)) return graph;
      const g = clone(graph);
      kind.notes.set(g, kind.notes.get(g).map((x) => (x.id === id ? n : x)));
      return g;
    },
    removeNote(graph, id) {
      if (!kind.notes.get(graph).some((n) => n.id === id)) return graph;
      const g = clone(graph);
      kind.notes.set(g, kind.notes.get(g).filter((n) => n.id !== id));
      return g;
    },

    // --- copy, paste, duplicate -------------------------------------------------------------------------

    copy,
    clipboardFromText(text) {
      const raw = readClipboard<C>(text, kind.clipboard.format);
      if (!raw) return null;
      try {
        return kind.clipboard.read(raw);
      } catch {
        return null;
      }
    },
    paste,
    duplicate(graph, ids, offset = DUPLICATE_OFFSET) {
      const clip = copy(graph, ids);
      const corner = clip && topLeft(clip);
      if (!clip || !corner) return { graph, ids: [] };
      return paste(graph, clip, [corner[0] + offset[0], corner[1] + offset[1]]);
    },
  };
}
