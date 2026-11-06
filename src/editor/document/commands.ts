import { isFieldOverride, type ComponentEntry, type NodeEntry, type NodePath, type OverrideEntry, type SceneDocument, type SceneFile } from "./SceneDocument";

/**
 * What a command changed, so the Editor World can catch up incrementally (see `WorldSync`).
 * - `field`: one component field (on a plain node, or a prefab override for the node at `path`)
 * - `name` / `active`: a node's name or active flag
 * - `rebuild`: re-create the subtree rooted at a document node
 * - `add` / `remove`: a subtree was added to or removed from the document
 * - `move`: a node got a new parent or sibling position
 */
export type Change =
  | { readonly kind: "field"; readonly path: NodePath; readonly type: string; readonly index: number; readonly field: string }
  | { readonly kind: "name" | "active"; readonly node: string }
  | { readonly kind: "rebuild" | "add" | "remove" | "move"; readonly node: string };

/** A text file a command writes besides the scene: its whole new text, or null to delete it. */
export interface FileWrite {
  readonly path: string;
  readonly text: string | null;
}

/** An undoable edit of a SceneDocument (ADR 0026). `apply` and `undo` return what changed. */
export interface Command {
  readonly label: string;
  apply(doc: SceneDocument): Change[];
  undo(doc: SceneDocument): Change[];
  /**
   * Text files the command writes besides the scene (a UI document's markup and stylesheets, ADR
   * 0077). The CommandStack writes them through its `files` host and records the change in the
   * step, so undo and redo write them back in order with scene edits.
   */
  readonly files?: readonly FileWrite[];
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

/** Shallow copy of an object's own keys, in order, for restoring it exactly on undo. */
function snapshot<T extends object>(obj: T): T {
  return { ...obj };
}

/** Put back every key of `snap` on `target`, in the snapshot's order (keeps file key order on undo). */
function restore<T extends object>(target: T, snap: T): void {
  for (const k of Object.keys(target)) delete (target as Record<string, unknown>)[k];
  Object.assign(target, snap);
}

/**
 * Set `key` on `obj`. A key that isn't there yet goes right after the last of `after` that is
 * (e.g. `parent` after `id`/`name`), so new keys land where a person would write them.
 */
function setKey<T extends object>(obj: T, key: string, value: unknown, after: readonly string[]): void {
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
  private undoState: (() => void) | null = null;

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
    return [this.change()];
  }

  undo(): Change[] {
    this.undoState?.();
    this.undoState = null;
    return [this.change()];
  }

  private change(): Change {
    return { kind: "field", path: [this.node, ...this.target], type: this.type, index: this.index, field: this.field };
  }

  private applyData(doc: SceneDocument, entry: NodeEntry): void {
    let pos = doc.componentPosition(this.node, this.type, this.index);
    const hadComponents = entry.components !== undefined;
    let addedComponent = false;
    if (pos < 0) {
      if (this.type !== "engine.Transform" || this.index !== 0) throw new Error(`"${this.node}" has no component "${this.type}" (#${this.index}).`);
      entry.components ??= [];
      entry.components.unshift({ type: "engine.Transform" });
      pos = 0;
      addedComponent = true;
    }
    const c = entry.components![pos];
    const hadData = c.data !== undefined;
    const hadKey = hadData && Object.prototype.hasOwnProperty.call(c.data, this.field);
    const old = hadKey ? clone(c.data![this.field]) : undefined;
    c.data ??= {};
    c.data[this.field] = clone(this.value);
    this.undoState = () => {
      if (addedComponent) {
        entry.components!.splice(0, 1);
        if (!hadComponents) delete entry.components;
        return;
      }
      if (hadKey) c.data![this.field] = old;
      else {
        delete c.data![this.field];
        if (!hadData) delete c.data;
      }
    };
  }

