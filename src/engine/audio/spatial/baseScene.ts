/**
 * The base game scene of a spatial test scene (ADR 0347 "Optionally `base` names a game scene whose audio components and
 * colliders load read-only underneath"): which of the scene's nodes and components the Studio loads, and where they
 * are, from the engine's resolved scene view (`resolveScene`: prefab instances expanded, every override applied), so the
 * Studio sees what the game instantiates.
 *
 * - **Imported:** `AudioSource`, `AudioZone`, `AudioReverbZone` and `AudioOccluder`, and the 3D colliders (`BoxCollider`,
 *   `SphereCollider`, `CapsuleCollider`, `MeshCollider`) with their layers, so the occlusion pass casts at the same
 *   shapes, layers and materials as in the game. Every imported node keeps its ancestors (names, Transforms and active
 *   flags), so world poses, an occluder that covers its children's colliders, and `replace` paths (`"Cave/Fire/AudioSource"`)
 *   all hold as in the game.
 * - **Left out:** everything else (scripts, renderers, lights, bodies). An `AudioListener` (the test scene's own listener
 *   hears), a `RigidBody` (its colliders load static: the base is a still snapshot), a `CharacterController` (a moving
 *   actor, not geometry) and the 2D colliders (occlusion casts in 3D) are noted once each.
 * - **References:** a `MeshCollider` with no mesh takes its node's `MeshRenderer` mesh (as the physics world does), since
 *   renderers aren't loaded; one with neither is left out. A `{"$node"}` reference in imported data points at the
 *   imported copy of its node, or is cleared when that node isn't imported. Asset paths stay as the scene wrote them
 *   (project paths).
 * - **Missing:** a base that isn't a readable scene imports nothing, with one problem line; the test scene plays alone.
 *
 * `file` is the imported part as a scene file (`myco.scene@4`, 3D physics), for the runtime to load through the engine's
 * scene loading; `objects` is what the Spatial screen's plan draws (world positions and footprints, x/z plan, y up).
 *
 * Pure: no plugin, no DOM; reads files only through `read` (default: the engine's scene file reader over `Assets`).
 */
import { Quaternion, DEG2RAD } from "../../core/math";
import { mapFieldNodeRefs } from "../../scene/nodeReferences";
import { resolveScene, type ResolvedComponent, type ResolvedNode } from "../../scene/resolvedScene";
import { CURRENT_FORMAT_VERSION, SCENE_FORMAT, type ComponentEntry, type NodeEntry } from "../../scene/SceneLoader";
import type { SceneBox, Vec3 } from "./testSceneTypes";
import { normalizeAssetPath } from "../../scene/assetPath";

/** The audio components a base scene contributes. */
export const BASE_AUDIO_COMPONENTS = ["engine.AudioSource", "engine.AudioZone", "engine.AudioReverbZone", "engine.AudioOccluder"] as const;
/** The colliders a base scene contributes (the occlusion pass casts at 3D colliders). */
export const BASE_COLLIDER_COMPONENTS = ["engine.BoxCollider", "engine.SphereCollider", "engine.CapsuleCollider", "engine.MeshCollider"] as const;

const TRANSFORM = "engine.Transform";
const MESH_RENDERER = "engine.MeshRenderer";
const KEPT = new Set<string>([...BASE_AUDIO_COMPONENTS, ...BASE_COLLIDER_COMPONENTS]);
/** Left out with a note: why each matters to someone reading the problems. */
const NOTED: Readonly<Record<string, string>> = {
  "engine.AudioListener": "AudioListener isn't loaded (the test scene's listener hears)",
  "engine.RigidBody": "RigidBody isn't loaded (its colliders load static)",
  "engine.CharacterController": "CharacterController isn't loaded (a moving actor, not geometry)",
  "engine.BoxCollider2D": "2D colliders aren't loaded (occlusion casts in 3D)",
  "engine.CircleCollider2D": "2D colliders aren't loaded (occlusion casts in 3D)",
  "engine.PolygonCollider2D": "2D colliders aren't loaded (occlusion casts in 3D)",
  "engine.CapsuleCollider2D": "2D colliders aren't loaded (occlusion casts in 3D)",
};

/** What a base object is on the plan. */
export type BaseObjectKind = "emitter" | "audioZone" | "reverbZone" | "collider";

