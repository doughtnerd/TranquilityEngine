// The binding table (ADR 0371, "Bindings"): once per (clip, Animator), each property track's target — `nodePath`
// relative to the Animator's node, a component id and a field path — is resolved against the hierarchy and the
// registry, checked animatable (`isFieldAnimatable`, sub-paths included: D86, D91), and turned into one write function
// from the clip's column block into the ECS. `animation.Apply` then runs the writes in bulk with no string lookups.
//
// - **Where values go,** the way the engine itself writes each kind of field (the scene loader, `editor.writeField`):
//   numbers, booleans, enums (`choices`, by index), asset references (the clip's string, `asset:` stripped) are
//   assigned; vectors, quaternions and colours are copied into the live value and assigned back, so a setter still
//   runs; a plain object's sub-path (`drive.targetRotation`, D91 stores `{x, y, z, w}`) is written in place and the
//   field assigned back. A field already holding the value isn't written, so setters with side effects (a collider
//   rebuild) don't run every frame. Data components write their typed-array column directly. `engine.Transform`'s
//   `position`, `rotation` and `scale` go through the Transform. `material.<name>` on a MeshRenderer (field paths are read by `engine/animation/bindingPath.ts`, ADR 0452) is a per-renderer
//   material property override (`setMaterialProperty`: Unity's animated material properties through its property
//   blocks), so animating it never changes the shared material asset. `materials[1].<name>` (the form model imports
//   emit, T14) is the same override for material slot 1 only (`setMaterialProperty(name, value, 1)`; T24's render
//   sync draws it on the renderer's own copy of that slot's material, colours linear). `morph` tracks write
//   `SkinnedMeshRenderer.morphWeights[i]`; `activation` tracks set the node active.
// - **Missing targets** (no such node, component or field; not animatable; a track kind the field can't take) leave
//   the track unbound and give one warning per clip and Animator node, listing them.
// - **Rebinding:** a table records a stamp of every node its resolution looked at (alive, parent, name, component
//   count; child count where a child was missing) and every data component it read or missed. `valid` compares them
//   each frame (integer and reference compares, no lookups); any change (a component added or removed, a node renamed,
//   moved or destroyed) rebuilds the table.
import { parseFieldPath, resolveNodePath } from "../../../../../engine/animation/bindingPath";
import type { Component } from "../../../../../engine/core/Component";
import { getDataComponentDef, type DataComponentDef, type DataStore } from "../../../../../engine/core/data";
import { Color, Quaternion, Vector2, Vector3 } from "../../../../../engine/core/math";
import { AssetRef, PlainObject, getComponentClass, getFields, isFieldAnimatable, isListType, resolveChoices, type ComponentClass, type FieldInfo } from "../../../../../engine/core/registry";
import type { World } from "../../../../../engine/core/World";
import { MeshRenderer, type MaterialPropertyValue } from "../../../../../engine/render/components";
import type { GameObject } from "../../../../../engine/scene/GameObject";
import { SkinnedMeshRenderer } from "../../components/SkinnedMeshRenderer";
import type { ClipData } from "./clipData";
import type { ClipTrack, ClipTracks } from "./clipTracks";

/** `anim-format`'s `TrackKind` ids of the kinds that have columns. */
const FLOAT = 1, VEC2 = 2, VEC3 = 3, VEC4 = 4, COLOR = 5, QUAT = 6, DISCRETE = 7, MORPH = 8, ACTIVATION = 11, CURVE = 15;
const KIND_NAMES: Readonly<Record<number, string>> = { 1: "float", 2: "vec2", 3: "vec3", 4: "vec4", 5: "color", 6: "quat", 7: "discrete", 8: "morph", 11: "activation" };
/** `DiscreteType` ids. */
const BOOL = 0, ENUM = 1, ASSET = 2;
const NONE = 0xffffffff;

/** Writes one column (its first word at `at`) into its target. */
type Write = (f: Float32Array, u: Uint32Array, at: number) => void;

