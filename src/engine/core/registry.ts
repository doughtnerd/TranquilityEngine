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

/** Options on a declared field (ADR 0033). */
export interface FieldOptions {
  /** Replicate this field from server to clients on replicated nodes (T11). */
  replicate?: boolean;
  /** Roll back and re-simulate this field on the owning client (T13). Implies `replicate`. */
  predicted?: boolean;
  /** Send numbers rounded to this step (e.g. 0.01) to save bandwidth (T8, T11). */
  quantize?: number;
}

export interface FieldInfo {
  readonly name: string;
  readonly type: FieldType;
  readonly options?: FieldOptions;
}

/** Options on a registered component class (ADR 0033). */
export interface ComponentOptions {
  /**
   * Tags of the Worlds this component exists in (client-only, server-only…). In other Worlds it
   * isn't created when a scene loads. Default: every World (T11).
   */
  worlds?: readonly import("./worlds").WorldTag[];
}

const componentOptions = new Map<ComponentClass, ComponentOptions>();

/** The options a component class was registered with. */
export function getComponentOptions(type: ComponentClass): ComponentOptions {
  return componentOptions.get(type) ?? {};
}

const FIELDS = Symbol("tranquility.fields");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ComponentClass<T = unknown> = abstract new () => T;

const classById = new Map<string, ComponentClass>();
const idByClass = new Map<ComponentClass, string>();

let replacing = false;

/** @internal What scripts registered while loading (ADR 0030): component, data component and system ids. */
export interface ScriptRegistrations {
  components: string[];
  data: string[];
  systems: string[];
}

let recorded: { components: Set<string>; data: Set<string>; systems: Set<string> } | null = null;

/**
 * @internal Editor (ADR 0030): while on, registering a component, data component or system
 * whose id or name is taken replaces it instead of throwing, and every registration is recorded
 * (`_takeRecordedRegistrations`). On only while the editor loads or reloads project scripts.
 */
export function _setReplacingRegistrations(on: boolean): void {
  replacing = on;
  if (on) recorded = { components: new Set(), data: new Set(), systems: new Set() };
}

/** @internal True while the editor is (re)loading project scripts (see `_setReplacingRegistrations`). */
export const _isReplacingRegistrations = () => replacing;

/** @internal Note a registration made while loading scripts. */
export function _recordRegistration(kind: keyof ScriptRegistrations, id: string): void {
  recorded?.[kind].add(id);
}

/** @internal What was registered since replacing was last switched on. */
export function _takeRecordedRegistrations(): ScriptRegistrations {
  const r = recorded ?? { components: new Set(), data: new Set(), systems: new Set() };
  recorded = null;
  return { components: [...r.components], data: [...r.data], systems: [...r.systems] };
}

/** Classes the editor build registered that a script's registration replaced: put back when the script's goes. */
const buildClasses = new Map<string, ComponentClass>();
const fromBuild = new Set<string>();

/** @internal Editor: forget a component id a script registered, putting back the editor build's class if it replaced one. */
export function _unregisterComponent(id: string): void {
  const cls = classById.get(id);
  if (cls) idByClass.delete(cls);
  const original = buildClasses.get(id);
  if (original) {
    classById.set(id, original);
    idByClass.set(original, id);
    buildClasses.delete(id);
  } else {
    classById.delete(id);
  }
}

/** Register a component class under a stable id. Usually applied with `@behavior` / `@component`. */
export function registerComponent(id: string, type: ComponentClass, options?: ComponentOptions): void {
  if (options) componentOptions.set(type, options);
  const existing = classById.get(id);
  if (existing && existing !== type) {
    if (!replacing) throw new Error(`Component id "${id}" is already registered to a different class.`);
    idByClass.delete(existing);
    if (fromBuild.has(id) && !buildClasses.has(id)) buildClasses.set(id, existing);
  }
  if (replacing) _recordRegistration("components", id);
  else fromBuild.add(id);
  classById.set(id, type);
  idByClass.set(type, id);
}

/** Class decorator: register a GameBehavior under a stable id used by scene files. */
export function behavior(id: string, options?: ComponentOptions) {
  return function <T extends ComponentClass>(value: T, _context: ClassDecoratorContext): void {
    registerComponent(id, value, options);
  };
}

/** Class decorator for built-in engine components. Same as `@behavior`. */
export const component = behavior;

/** Field decorator: declare a serializable field and its type (and, for netcode, how it replicates). */
export function field(type: FieldType, options?: FieldOptions) {
  return function (_value: undefined, context: ClassFieldDecoratorContext): void {
    const meta = context.metadata as Record<symbol, FieldInfo[] | undefined>;
    // Metadata objects inherit from the parent class's metadata; copy before mutating.
    if (!Object.prototype.hasOwnProperty.call(meta, FIELDS)) {
      meta[FIELDS] = [...(meta[FIELDS] ?? [])];
    }
    meta[FIELDS]!.push(options ? { name: String(context.name), type, options } : { name: String(context.name), type });
  };
}

export function getFields(type: ComponentClass): readonly FieldInfo[] {
  const meta = (type as unknown as Record<symbol, Record<symbol, FieldInfo[]> | undefined>)[Symbol.metadata as symbol];
  return meta?.[FIELDS] ?? [];
}

export function getComponentClass(id: string): ComponentClass | undefined {
  return classById.get(id);
}

/** @internal Every registered component id, in registration order (for the editor's Add Component list). */
export function listComponentIds(): string[] {
  return [...classById.keys()];
}

export function getComponentId(type: ComponentClass): string | undefined {
  return idByClass.get(type);
}
