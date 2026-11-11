import { beforeEach, describe, expect, it } from "vitest";
import "../index";
import { World } from "../core/World";
import { instantiateDocument } from "../editor";
import { collectNavGeometry, findNavChunks, loadNavGeometryMeshes, navBakeChunk, navBakePath, navInputSignature, type NavGeometry } from "../nav/geometry";
import { defaultNavigationSettings } from "../nav/settings";
import type { NodeEntry, SceneFile } from "../scene/SceneLoader";
import type { GameObject } from "../scene/GameObject";
import { Assets } from "../scene/Assets";

// ADR 0065, W6: what a NavChunk bakes from, collected from a World's live nodes (CONTRACT.md's rules).

const t = (position: number[], extra: Record<string, unknown> = {}) => ({ type: "engine.Transform", data: { position, ...extra } });
const node = (id: string, components: NodeEntry["components"], more: Partial<NodeEntry> = {}): NodeEntry => ({ id, name: id, components, ...more });

function load(nodes: NodeEntry[]): { world: World; scene: GameObject; byId: (id: string) => GameObject } {
  const world = new World("editor");
  const file: SceneFile = { format: "myco.scene@4", nodes };
  const scene = World._runIn(world, () => instantiateDocument(world, file, "scenes/test.scene.json"));
  const byId = (id: string) => {
    const find = (n: GameObject): GameObject | null => (n.id === id ? n : n.children.map(find).find(Boolean) ?? null);
    const found = find(scene);
    if (!found) throw new Error(`no node ${id}`);
    return found;
  };
  return { world, scene, byId };
}

/** The bounding box of every vertex of the collected meshes (optionally only one kind). */
function bounds(g: NavGeometry, kind?: "navMesh" | "obstacle") {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of g.meshes) {
    if (kind && (m.kind ?? "navMesh") !== kind) continue;
    for (let i = 0; i < m.positions.length; i++) {
      min[i % 3] = Math.min(min[i % 3], m.positions[i]);
      max[i % 3] = Math.max(max[i % 3], m.positions[i]);
    }
  }
  return { min, max };
}

/** Sum of each triangle's `cross(b - a, c - a)`: points along the surface's walkable side. */
function normalSum(m: NavGeometry["meshes"][number]): number[] {
  const out = [0, 0, 0];
  const p = m.positions;
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [m.indices[i] * 3, m.indices[i + 1] * 3, m.indices[i + 2] * 3];
    const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    out[0] += u[1] * v[2] - u[2] * v[1];
    out[1] += u[2] * v[0] - u[0] * v[2];
    out[2] += u[0] * v[1] - u[1] * v[0];
  }
  return out;
}

const CHUNK = (data: Record<string, unknown> = {}) => ({ type: "engine.NavChunk", data });