/** One imported component, placed in the world (the plan's read-only layer). */
export interface BaseSceneObject {
  /** Unique: the node's id in the resolved view, then the component type and its index on the node. */
  readonly key: string;
  /** The node's name path from the scene's top (`"Cave/Campfire"`), as `replace` keys and `GameObject.find` name it. */
  readonly path: string;
  readonly name: string;
  readonly kind: BaseObjectKind;
  /** The component's type id. */
  readonly type: string;
  /** Which of its type it is on its node (the `[i]` of a `replace` key). */
  readonly index: number;
  /** The node and every ancestor are active, and the component is enabled. */
  readonly active: boolean;
  /** World position of the node (emitters) or of the shape's centre (zones, colliders). */
  readonly position: Vec3;
  /** An upright box footprint (box colliders, box reverb zones, audio zones, sideways capsules); null otherwise. */
  readonly box: SceneBox | null;
  /** A round footprint's radius (sphere colliders and zones, upright capsules); null otherwise. */
  readonly radius: number | null;
  /** Emitters and audio zones: the sound (a project path, no `asset:`). */
  readonly sound?: string;
  /** Emitters: false for a 2D sound (`spatial: false`). */
  readonly spatial?: boolean;
  /** Colliders: the material of the nearest `AudioOccluder` on the node or an ancestor (null: the project's default). */
  readonly material?: string | null;
  /** Colliders: the physics layer. */
  readonly layer?: string;
  /** Reverb zones: the preset (or the impulse response when one is set). */
  readonly preset?: string;
}

/** A base scene as the Studio loads it. */
export interface BaseSceneImport {
  readonly path: string;
  /** False when `path` isn't a readable scene file. */
  readonly found: boolean;
  /** The imported nodes as a scene file (3D physics), parents before children; no nodes when nothing is imported. */
  readonly file: { readonly format: string; readonly settings: { readonly physics: "3d" }; readonly nodes: readonly NodeEntry[] };
  readonly objects: readonly BaseSceneObject[];
  /** One line per thing left out or repaired, worded for the user. */
  readonly problems: readonly string[];
}

export interface BaseSceneOptions {
  /** A file's parsed JSON (throws or returns undefined when missing). Default: the engine's scene reader over `Assets`. */
  readonly read?: (path: string) => unknown;
}

// --- poses -----------------------------------------------------------------------------------------------------------

interface Pose {
  readonly p: Vec3;
  /** Rotation quaternion x, y, z, w. */
  readonly q: readonly [number, number, number, number];
  readonly s: Vec3;
}

const IDENTITY: Pose = { p: { x: 0, y: 0, z: 0 }, q: [0, 0, 0, 1], s: { x: 1, y: 1, z: 1 } };
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const vec = (v: unknown, d: Vec3): Vec3 => (Array.isArray(v) ? { x: num(v[0], d.x), y: num(v[1], d.y), z: num(v[2], d.z) } : d);

/** A Transform's rotation as a scene file writes it: a quaternion `[x, y, z, w]`, or Euler degrees `[x, y, z]` (ZXY). */
function quat(raw: unknown): [number, number, number, number] {
  if (!Array.isArray(raw)) return [0, 0, 0, 1];
  if (raw.length >= 4) {
    const [x, y, z, w] = [num(raw[0], 0), num(raw[1], 0), num(raw[2], 0), num(raw[3], 1)];
    const l = Math.hypot(x, y, z, w) || 1;
    return [x / l, y / l, z / l, w / l];
  }
  const q = Quaternion.euler(num(raw[0], 0) * DEG2RAD, num(raw[1], 0) * DEG2RAD, num(raw[2], 0) * DEG2RAD);
  return [q.x, q.y, q.z, q.w];
}

function qmul(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  const [ax, ay, az, aw] = a as [number, number, number, number];
  const [bx, by, bz, bw] = b as [number, number, number, number];
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

function rotate(q: readonly number[], v: Vec3): Vec3 {
  const [x, y, z, w] = q as [number, number, number, number];
  // v + 2w(q×v) + 2q×(q×v)
  const tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x);
  return { x: v.x + w * tx + (y * tz - z * ty), y: v.y + w * ty + (z * tx - x * tz), z: v.z + w * tz + (x * ty - y * tx) };
}

