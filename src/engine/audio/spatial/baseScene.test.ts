// ADR 0333: the base game scene of a spatial test scene: which nodes and components the Studio loads underneath, how
// their references resolve (prefab instances, a mesh collider's renderer mesh, node references), where they are on the
// plan, and the warning for a base that isn't there.
import { describe, expect, it } from "vitest";
import { importBaseScene, replaceKeyOf, unmatchedReplaceKeys } from "./baseScene";

const T = (position: number[], extra: Record<string, unknown> = {}) => ({ type: "engine.Transform", data: { position, ...extra } });
/** A quaternion turning `deg` degrees about +y. */
const yawQ = (deg: number) => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];

const files: Record<string, unknown> = {
  "scenes/canyon.scene.json": {
    format: "myco.scene@4",
    settings: { physics: "3d" },
    nodes: [
      { id: "cam", name: "Camera", components: [T([0, 5, -10]), { type: "engine.Camera", data: {} }] },
      { id: "player", name: "Player", components: [T([0, 1, 0]), { type: "engine.AudioListener", data: {} }, { type: "engine.CharacterController", data: {} }, { type: "game.PlayerMove", data: {} }] },
      { id: "cave", name: "Cave", components: [T([10, 0, 0], { rotation: yawQ(90) }), { type: "engine.AudioOccluder", data: { material: "stone" } }] },
      { id: "wall", name: "Wall", parent: "cave", components: [T([0, 0, 5]), { type: "engine.BoxCollider", data: { size: [4, 3, 1], center: [0, 1.5, 0], layer: "Walls" } }, { type: "engine.MeshRenderer", data: { mesh: "asset:models/wall.glb" } }] },
      { id: "fire", name: "Campfire", parent: "cave", components: [T([0, 0.5, 0]), { type: "engine.AudioSource", data: { clip: "asset:audio/fire.playlist.json", loop: true, spatial: true } }, { type: "game.Flicker", data: { target: { $node: "cam" } } }] },
      { id: "rock", name: "Rock", components: [T([-3, 0, 2]), { type: "engine.MeshCollider", data: {} }, { type: "engine.MeshRenderer", data: { mesh: "asset:models/rock.obj" } }] },
      { id: "bare", name: "Bare mesh", components: [T([0, 0, 0]), { type: "engine.MeshCollider", data: {} }] },
      { id: "crate", name: "Crate", components: [T([2, 0, 2]), { type: "engine.RigidBody", data: {} }, { type: "engine.BoxCollider", data: {} }] },
      { id: "lake", name: "Lake", components: [T([0, 0, 30]), { type: "engine.AudioReverbZone", data: { shape: "sphere", radius: 8, preset: "cave" } }] },
      { id: "wind", name: "Wind", components: [T([0, 2, -20]), { type: "engine.AudioZone", data: { sound: "audio/wind.playlist.json", width: 6, depth: 4, yaw: 30, bottom: -2, top: 8 } }] },
      { id: "off", name: "Off", active: false, components: [T([0, 0, 0]), { type: "engine.AudioSource", data: { clip: "a.wav" } }] },
      { id: "torches", name: "Torches", prefab: "prefabs/torch.prefab.json", overrides: [{ component: "engine.Transform", field: "position", value: [5, 0, 5] }, { component: "engine.AudioSource", field: "clip", value: "asset:audio/torch2.wav" }] },
    ],
  },
  "prefabs/torch.prefab.json": {
    format: "myco.scene@4",
    nodes: [{ id: "t", name: "Torch", components: [T([0, 2, 0]), { type: "engine.AudioSource", data: { clip: "asset:audio/torch.wav", target: { $node: "t" } } }, { type: "engine.PointLight", data: {} }] }],
  },
};
const read = (path: string) => {
  if (!(path in files)) throw new Error(`missing ${path}`);
  return files[path];
};
const canyon = () => importBaseScene("scenes/canyon.scene.json", { read });