interface Entry {
  readonly offset: number;
  readonly write: Write;
}

/** A node the resolution looked at, as it was. */
interface Watch {
  readonly e: number;
  readonly generation: number;
  readonly parent: number;
  readonly name: string;
  readonly components: number;
  /** Its child count, when a child was missing (-1: not watched). */
  kids: number;
}

/** A data component read (`present` 1) or missed (0) on a node. */
interface DataWatch {
  readonly def: DataComponentDef;
  readonly store: DataStore;
  readonly e: number;
  readonly present: number;
}

/** @internal One clip's bindings for one Animator. */
export interface BindingTable {
  readonly entries: readonly Entry[];
  readonly watches: readonly Watch[];
  readonly data: readonly DataWatch[];
}

/** @internal Whether `table` still matches the hierarchy it was resolved against (see the file header). */
export function bindingsValid(world: World, table: BindingTable): boolean {
  for (const w of table.watches) {
    if (!world.isAlive(w.e, w.generation) || world.parentOf[w.e] !== w.parent || world.names[w.e] !== w.name) return false;
    if (world._componentsOf(w.e).length !== w.components) return false;
    if (w.kids >= 0 && world.childEntities(w.e).length !== w.kids) return false;
  }
  for (const d of table.data) if (world._dataStore(d.def) !== d.store || d.store.present[d.e] !== d.present) return false;
  return true;
}

/** Animator nodes and the clips they already warned about. */
const warned = new WeakMap<GameObject, Set<string>>();

/** Collects what one resolution looked at. */
class Resolution {
  readonly watches = new Map<number, Watch>();
  readonly data: DataWatch[] = [];
  readonly misses: string[] = [];

  constructor(readonly world: World) {}

  watch(node: GameObject): Watch {
    const e = node.entity;
    let w = this.watches.get(e);
    if (!w) {
      const world = this.world;
      w = { e, generation: node.generation, parent: world.parentOf[e]!, name: world.names[e]!, components: world._componentsOf(e).length, kids: -1 };
      this.watches.set(e, w);
    }
    return w;
  }

  /** Watches `node`'s children (count and each one's name): one of them was missing. */
  watchChildren(node: GameObject): void {
    const kids = node.children;
    this.watch(node).kids = kids.length;
    for (const k of kids) this.watch(k);
  }

  dataOn(def: DataComponentDef, node: GameObject): DataStore {
    const store = this.world._dataStore(def);
    this.data.push({ def, store, e: node.entity, present: store.present[node.entity]! });
    return store;
  }
}

/** The node at `path` below `root` ("" is `root`), watching each node on the way; null (children watched) when missing. */
function resolveNode(r: Resolution, root: GameObject, path: string): GameObject | null {
  r.watch(root);
  return resolveNodePath(root, path, (parent, _part, child) => (child ? r.watch(child) : r.watchChildren(parent)));
}

/** The first component of `type` on `node` or its component nodes (ADR 0009), watching where it was looked for. */
function componentOn<T extends Component>(r: Resolution, node: GameObject, type: abstract new () => T): T | null {
  const c = node.getBehaviorInComponents(type as never) as T | null;
  if (c) r.watch(c.node);
  else r.watchChildren(node); // a component node may be added
  return c;
}

const describe = (t: ClipTrack): string => {
  const at = t.nodePath ? `"${t.nodePath}"` : "the Animator's node";
  return t.component ? `${at} ${t.component}${t.field ? `.${t.field}` : ""}` : t.field ? `${at} "${t.field}"` : at;
};

