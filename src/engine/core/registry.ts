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

/** The type of a single value: a field, or one item of a list field. */
export type ScalarFieldType =
  | NumberConstructor
  | BooleanConstructor
  | StringConstructor
  | typeof AssetRef
  | typeof PlainObject
  // Engine classes (Vector2, Vector3, Quaternion, Color, GameObject) are passed by reference;
  // typed loosely here to avoid import cycles.
  | (abstract new (...args: never[]) => unknown);

/**
 * A list field (ADR 0042): the item type in brackets, `@field([Number])`, `@field([Vector2])`,
 * `@field([GameObject])`. The value is a plain array; scene files store a JSON array of items in
 * their usual form. Lists don't nest.
 */
export type ListFieldType = readonly [ScalarFieldType];

export type FieldType = ScalarFieldType | ListFieldType;

/** True for a list field type (`[Number]`). */
export function isListType(type: unknown): type is ListFieldType {
  return Array.isArray(type);
}

/** The item type of a list field, or the type itself for any other field. */
export function itemType(type: FieldType): ScalarFieldType {
  return isListType(type) ? type[0] : type;
}

/** One choice of a dropdown field, with the label the editor shows. */
export interface FieldChoice {
  readonly label: string;
  readonly value: string | number;
}

/**
 * The values a field may take, shown as a dropdown in the editor (ADR 0042):
 * - a list of values: `["dynamic", "kinematic", "static"]` or `[1, 2, 4]`;
 * - an object of labels to values, such as a TypeScript enum: `{ Idle: 0, Run: 1 }` (a numeric
 *   enum's reverse entries are skipped);
 * - a function of the project settings, for lists that live there: `(s) => s.render.sortingLayers`, or
 *   labelled, `(s) => ({ Default: 1, Enemy: 2 })` (label = key; every entry is kept).
 *
 * Choices only guide the editor; scene files and scripts may still hold other values.
 */
export type FieldChoices =
  | readonly (string | number)[]
  | Readonly<Record<string, string | number>>
  | ((settings: import("./settings").ProjectSettings) => readonly (string | number)[] | Readonly<Record<string, string | number>>);

/**
 * The kind of asset an `AssetRef` field holds (ADR 0131): what the field needs, not a file format.
 * The editor offers only matching assets; scene files and scripts may still hold any path.
 * - `model`: model files (glTF, OBJ, FBX…); `mesh`: a model or a built-in mesh (`builtin:cube`);
 * - `material`: material assets and shader graphs; `texture`: images; `sprite`: images and their slices;
 * - `rendertexture`, `particles`, `formation`, `lut` (`.cube`), `tileset`, `uidocument` (`.ui.xml`),
 *   `scene`, `prefab`: assets of that kind;
 * - `environment`: what an Environment's `map` takes (HDR/EXR/DDS/`.env` maps, skies, cubemaps, panoramas);
 * - `envmap`: a baked `.env` map; `audio`: sound files; `font`: `.ttf`, `.otf`, `.woff`, `.woff2`;
 * - `navbake`: a baked navigation chunk (`.nav.bin`).
 */
export type AssetFieldKind =
  | "model"
  | "mesh"
  | "material"
  | "texture"
  | "sprite"
  | "rendertexture"
  | "audio"
  | "particles"
  | "formation"
  | "lut"
  | "environment"
  | "envmap"
  | "tileset"
  | "font"
  | "uidocument"
  | "navbake"
  | "scene"
  | "prefab";

/** Every `AssetFieldKind`, in declaration order. */
export const ASSET_FIELD_KINDS: readonly AssetFieldKind[] = [
  "model", "mesh", "material", "texture", "sprite", "rendertexture", "audio", "particles", "formation",
  "lut", "environment", "envmap", "tileset", "font", "uidocument", "navbake", "scene", "prefab",
];

