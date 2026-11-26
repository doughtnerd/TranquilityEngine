import { sameTarget, setsProperty } from "../../engine/scene/overrideFold";
import { type ComponentEntry, type NodeEntry, type NodePath, type OverrideEntry, type SceneDocument, type SceneFile } from "./SceneDocument";
import { normalizeAssetPath } from "../../engine/scene/Assets";

/**
 * What a command changed, so the Editor World can catch up incrementally (see `WorldSync`).
 * - `field`: one component field (on a plain node, or a prefab override for the node at `path`)
 * - `name` / `active`: a node's name or active flag (`path`: a node inside a prefab instance, ADR 0122)
 * - `rebuild`: re-create the subtree rooted at a document node
 * - `add` / `remove`: a subtree was added to or removed from the document
 * - `move`: a node got a new parent or sibling position
 */
export type Change =
  | { readonly kind: "field"; readonly path: NodePath; readonly type: string; readonly index: number; readonly field: string }
  | { readonly kind: "name" | "active"; readonly node: string; readonly path?: NodePath }
  | { readonly kind: "rebuild" | "add" | "remove" | "move"; readonly node: string };

/** A text file a command writes besides the scene: its whole new text, or null to delete it. */
export interface FileWrite {
  readonly path: string;
  readonly text: string | null;
}

/**
 * An edit of a SceneDocument (ADR 0026, 0321): a label, an `apply` that changes the document in
 * place and returns what changed, and optional text file writes. A command doesn't undo itself:
 * `CommandStack.execute` runs it and records the step as a patch of the document, and undo, redo
 * and jumps apply those patches (ADR 0027).
 */
export interface Command {
  readonly label: string;
  apply(doc: SceneDocument): Change[];
  /**
   * Text files the command writes besides the scene (a Svelte component's source, ADR
   * 0077). The CommandStack writes them through its `files` host and records the change in the
   * step, so undo and redo write them back in order with scene edits.
   */
  readonly files?: readonly FileWrite[];
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

/**
 * Set `key` on `obj`, an entry of the document a command is editing. A key that isn't there yet
 * goes right after the last of `after` that is (e.g. `parent` after `id`/`name`), so new keys land
 * where a person would write them.
 */
export function setKey<T extends object>(obj: T, key: string, value: unknown, after: readonly string[]): void {
  const o = obj as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(o, key)) {
    o[key] = value;
    return;
  }
  const keys = Object.keys(o);
  const anchor = Math.max(-1, ...after.map((a) => keys.indexOf(a)));
  const entries = Object.entries(o);
  entries.splice(anchor + 1, 0, [key, value]);
  for (const k of keys) delete o[k];
  for (const [k, v] of entries) o[k] = v;
}

// --- fields -----------------------------------------------------------------------------------

export interface SetFieldOptions {
  /** Which component of the type, when a node has several. Default 0. */
  index?: number;
  /** Path of node ids inside a prefab instance; only for prefab instances. Default: the instance root. */
  target?: readonly string[];
}

/**
 * Set a component field. On a plain node it writes the component's `data`; on a prefab instance
 * it writes (or replaces) an override. Setting `engine.Transform` on a plain node without a
 * Transform entry adds one. `value` is scene-file JSON (`[x, y, z]`, `"#rrggbb"`, `{"$node": id}`).
 */
export class SetField implements Command {
  readonly label: string;
  private readonly index: number;
  private readonly target: readonly string[];

  constructor(readonly node: string, readonly type: string, readonly field: string, readonly value: unknown, options: SetFieldOptions = {}) {
    this.index = options.index ?? 0;
    this.target = options.target ?? [];
    this.label = `Set ${field}`;
  }

  apply(doc: SceneDocument): Change[] {
    const entry = doc.node(this.node);
    if (entry.prefab) this.applyOverride(entry);
    else {
      if (this.target.length) throw new Error(`"${this.node}" is not a prefab instance; a target path only applies to overrides.`);
      this.applyData(doc, entry);
    }
    return [{ kind: "field", path: [this.node, ...this.target], type: this.type, index: this.index, field: this.field }];
  }

  private applyData(doc: SceneDocument, entry: NodeEntry): void {
    let pos = doc.componentPosition(this.node, this.type, this.index);
    if (pos < 0) {
      if (this.type !== "engine.Transform" || this.index !== 0) throw new Error(`"${this.node}" has no component "${this.type}" (#${this.index}).`);
      entry.components ??= [];
      entry.components.unshift({ type: "engine.Transform" });
      pos = 0;
    }
    const c = entry.components![pos];
    c.data ??= {};
    c.data[this.field] = clone(this.value);
  }

  private applyOverride(entry: NodeEntry): void {
    const list = (entry.overrides ??= []);
    const field = { kind: "field", type: this.type, index: this.index, field: this.field } as const;
    const pos = list.findIndex((o) => setsProperty(o, field) && sameTarget(o.target, this.target));
    if (pos >= 0) {
      list[pos].value = clone(this.value);
      return;
    }
    const o: OverrideEntry = {};
    if (this.target.length) o.target = [...this.target];
    o.component = this.type;
    if (this.index) o.index = this.index;
    o.field = this.field;
    o.value = clone(this.value);
    list.push(o);
  }
}

