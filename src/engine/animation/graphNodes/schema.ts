/**
 * The node catalogue's schema (ADR 0372 "One node catalogue"): every node kind declares its parameters once — name,
 * kind, unit, range, default, animatable — and how they pack into the kind's parameter block (the u32 words
 * `anim-graph`'s family modules document). The graph compiler (`graphCompile.ts`) packs with it, the graph editor's
 * cards read it, and third-party nodes (`anim-plugin-sdk`'s descriptor) use the same fields and ids.
 *
 * - **Value kinds** `float`, `int`, `bool`, `vec2`, `vec3`, `quat` carry `type`, the `anim-format` `ParamType` id
 *   (float 0, int 1, bool 2, vec2 3, vec3 4, quat 5), the same ids as the plugin SDK's `ParamKind`. `enum` packs its
 *   choice's index (type int).
 * - **Reference kinds:** `parameter` (a graph parameter's index, of `parameterTypes`), `asset` (an asset reference put in
 *   the string table and bound by string id at load, `asset` saying what it binds to), `name` (a string id; `hashed`
 *   when the core matches it across tables by FNV-1a, D55: markers, curves), `bone` (a bone index, or a Humanoid role
 *   name packed `ROLE | role`), `target` (an IK target slot name; the compiler assigns slot indices).
 * - **Lists** (`floatList`, `intList`, `boneList`, `targetList`, `parameterList`, `nameList`) pack element by element.
 * - **Animatable** floats take a number or a float graph parameter's name and pack two words: the value, then the
 *   parameter's index or `NONE` (the Rust layouts' "f32 x; u32 a float parameter giving it instead" pairs). For
 *   plugin nodes, animatable is the descriptor's `PARAM_ANIMATABLE` (a parameter binding).
 * - **Units** are the plugin SDK's `Unit` ids (`descriptor.rs`), so cards label built-in and third-party nodes alike.
 *
 * Absent words: the compiler always writes full blocks, with each default explicit (`NONE` = 0xFFFFFFFF for an absent
 * parameter, slot, bone or string word), which the core reads exactly as it reads an absent word.
 *
 * Pure; no plugin, no DOM. Internal: not public API.
 */
import type { GraphFamily, GraphParamType, NodeParamValue } from "../animGraph";

/** @internal "No index": an absent parameter, string, bone, slot or node word. */
export const NONE = 0xffffffff;

/** @internal Units, in `anim-plugin-sdk`'s `Unit` id order (`descriptor.rs`). */
export const PARAM_UNITS = ["none", "seconds", "meters", "degrees", "radians", "ratio", "percent", "hertz", "metersPerSecond", "degreesPerSecond", "multiplier"] as const;
export type ParamUnit = (typeof PARAM_UNITS)[number];

/** @internal The value kinds and their `ParamType` ids (`anim-format/src/graph.rs`; the plugin SDK's `ParamKind`). */
export const VALUE_KIND_TYPES = Object.freeze({ float: 0, int: 1, bool: 2, vec2: 3, vec3: 4, quat: 5 } as const);
export type ValueKind = keyof typeof VALUE_KIND_TYPES;
export type ListKind = "floatList" | "intList" | "boneList" | "targetList" | "parameterList" | "nameList";
export type NodeParamKind = ValueKind | "enum" | "parameter" | "asset" | "name" | "bone" | "target" | ListKind;

/** @internal What an asset reference binds to at load (`graph_bind` of its string id). */
export type AssetRefKind = "clip" | "mask" | "graph" | "posedb" | "retargetMap" | "plugin";

/** @internal One parameter of a node kind. */
export interface NodeParamSchema {
  readonly name: string;
  readonly kind: NodeParamKind;
  /** The value's `ParamType` id (value kinds and enums; list elements for number lists), else null. */
  readonly type: number | null;
  readonly unit: ParamUnit;
  readonly min?: number;
  readonly max?: number;
  /** The value when absent; null: none (packs `NONE` or the documented zero). */
  readonly default: NodeParamValue | null;
  /** Takes a graph parameter instead of a constant (two words: value, parameter). */
  readonly animatable: boolean;
  readonly choices?: readonly string[];
  /** Graph parameter types accepted (`parameter`, `parameterList`, animatable values). */
  readonly parameterTypes?: readonly GraphParamType[];
  readonly asset?: AssetRefKind;
  /** The core matches this name by its FNV-1a hash (D55), not by string id. */
  readonly hashed?: boolean;
  /** List length limits. */
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly doc: string;
}