/** Options on a declared field (ADR 0033, 0038, 0131). */
export interface FieldOptions {
  /** Replicate this field from server to clients on replicated nodes (T11). */
  replicate?: boolean;
  /** Roll back and re-simulate this field on the owning client (T13). Implies `replicate`. */
  predicted?: boolean;
  /** Send numbers rounded to this step (e.g. 0.01) to save bandwidth (T8, T11). */
  quantize?: number;
  /** The values this field (or each item of a list field) may take; the editor shows a dropdown. */
  choices?: FieldChoices;
  /**
   * For an `AssetRef` field, or each item of an `[AssetRef]` list: the kind (or kinds) of asset it
   * holds (ADR 0131). The editor offers only those. Only guides the editor.
   */
  kind?: AssetFieldKind | readonly AssetFieldKind[];
  /**
   * Not shown in the Inspector, for fields another editor owns (ADR 0131). The field is still saved,
   * loaded and replicated as usual.
   */
  hidden?: boolean;
}

/**
 * The choices of a field as labelled values, or null if it has none. `settings` feeds choices
 * that come from the project settings (without them those resolve to an empty list).
 */
export function resolveChoices(choices: FieldChoices | undefined, settings?: import("./settings").ProjectSettings): FieldChoice[] | null {
  if (choices === undefined) return null;
  const label = (v: string | number) => String(v);
  const fromFunction = typeof choices === "function";
  if (fromFunction && !settings) return [];
  const resolved = typeof choices === "function" ? choices(settings!) : choices;
  if (Array.isArray(resolved)) return (resolved as readonly (string | number)[]).map((value) => ({ label: label(value), value }));
  return Object.entries(resolved as Record<string, string | number>)
    // A numeric enum's reverse entries (`0: "Idle"`); a settings function's record is labels the project chose, kept whole.
    .filter(([key, value]) => fromFunction || !(typeof value === "string" && /^-?\d+(\.\d+)?$/.test(key)))
    .map(([key, value]) => ({ label: key, value }));
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

const FIELDS = Symbol("myco.fields");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ComponentClass<T = unknown> = abstract new () => T;

const classById = new Map<string, ComponentClass>();
const idByClass = new Map<ComponentClass, string>();

let replacing = false;

/** @internal What scripts registered while loading (ADR 0030): component, data component, system and input stream ids. */
export interface ScriptRegistrations {
  components: string[];
  data: string[];
  systems: string[];
  inputs: string[];
}

let recorded: { components: Set<string>; data: Set<string>; systems: Set<string>; inputs: Set<string> } | null = null;

/**
 * @internal Editor (ADR 0030): while on, registering a component, data component or system
 * whose id or name is taken replaces it instead of throwing, and every registration is recorded
 * (`_takeRecordedRegistrations`). On only while the editor loads or reloads project scripts.
 */
export function _setReplacingRegistrations(on: boolean): void {
  replacing = on;
  if (on) recorded = { components: new Set(), data: new Set(), systems: new Set(), inputs: new Set() };
}

/** @internal True while the editor is (re)loading project scripts (see `_setReplacingRegistrations`). */
export const _isReplacingRegistrations = () => replacing;

/** @internal Note a registration made while loading scripts. */
export function _recordRegistration(kind: keyof ScriptRegistrations, id: string): void {
  recorded?.[kind].add(id);
}

/** @internal What was registered since replacing was last switched on. */
export function _takeRecordedRegistrations(): ScriptRegistrations {
  const r = recorded ?? { components: new Set(), data: new Set(), systems: new Set(), inputs: new Set() };
  recorded = null;
  return { components: [...r.components], data: [...r.data], systems: [...r.systems], inputs: [...r.inputs] };
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
  if (isListType(type) && (type.length !== 1 || isListType(type[0]) || type[0] === undefined)) {
    throw new Error(`@field: a list field names one item type in brackets, e.g. @field([Number]); lists don't nest.`);
  }
  if (options?.kind !== undefined && itemType(type) !== AssetRef) {
    throw new Error(`@field: \`kind\` is for AssetRef fields (or [AssetRef] lists) only.`);
  }
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
