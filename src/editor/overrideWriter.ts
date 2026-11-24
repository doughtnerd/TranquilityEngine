// The prefab-instance override writer (ADR 0287), the write side of the override fold (ADR 0280).
// One module answers "set or revert property P of the node, or of the component, at path X" for every
// Inspector edit: it decides whether the value goes in a node's own entry, in the `addComponent`
// entry of a component this instance added, or in an override of the instance; it merges the value
// into the override that already sets P (the fold's own `setsProperty` decides which that is), drops
// an override left setting nothing, writes a value equal to what the prefab gives as a revert, and
// answers "is it overridden?". It also writes the structural overrides: adding and removing
// components, adding and removing nodes inside an instance.
//
// Paths are the editor's node paths: `[id]` for a node of the document (a plain node, or a prefab
// instance's root), `[instance, inner…]` for a node inside an instance (one id per nested instance on
// the way). The per-kind edit modules (`nodeEdits.ts`, `componentEdits.ts`, `inspectorEdits.ts`,
// `fieldEdits.ts`) keep the edit gate, labels and multi-select, and call this for each node.
import { isDataComponent } from "../engine/editor";
import { overrideComponent, sameTarget, setsProperty, type OverrideProperty } from "../engine/scene/overrideFold";
import type { ResolvedNode } from "../engine/scene/resolvedScene";
import {
  AddComponent,
  RemoveComponent,
  RenameNode,
  SetActive,
  SetComponentEnabled,
  SetComponentWorlds,
  SetField,
  SetOverrides,
  SetTags,
  type Change,
  type Command,
  type ComponentEntry,
  type NodeEntry,
  type NodePath,
  type OverrideEntry,
  type SceneDocument,
} from "./document";

export type { OverrideProperty };

/** Where a component of a node comes from: an entry in the node's own list, the prefab, or one of the instance's `addComponent` overrides. */
export type Origin = { kind: "file"; position: number } | { kind: "prefab" } | { kind: "added"; at: number } | null;

/** Where a write of a property lands. */
type Home = { kind: "entry"; position?: number } | { kind: "added"; at: number } | { kind: "override" };

const shortName = (type: string) => type.replace(/^[^.]*\./, "");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const targetKey = (target: readonly string[]) => (target.length > 0 ? { target: [...target] } : {});

/** The node at `path` as the game makes it (the document's resolved view), with `overrides` in place of the instance's own when given. */
function resolvedNode(doc: SceneDocument, path: NodePath, overrides?: readonly OverrideEntry[]): ResolvedNode | null {
  return doc.resolve(path[0], overrides).nodes.find((n) => sameTarget(n.path, path)) ?? null;
}

/**
 * Where component `info` (the `index`-th of its type) of the node at `path` comes from. Inside a
 * prefab instance this is the resolved view's word on it (ADR 0280): added by one of this
 * instance's `addComponent` overrides, or from the prefab files (their own overrides included).
 * Null when the file doesn't have it (a script added it).
 */
export function originOf(doc: SceneDocument, path: NodePath, info: { readonly type: string; readonly index: number }): Origin {
  const [id] = path;
  if (!doc.isPrefabInstance(id)) {
    const positions = (doc.node(id).components ?? []).flatMap((c, i) => (c.type === info.type ? [i] : []));
    return info.index < positions.length ? { kind: "file", position: positions[info.index] } : null;
  }
  const c = resolvedNode(doc, path)?.components.filter((x) => x.type === info.type)[info.index];
  if (!c) return null;
  return c.added && sameTarget(c.added.instance, [id]) ? { kind: "added", at: c.added.override } : { kind: "prefab" };
}

/**
 * Where a write of `p` on the node at `path` lands, or null where it can't be written: a node's own
 * name, active flag and tags are its entry's on a document node (an instance's root included) and
 * an override inside an instance; a component's switch and Worlds go where the component comes from;
 * a field is the node's entry on a plain node and an override on an instance (ADR 0257); an order is
 * an override (a plain node's list is reordered with `MoveComponent`).
 */
