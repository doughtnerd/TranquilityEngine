// Which track a component field is animated by (ADR 0371 "Track kinds", 0373), and a field's scene-file value as that
// track's key values. The Animation window's Add Property list, key buttons and record mode all ask here, so a field
// is keyed one way everywhere. The kinds match the runtime binding table's (`runtime/features/properties/bindings.ts`):
// numbers are `float`, vectors `vec2`/`vec3`, rotations `quat`, colours `color`, booleans, `choices` (by index) and
// asset references `discrete`. A dotted path into a plain object (`spring.targetPosition`, D86) is animatable when the
// field lists it; its kind comes from its value (a number, a vector array, a `{x, y, z, w}` rotation, D91).
//
// Pure; reads the component registry only.
import { parseFieldPath } from "../../../../engine/animation/bindingPath";
import type { DiscreteType, DiscreteValue } from "../../../../engine/animation/tracks";
import { Color, Quaternion, Vector2, Vector3 } from "../../../../engine/core/math";
import { AssetRef, getComponentClass, getFields, isFieldAnimatable, resolveChoices, type FieldInfo } from "../../../../engine/core/registry";
import { accept, refuse, type EditResult } from "../../../../editor/sdk";

/** What track animates a field: a curve kind with its width, a rotation, or discrete values. */
export type FieldTrackShape =
  | { readonly kind: "float" | "vec2" | "vec3" | "vec4" | "color"; readonly width: number }
  | { readonly kind: "quat" }
  | { readonly kind: "discrete"; readonly valueType: DiscreteType; readonly choices?: readonly (string | number)[] };

/** A key's values: one number per component of a curve kind, `[x, y, z, w]` for a rotation, or a discrete value. */
export type FieldKeyValue = { readonly kind: "numbers"; readonly values: readonly number[] } | { readonly kind: "discrete"; readonly value: DiscreteValue };

const title = (type: string) => type.replace(/^[^.]*\./, "");

/** `engine.Transform` isn't a registered component class: its local pose is what the binding table writes (T20t). */
const TRANSFORM = "engine.Transform";
const TRANSFORM_FIELDS = { position: { kind: "vec3", width: 3 }, rotation: { kind: "quat" }, scale: { kind: "vec3", width: 3 } } as const satisfies Record<string, FieldTrackShape>;

/** Whether a track may drive `path` of component `type` (a field, or a dotted sub-path, D86). */
export function isAnimatablePath(type: string, path: string): boolean {
  if (type === TRANSFORM) return path in TRANSFORM_FIELDS;
  const cls = getComponentClass(type);
  return !!cls && isFieldAnimatable(cls, path);
}

