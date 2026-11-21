import { describe, expect, it } from "vitest";
import { migrateSceneFile, type SceneFile } from "../scene/SceneLoader";
import { REMOVE_FIELD, mapSceneFile } from "../scene/sceneFileWalk";

/** A file with a component field value in every place one can sit (ADR 0279). */
const everyPlacement = (value: unknown): SceneFile => ({
  format: "myco.scene@4",
  nodes: [
    { id: "a", name: "A", components: [{ type: "t.Node", data: { f: value, other: 1 } }] },
    {
      id: "i",
      prefab: "p.prefab.json",
      overrides: [
        { component: "t.Override", field: "f", value },
        { name: "Renamed" },
        { addComponent: { type: "t.Added", data: { f: value } } },
        {
          addNodes: [
            { id: "n", components: [{ type: "t.AddedNode", data: { f: value } }] },
            {
              id: "deep",
              parent: "n",
              prefab: "q.prefab.json",
              overrides: [{ component: "t.DeepOverride", field: "f", value }, { addComponent: { type: "t.DeepAdded", data: { f: value } } }, { addNodes: [{ id: "deeper", components: [{ type: "t.Deeper", data: { f: value } }] }] }],
            },
          ],
        },
      ],
    },
  ],
});

describe("scene-file walk (ADR 0279)", () => {
  it("visits every component field value with its component type, wherever it sits", () => {
    const seen: string[] = [];
    mapSceneFile(everyPlacement("x"), { field: (component, field, value) => (seen.push(`${component}.${field}=${String(value)}`), value) });
    expect(seen.filter((s) => s.endsWith(".f=x"))).toEqual(["t.Node.f=x", "t.Override.f=x", "t.Added.f=x", "t.AddedNode.f=x", "t.DeepOverride.f=x", "t.DeepAdded.f=x", "t.Deeper.f=x"]);
    expect(seen).toContain("t.Node.other=1");
  });

  it("gives back the same file when the rule changes nothing, and copies only what changed", () => {
    const file = everyPlacement("x");
    const before = structuredClone(file);
    expect(mapSceneFile(file, { field: (_c, _f, v) => v, nodes: (n) => n })).toBe(file);
    const out = mapSceneFile(file, { field: (c, f, v) => (c === "t.Deeper" ? "y" : v) });
    expect(file).toEqual(before); // the input isn't touched
    expect(out.nodes[0]).toBe(file.nodes[0]);
    expect(out.nodes[1].overrides![0]).toBe(file.nodes[1].overrides![0]);
    const deep = out.nodes[1].overrides![3].addNodes![1];
    expect(deep.overrides![2].addNodes![0].components![0].data).toEqual({ f: "y" });
  });

  it("drops removed component fields and removed overrides", () => {
    const out = mapSceneFile(everyPlacement("x"), { field: (_c, f, v) => (f === "f" ? REMOVE_FIELD : v) });
    expect(out.nodes[0].components![0].data).toEqual({ other: 1 });
    expect(out.nodes[1].overrides!.map((o) => Object.keys(o)[0])).toEqual(["name", "addComponent", "addNodes"]);
    expect(out.nodes[1].overrides![1].addComponent!.data).toEqual({});
    const deep = out.nodes[1].overrides![2].addNodes![1];
    expect(deep.overrides!.map((o) => Object.keys(o)[0])).toEqual(["addComponent", "addNodes"]);
  });

  it("lets a rule filter every node list, the file's and each added-nodes list", () => {
    const lists: string[][] = [];
    const out = mapSceneFile(everyPlacement("x"), { nodes: (nodes) => (lists.push(nodes.map((n) => n.id)), nodes.filter((n) => n.id !== "deep")) });
    expect(lists).toEqual([["a", "i"], ["n", "deep"]]);
    expect(out.nodes[1].overrides![3].addNodes!.map((n) => n.id)).toEqual(["n"]);
  });
});

describe("scene format 1 → 2 (ADR 0118) through the walk", () => {
  it("pins part references to model space in added components and added nodes too", () => {
    const v1: SceneFile = {
      format: "myco.scene@1",
      nodes: [
        {
          id: "car",
          prefab: "car.prefab.json",
          overrides: [
            { component: "engine.MeshRenderer", field: "mesh", value: "asset:car.glb#Body" },
            { addComponent: { type: "engine.MeshCollider", data: { mesh: "asset:car.glb#Hull" } } },
            { addNodes: [{ id: "wheel", components: [{ type: "engine.MeshRenderer", data: { mesh: "asset:car.glb#Wheel" } }] }] },
          ],
        },
        { id: "rock", components: [{ type: "engine.MeshRenderer", data: { mesh: "asset:rock.obj#Rock" } }] },
      ],
    };
    const out = migrateSceneFile(v1);
    const [body, hull, wheel] = out.nodes[0].overrides!;
    expect(body.value).toBe("asset:car.glb#Body#model");
    expect(hull.addComponent!.data!.mesh).toBe("asset:car.glb#Hull#model");
    expect(wheel.addNodes![0].components![0].data!.mesh).toBe("asset:car.glb#Wheel#model");
    expect(out.nodes[1].components![0].data!.mesh).toBe("asset:rock.obj#Rock"); // OBJ parts are the same in both spaces
  });
});
