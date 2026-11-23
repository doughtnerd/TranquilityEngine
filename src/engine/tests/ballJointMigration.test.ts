// Scene format 4 → 5 (ADR 0375): a BallJoint's scalar `swingLimit` loads as `swing: { y, z }`, through the scene loader.
import { describe, expect, it } from "vitest";
import { Assets, BallJoint, Engine, SceneManager } from "../../myco";
import { CURRENT_FORMAT_VERSION, migrateSceneFile, type SceneFile } from "../scene/SceneLoader";
import { GameObject } from "../scene/GameObject";

const V4 = "myco.scene@4";

const scene = (): SceneFile =>
  ({
    format: V4,
    settings: { physics: "3d" },
    nodes: [
      { id: "plain", name: "Plain", components: [{ type: "engine.BallJoint", data: { useLimits: true, swingLimit: 30, twistLimits: { min: -10, max: 10 } } }] },
      { id: "kept", name: "Kept", components: [{ type: "engine.BallJoint", data: { swingLimit: 30, swing: { y: 5, z: 6 } } }] },
      { id: "bad", name: "Bad", components: [{ type: "engine.BallJoint", data: { swingLimit: "wide" } }] },
      { id: "inst", name: "Inst", prefab: "ball.prefab.json", overrides: [{ component: "engine.BallJoint", field: "swingLimit", value: 12 }, { addNodes: [{ id: "extra", name: "Extra", components: [{ type: "engine.BallJoint", data: { swingLimit: 50 } }] }] }] },
      { id: "other", name: "Other", components: [{ type: "engine.HingeJoint", data: { swingLimit: 99 } }] },
    ],
  }) as unknown as SceneFile;

const prefab = {
  format: V4,
  nodes: [{ id: "root", name: "Ball", components: [{ type: "engine.BallJoint", data: { swingLimit: 25 } }] }],
};

describe("BallJoint swingLimit → swing (format 5)", () => {
  it("rewrites every place a component's field sits and nothing else", () => {
    const out = migrateSceneFile(scene());
    expect(out.format).toBe(`myco.scene@${CURRENT_FORMAT_VERSION}`);
    const data = (id: string, i = 0) => out.nodes.find((n) => n.id === id)!.components![i]!.data!;
    expect(data("plain")).toEqual({ useLimits: true, swing: { y: 30, z: 30 }, twistLimits: { min: -10, max: 10 } });
    expect(data("kept")).toEqual({ swing: { y: 5, z: 6 } }); // an existing swing wins
    expect(data("bad")).toEqual({}); // not a number: the default
    expect(data("other")).toEqual({ swingLimit: 99 }); // other components keep their fields
    const inst = out.nodes.find((n) => n.id === "inst")!;
    expect(inst.overrides![0]).toEqual({ component: "engine.BallJoint", field: "swing", value: { y: 12, z: 12 } });
    expect(inst.overrides![1]!.addNodes![0]!.components![0]!.data).toEqual({ swing: { y: 50, z: 50 } });
  });

  it("leaves a file already at the current format alone", () => {
    const file = { format: `myco.scene@${CURRENT_FORMAT_VERSION}`, nodes: [{ id: "a", components: [{ type: "engine.BallJoint", data: { swing: { y: 1, z: 2 } } }] }] } as unknown as SceneFile;
    expect(migrateSceneFile(file).nodes).toEqual(file.nodes);
  });

  it("loads a saved version 4 scene and prefab with the cone the scalar meant", async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { ...scene(), nodes: scene().nodes.filter((n) => n.id !== "other") }, "ball.prefab.json": prefab }));
    await Engine.create({ headless: true, project: { physics: { gravity: [0, -10] as [number, number], layers: ["Default"] } } });
    await SceneManager.load("s.json");
    const joint = (name: string) => GameObject.findObjectsOfType(BallJoint).find((j) => j.node.name === name)!;
    expect(joint("Plain").swing).toEqual({ y: 30, z: 30 });
    expect(joint("Plain").twistLimits).toEqual({ min: -10, max: 10 });
    expect(joint("Kept").swing).toEqual({ y: 5, z: 6 });
    expect(joint("Bad").swing).toEqual({ y: 45, z: 45 });
    expect(joint("Inst").swing).toEqual({ y: 12, z: 12 }); // the instance's override of the prefab's 25
    expect(joint("Extra").swing).toEqual({ y: 50, z: 50 });
  });

  it("migrates a prefab file the same way (not only scenes)", () => {
    const out = migrateSceneFile(structuredClone(prefab) as unknown as SceneFile);
    expect(out.nodes[0]!.components![0]!.data).toEqual({ swing: { y: 25, z: 25 } });
  });
});
