/**
 * A third-party node module's descriptor blob (ADR 0370 "Third-party graph and rig nodes"): the node kinds a module
 * provides and each one's parameter schema, as `myco_node_describe` returns it. The layout is
 * `native/anim/crates/anim-plugin-sdk/src/descriptor.rs` (version 1, little-endian, no padding); its parameter kinds are
 * the catalogue's value kinds and its unit ids the catalogue's units (`graphNodes/schema.ts`), so the catalogue builds a
 * card per node kind from it (`graphNodes/plugin.ts`).
 *
 * This reader checks the layout (magic, version, lengths, names, kinds, units, flags) so a malformed blob is refused with
 * one line. The core checks the blob again, completely, when the loader registers it (`plugin_register`), so ranges and
 * defaults the core would refuse never run.
 *
 * Pure; no plugin, no DOM. Internal: not public API.
 */
import { PARAM_UNITS, VALUE_KIND_TYPES, type ParamUnit, type ValueKind } from "./graphNodes/schema";

/** @internal `anim-plugin-sdk`'s `abi::ABI_VERSION`: the node ABI this engine calls. */
export const NODE_ABI_VERSION = 1;

/** @internal The descriptor's fixed sizes and limits (`descriptor.rs`). */
export const DESCRIPTOR_LAYOUT = Object.freeze({
  magic: "MYND",
  headerBytes: 16,
  nodeFixedBytes: 13,
  paramFixedBytes: 28,
  maxNodes: 256,
  maxParams: 64,
  maxNameBytes: 64,
  maxInputs: 8,
  maxStateBytes: 64 * 1024,
});

/** Node flag `NODE_NEEDS_SKELETON`; parameter flag `PARAM_ANIMATABLE`. */
const NODE_NEEDS_SKELETON = 1;
const PARAM_ANIMATABLE = 1;

const KINDS = Object.keys(VALUE_KIND_TYPES) as ValueKind[];
const WORDS: Readonly<Record<ValueKind, number>> = { float: 1, int: 1, bool: 1, vec2: 2, vec3: 3, quat: 4 };

/** @internal One parameter of a node kind, as the module declares it. */
export interface PluginParamDescriptor {
  readonly name: string;
  readonly kind: ValueKind;
  readonly unit: ParamUnit;
  /** Tracks and graph parameters may drive it per evaluation (a binding). */
  readonly animatable: boolean;
  /** The range (per component for vectors); null for bool and quat, which have none. */
  readonly min: number | null;
  readonly max: number | null;
  /** The default: a number (float, int), a boolean, or the components (vec2, vec3, quat). */
  readonly default: number | boolean | readonly number[];
  /** `u32` words it takes in the parameter block. */
  readonly words: number;
}

/** @internal One node kind of a module. */
export interface PluginNodeDescriptor {
  /** The id `myco_node_evaluate` receives (graphs store it). */
  readonly kind: number;
  readonly name: string;
  /** Pose inputs (0–8). */
  readonly inputs: number;
  /** The node reads the skeleton's parent indices. */
  readonly needsSkeleton: boolean;
  /** Per-instance state bytes. */
  readonly stateBytes: number;
  readonly params: readonly PluginParamDescriptor[];
  /** The parameter block's `u32` words (the params' words, in order). */
  readonly blockWords: number;
}

/** @internal A module's descriptor. */
export interface PluginModuleDescriptor {
  readonly abiVersion: number;
  readonly nodes: readonly PluginNodeDescriptor[];
}

const validName = (s: string): boolean => s.length > 0 && s.length <= DESCRIPTOR_LAYOUT.maxNameBytes && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

/**
 * @internal Reads a descriptor blob (exactly its total length): the descriptor, or why it was refused. Never throws.
 */
