/**
 * Internal (ADR 0065): what a navigation chunk bakes from, collected from a World's live nodes. The
 * editor (Bake on a NavChunk, Bake All) and `npm run nav:bake` both use it, so a bake from either sees
 * the same triangles.
 *
 * Rules (src/engine/nav/CONTRACT.md):
 * - **Scope:** the chunk node and its descendants (`scope: "children"`), or the whole scene the chunk node
 *   is in (`"scene"`, the default). Inactive nodes are skipped with their subtrees, as are other scenes, the
 *   subtrees of other NavChunks that collect their own children, nodes with a NavAgent (characters), and
 *   nodes under a dynamic or kinematic RigidBody (moving things aren't baked).
 * - **Geometry per node:** a `NavSurface` makes the node's mesh, collider or both (its `source`) walkable,
 *   with its area and agent types; a `NavObstacle` makes them solid and never walkable (it wins over a
 *   NavSurface on the same node). Unmarked nodes give what the chunk's `collect` says ("renderMeshes",
 *   "colliders", "both", "none") as walkable sources. Marked nodes are collected even with "none".
 * - **Meshes** are MeshRenderer meshes (models and built-in primitives) in world space; **colliders** are
 *   3D box, sphere, capsule and mesh colliders, sized as physics sizes them (`physics/shape3d.ts`).
 *   Triggers and disabled components are left out. Components on component nodes count for their owner.
 * - **Volumes:** NavModifierVolume, NavResolutionVolume and NavGate in scope, as oriented boxes
 *   (the node's world matrix × `center` / `size`).
 * - **Chunk:** the NavChunk's bounds (world space when `useChunkBounds`), overlay depths and skipped agents.
 *
 * Collecting is synchronous; meshes of models still loading are listed in `pending` (call
 * {@link loadNavGeometryMeshes} first to wait for them).
 */
import type { World } from "../core/World";
import { getComponentId } from "../core/registry";
import type { Component } from "../core/Component";
import type { GameObject } from "../scene/GameObject";
import { loadMeshes, meshesIfLoaded, meshTriangles } from "../scene/models";
import { capsuleSize, sphereRadius } from "../physics/shape3d";
import type { NavBakeChunk, NavBakeMesh } from "./bake";
import type { NavigationSettings } from "./settings";

export const NAV_CHUNK = "engine.NavChunk";
export const NAV_SURFACE = "engine.NavSurface";
export const NAV_OBSTACLE = "engine.NavObstacle";
export const NAV_MODIFIER_VOLUME = "engine.NavModifierVolume";
export const NAV_RESOLUTION_VOLUME = "engine.NavResolutionVolume";
export const NAV_GATE = "engine.NavGate";
export const NAV_AGENT = "engine.NavAgent";

type V3 = [number, number, number];
type Mat = ArrayLike<number>;
type ModifierVolume = NonNullable<NavBakeChunk["modifierVolumes"]>[number];
type Gate = NonNullable<NavBakeChunk["gates"]>[number];
type ResolutionVolume = NonNullable<NavBakeChunk["resolutionVolumes"]>[number];

/** Everything a chunk bakes from, besides the project's navigation settings. */
export interface NavGeometry {
  meshes: NavBakeMesh[];
  /** The NavChunk's own settings (bounds, overlay depths, skipped agents). */
  chunk: Omit<NavBakeChunk, "modifierVolumes" | "gates" | "resolutionVolumes">;
  modifierVolumes: ModifierVolume[];
  gates: Gate[];
  resolutionVolumes: ResolutionVolume[];
  /** Mesh references whose models are still loading (their triangles are missing). */
  pending: string[];
  /** Things that are probably mistakes (an unknown agent type or area id). */
  warnings: string[];
}

/** `scenes/main.scene.json` → `scenes/main.nav.bin` (CONTRACT.md). */
export function navBakePath(scenePath: string): string {
  return `${scenePath.replace(/\.scene\.json$/i, "").replace(/\.json$/i, "")}.nav.bin`;
}

/** A component's registered type id. */
const typeOf = (c: Component): string | undefined => getComponentId(c.constructor as abstract new () => unknown);

/** A component's field (`(c as any)[name]`). */
const fieldOf = (c: Component, name: string): unknown => (c as unknown as Record<string, unknown>)[name];

