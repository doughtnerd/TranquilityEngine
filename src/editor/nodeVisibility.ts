// Hiding and locking nodes in the scene view (ADR 0022). Editor-only and per user: the flags are
// kept in browser storage per project and scene, never in the scene file, so they don't change the
// game or play mode. A hidden node (and everything under it) isn't drawn in the Scene view; a
// locked node (and everything under it) can't be picked in the viewport but is still selectable
// in the hierarchy.
import { effect, signal } from "@preact/signals";
import type { SceneDocument } from "./document";
import { ancestorKeys } from "./selectionModel";
import { currentProject, docVersion, openScene } from "./state";

export interface NodeFlags {
  /** Path keys of nodes hidden in the Scene view (their children inherit it). */
  readonly hidden: ReadonlySet<string>;
  /** Path keys of nodes that can't be picked in the viewport (their children inherit it). */
  readonly locked: ReadonlySet<string>;
}

const NONE: NodeFlags = { hidden: new Set(), locked: new Set() };

/** The active scene's flags. */
export const nodeFlags = signal<NodeFlags>(NONE);

/** The storage key for a scene's flags in a project (a folder's path, or a sample's name). */
export function flagsStorageKey(project: string, scene: string): string {
  return `myco.editor.nodeFlags:${project}:${scene}`;
}

function currentKey(): string | null {
  const scene = openScene.value, project = currentProject.value;
  return scene && project ? flagsStorageKey(project.root ?? `bundled:${project.name}`, scene.path) : null;
}

function load(key: string): NodeFlags {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return NONE;
    const v = JSON.parse(raw) as { hidden?: unknown; locked?: unknown };
    const keys = (x: unknown) => new Set(Array.isArray(x) ? x.filter((k): k is string => typeof k === "string") : []);
    return { hidden: keys(v.hidden), locked: keys(v.locked) };
  } catch {
    return NONE;
  }
}

function store(key: string, flags: NodeFlags): void {
  try {
    if (flags.hidden.size === 0 && flags.locked.size === 0) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, JSON.stringify({ hidden: [...flags.hidden], locked: [...flags.locked] }));
  } catch {
    // storage blocked: the flags last until the editor closes
  }
}

let loadedFor: string | null = null;
// Load the flags whenever another scene becomes active (or the project changes).
effect(() => {
  const key = currentKey();
  if (key === loadedFor) return;
  loadedFor = key;
  nodeFlags.value = key ? load(key) : NONE;
});

const flagged = (set: ReadonlySet<string>, doc: SceneDocument, key: string) => set.size > 0 && (set.has(key) || ancestorKeys(doc, key).some((a) => set.has(a)));

/** True if the row `key` is hidden, by itself or an ancestor (tracks the flags). */
export const isHidden = (doc: SceneDocument, key: string) => flagged(nodeFlags.value.hidden, doc, key);

/** True if the row `key` is locked, by itself or an ancestor (tracks the flags). */
export const isLocked = (doc: SceneDocument, key: string) => flagged(nodeFlags.value.locked, doc, key);

function update(change: (flags: { hidden: Set<string>; locked: Set<string> }) => void): void {
  const flags = { hidden: new Set(nodeFlags.peek().hidden), locked: new Set(nodeFlags.peek().locked) };
  change(flags);
  nodeFlags.value = flags;
  const key = currentKey();
  if (key) store(key, flags);
}

/** Hide or show the node at `key` in the Scene view. */
export function setHidden(key: string, hidden: boolean): void {
  if (nodeFlags.peek().hidden.has(key) === hidden) return;
  update((f) => (hidden ? f.hidden.add(key) : f.hidden.delete(key)));
  const scene = openScene.peek();
  if (!hidden && scene?.doc.has(key.split("/")[0])) {
    // Showing it again: rebuild its World node from the document, so it gets its authored active state back.
    scene.sync.apply([{ kind: "rebuild", node: key.split("/")[0] }]);
    docVersion.value++; // outlines and gizmos pick up the rebuilt nodes
  }
}

/** Lock or unlock the node at `key` against viewport picking. */
export function setLocked(key: string, locked: boolean): void {
  if (nodeFlags.peek().locked.has(key) === locked) return;
  update((f) => (locked ? f.locked.add(key) : f.locked.delete(key)));
}

// Keep hidden nodes switched off in the Editor World: after every edit (which may rebuild them)
// and whenever the flags change. Only the Editor World's nodes; the document is untouched.
effect(() => {
  docVersion.value;
  const scene = openScene.value, hidden = nodeFlags.value.hidden;
  if (!scene || hidden.size === 0) return;
  for (const key of hidden) {
    const node = scene.sync.nodeFor(key);
    if (node?.active) node.setActive(false);
  }
});
