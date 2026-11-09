// Creating 3D nodes, adding models from the Assets panel, and fitting a 3D collider around a mesh (ADR 0044, 0045, 0088).
// Split from the collider gizmo tests when those moved into the Physics editor half.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Assets, Engine, MeshRenderer } from "../myco";
import { addAsset, assetKind, prepareAssets, whyNotAddable } from "./assetBrowser";
import { newComponentEntry } from "./componentEdits";
import { createNode, newNodeEntry } from "./nodeCreate";
import { openSceneFile } from "./project";
import { openScene } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings } from "./testing";
import { meshesEditorPlugin } from "../plugins/meshes/editor";
import { useEditorPlugins } from "../plugins/testEditorPlugins";

// Models are the Meshes plugin's kind (ADR 0140).
useEditorPlugins([meshesEditorPlugin]);

describe("creating 3D nodes", () => {
  it("makes shapes with a mesh and matching collider, and lights aimed down", async () => {
    const engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    const doc = openScene.value!.doc;
    expect(newNodeEntry(doc, "sphere", null).components!.map((c) => c.type)).toEqual(["engine.Transform", "engine.MeshRenderer", "engine.SphereCollider"]);
    expect(newNodeEntry(doc, "plane", null).components![2].type).toBe("engine.MeshCollider");
    const sun = newNodeEntry(doc, "directional-light", null, [0, 0, 0]);
    expect(sun).toMatchObject({ id: "directional-light", name: "Directional Light" });
    expect(sun.components![0].data).toEqual({ position: [0, 5, 0], rotation: [-50, 30, 0] });
    expect(newNodeEntry(doc, "point-light", null).components![1].data).toEqual({ type: "point" });
    engine.dispose();
  });
});

describe("adding models from the Assets panel (ADR 0044)", () => {
  it("adds a one-mesh model as one node, and a model of several meshes as a node with a child per mesh", async () => {
    const engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    const file = (p: string) => `data:application/octet-stream;base64,${readFileSync(new URL(`../../samples/playground3d/${p}`, import.meta.url)).toString("base64")}`;
    const extra = Assets.fromObject({ "models/robot.fbx": file("models/robot.fbx"), "models/crate.obj": file("models/crate.obj"), "models/crate.mtl": file("models/crate.mtl") });
    Assets.addSource(extra);
    try {
      openSceneFile(engine, DEMO_SCENE);
      const scene = openScene.value!;
      expect(whyNotAddable(scene.doc, "models/robot.fbx")).toBeNull();
      await prepareAssets(["models/robot.fbx", "models/crate.obj"]);
      const robot = addAsset(scene, "models/robot.fbx", { position: [1, 0, 2] });
      expect(scene.doc.children(robot).map((id) => scene.doc.node(id).name)).toEqual(["Body", "Head"]);
      const head = scene.doc.children(robot)[1];
      expect(scene.doc.node(head).components!.find((c) => c.type === "engine.MeshRenderer")!.data).toEqual({ mesh: "asset:models/robot.fbx#Head" });
      const crate = addAsset(scene, "models/crate.obj");
      expect(scene.doc.children(crate)).toEqual([]);
      expect(scene.sync.nodeFor(crate)!.getBehavior(MeshRenderer)!.mesh).toBe("models/crate.obj");
      scene.stack.undo();
      expect(scene.doc.has(crate)).toBe(false);
    } finally {
      Assets.removeSource(extra);
      engine.dispose();
    }
  });
});

describe("adding glTF models from the Assets panel (ADR 0088)", () => {
  it("adds a glTF as the file's node tree, less the levels every mesh shares", async () => {
    const engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    const file = (p: string) => `data:application/octet-stream;base64,${readFileSync(new URL(`../../samples/playground3d/${p}`, import.meta.url)).toString("base64")}`;
    const extra = Assets.fromObject({ "models/lamp.glb": file("models/lamp.glb") });
    Assets.addSource(extra);
    try {
      openSceneFile(engine, DEMO_SCENE);
      const scene = openScene.value!;
      expect(assetKind("models/lamp.glb")).toBe("model");
      await prepareAssets(["models/lamp.glb"]);
      const lamp = addAsset(scene, "models/lamp.glb");
      const names = (id: string) => scene.doc.children(id).map((c) => scene.doc.node(c).name);
      const mesh = (id: string) => scene.doc.node(id).components!.find((c) => c.type === "engine.MeshRenderer")?.data;
      expect(names(lamp)).toEqual(["Base", "Pole"]);
      const pole = scene.doc.children(lamp)[1];
      expect(mesh(pole)).toEqual({ mesh: "asset:models/lamp.glb#Pole" });
      expect(names(pole)).toEqual(["Head"]);
      const head = scene.doc.children(pole)[0];
      expect(mesh(head)).toBeUndefined();
      expect(names(head)).toEqual(["Bulb", "Shade"]);
      expect(mesh(scene.doc.children(head)[0])).toEqual({ mesh: "asset:models/lamp.glb#Bulb" });
      scene.stack.undo();
      expect(scene.doc.has(lamp)).toBe(false);
    } finally {
      Assets.removeSource(extra);
      engine.dispose();
    }
  });
});

describe("adding a 3D collider beside a mesh (ADR 0045)", () => {
  it("fits a box, sphere or capsule around the mesh", async () => {
    const engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    const scene = openScene.value!;
    const id = createNode(scene, "capsule");
    const node = scene.sync.nodeFor(id)!;
    expect(newComponentEntry(node, "engine.BoxCollider")).toEqual({ type: "engine.BoxCollider", data: { center: [0, 0, 0], size: [1, 2, 1] } });
    expect(newComponentEntry(node, "engine.SphereCollider").data).toEqual({ center: [0, 0, 0], radius: 1 });
    expect(newComponentEntry(node, "engine.CapsuleCollider").data).toEqual({ center: [0, 0, 0], radius: 0.5, height: 2 });
    expect(newComponentEntry(scene.sync.nodeFor("bird")!, "engine.BoxCollider")).toEqual({ type: "engine.BoxCollider" }); // no mesh
    engine.dispose();
  });
});
