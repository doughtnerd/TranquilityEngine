// Field kinds (ADR 0273, finishing ADR 0165): one table of the kinds of value an Inspector field edits (ADR 0042).
// Each kind owns its rules: the scene-file form (ADR 0013) of a live value, when two values show as the same
// (a multi-selection's "mixed"), the blank value a list's Add starts from, whether a value may be unset ("Auto",
// and what Set writes then), and, for vectors and rotations, reading and writing one axis. Callers ask
// `fieldKind(field)` and get the kind; they never switch on names. A list's kind is built with its item kind, and
// every conversion takes the node-id resolution as a required argument, so neither can be forgotten.
// The widget for each kind is registered by kind in `../ui/fieldRows.tsx`, keeping this module free of Preact.
import { AssetRef, Color, GameObject, PlainObject, Quaternion, Vector2, Vector3 } from "../../engine";
import { formatHex } from "../../engine/core/colorSpace";
import { isListType, type FieldChoice } from "../../engine/core/registry";
import type { FieldValue } from "../../engine/editor";
import { itemField } from "../fieldValues";
import { rotationCodec, rotationFrom, withRotationAxis, type RotationView } from "./rotationCodec";

/** The kinds of field the Inspector edits. */
export type FieldKindName =
  | "number"
  | "integer"
  | "boolean"
  | "string"
  | "asset"
  | "color"
  | "vector2"
  | "vector3"
  | "quaternion"
  | "node"
  | "object"
  | "choice"
  | "list"
  | "unknown";

/**
 * How a node reference becomes its scene-file id: a document node id, a live World's entity key, or null when the node
 * can't be referenced there (written as `null`).
 */
export type NodeIds = (node: GameObject) => string | null;

/** Node-id resolution for values that can't hold node references (a Transform's pose): resolves none. */
export const noNodeRefs: NodeIds = () => null;

/** Reading and writing one shown axis of a vector or rotation. */
export interface AxisEdit {
  /** The axes `value` shows (a rotation's as `view` shows it; an unset vector's as Set would write it). */
  read(value: unknown, view: RotationView): number[];
  /** `value` with shown axis `axis` set to `n`, its other shown axes kept (a rotation comes back as a Quaternion). */
  write(value: unknown, axis: number, n: number, view: RotationView): unknown;
}

/** One kind of field value and its rules. */
export interface FieldKind {
  readonly name: FieldKindName;
  /** False for values the scene file can't hold (types the Inspector doesn't know): stored values and Keep values leave them out. */
  readonly savable: boolean;
  /** The scene-file form of a live value or of what a widget commits (vectors as arrays, colors as hex, assets as `asset:` paths, nodes as `{ $node }`). */
  toJSON(value: unknown, nodeIds: NodeIds): unknown;
  /** True when `a` and `b` show as the same (a rotation and its negation included), so a multi-selection isn't mixed. */
  same(a: unknown, b: unknown, nodeIds: NodeIds): boolean;
  /** The value a list's Add starts from when the list is empty (`choices`: the field's dropdown choices, for a choice). */
  blank(choices: readonly FieldChoice[] | null): unknown;
  /** True when `value` is unset, which this kind allows ("Auto": a sprite's size then comes from its texture). */
  isUnset(value: unknown): boolean;
  /** For kinds that may be unset: the value Set writes. */
  readonly explicit?: () => unknown;
  /** For vectors and rotations: per-axis reads and writes. */
  readonly axes?: AxisEdit;
  /** For a list: its items' kind. */
  readonly item?: FieldKind;
}

const isNone = (v: unknown): v is null | undefined => v === null || v === undefined;

/** JSON text for a scene-file value (a value that can't be written: its string form). */
function jsonText(v: unknown): string {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return String(v);
  }
}

/** A kind whose values are the same when their scene-file forms are, and which is never unset. */
function kind(name: FieldKindName, toJSON: (value: unknown, nodeIds: NodeIds) => unknown, blank: (choices: readonly FieldChoice[] | null) => unknown, extra: Partial<FieldKind> = {}): FieldKind {
  return {
    name,
    savable: true,
    toJSON,
    same: (a, b, nodeIds) => jsonText(toJSON(a, nodeIds)) === jsonText(toJSON(b, nodeIds)),
    blank,
    isUnset: () => false,
    ...extra,
  };
}

/** Scene-file JSON for a color: `#rrggbb`, or `#rrggbbaa` when not opaque. */
function colorJSON(c: Color): string {
  return formatHex([c.r, c.g, c.b], c.a);
}

/** A vector's axes (array or `toArray()`), or null when it has none. */
const vectorAxes = (value: unknown): number[] | null =>
  Array.isArray(value) ? [...value] : value && typeof value === "object" && "toArray" in value ? (value as { toArray(): number[] }).toArray() : null;

/**
 * A vector kind. A vector field may be unset (Auto: a sprite's size comes from its texture); Set writes `explicit`
 * (a 2D vector's 1, 1, a size; a 3D one's origin), which is also what an axis edit of an unset vector starts from. An
 * empty list's Add starts from the origin.
 */