// --- node properties --------------------------------------------------------------------------

/** Rename a node. On a prefab instance this sets the instance's name. */
export class RenameNode implements Command {
  readonly label = "Rename";
  constructor(readonly node: string, readonly name: string) {}

  apply(doc: SceneDocument): Change[] {
    setKey(doc.node(this.node), "name", this.name, ["id"]);
    return [{ kind: "name", node: this.node }];
  }
}

/**
 * Set the scene's `settings.preload` list (ADR 0080). An empty list removes the key, and `settings`
 * goes too when nothing else is in it; a new `settings` goes before `nodes`, where a person would
 * write it.
 */
export class SetScenePreload implements Command {
  readonly label: string;
  readonly paths: readonly string[];
  constructor(paths: readonly string[], label = "Change Preload List") {
    this.paths = [...new Set(paths.map((p) => normalizeAssetPath(p.trim())).filter(Boolean))];
    this.label = label;
  }

  apply(doc: SceneDocument): Change[] {
    const file = doc._file;
    const settings: Record<string, unknown> = { ...(file.settings ?? {}) };
    if (this.paths.length) settings.preload = [...this.paths];
    else delete settings.preload;
    if (Object.keys(settings).length) setKey(file, "settings", settings, ["format"]);
    else delete (file as { settings?: unknown }).settings;
    return []; // nothing in the World changes: the warm-up reads the list when the scene loads
  }
}

/** Activate or deactivate a node. Active is the default, so `true` removes the `active` key. */
export class SetActive implements Command {
  readonly label: string;
  constructor(readonly node: string, readonly active: boolean) {
    this.label = active ? "Activate" : "Deactivate";
  }

  apply(doc: SceneDocument): Change[] {
    const entry = doc.node(this.node);
    if (this.active) delete entry.active;
    else setKey(entry, "active", false, ["id", "name", "parent"]);
    return [{ kind: "active", node: this.node }];
  }
}

// --- structure --------------------------------------------------------------------------------

/** File-array position for a node placed at `index` among `parent`'s children (excluding `self`). */
function insertionPoint(doc: SceneDocument, parent: string | null, index: number | undefined, self?: string): number {
  const entries = doc._entries;
  const siblings = doc.children(parent).filter((id) => id !== self);
  if (index === undefined || index >= siblings.length) {
    if (!siblings.length) {
      // No siblings: right after the parent (or at the end for a top-level node).
      if (parent === null) return entries.length;
      const subtree = doc.subtree(parent).filter((id) => id !== self);
      const last = subtree[subtree.length - 1];
      return entries.findIndex((n) => n.id === last) + 1;
    }
    const last = siblings[siblings.length - 1];
    return entries.findIndex((n) => n.id === last) + 1;
  }
  const before = siblings[Math.max(0, index)];
  return entries.findIndex((n) => n.id === before);
}

export interface AddNodeOptions {
  /** Parent id; null or omitted for a top-level node. */
  parent?: string | null;
  /** Position among the parent's children; omitted: last. */
  index?: number;
}

/**
 * Add a node, or a subtree: `entries[0]` is the new node and the rest are its descendants
 * (their `parent` fields must point inside the subtree). Entries are copied.
 */
export class AddNode implements Command {
  readonly label = "Add node";
  private readonly entries: NodeEntry[];
  constructor(entries: NodeEntry | readonly NodeEntry[], readonly options: AddNodeOptions = {}) {
    this.entries = (Array.isArray(entries) ? entries : [entries]).map((e) => structuredClone(e));
  }

  get id(): string {
    return this.entries[0].id;
  }

  apply(doc: SceneDocument): Change[] {
    for (const e of this.entries) if (doc.has(e.id)) throw new Error(`A node with id "${e.id}" already exists.`);
    const parent = this.options.parent ?? null;
    if (parent !== null) doc.node(parent);
    const [root, ...rest] = this.entries.map((e) => structuredClone(e));
    if (parent === null) delete root.parent;
    else setKey(root, "parent", parent, ["id", "name"]);
    const at = insertionPoint(doc, parent, this.options.index);
    doc._entries.splice(at, 0, root, ...rest);
    doc._reindex();
    return [{ kind: "add", node: root.id }];
  }
}

/** Remove a node and its subtree. */
export class RemoveNode implements Command {
  readonly label = "Remove node";
  constructor(readonly node: string) {}

  apply(doc: SceneDocument): Change[] {
    const ids = new Set(doc.subtree(this.node));
    const entries = doc._entries;
    for (let i = entries.length - 1; i >= 0; i--) if (ids.has(entries[i].id)) entries.splice(i, 1);
    doc._reindex();
    return [{ kind: "remove", node: this.node }];
  }
}

/**
 * Move a node to a new parent (null: top level) at `index` among its new siblings (omitted:
 * last). The local transform is kept as authored. Moving a node under its own descendant throws.
 */