/** Resolves every written column of `data` for the Animator on `root`; warns once per clip and node about misses. */
export function bindClip(world: World, root: GameObject, clipName: string, data: ClipData): BindingTable {
  const r = new Resolution(world);
  const entries: Entry[] = [];
  const tracks = data.tracks;
  for (const col of data.columns) {
    if (col.kind === CURVE) continue; // a graph parameter source (T32), not a field
    const track = tracks?.tracks[col.track];
    if (!tracks || !track) {
      r.misses.push(`track ${col.track} (the clip's track table didn't read)`);
      continue;
    }
    const write = resolveTrack(r, root, track, col.kind, col.width, tracks);
    if (typeof write === "string") r.misses.push(`${describe(track)} (${write})`);
    else entries.push({ offset: col.offset, write });
  }
  if (r.misses.length) {
    let clips = warned.get(root);
    if (!clips) warned.set(root, (clips = new Set()));
    if (!clips.has(clipName)) {
      clips.add(clipName);
      console.warn(`[myco] ${root.name}: the clip "${clipName}" has tracks with no target, left unbound: ${r.misses.join("; ")}.`);
    }
  }
  return { entries, watches: [...r.watches.values()], data: r.data };
}

/** A write for one track, or why it can't bind. */
function resolveTrack(r: Resolution, root: GameObject, track: ClipTrack, kind: number, width: number, strings: ClipTracks): Write | string {
  const node = resolveNode(r, root, track.nodePath ?? "");
  if (!node) return "no such node";
  if (kind === ACTIVATION) return (_f, u, at) => {
    const on = u[at] !== 0;
    if (node.isValid && node.active !== on) node.setActive(on);
  };
  if (kind === MORPH) return morphWrite(r, node, track);
  const id = track.component;
  const field = track.field;
  if (!id || !field) return "no component or field";
  if (id === "engine.Transform") return transformWrite(node, field, kind);
  const def = getDataComponentDef(id);
  if (def) return dataWrite(r, node, def, field, kind, track.subtype);
  const type = getComponentClass(id) as ComponentClass<Component> | undefined;
  if (!type) return `no component type "${id}" is registered`;
  const c = componentOn(r, node, type as abstract new () => Component);
  if (!c) return "no such component on the node";
  return componentWrite(r.world, c, type, field, kind, width, track.subtype, strings);
}

/** The write for `field` (a path) of the component `c` of class `type`, or why it can't bind. */
function componentWrite(world: World, c: Component, type: ComponentClass<Component>, field: string, kind: number, width: number, subtype: number, strings: ClipTracks): Write | string {
  const path = parseFieldPath(field);
  if (c instanceof MeshRenderer && path.material) return materialWrite(c, path.material.name, kind, subtype, strings, path.material.slot);
  if (!isFieldAnimatable(type, field)) return "not an animatable field";
  const head = path.head;
  const fields = getFields(type);
  let info: FieldInfo | undefined;
  for (let i = fields.length - 1; i >= 0 && !info; i--) if (fields[i]!.name === head) info = fields[i];
  if (!info) return "not an animatable field";
  if (path.sub.length) return info.type === PlainObject ? subPathWrite(c, head, path.sub, kind, subtype, strings) : "not an animatable field";
  return fieldWrite(world, c, info, kind, width, subtype, strings);
}

/** @internal A column write: the column's words start at `at` in `f` (f32) and `u` (u32), two views of one buffer. */
export type FieldWrite = Write;

const NO_STRINGS: ClipTracks = { tracks: [], strings: [], string: () => null };

/**
 * @internal The write of one value into field path `field` of the component `c` (tweens): the same write a property
 * track binds to (material properties, sub-paths, the animatable check), for a `kind` column of `width` words
 * (`anim-format`'s `TrackKind` ids). Discrete asset values have no string table here. Returns why it can't bind, as a
 * string, instead.
 */
export function componentFieldWrite(world: World, c: Component, field: string, kind: number, width: number, subtype = 0): FieldWrite | string {
  return componentWrite(world, c, c.constructor as ComponentClass<Component>, field, kind, width, subtype, NO_STRINGS);
}

/** @internal The write of `engine.Transform`'s local `position`, `rotation` or `scale` of `node` as a `kind` column, or why not. */
export function transformFieldWrite(node: GameObject, field: string, kind: number): FieldWrite | string {
  return transformWrite(node, field, kind);
}

