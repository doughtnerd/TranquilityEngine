// ADR 0162 D2b / L-D2ba: the AudioOccluder component (§1.5, R15) and the nearest-occluder rule.
import { beforeEach, describe, expect, it } from "vitest";
import { getFields } from "../../../engine/core/registry";
import { Assets, Engine, GameObject, SceneManager } from "../../../myco";
import { AudioOccluder, nearestOccluder } from "./AudioOccluder";

beforeEach(async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  await Engine.create({ headless: true });
  await SceneManager.load("s.json");
});

describe("AudioOccluder fields", () => {
  it("has the four §1.5 fields with defaults and descriptions", () => {
    const fields = getFields(AudioOccluder);
    expect(fields.map((f) => f.name)).toEqual(["material", "transmissionTrimDb", "cutoffScale", "openness"]);
    for (const f of fields) expect(JSON.stringify(f), f.name).toMatch(/"description":"\S/);
    const o = GameObject.create("w").addBehavior(AudioOccluder);
    expect([o.material, o.transmissionTrimDb, o.cutoffScale, o.openness]).toEqual(["", 0, 1, 0]);
  });
});

describe("nearestOccluder", () => {
  it("finds the occluder on the node, else the nearest up the parent chain, else null", () => {
    const root = GameObject.create("root");
    const mid = GameObject.create("mid");
    const leaf = GameObject.create("leaf");
    mid.setParent(root);
    leaf.setParent(mid);
    expect(nearestOccluder(leaf)).toBeNull();
    const rootO = root.addBehavior(AudioOccluder, { material: "glass" });
    expect(nearestOccluder(leaf)).toBe(rootO);
    const midO = mid.addBehavior(AudioOccluder, { material: "wood" });
    expect(nearestOccluder(leaf)).toBe(midO);
    expect(nearestOccluder(root)).toBe(rootO);
    const leafO = leaf.addBehavior(AudioOccluder);
    expect(nearestOccluder(leaf)).toBe(leafO);
  });

  it("skips a disabled occluder", () => {
    const parent = GameObject.create("p");
    const child = GameObject.create("c");
    child.setParent(parent);
    const up = parent.addBehavior(AudioOccluder);
    const own = child.addBehavior(AudioOccluder);
    own.enabled = false;
    expect(nearestOccluder(child)).toBe(up);
  });
});