  private applyOverride(entry: NodeEntry): void {
    const hadList = entry.overrides !== undefined;
    entry.overrides ??= [];
    const list = entry.overrides;
    const pos = list.findIndex((o) => isFieldOverride(o, this.target, this.type, this.field, this.index));
    if (pos >= 0) {
      const old = clone(list[pos].value);
      list[pos].value = clone(this.value);
      this.undoState = () => { list[pos].value = old; };
      return;
    }
    const o: OverrideEntry = {};
    if (this.target.length) o.target = [...this.target];
    o.component = this.type;
    if (this.index) o.index = this.index;
    o.field = this.field;
    o.value = clone(this.value);
    list.push(o);
    this.undoState = () => {
      list.splice(list.indexOf(o), 1);
      if (!hadList) delete entry.overrides;
    };
  }
}

// --- node properties --------------------------------------------------------------------------

/** Rename a node. On a prefab instance this sets the instance's name. */
export class RenameNode implements Command {
  readonly label = "Rename";
  private before: NodeEntry | null = null;
  constructor(readonly node: string, readonly name: string) {}

  apply(doc: SceneDocument): Change[] {
    const entry = doc.node(this.node);
    this.before = snapshot(entry);
    setKey(entry, "name", this.name, ["id"]);
    return [{ kind: "name", node: this.node }];
  }

  undo(doc: SceneDocument): Change[] {
    restore(doc.node(this.node), this.before!);
    return [{ kind: "name", node: this.node }];
  }
}

/** Activate or deactivate a node. Active is the default, so `true` removes the `active` key. */
export class SetActive implements Command {
  readonly label: string;
  private before: NodeEntry | null = null;
  constructor(readonly node: string, readonly active: boolean) {
    this.label = active ? "Activate" : "Deactivate";
  }

  apply(doc: SceneDocument): Change[] {
    const entry = doc.node(this.node);
    this.before = snapshot(entry);
    if (this.active) delete entry.active;
    else setKey(entry, "active", false, ["id", "name", "parent"]);
    return [{ kind: "active", node: this.node }];
  }

  undo(doc: SceneDocument): Change[] {
    restore(doc.node(this.node), this.before!);
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

  undo(doc: SceneDocument): Change[] {
    const ids = new Set(this.entries.map((e) => e.id));
    const entries = doc._entries;
    for (let i = entries.length - 1; i >= 0; i--) if (ids.has(entries[i].id)) entries.splice(i, 1);
    doc._reindex();
    return [{ kind: "remove", node: this.id }];
  }
}

/** Remove a node and its subtree. Undo puts every entry back at its original file position. */
export class RemoveNode implements Command {
  readonly label = "Remove node";
  private removed: { at: number; entry: NodeEntry }[] = [];
  constructor(readonly node: string) {}

  apply(doc: SceneDocument): Change[] {
    const ids = new Set(doc.subtree(this.node));
    const entries = doc._entries;
    this.removed = [];
    entries.forEach((entry, at) => { if (ids.has(entry.id)) this.removed.push({ at, entry }); });
    for (let i = this.removed.length - 1; i >= 0; i--) entries.splice(this.removed[i].at, 1);
    doc._reindex();
    return [{ kind: "remove", node: this.node }];
  }

  undo(doc: SceneDocument): Change[] {
    const entries = doc._entries;
    for (const { at, entry } of this.removed) entries.splice(at, 0, entry);
    doc._reindex();
    return [{ kind: "add", node: this.node }];
  }
}

/**
 * Move a node to a new parent (null: top level) at `index` among its new siblings (omitted:
 * last). The local transform is kept as authored. Moving a node under its own descendant throws.
 */
export class ReparentNode implements Command {
  readonly label = "Reparent";
  private oldAt = -1;
  private before: NodeEntry | null = null;
  constructor(readonly node: string, readonly parent: string | null, readonly index?: number) {}

