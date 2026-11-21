/**
 * One walk over a scene or prefab file (ADR 0279). Every place a component field value can sit is
 * visited once, with its component type and field name:
 *
 * - a component entry's `data` on a node;
 * - a prefab instance's field override (`{ component, field, value }`);
 * - an added component's `data` (`{ addComponent }`);
 * - all of these again inside added nodes (`{ addNodes }`, ADR 0086), however deep they nest.
 *
 * Callers (the format migrations, asset cleanup) supply only their rule. The walk copies only what
 * changed, so a rule that changes nothing gives back the very same file.
 */
import type { ComponentEntry, NodeEntry, OverrideEntry, SceneFile } from "./SceneLoader";

/** Returned by a field rule to drop the value: a component field goes back to its default, an override goes (the prefab's value shows again). */
export const REMOVE_FIELD: unique symbol = Symbol("REMOVE_FIELD");

/** A rule over one field value: the same value to keep it, a new value, or `REMOVE_FIELD`. */
export type FieldRule = (component: string, field: string, value: unknown) => unknown;

export interface SceneFileRule {
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

function mapComponent(c: ComponentEntry, rule: SceneFileRule): ComponentEntry {
  if (!rule.field || !c.data) return c;
  let data: Record<string, unknown> | null = null;
  for (const [name, value] of Object.entries(c.data)) {
    const next = rule.field(c.type, name, value);
    if (next === value) continue;
    data ??= { ...c.data };
    if (next === REMOVE_FIELD) delete data[name];
    else data[name] = next;
  }
  return data ? { ...c, data } : c;
}

function mapOverride(o: OverrideEntry, rule: SceneFileRule): OverrideEntry | undefined {
  let out = o;
  if (rule.field && o.component && o.field && "value" in o) {
    const value = rule.field(o.component, o.field, o.value);
    if (value === REMOVE_FIELD) return undefined;
    if (value !== o.value) out = { ...out, value };
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