const mulv = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x * b.x, y: a.y * b.y, z: a.z * b.z });

/** A point in the node's local units, in the world. */
const toWorld = (pose: Pose, local: Vec3): Vec3 => {
  const r = rotate(pose.q, mulv(pose.s, local));
  return { x: pose.p.x + r.x, y: pose.p.y + r.y, z: pose.p.z + r.z };
};

/** The node's turn about the vertical, degrees (0 faces +z, positive towards +x), as zones and the plan read it. */
function yawOf(pose: Pose): number {
  const f = rotate(pose.q, { x: 0, y: 0, z: 1 });
  return Math.abs(f.x) < 1e-9 && Math.abs(f.z) < 1e-9 ? 0 : (Math.atan2(f.x, f.z) * 180) / Math.PI;
}

function childPose(parent: Pose, transform: Record<string, unknown> | undefined): Pose {
  const local: Pose = transform ? { p: vec(transform.position, IDENTITY.p), q: quat(transform.rotation), s: vec(transform.scale, IDENTITY.s) } : IDENTITY;
  return { p: toWorld(parent, local.p), q: qmul(parent.q, local.q), s: mulv(parent.s, local.s) };
}

const round = (v: number): number => Math.round(v * 1e6) / 1e6;
const roundV = (v: Vec3): Vec3 => ({ x: round(v.x), y: round(v.y), z: round(v.z) });

// --- the import ------------------------------------------------------------------------------------------------------

const nameOf = (n: ResolvedNode): string => n.name ?? n.id.slice(n.id.lastIndexOf("/") + 1);
const dataOf = (c: ResolvedComponent): Record<string, unknown> => (isRecord(c.data) ? c.data : {});
const assetPath = (v: unknown): string => (typeof v === "string" ? normalizeAssetPath(v) : "");