  apply(doc: SceneDocument): Change[] {
    if (this.parent !== null && doc.subtree(this.node).includes(this.parent)) throw new Error(`Can't move "${this.node}" under its own descendant "${this.parent}".`);
    const entries = doc._entries;
    const entry = doc.node(this.node);
    this.oldAt = entries.indexOf(entry);
    this.before = snapshot(entry);
    const at = insertionPoint(doc, this.parent, this.index, this.node);
    entries.splice(this.oldAt, 1);
    entries.splice(at > this.oldAt ? at - 1 : at, 0, entry);
    if (this.parent === null) delete entry.parent;
    else setKey(entry, "parent", this.parent, ["id", "name"]);
    return [{ kind: "move", node: this.node }];
  }

  undo(doc: SceneDocument): Change[] {
    const entries = doc._entries;
    const entry = doc.node(this.node);
    entries.splice(entries.indexOf(entry), 1);
    entries.splice(this.oldAt, 0, entry);
    restore(entry, this.before!);
    return [{ kind: "move", node: this.node }];
  }
}

// --- components -------------------------------------------------------------------------------

/** Add a component to a plain node at `position` in its components list (omitted: last). */
export class AddComponent implements Command {
  readonly label: string;
  private at = -1;
  private hadList = false;
  private readonly entry: ComponentEntry;
  constructor(readonly node: string, entry: ComponentEntry, readonly position?: number) {
    this.entry = structuredClone(entry);
    this.label = `Add ${entry.type}`;
  }

  apply(doc: SceneDocument): Change[] {
    const node = doc.node(this.node);
    if (node.prefab) throw new Error(`"${this.node}" is a prefab instance; add components to the prefab or via an override.`);
    this.hadList = node.components !== undefined;
    node.components ??= [];
    this.at = this.position === undefined ? node.components.length : Math.min(this.position, node.components.length);
    node.components.splice(this.at, 0, structuredClone(this.entry));
    return [{ kind: "rebuild", node: this.node }];
  }

  undo(doc: SceneDocument): Change[] {
    const node = doc.node(this.node);
    node.components!.splice(this.at, 1);
    if (!this.hadList) delete node.components;
    return [{ kind: "rebuild", node: this.node }];
  }
}

/** Remove the component at `position` in a plain node's components list. */
export class RemoveComponent implements Command {
  readonly label = "Remove component";
  private removed: ComponentEntry | null = null;
  constructor(readonly node: string, readonly position: number) {}

  apply(doc: SceneDocument): Change[] {
    const node = doc.node(this.node);
    const list = node.components ?? [];
    if (this.position < 0 || this.position >= list.length) throw new Error(`"${this.node}" has no component at position ${this.position}.`);
    [this.removed] = list.splice(this.position, 1);
    return [{ kind: "rebuild", node: this.node }];
  }

  undo(doc: SceneDocument): Change[] {
    doc.node(this.node).components!.splice(this.position, 0, this.removed!);
    return [{ kind: "rebuild", node: this.node }];
  }
}

/** Start the component at `position` in a plain node's list enabled or disabled (`enabled: false` in the file; enabled is the default and leaves no key). */
export class SetComponentEnabled implements Command {
  readonly label: string;
  private previous: boolean | undefined;
  constructor(readonly node: string, readonly position: number, readonly enabled: boolean) {
    this.label = enabled ? "Enable component" : "Disable component";
  }

  apply(doc: SceneDocument): Change[] {
    const entry = this.entry(doc);
    this.previous = entry.enabled;
    if (this.enabled) delete entry.enabled;
    else setKey(entry, "enabled", false, ["type"]);
    return [{ kind: "rebuild", node: this.node }];
  }

  undo(doc: SceneDocument): Change[] {
    const entry = this.entry(doc);
    if (this.previous === undefined) delete entry.enabled;
    else setKey(entry, "enabled", this.previous, ["type"]);
    return [{ kind: "rebuild", node: this.node }];
  }