const vec3 = (v: unknown, fallback: V3): V3 => {
  if (Array.isArray(v) && v.length >= 3) return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
  if (v && typeof v === "object" && "x" in v) {
    const o = v as { x: number; y: number; z: number };
    return [Number(o.x) || 0, Number(o.y) || 0, Number(o.z) || 0];
  }
  return [...fallback];
};
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s !== "") : []);
const enabled = (c: Component) => c.enabled && !c._destroyed;

/** The NavChunk component on a node, if any. */
export function navChunkOf(node: GameObject): Component | null {
  return node.world._componentsOf(node.entity).find((c) => typeOf(c) === NAV_CHUNK) ?? null;
}

/** Every node with a NavChunk under `root` (depth first, the root included). */
export function findNavChunks(root: GameObject): GameObject[] {
  const out: GameObject[] = [];
  const visit = (n: GameObject) => {
    if (navChunkOf(n)) out.push(n);
    for (const c of n.children) visit(c);
  };
  visit(root);
  return out;
}

/** A node's components, with those on its component nodes (ADR 0009), which act for it. */
function ownedComponents(node: GameObject): Component[] {
  const world = node.world;
  const out = [...world._componentsOf(node.entity)];
  for (const e of world.childEntities(node.entity)) if (world.isComponentNode(e)) out.push(...world._componentsOf(e));
  return out;
}

/** The world matrix (16 numbers, column-major) of the nearest node at or above `e` with a Transform. */
function matrixOf(world: World, e: number): Float64Array {
  let n = e;
  while (n >= 0 && !world.hasTransform[n]) n = world.parentEntity(n);
  const m = new Float64Array(16);
  if (n < 0) {
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  }
  const all = world.worldMatrix(n);
  for (let i = 0; i < 16; i++) m[i] = all[n * 16 + i];
  return m;
}

const transformPoint = (m: Mat, x: number, y: number, z: number): V3 => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

/** The determinant of the 3×3 part: negative for a mirrored transform, whose triangles need rewinding. */
const det3 = (m: Mat) => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);

/** The scale along each local axis (the lengths of the matrix's columns). */
const scaleOf = (m: Mat): V3 => [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])];

/** `m` × translate(center) × scale(size): the unit box `[-0.5, 0.5]^3` to world space. */
function boxToWorld(m: Mat, center: V3, size: V3): number[] {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) out[col * 4 + row] = m[col * 4 + row] * size[col];
  const t = transformPoint(m, center[0], center[1], center[2]);
  out[12] = t[0];
  out[13] = t[1];
  out[14] = t[2];
  out[15] = 1;
  return out;
}

/** Local triangles to world space: positions through `m`, triangles rewound when `m` mirrors. */
function toWorld(m: Mat, vertices: ArrayLike<number>, indices: ArrayLike<number>): { positions: Float32Array; indices: Uint32Array } {
  const count = Math.floor(vertices.length / 3);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) positions.set(transformPoint(m, vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]), i * 3);
  const tris = indices.length - (indices.length % 3);
  const out = new Uint32Array(tris);
  const flip = det3(m) < 0;
  for (let i = 0; i < tris; i += 3) {
    out[i] = indices[i];
    out[i + 1] = flip ? indices[i + 2] : indices[i + 1];
    out[i + 2] = flip ? indices[i + 1] : indices[i + 2];
  }
  return { positions, indices: out };
}

/** A unit box's corners and outward-wound triangles (counter-clockwise seen from outside). */
const BOX_VERTS = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
const BOX_TRIS = [
  0, 2, 1, 0, 3, 2, // -z
  4, 5, 6, 4, 6, 7, // +z
  0, 1, 5, 0, 5, 4, // -y
  3, 7, 6, 3, 6, 2, // +y
  0, 4, 7, 0, 7, 3, // -x
  1, 2, 6, 1, 6, 5, // +x
];

/**
 * A capsule (or a sphere, with `half` 0) along +Y in its own frame: `radius`, straight part ±`half`,
 * outward-wound. Coarse (8 around), since the bake voxelizes it anyway.
 */