function homeOf(doc: SceneDocument, path: NodePath, p: OverrideProperty): Home | null {
  const [id, ...target] = path;
  if (!doc.has(id)) return null;
  const instance = doc.isPrefabInstance(id);
  switch (p.kind) {
    case "name":
    case "active":
    case "tags":
      return instance && target.length > 0 ? { kind: "override" } : { kind: "entry" };
    case "order":
      return instance ? { kind: "override" } : null;
    case "field":
      return instance ? { kind: "override" } : { kind: "entry" };
  }
  const origin = originOf(doc, path, p);
  if (!origin) return null;
  if (origin.kind === "file") return { kind: "entry", position: origin.position };
  return origin.kind === "added" ? { kind: "added", at: origin.at } : { kind: "override" };
}

/** True when override `o`, written on the instance, sets `p` of the node at `target`. */
const sets = (o: OverrideEntry, target: readonly string[], p: OverrideProperty) => setsProperty(o, p) && sameTarget(o.target, target);

/** The position of the last override in `list` that sets `p` at `target` (the one the fold applies last), or -1. */
function lastSetting(list: readonly OverrideEntry[], target: readonly string[], p: OverrideProperty): number {
  for (let i = list.length - 1; i >= 0; i--) if (sets(list[i], target, p)) return i;
  return -1;
}

/** The value override `o` gives `p`. */
function valueIn(o: OverrideEntry, p: OverrideProperty): unknown {
  return p.kind === "field" ? o.value : o[p.kind];
}

/** The keys of an override that do something; one with none of them left is dropped. */
const EFFECTS = ["name", "active", "tags", "order", "addComponent", "removeComponent", "addNodes", "removeNode", "enabled", "worlds", "field"] as const;
const setsNothing = (o: OverrideEntry) => EFFECTS.every((k) => o[k] === undefined);

/** `o` without `p`. */
function strip(o: OverrideEntry, p: OverrideProperty): OverrideEntry {
  const out = structuredClone(o);
  if (p.kind === "field") {
    delete out.field;
    delete out.value;
  } else delete out[p.kind];
  return out;
}

/** A new override setting `p` of the node at `target` to `value`. */
function overrideFor(target: readonly string[], p: OverrideProperty, value: unknown): OverrideEntry {
  if (p.kind === "name" || p.kind === "active" || p.kind === "tags" || p.kind === "order") return { ...targetKey(target), [p.kind]: structuredClone(value) };
  const component = { component: p.type, ...(p.index > 0 ? { index: p.index } : {}) };
  if (p.kind === "field") return { ...targetKey(target), ...component, field: p.field, value: structuredClone(value) };
  return { ...targetKey(target), ...component, [p.kind]: structuredClone(value) };
}

/** `list` with no override setting `p` at `target` (overrides left setting nothing go). */
function without(list: readonly OverrideEntry[], target: readonly string[], p: OverrideProperty): OverrideEntry[] {
  return list.flatMap((o) => {
    if (!sets(o, target, p)) return [structuredClone(o)];
    const rest = strip(o, p);
    return setsNothing(rest) ? [] : [rest];
  });
}

/** `list` with `p` at `target` set to `value`: in the last override that sets it (the one the fold applies last), taken out of any earlier one, or in a new override. */
function withValue(list: readonly OverrideEntry[], target: readonly string[], p: OverrideProperty, value: unknown): OverrideEntry[] {
  const last = lastSetting(list, target, p);
  if (last < 0) return [...list.map((o) => structuredClone(o)), overrideFor(target, p, value)];
  return list.flatMap((o, i) => {
    if (i === last) {
      const next = structuredClone(o);
      if (p.kind === "field") next.value = structuredClone(value);
      else (next as Record<string, unknown>)[p.kind] = structuredClone(value);
      return [next];
    }
    if (!sets(o, target, p)) return [structuredClone(o)];
    const rest = strip(o, p);
    return setsNothing(rest) ? [] : [rest];
  });
}