  private entry(doc: SceneDocument): ComponentEntry {
    const entry = doc.node(this.node).components?.[this.position];
    if (!entry) throw new Error(`"${this.node}" has no component at position ${this.position}.`);
    return entry;
  }
}

/** Move the component at `from` in a plain node's list so it ends up at `to` (an index into the list after it's taken out). */
export class MoveComponent implements Command {
  readonly label = "Reorder components";
  constructor(readonly node: string, readonly from: number, readonly to: number) {}

  apply(doc: SceneDocument): Change[] {
    return this.move(doc, this.from, this.to);
  }

  undo(doc: SceneDocument): Change[] {
    return this.move(doc, this.to, this.from);
  }

  private move(doc: SceneDocument, from: number, to: number): Change[] {
    const list = doc.node(this.node).components ?? [];
    if (from < 0 || from >= list.length || to < 0 || to >= list.length) throw new Error(`"${this.node}": can't move component ${from} to ${to}.`);
    const [entry] = list.splice(from, 1);
    list.splice(to, 0, entry);
    return [{ kind: "rebuild", node: this.node }];
  }
}

/** Replace a plain node's components list (e.g. reordered as a whole). Undo puts the old list back. */
export class SetComponents implements Command {
  readonly label = "Reorder components";
  private previous: ComponentEntry[] | undefined;
  constructor(readonly node: string, private readonly components: readonly ComponentEntry[]) {}

  apply(doc: SceneDocument): Change[] {
    const node = doc.node(this.node);
    this.previous = node.components;
    node.components = structuredClone([...this.components]);
    return [{ kind: "rebuild", node: this.node }];
  }

  undo(doc: SceneDocument): Change[] {
    const node = doc.node(this.node);
    if (this.previous) node.components = this.previous;
    else delete node.components;
    return [{ kind: "rebuild", node: this.node }];
  }
}

/**
 * Replace the whole document with `next` (an edit made outside the command set, e.g. taking a
 * deleted asset out of it). Undo puts the previous document back. Every top-level node, before
 * and after, is rebuilt.
 */
export class ReplaceDocument implements Command {
  private previous: SceneFile | null = null;
  constructor(private readonly next: SceneFile, readonly label: string) {}

  apply(doc: SceneDocument): Change[] {
    this.previous = doc.toJSON();
    return this.swap(doc, structuredClone(this.next));
  }

  undo(doc: SceneDocument): Change[] {
    return this.swap(doc, structuredClone(this.previous!));
  }

  private swap(doc: SceneDocument, file: SceneFile): Change[] {
    const roots = new Set(doc.roots());
    doc._replace(file);
    for (const id of doc.roots()) roots.add(id);
    return [...roots].map((node) => ({ kind: "rebuild", node }) as const);
  }
}

// --- grouping ---------------------------------------------------------------------------------

/** Several commands as one undo step (used by `CommandStack.beginGroup`). */
export class CommandGroup implements Command {
  readonly commands: Command[] = [];
  constructor(readonly label: string) {}

  apply(doc: SceneDocument): Change[] {
    return this.commands.flatMap((c) => c.apply(doc));
  }

  undo(doc: SceneDocument): Change[] {
    const out: Change[] = [];
    for (let i = this.commands.length - 1; i >= 0; i--) out.push(...this.commands[i].undo(doc));
    return out;
  }

  get files(): readonly FileWrite[] | undefined {
    const all = this.commands.flatMap((c) => c.files ?? []);
    return all.length ? all : undefined;
  }
}

// --- text files -------------------------------------------------------------------------------

/**
 * Write text files (ADR 0077: a UI document's markup and stylesheets) as one undoable step. The
 * scene doesn't change; the stack records each file's change and writes it back on undo and redo.
 */
export class WriteFiles implements Command {
  constructor(
    readonly label: string,
    readonly files: readonly FileWrite[],
  ) {}

  apply(): Change[] {
    return [];
  }

  undo(): Change[] {
    return [];
  }
}
