import { beforeEach, describe, expect, it } from "vitest";
import { Assets } from "../index";
import { NAV_RUNTIME_TYPES, navBakeRefs } from "../../plugins/navigation/runtime/navigationSystems";
import { PHYSICS_3D_COMPONENTS } from "../../plugins/physics/runtime/systems3d";
import { anyComponentOf, assetRefs, invalidateResolvedScenes, resolveScene, resolvedComponents } from "../scene/resolvedScene";
import { collectAssetRefs } from "../scene/SceneLoader";
import { warmSet } from "../scene/warmUp";

const F = "myco.scene@1";
/** What the 3D physics World service's scene scan asks (ADR 0135). */
const usesPhysics3D = (path: string) => anyComponentOf(path, PHYSICS_3D_COMPONENTS);
const usesNavigation = (path: string) => anyComponentOf(path, NAV_RUNTIME_TYPES);
const files: Record<string, unknown> = {
  "scene.json": {
    nodes: [
      { id: "plain", components: [{ type: "game.A" }] },
      { id: "a", prefab: "p.json" },
      {
        id: "b",
        prefab: "p.json",
        overrides: [
          { component: "engine.Transform", field: "position", value: [5, 0, 0] },
          { addComponent: { type: "game.Extra" } },
          { target: ["kid"], removeComponent: "game.Kid" },
          { target: ["kid"], active: false },
          { target: ["deep", "leaf"], component: "engine.MeshRenderer", field: "mesh", value: "builtin:sphere" },
          { addNodes: [{ id: "added", components: [{ type: "game.Added" }] }, { id: "inner", parent: "added", prefab: "q.json" }] },
          { target: ["added"], addComponent: { type: "game.LateOnAdded" } },
        ],
      },
      { id: "missing", prefab: "nope.json" },
      { id: "loop", prefab: "loop.json" },
    ],
  },
  "p.json": {
    nodes: [
      { id: "root", components: [{ type: "engine.Transform", data: { position: [1, 2, 3], scale: [1, 1, 1] } }] },
      { id: "kid", parent: "root", components: [{ type: "game.Kid" }] },
      { id: "deep", parent: "root", prefab: "q.json" },
    ],
  },
  "q.json": { nodes: [{ id: "leaf", components: [{ type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } }] }] },
  "loop.json": { nodes: [{ id: "r", components: [{ type: "game.Loop" }] }, { id: "again", parent: "r", prefab: "loop.json" }] },
};
const read = (p: string) => files[p];
const ids = (path: string) => resolveScene(path, { read }).nodes.map((n) => n.id);
const node = (id: string) => resolveScene("scene.json", { read }).nodes.find((n) => n.id === id);
const types = (id: string) => node(id)?.components.map((c) => c.type);

describe("resolved scene view", () => {
  it("expands nested prefabs under unique id paths", () => {
    expect(ids("scene.json")).toEqual(expect.arrayContaining(["plain", "a/root", "a/kid", "a/deep/leaf", "b/root", "b/deep/leaf"]));
    expect(node("a/deep/leaf")?.parent).toBe("a/root");
  });
  it("applies addComponent, removeComponent and field overrides without touching the source", () => {
    expect(types("b/root")).toEqual(["engine.Transform", "game.Extra"]);
    expect(types("a/root")).toEqual(["engine.Transform"]);
    expect(types("b/kid")).toEqual([]);
    expect(types("a/kid")).toEqual(["game.Kid"]);
    expect((node("b/root")!.components[0].data as { position: number[]; scale: number[] })).toEqual({ position: [5, 0, 0], scale: [1, 1, 1] });
    expect((node("a/root")!.components[0].data as { position: number[] }).position).toEqual([1, 2, 3]);
    expect(node("b/deep/leaf")!.components[0].data).toEqual({ mesh: "builtin:sphere" });
  });
  it("applies active overrides down the hierarchy flag", () => {
    expect(node("b/kid")?.active).toBe(false);
    expect(node("a/kid")?.activeInHierarchy).toBe(true);
  });
  it("adds nodes with components and nested prefabs, which later overrides can target", () => {
    expect(node("b/added")?.parent).toBe("b/root");
    expect(types("b/added")).toEqual(["game.Added", "game.LateOnAdded"]);
    expect(node("b/inner/leaf")?.parent).toBe("b/added");
    expect(types("b/inner/leaf")).toEqual(["engine.MeshRenderer"]);
  });
  it("skips a missing prefab and survives a cycle", () => {
    expect(ids("scene.json")).not.toContain("missing");
    expect(ids("scene.json")).toContain("loop/r");
    expect(ids("scene.json").filter((i) => i.startsWith("loop"))).toEqual(["loop/r"]);
    expect(resolveScene("gone.json", { read }).nodes).toEqual([]);
    expect(resolveScene("bad.json", { read: () => "not a scene" }).nodes).toEqual([]);
    expect(resolveScene("throws.json", { read: () => { throw new Error("x"); } }).nodes).toEqual([]);
  });
  it("removes nodes and their subtrees", () => {
    const f = { nodes: [{ id: "i", prefab: "p.json", overrides: [{ target: ["deep"], removeNode: true }] }] };
    const r = (p: string) => (p === "s.json" ? f : files[p]);
    const out = resolveScene("s.json", { read: r }).nodes.map((n) => n.id);
    expect(out).toContain("i/kid");
    expect(out).not.toContain("i/deep/leaf");
  });
  it("helpers", () => {
    expect(anyComponentOf("scene.json", ["game.LateOnAdded"], { read })).toBe(true);
    expect(anyComponentOf("scene.json", new Set(["game.Nope"]), { read })).toBe(false);
    expect(resolvedComponents("scene.json", { read }).some((c) => c.type === "game.Loop")).toBe(true);
  });
});