/** `p` as the resolved node shows it. */
function readResolved(node: ResolvedNode, path: NodePath, p: OverrideProperty): unknown {
  switch (p.kind) {
    case "name":
      return node.name ?? path[path.length - 1];
    case "active":
      return node.active;
    case "tags":
      return node.tags;
    case "order":
      return node.components.map((c) => c.type).filter((t) => t !== "engine.Transform" && !isDataComponent(t));
  }
  const c = node.components.filter((x) => x.type === p.type)[p.index];
  if (!c) return undefined;
  if (p.kind === "enabled") return c.enabled !== false;
  if (p.kind === "worlds") return c.worlds;
  return (c.data as Record<string, unknown> | undefined)?.[p.field];
}

/**
 * True if the instance overrides `p` of the node at `path`. On an instance's root its own `tags`
 * count (they replace the prefab root's, ADR 0042); its name and active flag are the instance's own,
 * never an override. A plain node, and a component this instance added, have no overrides.
 */
export function isOverridden(doc: SceneDocument, path: NodePath, p: OverrideProperty): boolean {
  const home = homeOf(doc, path, p);
  if (!home) return false;
  const [id, ...target] = path;
  if (home.kind === "override") return doc.overrides(id).some((o) => sets(o, target, p));
  return home.kind === "entry" && p.kind === "tags" && doc.isPrefabInstance(id) && doc.node(id).tags !== undefined;
}

/** What this scene writes for `p` of the node at `path` (the entry's value, the added component's, or the instance's override); undefined when nothing. */
export function writtenValue(doc: SceneDocument, path: NodePath, p: OverrideProperty): unknown {
  const home = homeOf(doc, path, p);
  if (!home) return undefined;
  const [id, ...target] = path;
  if (home.kind === "override") {
    const list = doc.overrides(id);
    const last = lastSetting(list, target, p);
    return last < 0 ? undefined : valueIn(list[last], p);
  }
  if (home.kind === "added") {
    const entry = doc.overrides(id)[home.at].addComponent!;
    return p.kind === "enabled" || p.kind === "worlds" ? entry[p.kind] : undefined;
  }
  const node = doc.node(id);
  if (p.kind === "name" || p.kind === "active" || p.kind === "tags") return node[p.kind];
  if (p.kind === "field") return doc.fieldValue(id, p.type, p.field, p.index);
  if (p.kind === "order" || home.position === undefined) return undefined;
  return node.components?.[home.position]?.[p.kind];
}

/**
 * What `p` of the node at `path` comes to without this instance's override of it: the prefab
 * files' value, their own nested overrides included (the resolved view with the override taken
 * out). Undefined where `p` isn't written as an override.
 */
export function inheritedValue(doc: SceneDocument, path: NodePath, p: OverrideProperty): unknown {
  if (homeOf(doc, path, p)?.kind !== "override") return undefined;
  const [id, ...target] = path;
  const node = resolvedNode(doc, path, without(doc.overrides(id), target, p));
  return node ? readResolved(node, path, p) : undefined;
}

function defaultLabel(p: OverrideProperty, value: unknown): string {
  switch (p.kind) {
    case "name":
      return "Rename";
    case "active":
      return value === false ? "Deactivate" : "Activate";
    case "tags":
      return value === undefined ? "Revert tags" : "Set tags";
    case "order":
      return "Reorder components";
    case "enabled":
      return `${value === false ? "Disable" : "Enable"} ${shortName(p.type)}`;
    case "worlds":
      return value === undefined ? "Reset Worlds" : "Set Worlds";
    case "field":
      return value === undefined ? `Revert ${p.field}` : `Set ${p.field}`;
  }
}

/** The command writing `value` into the node's own entry (undefined: back to the default), or null where that means nothing. */
function entryCommand(doc: SceneDocument, id: string, position: number | undefined, p: OverrideProperty, value: unknown): Command | null {
  switch (p.kind) {
    case "name":
      return typeof value === "string" ? new RenameNode(id, value) : null;
    case "active":
      return new SetActive(id, value !== false);
    case "tags":
      return value === undefined && !doc.isPrefabInstance(id) ? null : new SetTags(id, value as readonly string[] | undefined);
    case "order":
      return null;
    case "field":
      return value === undefined ? null : new SetField(id, p.type, p.field, value, { index: p.index });
    case "enabled":
      return new SetComponentEnabled(id, position!, value !== false);
    case "worlds":
      return new SetComponentWorlds(id, position!, value as readonly string[] | undefined);
  }
}