export function readPluginDescriptor(bytes: Uint8Array): { readonly descriptor: PluginModuleDescriptor } | { readonly error: string } {
  const L = DESCRIPTOR_LAYOUT;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (error: string) => ({ error: `descriptor: ${error}` });
  if (bytes.length < L.headerBytes) return fail("shorter than its header");
  if (String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== L.magic) return fail("bad magic");
  const abiVersion = view.getUint16(4, true);
  if (abiVersion !== NODE_ABI_VERSION) return fail(`ABI version ${abiVersion}; this engine calls version ${NODE_ABI_VERSION}`);
  const count = view.getUint16(6, true);
  const total = view.getUint32(8, true);
  if (total !== bytes.length) return fail(`its length field says ${total} bytes, the blob has ${bytes.length}`);
  if (view.getUint32(12, true) !== 0) return fail("reserved bytes aren't zero");
  if (count === 0 || count > L.maxNodes) return fail(`a module has 1 to ${L.maxNodes} nodes (got ${count})`);
  let at = L.headerBytes;
  const ascii = (from: number, n: number) => String.fromCharCode(...bytes.subarray(from, from + n));
  const nodes: PluginNodeDescriptor[] = [];
  for (let i = 0; i < count; i++) {
    if (at + L.nodeFixedBytes > bytes.length) return fail("truncated node record");
    const kind = view.getUint32(at, true);
    const inputs = bytes[at + 4]!;
    const flags = bytes[at + 5]!;
    const paramCount = view.getUint16(at + 6, true);
    const stateBytes = view.getUint32(at + 8, true);
    const nameLen = bytes[at + 12]!;
    if (at + L.nodeFixedBytes + nameLen > bytes.length) return fail("truncated node name");
    const name = ascii(at + L.nodeFixedBytes, nameLen);
    at += L.nodeFixedBytes + nameLen;
    if (!validName(name)) return fail(`node name "${name}" isn't 1–64 letters, digits or "_" (not starting with a digit)`);
    if (inputs > L.maxInputs) return fail(`node ${name} has ${inputs} inputs, at most ${L.maxInputs}`);
    if (flags & ~NODE_NEEDS_SKELETON) return fail(`node ${name} has unknown flags`);
    if (paramCount > L.maxParams) return fail(`node ${name} has ${paramCount} parameters, at most ${L.maxParams}`);
    if (stateBytes > L.maxStateBytes) return fail(`node ${name}'s state is over ${L.maxStateBytes} bytes`);
    if (nodes.some((n) => n.kind === kind)) return fail(`two nodes have kind ${kind}`);
    if (nodes.some((n) => n.name === name)) return fail(`two nodes are named ${name}`);
    const params: PluginParamDescriptor[] = [];
    let blockWords = 0;
    for (let p = 0; p < paramCount; p++) {
      if (at + L.paramFixedBytes > bytes.length) return fail(`truncated parameter record in node ${name}`);
      const kindId = bytes[at]!;
      const pflags = bytes[at + 1]!;
      const unitId = bytes[at + 2]!;
      const plen = bytes[at + 3]!;
      if (at + L.paramFixedBytes + plen > bytes.length) return fail(`truncated parameter name in node ${name}`);
      const pname = ascii(at + L.paramFixedBytes, plen);
      const pkind = KINDS[kindId];
      const unit = PARAM_UNITS[unitId];
      if (!validName(pname)) return fail(`node ${name}: parameter name "${pname}" isn't valid`);
      if (!pkind) return fail(`node ${name}: parameter ${pname} has unknown kind ${kindId}`);
      if (!unit) return fail(`node ${name}: parameter ${pname} has unknown unit ${unitId}`);
      if (pflags & ~PARAM_ANIMATABLE) return fail(`node ${name}: parameter ${pname} has unknown flags`);
      if (params.some((x) => x.name === pname)) return fail(`node ${name} has two parameters named ${pname}`);
      const words = WORDS[pkind];
      const f32 = (o: number) => view.getFloat32(at + o, true);
      const i32 = (o: number) => view.getInt32(at + o, true);
      const isFloat = pkind === "float" || pkind === "vec2" || pkind === "vec3" || pkind === "quat";
      const ranged = pkind !== "bool" && pkind !== "quat";
      const min = ranged ? (isFloat ? f32(4) : i32(4)) : null;
      const max = ranged ? (isFloat ? f32(8) : i32(8)) : null;
      const comps = Array.from({ length: words }, (_, w) => (isFloat ? f32(12 + w * 4) : i32(12 + w * 4)));
      const def: number | boolean | readonly number[] = pkind === "bool" ? comps[0] !== 0 : words === 1 ? comps[0]! : comps;
      params.push({ name: pname, kind: pkind, unit, animatable: (pflags & PARAM_ANIMATABLE) !== 0, min, max, default: def, words });
      blockWords += words;
      at += L.paramFixedBytes + plen;
    }
    nodes.push({ kind, name, inputs, needsSkeleton: (flags & NODE_NEEDS_SKELETON) !== 0, stateBytes, params, blockWords });
  }
  if (at !== bytes.length) return fail("bytes after the last record");
  return { descriptor: { abiVersion, nodes } };
}