export class ReparentNode implements Command {
  readonly label = "Reparent";
  constructor(readonly node: string, readonly parent: string | null, readonly index?: number) {}

  apply(doc: SceneDocument): Change[] {
    if (this.parent !== null && doc.subtree(this.node).includes(this.parent)) throw new Error(`Can't move "${this.node}" under its own descendant "${this.parent}".`);
    const entries = doc._entries;
    const entry = doc.node(this.node);
    const from = entries.indexOf(entry);
    const at = insertionPoint(doc, this.parent, this.index, this.node);
    entries.splice(from, 1);
    entries.splice(at > from ? at - 1 : at, 0, entry);
    if (this.parent === null) delete entry.parent;
    else setKey(entry, "parent", this.parent, ["id", "name"]);
    return [{ kind: "move", node: this.node }];
  }
}

// --- components -------------------------------------------------------------------------------

/** The component entry at `position` in a plain node's components list; throws when there's none. */
function componentAt(doc: SceneDocument, node: string, position: number): ComponentEntry {
  const entry = doc.node(node).components?.[position];
  if (!entry) throw new Error(`"${node}" has no component at position ${position}.`);
  return entry;
}

/** Add a component to a plain node at `position` in its components list (omitted: last). */
export class AddComponent implements Command {
  readonly label: string;
  private readonly entry: ComponentEntry;
  constructor(readonly node: string, entry: ComponentEntry, readonly position?: number) {
    this.entry = structuredClone(entry);
    this.label = `Add ${entry.type}`;
  }

  apply(doc: SceneDocument): Change[] {
    const node = doc.node(this.node);
    if (node.prefab) throw new Error(`"${this.node}" is a prefab instance; add components to the prefab or via an override.`);
    const list = (node.components ??= []);
    list.splice(this.position === undefined ? list.length : Math.min(this.position, list.length), 0, structuredClone(this.entry));
    return [{ kind: "rebuild", node: this.node }];
  }
}

/** Remove the component at `position` in a plain node's components list. */
export class RemoveComponent implements Command {
  readonly label = "Remove component";
  constructor(readonly node: string, readonly position: number) {}

  apply(doc: SceneDocument): Change[] {
    componentAt(doc, this.node, this.position);
    doc.node(this.node).components!.splice(this.position, 1);
    return [{ kind: "rebuild", node: this.node }];
  }
}

/** Start the component at `position` in a plain node's list enabled or disabled (`enabled: false` in the file; enabled is the default and leaves no key). */
export class SetComponentEnabled implements Command {
  readonly label: string;
  constructor(readonly node: string, readonly position: number, readonly enabled: boolean) {
    this.label = enabled ? "Enable component" : "Disable component";
  }

  apply(doc: SceneDocument): Change[] {
    const entry = componentAt(doc, this.node, this.position);
    if (this.enabled) delete entry.enabled;
    else setKey(entry, "enabled", false, ["type"]);
    return [{ kind: "rebuild", node: this.node }];
  }
}

/** Move the component at `from` in a plain node's list so it ends up at `to` (an index into the list after it's taken out). */
export class MoveComponent implements Command {
  readonly label = "Reorder components";
  constructor(readonly node: string, readonly from: number, readonly to: number) {}

  apply(doc: SceneDocument): Change[] {
    const { from, to } = this;
    const list = doc.node(this.node).components ?? [];
    if (from < 0 || from >= list.length || to < 0 || to >= list.length) throw new Error(`"${this.node}": can't move component ${from} to ${to}.`);
    const [entry] = list.splice(from, 1);
    list.splice(to, 0, entry);
    return [{ kind: "rebuild", node: this.node }];
  }
}

/** Replace a plain node's components list (e.g. reordered as a whole). */
export class SetComponents implements Command {
  readonly label = "Reorder components";
  constructor(readonly node: string, private readonly components: readonly ComponentEntry[]) {}

  apply(doc: SceneDocument): Change[] {
    doc.node(this.node).components = structuredClone([...this.components]);
    return [{ kind: "rebuild", node: this.node }];
  }
}

/**
 * Replace the whole document with `next` (an edit made outside the command set, e.g. taking a
 * deleted asset out of it). Every top-level node, before and after, is rebuilt.
 */
export class ReplaceDocument implements Command {
  constructor(private readonly next: SceneFile, readonly label: string) {}

  apply(doc: SceneDocument): Change[] {
    const roots = new Set(doc.roots());
    doc._replace(structuredClone(this.next));
    for (const id of doc.roots()) roots.add(id);
    return [...roots].map((node) => ({ kind: "rebuild", node }) as const);
  }
}

// --- text files -------------------------------------------------------------------------------

/**
 * Write text files (ADR 0077, 0419: a Svelte component's source) as one step. The scene
 * doesn't change; the stack records each file's change and writes it back on undo and redo.
 */
export class WriteFiles implements Command {
  constructor(
    readonly label: string,
    readonly files: readonly FileWrite[],
  ) {}

  apply(): Change[] {
    return [];
  }
}