/** The base scene at `path`: the nodes and components the Studio loads underneath a test scene, and where they are. */
export function importBaseScene(path: string, options: BaseSceneOptions = {}): BaseSceneImport {
  const empty = (problems: string[]): BaseSceneImport => ({ path, found: false, file: { format: `${SCENE_FORMAT}@${CURRENT_FORMAT_VERSION}`, settings: { physics: "3d" }, nodes: [] }, objects: [], problems });
  const resolved = resolveScene(path, options.read ? { read: options.read } : {});
  if (!resolved.files.includes(path)) return empty([`The base scene "${path}" isn't in the project (or isn't a scene file); the test scene plays without it.`]);

  const problems: string[] = [];
  const noted = new Map<string, string[]>();
  const byId = new Map(resolved.nodes.map((n) => [n.id, n]));
  const kept = new Set<string>();
  for (const n of resolved.nodes) {
    for (const c of n.components) {
      if (KEPT.has(c.type)) {
        if (meshOf(n, c) === null) problems.push(`"${nameOf(n)}": its MeshCollider has no mesh and no MeshRenderer to take one from; it isn't loaded.`);
        else kept.add(n.id);
      } else if (NOTED[c.type]) {
        const list = noted.get(NOTED[c.type]!) ?? [];
        list.push(nameOf(n));
        noted.set(NOTED[c.type]!, list);
      }
    }
  }
  // Ancestors carry the poses, occluders that cover children, and the name paths.
  for (const id of [...kept]) for (let p = byId.get(id)?.parent; p !== undefined && !kept.has(p); p = byId.get(p)?.parent) kept.add(p);

  const poses = new Map<string, Pose>();
  const namePaths = new Map<string, string>();
  /** The material of the nearest occluder on each kept node or an ancestor (undefined: none). */
  const occluders = new Map<string, string | undefined>();
  const nodes: NodeEntry[] = [];
  const objects: BaseSceneObject[] = [];
  const refMap = (from: ResolvedNode) => (ref: string): string | null => {
    // A reference names a node of the file it is written in: try the referring node's instance scopes, innermost first.
    const scopes = from.id.split("/").slice(0, -1);
    for (let i = scopes.length; i >= 0; i--) {
      const id = [...scopes.slice(0, i), ref].join("/");
      if (byId.has(id)) {
        if (kept.has(id)) return id;
        problems.push(`"${nameOf(from)}" refers to "${nameOf(byId.get(id)!)}", which isn't loaded with the base scene; the reference is cleared.`);
        return null;
      }
    }
    return ref; // left as written: the engine reports a reference it can't resolve
  };

  for (const n of resolved.nodes) {
    if (!kept.has(n.id)) continue;
    const parentPose = n.parent !== undefined ? poses.get(n.parent) ?? IDENTITY : IDENTITY;
    const transform = n.components.find((c) => c.type === TRANSFORM);
    const pose = childPose(parentPose, transform ? dataOf(transform) : undefined);
    poses.set(n.id, pose);
    const name = nameOf(n);
    const namePath = n.parent !== undefined && namePaths.has(n.parent) ? `${namePaths.get(n.parent)}/${name}` : name;
    namePaths.set(n.id, namePath);
    const own = n.components.find((c) => c.type === "engine.AudioOccluder" && c.enabled !== false);
    occluders.set(n.id, own ? (typeof dataOf(own).material === "string" ? (dataOf(own).material as string) : "") : n.parent !== undefined ? occluders.get(n.parent) : undefined);

    const components: ComponentEntry[] = transform ? [{ type: TRANSFORM, data: { ...dataOf(transform) } }] : [];
    const counts = new Map<string, number>();
    for (const c of n.components) {
      const mesh = meshOf(n, c);
      if (!KEPT.has(c.type) || mesh === null) continue;
      const index = counts.get(c.type) ?? 0;
      counts.set(c.type, index + 1);
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(dataOf(c))) data[k] = mapFieldNodeRefs(v, refMap(n));
      if (mesh) data.mesh = `asset:${mesh}`;
      components.push({ type: c.type, ...(c.enabled === false ? { enabled: false } : {}), data });
      const object = placeObject(c.type, data, pose, { key: `${n.id}#${c.type}[${index}]`, path: namePath, name, index, active: n.activeInHierarchy && c.enabled !== false });
      if (object) objects.push(object);
    }
    nodes.push({ id: n.id, name, ...(n.parent !== undefined ? { parent: n.parent } : {}), ...(n.active ? {} : { active: false }), components });
  }
  // Materials once every occluder is known (a collider's own node may hold the occluder after it).
  const withMaterials = objects.map((o) => (o.kind === "collider" ? { ...o, material: occluderOf(o.key, occluders) } : o));

  for (const [why, names] of noted) problems.push(`${why}: ${[...new Set(names)].map((x) => `"${x}"`).join(", ")}.`);
  return { path, found: true, file: { format: `${SCENE_FORMAT}@${CURRENT_FORMAT_VERSION}`, settings: { physics: "3d" }, nodes }, objects: withMaterials, problems };
}

/** A mesh collider's mesh: its own, else its node's MeshRenderer's (null: neither); "" for any other component. */
function meshOf(n: ResolvedNode, c: ResolvedComponent): string | null {
  if (c.type !== "engine.MeshCollider") return "";
  const own = assetPath(dataOf(c).mesh);
  if (own) return own;
  const renderer = n.components.find((x) => x.type === MESH_RENDERER);
  return (renderer && assetPath(dataOf(renderer).mesh)) || null;
}

function occluderOf(key: string, occluders: ReadonlyMap<string, string | undefined>): string | null {
  const m = occluders.get(key.slice(0, key.lastIndexOf("#")));
  return m ? m : null; // none, or an occluder with no material: the project's default
}