/** The Editor World's changes for an override of `p`: a name or flag for those, else the instance is rebuilt. */
function changesOf(path: NodePath, p: OverrideProperty): Change[] | undefined {
  return p.kind === "name" || p.kind === "active" ? [{ kind: p.kind, node: path[0], path }] : undefined;
}

/**
 * The command that sets `p` of the node at `path` to `value`, or with `value` undefined reverts it
 * (removes the override; on a document node, the entry's key where that means something). Inside an
 * instance a value equal to what the prefab gives is written as a revert, so no override repeats the
 * prefab (a field keeps its override, ADR 0257). Null when nothing would change, or `p` can't be
 * written there (a component a script added, an order on a plain node).
 */
export function writeProperty(doc: SceneDocument, path: NodePath, p: OverrideProperty, value: unknown, label = defaultLabel(p, value)): Command | null {
  const home = homeOf(doc, path, p);
  if (!home) return null;
  const [id, ...target] = path;
  if (home.kind === "entry") return entryCommand(doc, id, home.position, p, value);
  const list = doc.overrides(id);
  let next: OverrideEntry[];
  if (home.kind === "added") {
    next = list.map((o) => structuredClone(o));
    const o = next[home.at];
    const { type, enabled: _e, worlds: _w, ...rest } = o.addComponent!;
    const enabled = p.kind === "enabled" ? (value === false ? false : undefined) : o.addComponent!.enabled;
    const worlds = p.kind === "worlds" ? (value as string[] | undefined) : o.addComponent!.worlds;
    // An added component's switch and Worlds go on its own entry, where a plain node's would.
    o.addComponent = { type, ...(enabled === false ? { enabled } : {}), ...(worlds !== undefined ? { worlds: [...worlds] } : {}), ...rest };
  } else {
    const revert = value === undefined || (p.kind !== "field" && same(value, inheritedValue(doc, path, p)));
    if (!revert && p.kind === "field") return new SetField(id, p.type, p.field, value, { index: p.index, target });
    next = revert ? without(list, target, p) : withValue(list, target, p, value);
  }
  if (same(next, list)) return null;
  return new SetOverrides(id, label, next, changesOf(path, p));
}

// --- structural overrides -------------------------------------------------------------------------

/** The command adding component `entry` to the node at `path`: to a plain node's list, or as an `addComponent` override. */
export function writeAddComponent(doc: SceneDocument, path: NodePath, entry: ComponentEntry, label = `Add ${shortName(entry.type)}`): Command {
  const [id, ...target] = path;
  if (!doc.isPrefabInstance(id)) return new AddComponent(id, entry);
  return new SetOverrides(id, label, [...doc.overrides(id), { ...targetKey(target), addComponent: structuredClone(entry) }]);
}

/**
 * The command removing component `index` of `type` from the node at `path`, or null when the file
 * doesn't have it. On a plain node it leaves the list. Inside an instance the override that added it
 * is dropped, or for one from the prefab a `removeComponent` override is added (it removes the first
 * of its type); the switch, Worlds and field overrides of that component go, later ones of its type
 * shift down by one, and it leaves an `order` override.
 */