/** The declared field `name` of `type` (a subclass's redeclaration wins). */
function fieldInfo(type: string, name: string): FieldInfo | null {
  const cls = getComponentClass(type);
  if (!cls) return null;
  const fields = getFields(cls);
  for (let i = fields.length - 1; i >= 0; i--) if (fields[i]!.name === name) return fields[i]!;
  return null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nums = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(isNum);
const isQuatObject = (v: unknown): v is { x: number; y: number; z: number; w: number } =>
  !!v && typeof v === "object" && ["x", "y", "z", "w"].every((k) => isNum((v as Record<string, unknown>)[k]));

/** The shape of a sub-path's value (D86: undeclared, so read from the value). */
function shapeOfValue(value: unknown): FieldTrackShape | null {
  if (isNum(value)) return { kind: "float", width: 1 };
  if (typeof value === "boolean") return { kind: "discrete", valueType: "bool" };
  if (nums(value, 2)) return { kind: "vec2", width: 2 };
  if (nums(value, 3)) return { kind: "vec3", width: 3 };
  if (isQuatObject(value) || nums(value, 4)) return { kind: "quat" };
  return null;
}

/**
 * The track that animates `path` of component `type` (a field, or a dotted sub-path, D86), or why it can't be
 * animated. A sub-path's kind is read from `value` (its value now, in scene-file JSON).
 */
export function fieldTrackShape(type: string, path: string, value?: unknown): EditResult<FieldTrackShape> {
  if (type === TRANSFORM) return path in TRANSFORM_FIELDS ? accept(TRANSFORM_FIELDS[path as keyof typeof TRANSFORM_FIELDS]) : refuse(`Transform.${path} isn't animatable`);
  const cls = getComponentClass(type);
  if (!cls) return refuse(`${type} isn't a registered component`);
  if (!isFieldAnimatable(cls, path)) return refuse(`${title(type)}.${path} isn't animatable`);
  if (parseFieldPath(path).sub.length) {
    const shape = shapeOfValue(value);
    return shape ? accept(shape) : refuse(`${title(type)}.${path} holds no value a track can key`);
  }
  const info = fieldInfo(type, path)!;
  const choices = resolveChoices(info.options?.choices);
  if (choices) return choices.length ? accept({ kind: "discrete", valueType: "enum", choices: choices.map((c) => c.value) }) : refuse(`${title(type)}.${path}'s choices come from the project settings`);
  const t = info.type;
  if (t === Number) return accept({ kind: "float", width: 1 });
  if (t === Boolean) return accept({ kind: "discrete", valueType: "bool" });
  if (t === AssetRef) return accept({ kind: "discrete", valueType: "asset" });
  if (t === Vector2) return accept({ kind: "vec2", width: 2 });
  if (t === Vector3) return accept({ kind: "vec3", width: 3 });
  if (t === Quaternion) return accept({ kind: "quat" });
  if (t === Color) return accept({ kind: "color", width: 4 });
  return refuse(`${title(type)}.${path} has no track kind`);
}

/** The animatable sub-paths a plain-object field lists (D86), `["targetPosition"]` for `spring`; empty for other fields. */
export function animatableSubPaths(type: string, field: string): string[] {
  const declared = fieldInfo(type, field)?.options?.animatable;
  return Array.isArray(declared) ? [...declared] : [];
}

/**
 * The field paths of `field` that tracks animate: the field itself when it is animatable, else its listed animatable
 * sub-paths (`spring.targetPosition`); empty when it can't be animated.
 */
export function animatedPaths(type: string, field: string): string[] {
  if (isAnimatablePath(type, field)) return [field];
  return animatableSubPaths(type, field).map((s) => `${field}.${s}`);
}

/** A field value (scene-file JSON) as a key of `shape`, or why it can't be one. */
export function keyValueOf(shape: FieldTrackShape, value: unknown): EditResult<FieldKeyValue> {
  const numbers = (values: readonly number[]) => accept<FieldKeyValue>({ kind: "numbers", values });
  switch (shape.kind) {
    case "float":
      return isNum(value) ? numbers([value + 0]) : refuse("the value isn't a number");
    case "vec2":
    case "vec3":
    case "vec4": {
      const n = shape.width;
      if (nums(value, n)) return numbers(value.map((v) => v + 0));
      if (value && typeof value === "object") {
        const xs = ["x", "y", "z", "w"].slice(0, n).map((k) => (value as Record<string, unknown>)[k]);
        if (xs.every(isNum)) return numbers(xs as number[]);
      }
      return refuse(`the value isn't a ${n}-component vector`);
    }
    case "color": {
      if (typeof value !== "string" && !(Array.isArray(value) && value.every(isNum))) return refuse("the value isn't a colour");
      try {
        const c = Color.from(value as string | number[]);
        return numbers([c.r, c.g, c.b, c.a]);
      } catch {
        return refuse("the value isn't a colour");
      }
    }
    case "quat": {
      const q = isQuatObject(value) ? [value.x, value.y, value.z, value.w] : nums(value, 4) ? value : null;
      if (!q) return refuse("the value isn't a rotation");
      const len = Math.hypot(...q);
      return len > 0 ? numbers(q.map((v) => v / len + 0)) : refuse("a zero quaternion isn't a rotation");
    }
    case "discrete": {
      if (shape.valueType === "bool") return typeof value === "boolean" ? accept({ kind: "discrete", value }) : refuse("the value isn't true or false");
      if (shape.valueType === "asset") return typeof value === "string" ? accept({ kind: "discrete", value }) : refuse("the value isn't an asset reference");
      const at = shape.choices?.findIndex((c) => c === value) ?? -1;
      return at >= 0 ? accept({ kind: "discrete", value: at }) : refuse(`${JSON.stringify(value)} isn't one of the choices`);
    }
  }
}