const mismatch = (kind: number, what: string) => `a ${KIND_NAMES[kind] ?? `kind ${kind}`} track can't drive ${what}`;
const assetPath = (strings: ClipTracks, id: number): string => (id === NONE ? "" : (strings.string(id) ?? "").replace(/^asset:/, ""));

/** A declared field of a component class (no sub-path). */
function fieldWrite(world: World, c: Component, info: FieldInfo, kind: number, width: number, subtype: number, strings: ClipTracks): Write | string {
  const o = c as unknown as Record<string, unknown>;
  const k = info.name;
  const t = info.type;
  if (isListType(t)) return mismatch(kind, "a list field");
  if (kind === DISCRETE) {
    const choices = resolveChoices(info.options?.choices, world.settings);
    if (choices) {
      if (subtype !== ENUM) return mismatch(kind, "an enum field without enum values");
      return (_f, u, at) => {
        const v = choices[u[at]!]?.value;
        if (v !== undefined && o[k] !== v) o[k] = v;
      };
    }
    if (t === Boolean && subtype === BOOL) return (_f, u, at) => {
      const v = u[at] !== 0;
      if (o[k] !== v) o[k] = v;
    };
    if (t === Number && subtype !== ASSET) return (_f, u, at) => {
      const v = u[at]!;
      if (o[k] !== v) o[k] = v;
    };
    if ((t === AssetRef || t === String) && subtype === ASSET) return (_f, u, at) => {
      const v = assetPath(strings, u[at]!);
      if (o[k] !== v) o[k] = v;
    };
    return mismatch(kind, `this field`);
  }
  if (t === Number && kind === FLOAT) return (f, _u, at) => {
    const v = f[at]!;
    if (o[k] !== v) o[k] = v;
  };
  if (t === Vector2 && kind === VEC2) return (f, _u, at) => {
    const x = f[at]!, y = f[at + 1]!;
    const cur = o[k];
    if (cur instanceof Vector2) {
      if (cur.x !== x || cur.y !== y) o[k] = cur.set(x, y);
    } else o[k] = new Vector2(x, y);
  };
  if (t === Vector3 && kind === VEC3) return (f, _u, at) => {
    const x = f[at]!, y = f[at + 1]!, z = f[at + 2]!;
    const cur = o[k];
    if (cur instanceof Vector3) {
      if (cur.x !== x || cur.y !== y || cur.z !== z) o[k] = cur.set(x, y, z);
    } else o[k] = new Vector3(x, y, z);
  };
  if (t === Quaternion && (kind === QUAT || kind === VEC4)) return (f, _u, at) => {
    const x = f[at]!, y = f[at + 1]!, z = f[at + 2]!, w = f[at + 3]!;
    const cur = o[k];
    if (cur instanceof Quaternion) {
      if (cur.x !== x || cur.y !== y || cur.z !== z || cur.w !== w) o[k] = cur.set(x, y, z, w);
    } else o[k] = new Quaternion(x, y, z, w);
  };
  if (t === Color && (kind === COLOR || kind === VEC4 || kind === VEC3)) return (f, _u, at) => {
    const r = f[at]!, g = f[at + 1]!, b = f[at + 2]!, a = width >= 4 ? f[at + 3]! : 1;
    const cur = o[k];
    if (cur instanceof Color) {
      if (cur.r !== r || cur.g !== g || cur.b !== b || cur.a !== a) {
        cur.r = r;
        cur.g = g;
        cur.b = b;
        cur.a = a;
        o[k] = cur;
      }
    } else o[k] = new Color(r, g, b, a);
  };
  return mismatch(kind, "this field");
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Sets the numbers `keys` → `values` on the object at `obj[leaf]` (made when absent); true when anything changed. */
function setObject(obj: Record<string, unknown>, leaf: string, keys: readonly string[], values: readonly number[]): boolean {
  let cur = obj[leaf];
  if (!isRecord(cur)) obj[leaf] = cur = {};
  const rec = cur as Record<string, unknown>;
  let changed = false;
  for (let i = 0; i < keys.length; i++) {
    if (rec[keys[i]!] !== values[i]) {
      rec[keys[i]!] = values[i];
      changed = true;
    }
  }
  return changed;
}

/** A sub-path of a plain-object field (D86): the leaf written in place, the field assigned back when it changed. */
function subPathWrite(c: Component, head: string, path: readonly string[], kind: number, subtype: number, strings: ClipTracks): Write | string {
  const o = c as unknown as Record<string, unknown>;
  const leaf = path[path.length - 1]!;
  const parentOf = (): Record<string, unknown> | null => {
    let obj = o[head];
    for (let i = 0; i < path.length - 1; i++) obj = isRecord(obj) ? obj[path[i]!] : undefined;
    return isRecord(obj) ? obj : null;
  };
  const scratch = [0, 0, 0, 0];
  /** The field assigned its own (changed) object again, so a setter sees the change. */
  const reassign = () => {
    const v = o[head];
    o[head] = v;
  };
  const objectWrite = (keys: readonly string[]): Write => (f, _u, at) => {
    const parent = parentOf();
    if (!parent) return;
    for (let i = 0; i < keys.length; i++) scratch[i] = f[at + i]!;
    if (setObject(parent, leaf, keys, scratch)) reassign();
  };
  const scalarWrite = (value: (f: Float32Array, u: Uint32Array, at: number) => unknown): Write => (f, u, at) => {
    const parent = parentOf();
    if (!parent) return;
    const v = value(f, u, at);
    if (parent[leaf] !== v) {
      parent[leaf] = v;
      reassign();
    }
  };
  switch (kind) {
    case FLOAT:
      return scalarWrite((f, _u, at) => f[at]);
    case VEC2:
      return objectWrite(["x", "y"]);
    case VEC3:
      return objectWrite(["x", "y", "z"]);
    case VEC4:
    case QUAT:
      return objectWrite(["x", "y", "z", "w"]);
    case COLOR:
      return objectWrite(["r", "g", "b", "a"]);
    case DISCRETE:
      return scalarWrite(subtype === BOOL ? (_f, u, at) => u[at] !== 0 : subtype === ASSET ? (_f, u, at) => assetPath(strings, u[at]!) : (_f, u, at) => u[at]);
    default:
      return mismatch(kind, "a plain-object field");
  }
}

/** A data component's numeric column (`f32`, `i32`, `u8`). */
function dataWrite(r: Resolution, node: GameObject, def: DataComponentDef, field: string, kind: number, subtype: number): Write | string {
  const store = r.dataOn(def, node);
  if (!store.present[node.entity]) return "no such component on the node";
  if (!def.fields.includes(field)) return "no such field";
  const e = node.entity;
  if (kind === FLOAT) return (f, _u, at) => {
    if (store.present[e]) store.arrays[field]![e] = f[at]!;
  };
  if (kind === DISCRETE && subtype !== ASSET) return (_f, u, at) => {
    if (store.present[e]) store.arrays[field]![e] = u[at]!;
  };
  return mismatch(kind, "a data component's number");
}

/**
 * `engine.Transform`'s local `position`, `rotation` and `scale`, written straight into the World's transform columns
 * (`tPos`/`tRot`/`tScl`, the storage the Transform's live views sit on, read again each write since the World may grow
 * them), then marked dirty once: the same bits and the same dirty mark as `transform.position = …`, without the
 * Transform facade's calls (1,000 tweens write here every frame).
 */
function transformWrite(node: GameObject, field: string, kind: number): Write | string {
  if (!node.transform) return "the node has no Transform";
  const world = node.world;
  const e = node.entity;
  if ((field === "position" || field === "scale") && kind === VEC3) {
    const position = field === "position";
    return (f, _u, at) => {
      const a = position ? world.tPos : world.tScl;
      const o = e * 3;
      const x = f[at]!, y = f[at + 1]!, z = f[at + 2]!;
      if (a[o] === x && a[o + 1] === y && a[o + 2] === z) return;
      a[o] = x;
      a[o + 1] = y;
      a[o + 2] = z;
      world.markTransformDirty(e);
    };
  }
  if (field === "rotation" && kind === QUAT) return (f, _u, at) => {
    const a = world.tRot;
    const o = e * 4;
    const x = f[at]!, y = f[at + 1]!, z = f[at + 2]!, w = f[at + 3]!;
    if (a[o] === x && a[o + 1] === y && a[o + 2] === z && a[o + 3] === w) return;
    a[o] = x;
    a[o + 1] = y;
    a[o + 2] = z;
    a[o + 3] = w;
    world.markTransformDirty(e);
  };
  return field === "position" || field === "rotation" || field === "scale" ? mismatch(kind, `Transform.${field}`) : "not an animatable field";
}

/**
 * A MeshRenderer's material property override (`material.color` → `setMaterialProperty("color", …)`), or with a `slot`
 * (`materials[1].color` → `setMaterialProperty("color", …, 1)`) one material slot's.
 */
function materialWrite(c: MeshRenderer, name: string, kind: number, subtype: number, strings: ClipTracks, slot?: number): Write | string {
  if (!name) return "no material property named";
  const set = (v: MaterialPropertyValue) => c.setMaterialProperty(name, v, slot);
  const get = () => c.getMaterialProperty(name, slot);
  switch (kind) {
    case FLOAT:
      return (f, _u, at) => {
        if (get() !== f[at]) set(f[at]!);
      };
    case COLOR: {
      const color = new Color();
      return (f, _u, at) => {
        const cur = get();
        if (cur instanceof Color && cur.r === f[at] && cur.g === f[at + 1] && cur.b === f[at + 2] && cur.a === f[at + 3]) return;
        color.r = f[at]!;
        color.g = f[at + 1]!;
        color.b = f[at + 2]!;
        color.a = f[at + 3]!;
        set(color);
      };
    }
    case VEC2:
    case VEC3:
    case VEC4: {
      const n = kind - VEC2 + 2;
      return (f, _u, at) => {
        const cur = get();
        const parts = cur instanceof Vector2 ? [cur.x, cur.y] : cur instanceof Vector3 ? [cur.x, cur.y, cur.z] : Array.isArray(cur) ? cur : null;
        if (parts && parts.length === n && parts.every((p, i) => p === f[at + i])) return;
        set(n === 2 ? new Vector2(f[at], f[at + 1]) : n === 3 ? new Vector3(f[at], f[at + 1], f[at + 2]) : [f[at]!, f[at + 1]!, f[at + 2]!, f[at + 3]!]);
      };
    }
    case DISCRETE:
      if (subtype !== ASSET) return mismatch(kind, "a material property without an asset");
      return (_f, u, at) => {
        const v = assetPath(strings, u[at]!);
        if (get() !== v) set(v);
      };
    default:
      return mismatch(kind, "a material property");
  }
}

/**
 * A `morph` track: the target's index in `SkinnedMeshRenderer.morphWeights`. The field names the morph target; its
 * index in the mesh's order is used when the name is one ("0", "#2"). Names come with imported meshes (T14), whose
 * morph target names the importer will resolve here.
 */
function morphWrite(r: Resolution, node: GameObject, track: ClipTrack): Write | string {
  if (track.component && track.component !== "engine.SkinnedMeshRenderer") return "a morph track drives a SkinnedMeshRenderer";
  const renderer = componentOn(r, node, SkinnedMeshRenderer);
  if (!renderer) return "no SkinnedMeshRenderer on the node";
  const m = /^#?(\d+)$/.exec(track.field ?? "");
  if (!m) return `no morph target named "${track.field ?? ""}" (morph targets are found by index until imported meshes name them)`;
  const index = Number(m[1]);
  return (f, _u, at) => {
    const w = renderer.morphWeights;
    while (w.length <= index) w.push(0);
    if (w[index] !== f[at]) w[index] = f[at]!;
  };
}