describe("collectNavGeometry", () => {
  beforeEach(() => Assets.clearSources());

  it("collects render meshes in world space, wound with the walkable side up", () => {
    const { world, scene, byId } = load([
      node("nav", [t([0, 0, 0]), CHUNK()]),
      node("ground", [t([10, 2, 0], { scale: [2, 1, 2] }), { type: "engine.MeshRenderer", data: { mesh: "builtin:plane" } }]),
    ]);
    const g = collectNavGeometry(world, byId("nav"));
    expect(g.meshes).toHaveLength(1);
    expect(g.pending).toEqual([]);
    const b = bounds(g);
    // A 10 m plane scaled 2×: 20 m across, centred on (10, 2, 0).
    expect(b.min).toEqual([0, 2, -10]);
    expect(b.max).toEqual([20, 2, 10]);
    expect(normalSum(g.meshes[0])[1]).toBeGreaterThan(0);
    expect(g.meshes[0].kind).toBe("navMesh");
    expect(findNavChunks(scene).map((n) => n.id)).toEqual(["nav"]);
  });

  // ADR 0164: engine meshes wind left-handed (cross(b - a, c - a) into the surface); the bake input winds the
  // other way, so surfaces facing up stay walkable whatever the source.
  /** Sum of `cross(b - a, c - a)` over the triangles whose vertices all sit at height `y`. */
  const facesAt = (m: NavGeometry["meshes"][number], y: number): number[] => {
    const p = m.positions;
    const keep: number[] = [];
    for (let i = 0; i < m.indices.length; i += 3) {
      const tri = [m.indices[i], m.indices[i + 1], m.indices[i + 2]];
      if (tri.every((v) => Math.abs(p[v * 3 + 1] - y) < 1e-4)) keep.push(...tri);
    }
    return normalSum({ ...m, indices: new Uint32Array(keep) });
  };

  it("keeps the walkable side up for built-in meshes under a rotated node, and for box colliders (ADR 0164)", () => {
    const yaw = [0, Math.sin(0.35), 0, Math.cos(0.35)];
    const { world, byId } = load([
      node("nav", [t([0, 0, 0]), CHUNK()]),
      node("plane", [t([0, 0, 0], { rotation: yaw }), { type: "engine.MeshRenderer", data: { mesh: "builtin:plane" } }]),
      node("cube", [t([30, 0.5, 0], { rotation: yaw }), { type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } }]),
      node("crate", [t([-30, 0.5, 0], { rotation: yaw }), { type: "engine.BoxCollider", data: {} }]),
    ]);
    const g = collectNavGeometry(world, byId("nav"));
    expect(g.meshes).toHaveLength(3);
    const [plane, cube, crate] = g.meshes;
    expect(normalSum(plane)[1]).toBeGreaterThan(0);
    expect(facesAt(cube, 1)[1]).toBeGreaterThan(0);
    expect(facesAt(cube, 0)[1]).toBeLessThan(0);
    expect(facesAt(crate, 1)[1]).toBeGreaterThan(0);
    expect(facesAt(crate, 0)[1]).toBeLessThan(0);
  });

  it("keeps the walkable side up for an imported model, and under a mirroring scale (ADR 0164)", async () => {
    // A right-handed OBJ floor, counter-clockwise from above (its file normal is +Y).
    const obj = "v -1 0 -1\nv 1 0 -1\nv 1 0 1\nv -1 0 1\nf 1 3 2\nf 1 4 3\n";
    Assets.addSource(Assets.fromObject({ "models/floor.obj": `data:text/plain;base64,${Buffer.from(obj).toString("base64")}` }));
    const { world, byId } = load([
      node("nav", [t([0, 0, 0]), CHUNK()]),
      node("floor", [t([0, 0, 0]), { type: "engine.MeshRenderer", data: { mesh: "asset:models/floor.obj" } }]),
      node("mirrored", [t([10, 0, 0], { scale: [-1, 1, 1] }), { type: "engine.MeshRenderer", data: { mesh: "asset:models/floor.obj" } }]),
    ]);
    await loadNavGeometryMeshes(world, byId("nav"));
    const g = collectNavGeometry(world, byId("nav"));
    expect(g.pending).toEqual([]);
    expect(g.meshes).toHaveLength(2);
    for (const m of g.meshes) expect(normalSum(m)[1]).toBeGreaterThan(0);
  });

  it("collects box, sphere and capsule colliders sized as physics sizes them, and skips triggers", () => {
    const { world, byId } = load([
      node("nav", [t([0, 0, 0]), CHUNK({ collect: "colliders" })]),
      node("box", [t([0, -0.5, 0], { scale: [2, 1, 1] }), { type: "engine.BoxCollider", data: { size: [10, 1, 10] } }, { type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } }]),
      node("ball", [t([0, 5, 0], { scale: [1, 3, 1] }), { type: "engine.SphereCollider", data: { radius: 1 } }]),
      node("pill", [t([20, 0, 0]), { type: "engine.CapsuleCollider", data: { radius: 0.5, height: 4, direction: "x" } }]),
      node("trigger", [t([50, 0, 0]), { type: "engine.BoxCollider", data: { isTrigger: true } }]),
    ]);
    const g = collectNavGeometry(world, byId("nav"));
    expect(g.meshes).toHaveLength(3); // the box's MeshRenderer isn't collected with "colliders"; the trigger isn't
    const [box, ball, pill] = g.meshes;
    const bb = bounds({ ...g, meshes: [box] });
    expect(bb.min.map((v) => +v.toFixed(4))).toEqual([-10, -1, -5]);
    expect(bb.max.map((v) => +v.toFixed(4))).toEqual([10, 0, 5]);
    // Outward-wound: the sum of a closed box's face normals is 0, but its top faces point up.
    const sb = bounds({ ...g, meshes: [ball] });
    expect(sb.max[1] - sb.min[1]).toBeCloseTo(6, 4); // radius 1 × the largest scale (3)
    const pb = bounds({ ...g, meshes: [pill] });
    expect(pb.max[0] - pb.min[0]).toBeCloseTo(4, 4); // along x
    expect(pb.max[1] - pb.min[1]).toBeLessThan(1.01);
  });

  it("applies NavSurface and NavObstacle, and the chunk's collect setting to unmarked nodes", () => {
    const { world, byId } = load([
      node("nav", [t([0, 0, 0]), CHUNK({ collect: "none" })]),
      node("plain", [t([0, 0, 0]), { type: "engine.MeshRenderer", data: { mesh: "builtin:plane" } }]),
      node("mud", [
        t([30, 0, 0]),
        { type: "engine.MeshRenderer", data: { mesh: "builtin:plane" } },
        { type: "engine.BoxCollider", data: {} },
        { type: "engine.NavSurface", data: { area: "mud", walkableFor: ["a1"], source: "both" } },
      ]),
      node("wall", [t([60, 0, 0]), { type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } }, { type: "engine.NavObstacle", data: { source: "mesh" } }]),
    ]);
    const settings = defaultNavigationSettings();
    const g = collectNavGeometry(world, byId("nav"), settings);
    // "none" skips the plain node; the marked ones are collected anyway.
    expect(g.meshes.map((m) => [m.kind, m.area ?? null, m.walkableFor ?? null])).toEqual([
      ["navMesh", "mud", ["a1"]],
      ["navMesh", "mud", ["a1"]],
      ["obstacle", null, null],
    ]);
    expect(g.warnings.join("\n")).toMatch(/no area has the id "mud"/);
    expect(g.warnings.join("\n")).toMatch(/no agent type has the id "a1"/);
  });

  it("collects volumes as oriented boxes, and the chunk's bounds and settings", () => {
    const { world, byId } = load([
      node("nav", [t([0, 0, 0]), CHUNK({ useChunkBounds: true, center: [1, 2, 3], size: [10, 20, 30], skipAgents: ["x"], minOverlayDepth: 2, maxOverlayDepth: 3 })]),
      node("mod", [t([5, 0, 0], { scale: [2, 2, 2] }), { type: "engine.NavModifierVolume", data: { center: [1, 0, 0], size: [2, 3, 4], area: "water", appliesTo: "ground", agents: ["a"] } }]),
      node("res", [t([0, 10, 0]), { type: "engine.NavResolutionVolume", data: { size: [4, 4, 4], cellSize: 0.25 } }]),
      node("res2", [t([0, 20, 0]), { type: "engine.NavResolutionVolume", data: { size: [2, 2, 2], cellSize: 0.5, agents: ["bat"] } }]),
      node("gate", [t([0, 0, 7]), { type: "engine.NavGate", data: { gateId: "door", open: false } }]),
    ]);
    const g = collectNavGeometry(world, byId("nav"));
    expect(g.chunk).toEqual({ useChunkBounds: true, center: [1, 2, 3], size: [10, 20, 30], minOverlayDepth: 2, maxOverlayDepth: 3, skipAgents: ["x"] });
    expect(g.modifierVolumes).toHaveLength(1);
    const m = g.modifierVolumes[0];
    expect(m).toMatchObject({ area: "water", appliesTo: "ground", affectedAgents: ["a"] });
    // Column-major: x axis × size 2 × scale 2, translation = node (5, 0, 0) + centre (1, 0, 0) × scale 2.
    expect(m.boxToWorld[0]).toBeCloseTo(4);
    expect(m.boxToWorld[5]).toBeCloseTo(6);
    expect(m.boxToWorld[10]).toBeCloseTo(8);
    expect([m.boxToWorld[12], m.boxToWorld[13], m.boxToWorld[14]].map((v) => +v.toFixed(4))).toEqual([7, 0, 0]);
    // Foxfire's Affected Agents: empty = every type; listed types reach the bake as affectedAgents.
    expect(g.resolutionVolumes).toEqual([
      { boxToWorld: expect.any(Array), cellSize: 0.25 },
      { boxToWorld: expect.any(Array), cellSize: 0.5, affectedAgents: ["bat"] },
    ]);
    expect(g.resolutionVolumes[0].boxToWorld[13]).toBeCloseTo(10);
    expect(g.gates).toEqual([{ boxToWorld: expect.any(Array), id: "door", startOpen: false }]);
    expect(navBakeChunk(g).gates).toBe(g.gates);
  });

  it("scopes to the chunk's children or its scene, and leaves out inactive nodes, agents, moving bodies and other chunks", () => {
    const plane = { type: "engine.MeshRenderer", data: { mesh: "builtin:plane" } };
    const { world, byId } = load([
      node("level", [t([0, 0, 0]), CHUNK({ scope: "children" })]),
      node("floor", [t([0, 0, 0]), plane], { parent: "level" }),
      node("outside", [t([100, 0, 0]), plane]),
      node("hidden", [t([200, 0, 0]), plane], { active: false }),
      node("walker", [t([300, 0, 0]), plane, { type: "engine.NavAgent", data: {} }]),
      node("crate", [t([400, 0, 0]), plane, { type: "engine.RigidBody", data: { bodyType: "dynamic" } }]),
      node("pillar", [t([500, 0, 0]), plane, { type: "engine.RigidBody", data: { bodyType: "static" } }]),
      node("whole", [t([0, 0, 0]), CHUNK({ scope: "scene" })]),
    ]);
    const children = collectNavGeometry(world, byId("level"));
    expect(children.meshes).toHaveLength(1);
    expect(bounds(children).max[0]).toBe(5);

    const scene = collectNavGeometry(world, byId("whole"));
    // outside and pillar; not the "level" chunk's own children, nor the hidden, walking or dynamic ones.
    const xs = scene.meshes.map((m) => Math.round((m.positions[0] + m.positions[3]) / 2 / 100) * 100);
    expect(scene.meshes).toHaveLength(2);
    expect(xs.sort((a, b) => a - b)).toEqual([100, 500]);
  });

  it("names bake files after the scene, and signs inputs so a change shows", () => {
    expect(navBakePath("scenes/main.scene.json")).toBe("scenes/main.nav.bin");
    const { world, byId } = load([node("nav", [t([0, 0, 0]), CHUNK()]), node("ground", [t([0, 0, 0]), { type: "engine.MeshRenderer", data: { mesh: "builtin:plane" } }])]);
    const settings = defaultNavigationSettings();
    const a = navInputSignature(collectNavGeometry(world, byId("nav")), settings, "scenes/main.scene.json", "nav");
    expect(navInputSignature(collectNavGeometry(world, byId("nav")), settings, "scenes/main.scene.json", "nav")).toBe(a);
    byId("ground").transform!.position.x = 1;
    expect(navInputSignature(collectNavGeometry(world, byId("nav")), settings, "scenes/main.scene.json", "nav")).not.toBe(a);
    settings.tileSize = 32;
    expect(navInputSignature(collectNavGeometry(world, byId("nav")), settings, "scenes/main.scene.json", "nav")).toMatch(/^[0-9a-f]{16}$/);
  });
});