describe("walkers see every override kind", () => {
  beforeEach(() => {
    Assets.clearSources();
    invalidateResolvedScenes();
  });
  const use = (map: Record<string, unknown>) => Assets.addSource(Assets.fromObject(map));
  const prefab = { format: F, nodes: [{ id: "root", components: [] }] };
  const added = (component: { type: string; data?: unknown }) => ({
    format: F,
    nodes: [{ id: "i", prefab: "prefabs/p.prefab.json", overrides: [{ addNodes: [{ id: "n", components: [component] }] }] }],
  });

  it("usesPhysics3D: a MeshCollider added via addNodes", () => {
    use({ "s.scene.json": added({ type: "engine.MeshCollider" }), "prefabs/p.prefab.json": prefab });
    expect(usesPhysics3D("s.scene.json")).toBe(true);
  });
  it("usesNavigation and navBakeRefs: a NavAgent / NavChunk added via addNodes", () => {
    use({ "s.scene.json": added({ type: "engine.NavAgent" }), "prefabs/p.prefab.json": prefab });
    expect(usesNavigation("s.scene.json")).toBe(true);
    Assets.clearSources();
    use({ "s.scene.json": added({ type: "engine.NavChunk", data: { bake: "bakes/a.bin" } }), "prefabs/p.prefab.json": prefab });
    expect(navBakeRefs("s.scene.json")).toEqual(["bakes/a.bin"]);
  });
  it("collectAssetRefs follows a prefab inside addNodes", () => {
    use({
      "s.scene.json": { format: F, nodes: [{ id: "i", prefab: "prefabs/p.prefab.json", overrides: [{ addNodes: [{ id: "n", prefab: "prefabs/x.prefab.json" }] }] }] },
      "prefabs/p.prefab.json": prefab,
      "prefabs/x.prefab.json": { format: F, nodes: [{ id: "r", components: [{ type: "engine.SpriteRenderer", data: { sprite: "asset:images/x.png" } }] }] },
    });
    expect([...collectAssetRefs("s.scene.json")]).toEqual(["images/x.png"]);
    expect([...assetRefs("s.scene.json")]).toEqual(["images/x.png"]);
  });
  it("warmSet includes a MeshRenderer added by an override", () => {
    use({
      "s.scene.json": { format: F, nodes: [{ id: "i", prefab: "prefabs/p.prefab.json", overrides: [{ addComponent: { type: "engine.MeshRenderer", data: { mesh: "builtin:capsule" } } }] }] },
      "prefabs/p.prefab.json": prefab,
    });
    expect(warmSet("s.scene.json").meshes.map((m) => m.mesh)).toEqual(["builtin:capsule"]);
  });
  it("the cache follows asset changes", () => {
    const src = { "s.scene.json": added({ type: "engine.MeshCollider" }), "prefabs/p.prefab.json": prefab };
    use(src);
    expect(usesPhysics3D("s.scene.json")).toBe(true);
    src["s.scene.json"] = added({ type: "game.None" });
    expect(usesPhysics3D("s.scene.json")).toBe(false);
  });
});
