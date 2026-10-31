/**
 * Type registry and field declarations (ADR 0013).
 *
 * Components are identified in scene data by stable string ids (`engine.SpriteRenderer`,
 * `game.Bird`) rather than class names, which minifiers mangle. Serializable fields are
 * declared with standard ES decorators; the declarations drive scene loading and, later,
 * the editor inspector (ADR 0022).
 */

// Decorator metadata needs Symbol.metadata to exist before any decorated class is evaluated.
// Every decorated class imports this module, so the polyfill always runs first.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

/** Marker for fields that hold an asset path (`"asset:images/bird.png"` in scene data). */
export const AssetRef = { kind: "asset" } as const;

/** Marker for fields that hold arbitrary JSON-compatible objects (deep-copied on load). */
export const PlainObject = { kind: "object" } as const;

export type FieldType =
  | NumberConstructor
  | BooleanConstructor
  | StringConstructor
  | typeof AssetRef
  | typeof PlainObject
  // Engine classes (Vector2, Vector3, Color, GameObject) are passed by reference; typed loosely
  // here to avoid import cycles.
  | (abstract new (...args: never[]) => unknown);

export interface FieldInfo {
  readonly name: string;
  readonly type: FieldType;
}

const FIELDS = Symbol("tranquility.fields");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ComponentClass<T = unknown> = abstract new () => T;

const classById = new Map<string, ComponentClass>();
const idByClass = new Map<ComponentClass, string>();

/** Register a component class under a stable id. Usually applied with `@behavior` / `@component`. */
export function registerComponent(id: string, type: ComponentClass): void {
  const existing = classById.get(id);
  if (existing && existing !== type) {
    throw new Error(`Component id "${id}" is already registered to a different class.`);
  }
  classById.set(id, type);
  idByClass.set(type, id);
}

/** Class decorator: register a GameBehavior under a stable id used by scene files. */
export function behavior(id: string) {
  return function <T extends ComponentClass>(value: T, _context: ClassDecoratorContext): void {
    registerComponent(id, value);
  };
}

/** Class decorator for built-in engine components. Same as `@behavior`. */
export const component = behavior;

/** Field decorator: declare a serializable field and its type. */
export function field(type: FieldType) {
  return function (_value: undefined, context: ClassFieldDecoratorContext): void {
    const meta = context.metadata as Record<symbol, FieldInfo[] | undefined>;
    // Metadata objects inherit from the parent class's metadata; copy before mutating.
    if (!Object.prototype.hasOwnProperty.call(meta, FIELDS)) {
      meta[FIELDS] = [...(meta[FIELDS] ?? [])];
    }
    meta[FIELDS]!.push({ name: String(context.name), type });
  };
}

export function getFields(type: ComponentClass): readonly FieldInfo[] {
  const meta = (type as unknown as Record<symbol, Record<symbol, FieldInfo[]> | undefined>)[Symbol.metadata as symbol];
  return meta?.[FIELDS] ?? [];
}

export function getComponentClass(id: string): ComponentClass | undefined {
  return classById.get(id);
}

export function getComponentId(type: ComponentClass): string | undefined {
  return idByClass.get(type);
}