/** @internal A node kind's pose inputs. */
export interface NodeInputsSchema {
  readonly min: number;
  readonly max: number;
  /** Names of fixed inputs, in order; a variadic kind names one ("samples"). */
  readonly names: readonly string[];
}

/** @internal Which side table names a node (`MACHINES`, `CHOOSERS`, `SLOTS`, `LINKED`). */
export type NodeSideTable = "machine" | "chooser" | "slot" | "linked";

/**
 * @internal What a kind's `pack` writes with: each method reads the node's value of a declared parameter (or its default),
 * checks it against the schema (problems name the parameter's path), and appends its words.
 */
export interface NodePacker {
  /** The node's input count. */
  readonly inputCount: number;
  /** Appends raw words. */
  push(...words: number[]): void;
  /** Appends f32 bits. */
  f32(v: number): void;
  /** A float parameter's value (default when absent or wrong; clamped to its range). */
  num(name: string): number;
  /** An int parameter's value, or null when absent with no default. */
  int(name: string): number | null;
  bool(name: string): boolean;
  /** An enum parameter's choice index. */
  choice(name: string): number;
  /** A vec2/vec3/quat parameter's components. */
  vec(name: string): number[];
  /** An animatable float: the constant and the graph parameter index (or `NONE`). */
  animated(name: string): [number, number];
  /** A parameter reference's index, or `NONE`. */
  parameter(name: string): number;
  /** An asset reference's string id, or `NONE`. */
  asset(name: string): number;
  /** A name's string id, or `NONE`. */
  name(name: string): number;
  /** A bone word: index, `ROLE | role`, or `NONE`. */
  bone(name: string): number;
  /** A bone word for a bone or Humanoid role name (not a parameter's value). */
  boneByName(name: string): number;
  /** A string parameter's text ("" when absent). */
  text(name: string): string;
  /** A string list parameter's texts. */
  texts(name: string): string[];
  /** An IK target slot index, or `NONE`. */
  target(name: string): number;
  /** Whether the node sets the parameter. */
  has(name: string): boolean;
  /** A list parameter's packed words (floats as f32 bits). */
  list(name: string): number[];
  /** A list parameter's length. */
  listLength(name: string): number;
  /** A top-level graph layer's index by name, or `NONE`. */
  layerIndex(name: string): number;
  /** Assigns `n` consecutive ray rows (grounders), returning the first. */
  rays(n: number): number;
  /** Reports a problem at the node (or one of its parameters). */
  problem(message: string, param?: string, warning?: boolean): void;
}

/** @internal One node kind. */
export interface NodeKindSchema {
  readonly family: GraphFamily;
  /** The kind name (`GRAPH_NODE_KINDS`). */
  readonly kind: string;
  /** The `u16` kind id (`<family>.rs`'s `kind` module). */
  readonly id: number;
  readonly doc: string;
  readonly inputs: NodeInputsSchema;
  readonly params: readonly NodeParamSchema[];
  readonly side?: NodeSideTable;
  /** Packs the parameter block. */
  pack(p: NodePacker): void;
}

/** @internal One family file's contents. */
export interface NodeFamilyCatalogue {
  readonly family: GraphFamily;
  /** In kind id order (index = id). */
  readonly kinds: readonly NodeKindSchema[];
}

// --- schema builders (shared by the family files) -------------------------------------------------------------------

type Extra = Partial<Omit<NodeParamSchema, "name" | "kind" | "type" | "doc">>;
const base = (name: string, kind: NodeParamKind, type: number | null, doc: string, extra: Extra): NodeParamSchema => ({ unit: "none", default: null, animatable: false, ...extra, name, kind, type, doc });