/** The plan's object for one imported component. */
function placeObject(type: string, data: Record<string, unknown>, pose: Pose, base: Pick<BaseSceneObject, "key" | "path" | "name" | "index" | "active">): BaseSceneObject | null {
  const yaw = yawOf(pose);
  const sx = Math.abs(pose.s.x), sy = Math.abs(pose.s.y) || 1, sz = Math.abs(pose.s.z);
  const smax = Math.max(sx, sy, sz);
  const center = (c: unknown) => toWorld(pose, vec(c, { x: 0, y: 0, z: 0 }));
  const upright = (at: Vec3, width: number, depth: number, height: number, turn = yaw): SceneBox => ({
    center: roundV({ x: at.x, y: 0, z: at.z }),
    width: round(width),
    depth: round(depth),
    yaw: round(turn),
    bottom: round(at.y - height / 2),
    top: round(at.y + height / 2),
  });
  const common = { ...base, type };
  switch (type) {
    case "engine.AudioSource":
      return { ...common, kind: "emitter", position: roundV(pose.p), box: null, radius: null, sound: assetPath(data.clip), spatial: data.spatial !== false };
    case "engine.AudioZone": {
      const c = center(data.center);
      const width = Math.abs(num(data.width, 10) * sx), depth = Math.abs(num(data.depth, 10) * sz);
      const bottom = num(data.bottom, 0), top = Math.max(bottom, num(data.top, 10));
      return {
        ...common, kind: "audioZone", position: roundV(c), radius: null, sound: assetPath(data.sound),
        box: { center: roundV({ x: c.x, y: 0, z: c.z }), width: round(width), depth: round(depth), yaw: round(yaw + num(data.yaw, 0)), bottom: round(c.y + bottom * sy), top: round(c.y + top * sy) },
      };
    }
    case "engine.AudioReverbZone": {
      const c = center(data.center);
      const preset = assetPath(data.ir) || (typeof data.preset === "string" ? data.preset : "hall");
      if (data.shape === "sphere") return { ...common, kind: "reverbZone", position: roundV(c), box: null, radius: round(Math.abs(num(data.radius, 5)) * smax), preset };
      const s = vec(data.size, { x: 10, y: 4, z: 10 });
      return { ...common, kind: "reverbZone", position: roundV(c), box: upright(c, Math.abs(s.x) * sx, Math.abs(s.z) * sz, Math.abs(s.y) * sy), radius: null, preset };
    }
    case "engine.AudioOccluder":
      return null; // a material, not a shape: its colliders show it
    default: {
      const c = center(data.center);
      const layer = typeof data.layer === "string" ? data.layer : "Default";
      const collider = { ...common, kind: "collider" as const, position: roundV(c), layer };
      if (type === "engine.BoxCollider") {
        const s = vec(data.size, { x: 1, y: 1, z: 1 });
        return { ...collider, box: upright(c, Math.abs(s.x) * sx, Math.abs(s.z) * sz, Math.abs(s.y) * sy), radius: null };
      }
      if (type === "engine.SphereCollider") return { ...collider, box: null, radius: round(Math.abs(num(data.radius, 0.5)) * smax) };
      if (type === "engine.CapsuleCollider") {
        const r = Math.abs(num(data.radius, 0.5)), h = Math.max(2 * r, Math.abs(num(data.height, 2)));
        const axis = data.direction === "x" || data.direction === "z" ? data.direction : "y";
        if (axis === "y") return { ...collider, box: null, radius: round(r * Math.max(sx, sz)) };
        const across = 2 * r * Math.max(sy, axis === "x" ? sz : sx);
        return { ...collider, box: axis === "x" ? upright(c, h * sx, across, 2 * r * sy) : upright(c, across, h * sz, 2 * r * sy), radius: null };
      }
      return { ...collider, box: null, radius: null }; // a mesh: its shape is the model's
    }
  }
}

/**
 * The `replace` keys (ADR 0347) a test scene names that match no imported `AudioSource` or `AudioZone`, each with why
 * (one problem line each); the runtime skips them.
 */
export function unmatchedReplaceKeys(base: BaseSceneImport, replace: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(replace)) {
    const slash = key.lastIndexOf("/");
    const m = /^(AudioSource|AudioZone)(?:\[(\d+)\])?$/.exec(key.slice(slash + 1));
    const node = slash < 0 ? "" : key.slice(0, slash);
    const type = m ? `engine.${m[1]}` : "";
    const index = Number(m?.[2] ?? 0);
    if (!m) out.push(`replace "${key}": the last part must be AudioSource or AudioZone (with [i] for the i-th); ignored.`);
    else if (!base.objects.some((o) => o.type === type && o.path === node && o.index === index)) out.push(`replace "${key}": the base scene has no such ${m[1]}; ignored.`);
  }
  return out;
}

/** The `replace` key that names `o` (an emitter or audio zone of the base scene). */
export function replaceKeyOf(o: Pick<BaseSceneObject, "path" | "type" | "index">): string {
  const short = o.type.replace(/^engine\./, "");
  return `${o.path}/${short}${o.index > 0 ? `[${o.index}]` : ""}`;
}
