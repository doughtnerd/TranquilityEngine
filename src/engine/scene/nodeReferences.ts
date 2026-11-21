/**
 * Where a node reference can sit in a scene file (ADR 0013, 0042, 0280), for every module that
 * reads or rewrites them: instantiation, the editor's reference list, paste and asset cleanup.
 *
 * A reference is `{"$node": id}`. It is a component field's value, or one item of a list field's
 * value; never deeper (inside a plain JSON value it is just data). In a node entry, the values whose
 * references resolve among the file's own nodes are its components' data, its overrides' field
 * values and its overrides' added components' data. Components of an override's added nodes
 * resolve among those added nodes instead, so they belong to that node list, not to the entry.
 */
import type { ComponentEntry, NodeEntry, OverrideEntry } from "./SceneLoader";

/** The id a reference value names, or null when `value` isn't a reference. */
export function nodeRefId(value: unknown): string | null {
  return value && typeof value === "object" && !Array.isArray(value) && typeof (value as { $node?: unknown }).$node === "string" ? (value as { $node: string }).$node : null;
}

/** One reference a field value holds: the value itself, or the list item at `element`. */
export interface FieldNodeRef {
  readonly to: string;
  readonly element?: number;
}

/** The references a field value holds. */
export function fieldNodeRefs(value: unknown): FieldNodeRef[] {
  const self = nodeRefId(value);
  if (self !== null) return [{ to: self }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, element) => {
    const to = nodeRefId(item);
    return to === null ? [] : [{ to, element }];
  });
}

/** `value` with each reference it holds re-pointed by `map` (null: no node). The same value when nothing changed. */
export function mapFieldNodeRefs(value: unknown, map: (id: string) => string | null): unknown {
  const one = (v: unknown): unknown => {
    const id = nodeRefId(v);
    if (id === null) return v;
    const to = map(id);
    return to === id ? v : to === null ? null : { $node: to };
  };
  if (!Array.isArray(value)) return one(value);
  const out = value.map(one);
  return out.every((v, i) => v === value[i]) ? value : out;
}

/** Where a field value sits in a node entry. */
export type NodeRefSlot =
  | { readonly kind: "component"; readonly component: number }
  | { readonly kind: "override"; readonly override: number }
  | { readonly kind: "addComponent"; readonly override: number };

/** One field value of a node entry whose references resolve among the entry's file's nodes. */
export interface EntryFieldValue {
  readonly slot: NodeRefSlot;
  /** The override's target (empty for the entry itself or the instance root). */
  readonly target: readonly string[];
  readonly type: string;
  readonly field: string;
  readonly value: unknown;
}

/** Every field value of `entry` whose references resolve among its file's nodes. */
export function entryFieldValues(entry: NodeEntry): EntryFieldValue[] {
  const out: EntryFieldValue[] = [];
  (entry.components ?? []).forEach((c, component) => {
    for (const [field, value] of Object.entries(c.data ?? {})) out.push({ slot: { kind: "component", component }, target: [], type: c.type, field, value });
  });
  (entry.overrides ?? []).forEach((o, override) => {
    const target = o.target ?? [];
    if (o.component && o.field !== undefined && "value" in o) out.push({ slot: { kind: "override", override }, target, type: o.component, field: o.field, value: o.value });
    if (o.addComponent) for (const [field, value] of Object.entries(o.addComponent.data ?? {})) out.push({ slot: { kind: "addComponent", override }, target, type: o.addComponent.type, field, value });
  });
  return out;
}

/** `entry` with every reference in its own field values (see `entryFieldValues`) re-pointed by `map`; the same entry when nothing changed. */
export function mapEntryNodeRefs(entry: NodeEntry, map: (id: string) => string | null): NodeEntry {
  const data = (d: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!d) return d;
    let out: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(d)) {
      const next = mapFieldNodeRefs(v, map);
      if (next !== v) (out ??= { ...d })[k] = next;
    }
    return out ?? d;
  };
  const component = (c: ComponentEntry): ComponentEntry => {
    const d = data(c.data);
    return d === c.data ? c : { ...c, data: d };
  };
  const override = (o: OverrideEntry): OverrideEntry => {
    let out = o;
    if (o.component && o.field !== undefined && "value" in o) {
      const value = mapFieldNodeRefs(o.value, map);
      if (value !== o.value) out = { ...out, value };
    }
    if (o.addComponent) {
      const addComponent = component(o.addComponent);
      if (addComponent !== o.addComponent) out = { ...out, addComponent };
    }
    return out;
  };
  const components = entry.components?.map(component);
  const overrides = entry.overrides?.map(override);
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) => a === b || (!!a && !!b && a.every((x, i) => x === b[i]));
  if (same(components, entry.components) && same(overrides, entry.overrides)) return entry;
  return { ...entry, ...(components ? { components } : {}), ...(overrides ? { overrides } : {}) };
}