/** @internal Parameter builders. */
export const P = {
  float: (name: string, def: number, doc: string, extra: Extra = {}) => base(name, "float", 0, doc, { default: def, ...extra }),
  /** An animatable float (two words: value, parameter). */
  animated: (name: string, def: number, doc: string, extra: Extra = {}) => base(name, "float", 0, doc, { default: def, animatable: true, parameterTypes: ["float"], ...extra }),
  int: (name: string, def: number | null, doc: string, extra: Extra = {}) => base(name, "int", 1, doc, { default: def, ...extra }),
  bool: (name: string, def: boolean, doc: string, extra: Extra = {}) => base(name, "bool", 2, doc, { default: def, ...extra }),
  vec2: (name: string, def: readonly number[], doc: string, extra: Extra = {}) => base(name, "vec2", 3, doc, { default: def, ...extra }),
  vec3: (name: string, def: readonly number[], doc: string, extra: Extra = {}) => base(name, "vec3", 4, doc, { default: def, ...extra }),
  quat: (name: string, def: readonly number[], doc: string, extra: Extra = {}) => base(name, "quat", 5, doc, { default: def, ...extra }),
  enum: (name: string, choices: readonly string[], doc: string, extra: Extra = {}) => base(name, "enum", 1, doc, { default: choices[0], choices, ...extra }),
  parameter: (name: string, types: readonly GraphParamType[], doc: string, extra: Extra = {}) => base(name, "parameter", null, doc, { parameterTypes: types, ...extra }),
  asset: (name: string, asset: AssetRefKind, doc: string, extra: Extra = {}) => base(name, "asset", null, doc, { asset, ...extra }),
  name: (name: string, doc: string, extra: Extra = {}) => base(name, "name", null, doc, extra),
  bone: (name: string, doc: string, extra: Extra = {}) => base(name, "bone", null, doc, extra),
  target: (name: string, doc: string, extra: Extra = {}) => base(name, "target", null, doc, extra),
  list: (name: string, kind: ListKind, doc: string, extra: Extra = {}) => base(name, kind, kind === "floatList" ? 0 : kind === "intList" ? 1 : null, doc, extra),
};

/** @internal Packs `names` in order by their kinds (animatable floats as two words). */
export function packInOrder(p: NodePacker, schema: readonly NodeParamSchema[], names?: readonly string[]): void {
  for (const s of names ? names.map((n) => schema.find((x) => x.name === n)!) : schema) {
    switch (s.kind) {
      case "float":
        if (s.animatable) {
          const [v, q] = p.animated(s.name);
          p.f32(v);
          p.push(q);
        } else p.f32(p.num(s.name));
        break;
      case "int": p.push(p.int(s.name) ?? NONE); break;
      case "bool": p.push(p.bool(s.name) ? 1 : 0); break;
      case "enum": p.push(p.choice(s.name)); break;
      case "vec2": case "vec3": case "quat": for (const c of p.vec(s.name)) p.f32(c); break;
      case "parameter": p.push(p.parameter(s.name)); break;
      case "asset": p.push(p.asset(s.name)); break;
      case "name": p.push(p.name(s.name)); break;
      case "bone": p.push(p.bone(s.name)); break;
      case "target": p.push(p.target(s.name)); break;
      default: p.push(...p.list(s.name));
    }
  }
}

/** @internal A kind definition (checks nothing; the registry test does). */
export const kind = (family: GraphFamily, name: string, id: number, doc: string, inputs: NodeInputsSchema, params: readonly NodeParamSchema[], pack?: (p: NodePacker, params: readonly NodeParamSchema[]) => void, side?: NodeSideTable): NodeKindSchema => ({
  family, kind: name, id, doc, inputs, params, ...(side ? { side } : {}),
  pack: (p) => (pack ? pack(p, params) : packInOrder(p, params)),
});

/** @internal Input shapes. */
export const I = {
  none: { min: 0, max: 0, names: [] } as NodeInputsSchema,
  one: (name = "input"): NodeInputsSchema => ({ min: 1, max: 1, names: [name] }),
  fixed: (...names: string[]): NodeInputsSchema => ({ min: names.length, max: names.length, names }),
  range: (min: number, max: number, ...names: string[]): NodeInputsSchema => ({ min, max, names }),
};