function capsuleMesh(radius: number, half: number, around = 8, rings = 4): { vertices: number[]; indices: number[] } {
  const vertices: number[] = [];
  const indices: number[] = [];
  // Rows from the bottom pole to the top pole; each hemisphere has `rings` rows, the equator rows doubled for the straight part.
  const rows: { y: number; r: number }[] = [];
  for (let i = 0; i <= rings; i++) {
    const a = -Math.PI / 2 + (i / rings) * (Math.PI / 2);
    rows.push({ y: Math.sin(a) * radius - half, r: Math.cos(a) * radius });
  }
  for (let i = 0; i <= rings; i++) {
    const a = (i / rings) * (Math.PI / 2);
    rows.push({ y: Math.sin(a) * radius + half, r: Math.cos(a) * radius });
  }
  for (const row of rows) {
    for (let j = 0; j < around; j++) {
      const t = (j / around) * Math.PI * 2;
      vertices.push(Math.cos(t) * row.r, row.y, Math.sin(t) * row.r);
    }
  }
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * around + j, b = i * around + ((j + 1) % around), c = a + around, d = b + around;
      // Seen from outside, (a, c, b) and (b, c, d) run counter-clockwise.
      indices.push(a, c, b, b, c, d);
    }
  }
  return { vertices, indices };
}

/** A rigid frame: `m`'s rotation (scale removed) and the given origin. */
function rigidFrame(m: Mat, origin: V3, up: 0 | 1 | 2): Float64Array {
  const s = scaleOf(m);
  const col = (i: number): V3 => [m[i * 4] / (s[i] || 1), m[i * 4 + 1] / (s[i] || 1), m[i * 4 + 2] / (s[i] || 1)];
  // The capsule mesh runs along its own +Y: map that to the node's `up` axis, keeping a right-handed frame.
  const [x, y, z] = up === 1 ? [col(0), col(1), col(2)] : up === 0 ? [col(1), col(0), col(2).map((v) => -v) as V3] : [col(0), col(2), col(1).map((v) => -v) as V3];
  const out = new Float64Array(16);
  out.set([...x, 0, ...y, 0, ...z, 0, ...origin, 1]);
  return out;
}

interface Owner {
  node: GameObject;
  components: Component[];
}

/**
 * Collect what `chunkNode`'s NavChunk bakes from the World's live nodes. `chunkNode` may lack a NavChunk
 * (a whole scene baked with the defaults). `settings` lets agent type and area ids be checked.
 */