export function writeRemoveComponent(doc: SceneDocument, path: NodePath, type: string, index: number, label = `Remove ${shortName(type)}`): Command | null {
  const origin = originOf(doc, path, { type, index });
  if (!origin) return null;
  const [id, ...target] = path;
  if (origin.kind === "file") return new RemoveComponent(id, origin.position);
  const dropAt = origin.kind === "added" ? origin.at : -1;
  const out: OverrideEntry[] = [];
  let firstShifted = -1;
  doc.overrides(id).forEach((o, i) => {
    if (i === dropAt) return;
    if (sets(o, target, { kind: "order" })) {
      // Take the removed component's entry out of the order (its index-th occurrence of the type).
      const at = o.order!.flatMap((t, j) => (t === type ? [j] : []))[index];
      const order = o.order!.filter((_, j) => j !== at);
      const rest = order.length > 0 ? { ...structuredClone(o), order } : strip(o, { kind: "order" });
      if (!setsNothing(rest)) out.push(rest);
      return;
    }
    const c = overrideComponent(o);
    if (c?.type === type && sameTarget(o.target, target) && (o.field !== undefined || o.enabled !== undefined || o.worlds !== undefined)) {
      if (c.index === index) return;
      if (c.index > index) {
        const shifted: OverrideEntry = { ...structuredClone(o), index: c.index - 1 };
        if (shifted.index === 0) delete shifted.index;
        if (firstShifted < 0) firstShifted = out.length;
        out.push(shifted);
        return;
      }
    }
    out.push(structuredClone(o));
  });
  // The removal goes before the first override it renumbered: an index counts the entries as they stand when its override applies.
  if (dropAt < 0) out.splice(firstShifted < 0 ? out.length : firstShifted, 0, { ...targetKey(target), removeComponent: type });
  return new SetOverrides(id, label, out);
}

/** The command adding the flat subtree(s) `nodes` under the node at `path` inside an instance: an `addNodes` override (ADR 0086). */
export function writeAddNodes(doc: SceneDocument, path: NodePath, nodes: readonly NodeEntry[], label: string): Command {
  const [id, ...target] = path;
  if (!doc.isPrefabInstance(id)) throw new Error(`"${id}" is not a prefab instance.`);
  return new SetOverrides(id, label, [...doc.overrides(id), { ...targetKey(target), addNodes: structuredClone([...nodes]) }]);
}

/**
 * The command removing the node at `path` inside an instance: one the instance added leaves its
 * `addNodes` override (its added children with it), one from the prefab gets a `removeNode`
 * override; overrides aimed at it or under it go.
 */
export function writeRemoveNode(doc: SceneDocument, path: NodePath, label = "Remove node"): Command {
  const [instance, ...target] = path;
  if (target.length === 0) throw new Error("Remove the instance itself, not a node inside it.");
  const id = target[target.length - 1];
  // Ids are unique per instance level only (ADR 0086): the node's level is the nested instances its target passes.
  const scope = target.slice(0, -1);
  const inScope = (path: readonly string[]) => path.length >= scope.length && scope.every((s, i) => path[i] === s);
  const list = doc.overrides(instance);
  // Nodes added at target T join the level of T's node: T without its last id, or T itself when T ends at a nested
  // instance's root. Only one of the two can name a level holding the node.
  const addsToScope = (t: readonly string[]) => sameTarget(t.slice(0, -1), scope) || (t.length > 0 && sameTarget(t, scope));
  const addedHere = list.findIndex((o) => addsToScope(o.target ?? []) && o.addNodes?.some((n) => n.id === id));
  const doomed = new Set<string>([id]);
  if (addedHere >= 0) {
    const nodes = list[addedHere].addNodes!;
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of nodes) if (n.parent && doomed.has(n.parent) && !doomed.has(n.id)) (doomed.add(n.id), (grew = true));
    }
  }
  const next: OverrideEntry[] = [];
  list.forEach((o, i) => {
    if (i === addedHere) {
      const keep = o.addNodes!.filter((n) => !doomed.has(n.id));
      if (keep.length > 0) next.push({ ...structuredClone(o), addNodes: keep });
      else {
        const rest = structuredClone(o);
        delete rest.addNodes;
        if (!setsNothing(rest)) next.push(rest);
      }
    } else {
      // Aimed at a removed node or into it (a removed nested instance): its id at the removed node's level.
      const t = o.target ?? [];
      if (!(inScope(t) && t.length > scope.length && doomed.has(t[scope.length]))) next.push(structuredClone(o));
    }
  });
  if (addedHere < 0) next.push({ target: [...target], removeNode: true });
  return new SetOverrides(instance, label, next);
}
