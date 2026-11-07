import type { World } from "../../engine/core/World";
import { destroyNow, instantiateDocument, instantiateNodes, moveNode, setSiblingIndex, writeField } from "../../engine/editor";
import type { GameObject } from "../../engine/scene/GameObject";
import type { Change } from "./commands";
import type { CommandStack } from "./CommandStack";
import { pathKey, sameTarget, type ComponentEntry, type NodePath, type SceneDocument } from "./SceneDocument";

interface Mapped {
  readonly generation: number;
  readonly path: NodePath;
}

/**
 * Keeps an Editor World showing a SceneDocument (ADR 0026). `build()` instantiates the document
 * under a new edit-mode scene node (no scripts, systems or physics run in it). After that,
 * `apply(changes)` catches the World up with each command: field values are written in place;
 * structural changes rebuild only the affected subtree and re-point references into it.
 *
 * It also maps World nodes back to document nodes, for viewport selection:
 * `nodeIdOf(node)` gives the document node a World node belongs to (for nodes inside a prefab
 * instance, the instance), `pathOf(node)` the full path.
 */
export class WorldSync {
  private scene: GameObject | null = null;
  private byKey = new Map<string, GameObject>();
  private byEntity = new Map<number, Mapped>();
  private readonly resolve = (id: string): GameObject | null => this.nodeFor([id]);
  /** Components that couldn't be created, by node path key (unknown types: a deleted or broken script, ADR 0030). */
  private readonly missing = new Map<string, ComponentEntry[]>();
  private readonly onProblem = (message: string, path: readonly string[], component?: ComponentEntry): void => {
    if (!component) {
      console.warn(`[editor] ${message}`);
      return;
    }
    const key = pathKey(path);
    this.missing.set(key, [...(this.missing.get(key) ?? []), component]);
  };

  constructor(readonly world: World, readonly doc: SceneDocument) {}

  /** The scene node holding the document's nodes (null before `build`). */
  get sceneNode(): GameObject | null {
    return this.scene?.isValid ? this.scene : null;
  }

  /** Instantiate the whole document (replacing any previous build). Returns the scene node. */
  build(): GameObject {
    this.dispose();
    this.missing.clear();
    this.scene = instantiateDocument(this.world, this.doc.toJSON(), this.doc.path, { onNode: (node, path) => this.record(node, path), onProblem: this.onProblem });
    return this.scene;
  }

  /**
   * Components of the node at `path` the World couldn't create because their type isn't
   * registered (its script was deleted or didn't load), as the scene files have them. The
   * document keeps them; the Inspector shows them as missing scripts.
   */
  missingComponents(path: NodePath | string): readonly ComponentEntry[] {
    return this.missing.get(typeof path === "string" ? path : pathKey(path)) ?? [];
  }

  /** Apply every change from the stack as it happens. Returns an unsubscribe function. */
  attach(stack: CommandStack): () => void {
    return stack.subscribe((e) => this.apply(e.changes));
  }

  /** Bring the World up to date with changes already applied to the document. */
  apply(changes: readonly Change[]): void {
    if (!this.sceneNode) return;
    for (const change of changes) {
      switch (change.kind) {
        case "field": this.field(change.path, change.type, change.index, change.field); break;
        case "name":
        case "active":
          if (change.path && change.path.length > 1) this.innerProperty(change.path, change.kind);
          else if (change.kind === "name") this.name(change.node);
          else this.active(change.node);
          break;
        case "move": this.move(change.node); break;
        case "add":
        case "rebuild": this.rebuild(change.node); break;
        case "remove": this.remove(change.node); break;
      }
    }
  }

  /** The World node for a document path (`[id]`, or `[instanceId, …target]`), or null. */
  nodeFor(path: NodePath | string): GameObject | null {
    const node = this.byKey.get(typeof path === "string" ? path : pathKey(path));
    return node?.isValid ? node : null;
  }

  /** Full document path of a World node, or null if it isn't part of the document. */
  pathOf(node: GameObject | number): NodePath | null {
    const e = typeof node === "number" ? node : node.entity;
    const m = this.byEntity.get(e);
    return m && this.world.isAlive(e, m.generation) ? m.path : null;
  }

  /** Document node id a World node belongs to (the prefab instance for nodes inside one), or null. */
  nodeIdOf(node: GameObject | number): string | null {
    return this.pathOf(node)?.[0] ?? null;
  }

  /** Destroy the scene node and forget all mappings. */
  dispose(): void {
    if (this.scene?.isValid) destroyNow(this.scene);
    this.scene = null;
    this.byKey.clear();
    this.byEntity.clear();
  }

  // --- change handlers --------------------------------------------------------------------------