export function collectNavGeometry(world: World, chunkNode: GameObject, settings?: NavigationSettings): NavGeometry {
  const chunkComp = navChunkOf(chunkNode);
  const get = (name: string) => (chunkComp ? fieldOf(chunkComp, name) : undefined);
  const collect = str(get("collect"), "both");
  const scope = str(get("scope"), "scene");
  const geometry: NavGeometry = {
    meshes: [],
    chunk: {
      useChunkBounds: get("useChunkBounds") === true,
      center: vec3(get("center"), [0, 0, 0]),
      size: vec3(get("size"), [64, 32, 64]),
      minOverlayDepth: num(get("minOverlayDepth"), 1),
      maxOverlayDepth: num(get("maxOverlayDepth"), 2),
      skipAgents: strings(get("skipAgents")),
    },
    modifierVolumes: [],
    gates: [],
    resolutionVolumes: [],
    pending: [],
    warnings: [],
  };

  const agentIds = settings ? new Set(settings.agentTypes.map((t) => t.id)) : null;
  const areaIds = settings ? new Set(settings.areas.map((a) => a.id)) : null;
  const checkAgents = (ids: readonly string[], where: string) => {
    if (!agentIds) return;
    for (const id of ids) if (!agentIds.has(id)) geometry.warnings.push(`${where}: no agent type has the id "${id}".`);
  };
  const checkArea = (id: string, where: string) => {
    if (areaIds && id && !areaIds.has(id)) geometry.warnings.push(`${where}: no area has the id "${id}".`);
  };
  checkAgents(geometry.chunk.skipAgents ?? [], `${chunkNode.name} (NavChunk skipAgents)`);

  const start = scope === "children" ? chunkNode : (chunkNode.isSceneNode ? chunkNode : chunkNode.scene) ?? world.root;
  const owners: Owner[] = [];
  const visit = (node: GameObject) => {
    if (!node.activeInHierarchy) return;
    if (node !== start && node.isSceneNode) return; // another scene
    const components = ownedComponents(node);
    const types = components.filter(enabled).map(typeOf);
    if (node !== chunkNode && node !== start) {
      const other = components.find((c) => typeOf(c) === NAV_CHUNK);
      if (other && str(fieldOf(other, "scope"), "scene") === "children") return; // a chunk of its own
    }
    if (types.includes(NAV_AGENT)) return;
    const body = components.find((c) => typeOf(c) === "engine.RigidBody" && enabled(c));
    if (body && str(fieldOf(body, "bodyType"), "dynamic") !== "static") return;
    owners.push({ node, components });
    for (const e of world.childEntities(node.entity)) {
      if (world.isComponentNode(e)) continue;
      visit(world.handle(e));
    }
  };
  visit(start);

  for (const { node, components } of owners) {
    const live = components.filter(enabled);
    const of = (type: string) => live.filter((c) => typeOf(c) === type);
    const surface = of(NAV_SURFACE)[0];
    const obstacle = of(NAV_OBSTACLE)[0];
    let source: string;
    let base: Pick<NavBakeMesh, "kind" | "area" | "walkableFor">;
    if (obstacle) {
      if (surface) geometry.warnings.push(`${node.name}: has both a NavSurface and a NavObstacle; it's baked as an obstacle.`);
      source = str(fieldOf(obstacle, "source"), "mesh");
      base = { kind: "obstacle" };
    } else if (surface) {
      source = str(fieldOf(surface, "source"), "mesh");
      const area = str(fieldOf(surface, "area"), "");
      const walkableFor = strings(fieldOf(surface, "walkableFor"));
      checkArea(area, `${node.name} (NavSurface)`);
      checkAgents(walkableFor, `${node.name} (NavSurface)`);
      base = { kind: "navMesh", ...(area ? { area } : {}), ...(walkableFor.length ? { walkableFor } : {}) };
    } else {
      source = collect === "renderMeshes" ? "mesh" : collect === "colliders" ? "collider" : collect === "both" ? "both" : "none";
      base = { kind: "navMesh" };
    }
    const useMesh = source === "mesh" || source === "both";
    const useCollider = source === "collider" || source === "both";

    const add = (m: Mat, vertices: ArrayLike<number>, indices: ArrayLike<number>) => {
      if (indices.length < 3) return;
      geometry.meshes.push({ ...toWorld(m, vertices, indices), ...base, ...(base.walkableFor ? { walkableFor: [...base.walkableFor] } : {}) });
    };
    const addRef = (c: Component, ref: string) => {
      const meshes = meshesIfLoaded(ref);
      if (meshes === null) {
        if (!geometry.pending.includes(ref)) geometry.pending.push(ref);
        return;
      }
      const m = matrixOf(world, c.node.entity);
      for (const mesh of meshes) {
        const t = meshTriangles(mesh);
        add(m, t.vertices, t.indices);
      }
    };

    if (useMesh) for (const r of of("engine.MeshRenderer")) addRef(r, str(fieldOf(r, "mesh"), ""));
    if (useCollider) {
      for (const c of live) {
        const type = typeOf(c);
        if (!type || !/^engine\.(Box|Sphere|Capsule|Mesh)Collider$/.test(type) || fieldOf(c, "isTrigger") === true) continue;
        const m = matrixOf(world, c.node.entity);
        const center = vec3(fieldOf(c, "center"), [0, 0, 0]);
        if (type === "engine.BoxCollider") {
          const box = boxToWorld(m, center, vec3(fieldOf(c, "size"), [1, 1, 1]));
          add(box, BOX_VERTS, BOX_TRIS);
        } else if (type === "engine.SphereCollider") {
          const r = sphereRadius(num(fieldOf(c, "radius"), 0.5), scaleOf(m));
          const frame = rigidFrame(m, transformPoint(m, ...center), 1);
          const s = capsuleMesh(r, 0);
          add(frame, s.vertices, s.indices);
        } else if (type === "engine.CapsuleCollider") {
          const axis = ({ x: 0, y: 1, z: 2 } as const)[str(fieldOf(c, "direction"), "y") as "x" | "y" | "z"] ?? 1;
          const size = capsuleSize(num(fieldOf(c, "radius"), 0.5), num(fieldOf(c, "height"), 2), axis, scaleOf(m));
          const frame = rigidFrame(m, transformPoint(m, ...center), axis);
          const s = capsuleMesh(size.radius, size.halfHeight);
          add(frame, s.vertices, s.indices);
        } else {
          const ref = str(fieldOf(c, "mesh"), "") || str(of("engine.MeshRenderer")[0] && fieldOf(of("engine.MeshRenderer")[0], "mesh"), "");
          if (ref) addRef(c, ref);
        }
      }
    }

    for (const v of of(NAV_MODIFIER_VOLUME)) {
      const m = matrixOf(world, v.node.entity);
      const area = str(fieldOf(v, "area"), "");
      const agents = strings(fieldOf(v, "agents"));
      checkArea(area, `${node.name} (NavModifierVolume)`);
      checkAgents(agents, `${node.name} (NavModifierVolume)`);
      const appliesTo = str(fieldOf(v, "appliesTo"), "both") as ModifierVolume["appliesTo"];
      geometry.modifierVolumes.push({
        boxToWorld: boxToWorld(m, vec3(fieldOf(v, "center"), [0, 0, 0]), vec3(fieldOf(v, "size"), [1, 1, 1])),
        area,
        appliesTo,
        ...(agents.length ? { affectedAgents: agents } : {}),
      });
    }
    for (const v of of(NAV_RESOLUTION_VOLUME)) {
      const m = matrixOf(world, v.node.entity);
      const agents = strings(fieldOf(v, "agents"));
      geometry.resolutionVolumes.push({
        boxToWorld: boxToWorld(m, vec3(fieldOf(v, "center"), [0, 0, 0]), vec3(fieldOf(v, "size"), [1, 1, 1])),
        cellSize: num(fieldOf(v, "cellSize"), 0.5),
        ...(agents.length ? { affectedAgents: agents } : {}),
      });
    }
    for (const g of of(NAV_GATE)) {
      const m = matrixOf(world, g.node.entity);
      geometry.gates.push({
        boxToWorld: boxToWorld(m, vec3(fieldOf(g, "center"), [0, 0, 0]), vec3(fieldOf(g, "size"), [1, 1, 1])),
        id: str(fieldOf(g, "gateId"), "") || g.node.id || g.node.name,
        startOpen: fieldOf(g, "open") !== false,
      });
    }
  }
  return geometry;
}

