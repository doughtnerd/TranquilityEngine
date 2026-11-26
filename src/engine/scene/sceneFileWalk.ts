/**
 * One walk over a scene or prefab file (ADR 0279). Every place a component field value can sit is
 * visited once, with its component type and field name:
 *
 * - a component entry's `data` on a node;
 * - a prefab instance's field override (`{ component, field, value }`);
 * - an added component's `data` (`{ addComponent }`);
 * - all of these again inside added nodes (`{ addNodes }`, ADR 0086), however deep they nest.
 *
 * A `type` rule likewise sees every component id the file names: component entries, an override's `component`,
 * `removeComponent`, `order` and `addComponent`, in nodes and added nodes alike.
 *
 * Callers (the format migrations, asset cleanup) supply only their rule. The walk copies only what
 * changed, so a rule that changes nothing gives back the very same file.
 */
import type { ComponentEntry, NodeEntry, OverrideEntry, SceneFile } from "./SceneLoader";

/** Returned by a field rule to drop the value: a component field goes back to its default, an override goes (the prefab's value shows again). */
export const REMOVE_FIELD: unique symbol = Symbol("REMOVE_FIELD");

/** What a field rule returns to move a value to another field of the same component, with a new value. */
export interface FieldRename {
  readonly renameTo: string;
  readonly value: unknown;
}

/** A field rule's answer that renames: the value moves to the field `to` (an existing `to` in a component's data wins). */
export function renameField(to: string, value: unknown): FieldRename {
  return { renameTo: to, value };
}

const isRename = (v: unknown): v is FieldRename => typeof v === "object" && v !== null && "renameTo" in v && Object.keys(v).length === 2;

/** A rule over one field value: the same value to keep it, a new value, `renameField(...)`, or `REMOVE_FIELD`. */
export type FieldRule = (component: string, field: string, value: unknown) => unknown;

export interface SceneFileRule {
  /** Every component id the file names, wherever it sits: the same id to keep it, or another (ADR 0423's aliases). Runs before `field`. */
  readonly type?: (id: string) => string;
  /** Every component field value in the file, wherever it sits. */
  readonly field?: FieldRule;
  /**
   * Every node list: the file's own and each `addNodes` list, before its nodes are walked. Return
   * the same list to keep it, or a new list (nodes left out aren't walked).
   */
  readonly nodes?: (nodes: NodeEntry[]) => NodeEntry[];
}

/** The file with `rule` applied everywhere it can apply; the same object when nothing changed. */
export function mapSceneFile(file: SceneFile, rule: SceneFileRule): SceneFile {
  const nodes = mapNodes(file.nodes ?? [], rule);
  return nodes === file.nodes ? file : { ...file, nodes };
}

/** `items` mapped by `f`, the same array when every item came back the same (`undefined` drops one). */
function mapList<T>(items: T[], f: (item: T) => T | undefined): T[] {
  let out: T[] | null = null;
  items.forEach((item, i) => {
    const next = f(item);
    if (next !== item && out === null) out = items.slice(0, i);
    if (out !== null && next !== undefined) out.push(next);
  });
  return out ?? items;
}

function mapNodes(nodes: NodeEntry[], rule: SceneFileRule): NodeEntry[] {
  const kept = rule.nodes ? rule.nodes(nodes) : nodes;
  return mapList(kept, (n) => mapNode(n, rule));
}

function mapNode(n: NodeEntry, rule: SceneFileRule): NodeEntry {
  const components = n.components && mapList(n.components, (c) => mapComponent(c, rule));
  const overrides = n.overrides && mapList(n.overrides, (o) => mapOverride(o, rule));
  if (components === n.components && overrides === n.overrides) return n;
  const out: NodeEntry = { ...n };
  if (components) out.components = components;
  if (overrides) {
    if (overrides.length > 0) out.overrides = overrides;
    else delete out.overrides;
  }
  return out;
}

function mapComponent(entry: ComponentEntry, rule: SceneFileRule): ComponentEntry {
  const type = rule.type && typeof entry.type === "string" ? rule.type(entry.type) : entry.type;
  const c = type === entry.type ? entry : { ...entry, type };
  if (!rule.field || !c.data) return c;
  let data: Record<string, unknown> | null = null;
  for (const [name, value] of Object.entries(c.data)) {
    const next = rule.field(c.type, name, value);
    if (next === value) continue;
    data ??= { ...c.data };
    if (next === REMOVE_FIELD) delete data[name];
    else if (isRename(next)) {
      delete data[name];
      if (!(next.renameTo in c.data)) data[next.renameTo] = next.value;
    } else data[name] = next;
  }
  return data ? { ...c, data } : c;
}

function mapOverride(entry: OverrideEntry, rule: SceneFileRule): OverrideEntry | undefined {
  const o = rule.type ? mapOverrideTypes(entry, rule.type) : entry;
  let out = o;
  if (rule.field && o.component && o.field && "value" in o) {
    const value = rule.field(o.component, o.field, o.value);
    if (value === REMOVE_FIELD) return undefined;
    if (isRename(value)) out = { ...out, field: value.renameTo, value: value.value };
    else if (value !== o.value) out = { ...out, value };
  }
  if (o.addComponent) {
    const addComponent = mapComponent(o.addComponent, rule);
    if (addComponent !== o.addComponent) out = { ...out, addComponent };
  }
  if (o.addNodes) {
    const addNodes = mapNodes(o.addNodes, rule);
    if (addNodes !== o.addNodes) out = { ...out, addNodes };
  }
  return out;
}

/** The override with `type` applied to the component ids it names itself (`addComponent` is mapped as a component). */
function mapOverrideTypes(o: OverrideEntry, type: (id: string) => string): OverrideEntry {
  let out = o;
  if (typeof o.component === "string") {
    const component = type(o.component);
    if (component !== o.component) out = { ...out, component };
  }
  if (typeof o.removeComponent === "string") {
    const removeComponent = type(o.removeComponent);
    if (removeComponent !== o.removeComponent) out = { ...out, removeComponent };
  }
  if (Array.isArray(o.order)) {
    const order = mapList(o.order, (id) => (typeof id === "string" ? type(id) : id));
    if (order !== o.order) out = { ...out, order };
  }
  return out;
}