function vectorKind(name: "vector2" | "vector3", explicit: readonly number[]): FieldKind {
  const read = (value: unknown) => vectorAxes(value) ?? [...explicit];
  return kind(name, (v) => (isNone(v) ? null : vectorAxes(v)), () => explicit.map(() => 0), {
    isUnset: isNone,
    explicit: () => [...explicit],
    axes: { read, write: (value, axis, n) => read(value).map((old, i) => (i === axis ? n : old)) },
  });
}

const radians = rotationCodec("radians");

/**
 * Rotations (ADR 0163, 0165): stored as a quaternion `[x, y, z, w]` in the rotation codec's form, from a Quaternion,
 * a raw `[x, y, z, w]` or Euler radians `[x, y, z]` (ZXY, remembered for the Inspector); the same turn is the same
 * value (the codec's `same`); axes are the ones the view shows.
 */
const quaternionKind: FieldKind = {
  name: "quaternion",
  savable: true,
  toJSON: (v) => {
    if (isNone(v)) return null;
    const q = rotationFrom(v);
    return q ? radians.toJSON(q) : v;
  },
  same: (a, b) => {
    if (isNone(a) || isNone(b)) return isNone(a) && isNone(b);
    const qa = rotationFrom(a), qb = rotationFrom(b);
    return qa && qb ? radians.same(qa, qb) : jsonText(a) === jsonText(b);
  },
  blank: () => [0, 0, 0, 1],
  isUnset: () => false,
  axes: {
    read: (value, view) => rotationCodec(view).read(rotationFrom(value) ?? Quaternion.identity),
    write: (value, axis, n, view) => withRotationAxis(rotationFrom(value), view, axis, n),
  },
};

/** Node references: `{ "$node": id }` (a node choice's key is already one), or null for none or a node `nodeIds` can't name. */
const nodeKind = kind(
  "node",
  (v, nodeIds) => {
    if (isNone(v)) return null;
    if (typeof v === "string") return { $node: v };
    const id = nodeIds(v as GameObject);
    return id === null ? null : { $node: id };
  },
  () => null,
);

/** The kinds that aren't lists, by name. */
export const FIELD_KINDS: Readonly<Record<Exclude<FieldKindName, "list">, FieldKind>> = {
  number: kind("number", (v) => Number(v), () => 0),
  integer: kind("integer", (v) => Math.round(Number(v)), () => 0),
  boolean: kind("boolean", (v) => Boolean(v), () => false),
  string: kind("string", (v) => v, () => ""),
  asset: kind(
    "asset",
    (v) => {
      const path = String(v ?? "");
      return path === "" || path.startsWith("asset:") ? path : `asset:${path}`;
    },
    () => "",
  ),
  color: kind("color", (v) => (isNone(v) ? null : colorJSON(v instanceof Color ? v : Color.from(v as string))), () => Color.white),
  vector2: vectorKind("vector2", [1, 1]),
  vector3: vectorKind("vector3", [0, 0, 0]),
  quaternion: quaternionKind,
  node: nodeKind,
  object: kind("object", (v) => structuredClone(v), () => ({}), { same: (a, b) => jsonText(a) === jsonText(b) }),
  choice: kind("choice", (v) => v, (choices) => choices?.[0]?.value ?? ""),
  unknown: { ...kind("unknown", (v) => v, () => null), savable: false },
};

/** A list of `item`s (ADR 0042): each item in its own scene-file form; the whole list is written at once. */
function listKind(item: FieldKind): FieldKind {
  const items = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return {
    name: "list",
    savable: item.savable,
    item,
    toJSON: (v, nodeIds) => items(v).map((x) => item.toJSON(x, nodeIds)),
    same: (a, b, nodeIds) => {
      const xs = items(a), ys = items(b);
      return xs.length === ys.length && xs.every((x, i) => item.same(x, ys[i], nodeIds));
    },
    blank: () => [],
    isUnset: () => false,
  };
}

/** A non-list kind from the declared type, falling back to the live value's shape. */
function scalarKind(field: FieldValue): FieldKind {
  const t = field.type as unknown;
  if (field.options?.choices !== undefined) return FIELD_KINDS.choice;
  if (t === Quaternion) return FIELD_KINDS.quaternion;
  if (t === Number) return FIELD_KINDS.number;
  if (t === Boolean) return FIELD_KINDS.boolean;
  if (t === String) return FIELD_KINDS.string;
  if (t === AssetRef) return FIELD_KINDS.asset;
  if (t === Color) return FIELD_KINDS.color;
  if (t === Vector2) return FIELD_KINDS.vector2;
  if (t === Vector3) return FIELD_KINDS.vector3;
  if (t === GameObject) return FIELD_KINDS.node;
  if (t === PlainObject) return FIELD_KINDS.object;
  if (t && typeof t === "object" && "kind" in t) return (t as { kind: string }).kind === "f32" ? FIELD_KINDS.number : FIELD_KINDS.integer; // data component scalars
  const v = field.value;
  if (typeof v === "number") return FIELD_KINDS.number;
  if (typeof v === "boolean") return FIELD_KINDS.boolean;
  if (typeof v === "string") return FIELD_KINDS.string;
  return FIELD_KINDS.unknown;
}

/** The kind of `field`, from its declared type (a list's with its item kind), falling back to the live value's shape. */
export function fieldKind(field: FieldValue): FieldKind {
  return isListType(field.type) ? listKind(scalarKind(itemField(field, 0, undefined))) : scalarKind(field);
}