/** Wait for every model the chunk's meshes and mesh colliders use, so {@link collectNavGeometry} has no `pending`. */
export async function loadNavGeometryMeshes(world: World, chunkNode: GameObject, settings?: NavigationSettings): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const { pending } = collectNavGeometry(world, chunkNode, settings);
    if (pending.length === 0) return;
    await Promise.all(pending.map((ref) => loadMeshes(ref).catch(() => [])));
  }
}

/** The geometry's chunk settings with its volumes, as `bakeChunk` takes them. */
export function navBakeChunk(geometry: NavGeometry): NavBakeChunk {
  return { ...geometry.chunk, modifierVolumes: geometry.modifierVolumes, gates: geometry.gates, resolutionVolumes: geometry.resolutionVolumes };
}

/**
 * A quick signature of a bake's inputs (FNV-1a, 64 bits as hex): equal inputs give equal signatures, so a
 * bake whose recorded signature differs from the current one is stale. (The bake file's own signature is
 * computed in Rust; this one is recomputed cheaply in TypeScript without baking.)
 */
export function navInputSignature(geometry: NavGeometry, settings: NavigationSettings, scenePath: string, chunkNodeId: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  const byte = (b: number) => {
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ b, 0x5bd1e995) >>> 0;
  };
  const text = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      byte(c & 0xff);
      byte(c >>> 8);
    }
  };
  const bytes = (a: Float32Array | Uint32Array) => {
    const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < u.length; i++) byte(u[i]);
  };
  text(JSON.stringify({ settings, chunk: navBakeChunk(geometry), scenePath, chunkNodeId }));
  for (const m of geometry.meshes) {
    text(JSON.stringify([m.kind ?? "navMesh", m.area ?? "", m.walkableFor ?? []]));
    bytes(m.positions);
    bytes(m.indices);
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