  private field(path: NodePath, type: string, index: number, field: string): void {
    const [id, ...target] = path;
    if (!this.doc.has(id)) return;
    const node = this.nodeFor(path);
    const raw = this.doc.isPrefabInstance(id) ? this.doc.overrideValue(id, target, type, field, index) : this.doc.fieldValue(id, type, field, index);
    // An unset value means "back to the default", which only a fresh instance knows.
    if (!node || raw === undefined || !writeField(node, type, index, field, raw, this.resolve)) this.rebuild(id);
  }

  private name(id: string): void {
    const node = this.nodeFor([id]);
    const entry = this.doc.node(id);
    if (!node) return this.rebuild(id);
    if (entry.name !== undefined) node.name = entry.name;
    else if (entry.prefab) this.rebuild(id); // back to the prefab root's own name
    else node.name = entry.id;
  }

  /**
   * A node inside a prefab instance got or lost a name or active override (ADR 0122). With no
   * override left only a fresh instance knows the prefab's value, so the instance is rebuilt.
   */
  private innerProperty(path: NodePath, key: "name" | "active"): void {
    const [id, ...target] = path;
    if (!this.doc.has(id)) return;
    const node = this.nodeFor(path);
    const o = [...this.doc.overrides(id)].reverse().find((x) => x[key] !== undefined && x.component === undefined && sameTarget(x.target, target));
    if (!node || !o) return this.rebuild(id);
    if (key === "name") node.name = o.name!;
    else node.setActive(o.active!);
  }

  private active(id: string): void {
    const node = this.nodeFor([id]);
    const entry = this.doc.node(id);
    if (!node || (entry.prefab && entry.active === undefined)) return this.rebuild(id);
    node.setActive(entry.active !== false);
  }

  private move(id: string): void {
    const node = this.nodeFor([id]);
    const parentId = this.doc.parentOf(id);
    const parent = parentId === null ? this.sceneNode : this.nodeFor([parentId]);
    if (!node || !parent) return this.rebuild(id);
    moveNode(node, parent, this.doc.children(parentId).indexOf(id));
  }

  private remove(id: string): void {
    const removed = this.destroy(id);
    this.repointReferences(removed);
  }

  /** Re-create the subtree for document node `id` (or just drop it if `id` is gone). */
  private rebuild(id: string): void {
    const removed = this.destroy(id);
    if (this.doc.has(id)) {
      const parentId = this.doc.parentOf(id);
      const parent = parentId === null ? this.sceneNode : this.nodeFor([parentId]);
      if (!parent) {
        this.build(); // parent missing from the World: fall back to a full rebuild
        return;
      }
      const ids = this.doc.subtree(id);
      for (const key of [...this.missing.keys()]) if (ids.some((i) => key === i || key.startsWith(`${i}/`))) this.missing.delete(key);
      const nodes = ids.map((i) => structuredClone(this.doc.node(i)));
      delete nodes[0].parent;
      instantiateNodes(this.world, { format: this.doc.format, nodes }, parent, this.doc.path, {
        onNode: (node, path) => this.record(node, path),
        resolveExternal: this.resolve,
        onProblem: this.onProblem,
      });
      const root = this.nodeFor([id]);
      if (root) setSiblingIndex(root, this.doc.children(parentId).indexOf(id));
      for (const i of ids) removed.add(i);
    }
    this.repointReferences(removed);
  }

  /** Destroy the World subtree of document node `id`. Returns the document ids that lost their node. */
  private destroy(id: string): Set<string> {
    const node = this.nodeFor([id]);
    const gone = new Set<string>();
    if (!node) return gone;
    destroyNow(node);
    for (const [e, m] of this.byEntity) {
      if (this.world.isAlive(e, m.generation)) continue;
      this.byEntity.delete(e);
      this.byKey.delete(pathKey(m.path));
      if (m.path.length === 1) gone.add(m.path[0]);
    }
    for (const [key, n] of this.byKey) if (!n.isValid) this.byKey.delete(key);
    return gone;
  }

  /** Re-resolve `$node` references from outside `ids` that point at nodes in `ids`. */
  private repointReferences(ids: ReadonlySet<string>): void {
    if (!ids.size) return;
    for (const ref of this.doc.references()) {
      if (!ids.has(ref.to) || ids.has(ref.path[0])) continue;
      const node = this.nodeFor(ref.path);
      if (!node) continue;
      if (ref.element === undefined) writeField(node, ref.type, ref.index, ref.field, { $node: ref.to }, this.resolve);
      else {
        // A list field: write the whole list again, so every item re-resolves.
        const [id, ...target] = ref.path;
        const raw = this.doc.isPrefabInstance(id) ? this.doc.overrideValue(id, target, ref.type, ref.field, ref.index) : this.doc.fieldValue(id, ref.type, ref.field, ref.index);
        writeField(node, ref.type, ref.index, ref.field, raw, this.resolve);
      }
    }
  }

  private record(node: GameObject, path: readonly string[]): void {
    this.byKey.set(pathKey(path), node);
    this.byEntity.set(node.entity, { generation: node.generation, path: [...path] });
  }
}