describe("importBaseScene", () => {
  it("imports the audio components and 3D colliders with their ancestors, and nothing else", () => {
    const b = canyon();
    expect(b.found).toBe(true);
    expect(b.file.settings).toEqual({ physics: "3d" });
    const byName = new Map(b.file.nodes.map((n) => [n.name, n]));
    expect([...byName.keys()]).toEqual(["Cave", "Wall", "Campfire", "Rock", "Crate", "Lake", "Wind", "Off", "Torches"]);
    expect(byName.get("Wall")!.components!.map((c) => c.type)).toEqual(["engine.Transform", "engine.BoxCollider"]);
    expect(byName.get("Campfire")!.components!.map((c) => c.type)).toEqual(["engine.Transform", "engine.AudioSource"]);
    expect(byName.get("Crate")!.components!.map((c) => c.type)).toEqual(["engine.Transform", "engine.BoxCollider"]); // static: no body
    expect(byName.get("Wall")!.parent).toBe("cave");
    expect(byName.get("Off")!.active).toBe(false);
    // Left out, each noted once.
    expect(b.problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/AudioListener isn't loaded.*"Player"/),
      expect.stringMatching(/RigidBody isn't loaded.*"Crate"/),
      expect.stringMatching(/CharacterController isn't loaded.*"Player"/),
    ]));
  });

  it("expands prefab instances with their overrides (the resolved scene view)", () => {
    const b = canyon();
    const torch = b.file.nodes.find((n) => n.name === "Torches")!; // the instance's name
    expect(torch.id).toBe("torches/t"); // the resolved view's id: the instance, then the prefab's root
    expect(torch.components!.find((c) => c.type === "engine.AudioSource")!.data).toMatchObject({ clip: "asset:audio/torch2.wav" });
    const o = b.objects.find((x) => x.name === "Torches")!;
    expect(o).toMatchObject({ kind: "emitter", sound: "audio/torch2.wav", path: "Torches" });
    expect(o.position).toEqual({ x: 5, y: 0, z: 5 }); // the instance's Transform replaces the prefab root's
  });

  it("resolves references: a mesh collider takes its renderer's mesh, node references point at imported nodes or clear", () => {
    const b = canyon();
    const rock = b.file.nodes.find((n) => n.name === "Rock")!;
    expect(rock.components!.find((c) => c.type === "engine.MeshCollider")!.data).toEqual({ mesh: "asset:models/rock.obj" });
    expect(b.file.nodes.some((n) => n.name === "Bare mesh")).toBe(false);
    expect(b.problems).toContainEqual(expect.stringMatching(/"Bare mesh": its MeshCollider has no mesh/));
    // Inside the prefab, "t" is the prefab's own node: the instance's flattened id.
    const torch = b.file.nodes.find((n) => n.name === "Torches")!;
    expect(torch.components!.find((c) => c.type === "engine.AudioSource")!.data!.target).toEqual({ $node: "torches/t" });
  });

  it("places objects in the world: parent turns and offsets, zones' and colliders' footprints, occluder materials", () => {
    const b = canyon();
    const at = (name: string) => b.objects.find((o) => o.name === name)!;
    // The cave turns 90° (local +z is world +x): the wall 5 m along it.
    const wall = at("Wall");
    expect(wall.kind).toBe("collider");
    expect(wall.box!.center.x).toBeCloseTo(15, 6);
    expect(wall.box!.center.z).toBeCloseTo(0, 6);
    expect(wall.box).toMatchObject({ width: 4, depth: 1, bottom: 0, top: 3 });
    expect(wall.box!.yaw).toBeCloseTo(90, 6);
    expect(wall).toMatchObject({ material: "stone", layer: "Walls" }); // the cave's occluder covers its children
    expect(at("Crate").material).toBeNull(); // no occluder: the project's default
    expect(at("Campfire")).toMatchObject({ kind: "emitter", sound: "audio/fire.playlist.json", spatial: true, path: "Cave/Campfire", position: { x: 10, y: 0.5, z: 0 } });
    expect(at("Lake")).toMatchObject({ kind: "reverbZone", radius: 8, preset: "cave", box: null });
    expect(at("Wind")).toMatchObject({ kind: "audioZone", sound: "audio/wind.playlist.json", box: { center: { x: 0, y: 0, z: -20 }, width: 6, depth: 4, yaw: 30, bottom: 0, top: 10 } });
    expect(at("Off").active).toBe(false);
    expect(at("Rock")).toMatchObject({ kind: "collider", box: null, radius: null });
  });

  it("names replace keys and finds the ones that match nothing", () => {
    const b = canyon();
    expect(replaceKeyOf(b.objects.find((o) => o.name === "Campfire")!)).toBe("Cave/Campfire/AudioSource");
    expect(unmatchedReplaceKeys(b, { "Cave/Campfire/AudioSource": "x.wav", "Wind/AudioZone": "y.wav", "Cave/Campfire/AudioSource[1]": "z.wav", "Nowhere/AudioSource": "z.wav", "Cave/Campfire/Light": "z.wav" })).toEqual([
      expect.stringContaining('"Cave/Campfire/AudioSource[1]"'),
      expect.stringContaining('"Nowhere/AudioSource"'),
      expect.stringContaining('"Cave/Campfire/Light": the last part must be'),
    ]);
  });

  it("a base scene that isn't there imports nothing, with one warning", () => {
    const b = importBaseScene("scenes/gone.scene.json", { read });
    expect(b).toMatchObject({ found: false, objects: [], file: { nodes: [] } });
    expect(b.problems).toEqual([expect.stringContaining('The base scene "scenes/gone.scene.json" isn\'t in the project')]);
    expect(importBaseScene("scenes/bad.scene.json", { read: () => ({ format: "myco.scene@4" }) }).found).toBe(false); // no nodes: not a scene
  });

  it("a scene with nothing audible imports no nodes", () => {
    const b = importBaseScene("scenes/empty.scene.json", { read: () => ({ format: "myco.scene@4", nodes: [{ id: "a", components: [{ type: "engine.Camera", data: {} }] }] }) });
    expect(b.found).toBe(true);
    expect(b.file.nodes).toEqual([]);
    expect(b.objects).toEqual([]);
  });
});
