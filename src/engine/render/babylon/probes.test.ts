// ADR 0446 §3: each probe capture has a view of its own (selected by distance from the probe at its face resolution,
// nothing off-screen) and draws the render list chosen for it.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../../core/World";
import { Assets, Engine, GameObject, Graphics, ReflectionProbe, SceneManager, Vector3 } from "../../index";
import { PROBE_RESOLUTION } from "../probeBoxes";
import { BabylonProbes, probeView } from "./probes";

describe("probe captures' own selections (ADR 0446 §3)", () => {
  let engine: Engine;
  let babylon: NullEngine;
  let scene: Scene;
  let probes: BabylonProbes;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    babylon = new NullEngine();
    scene = new Scene(babylon);
    probes = new BabylonProbes(scene);
    Graphics.quality = "High";
  });
  afterEach(() => {
    Graphics.quality = Graphics.defaultQuality;
    probes.dispose();
    scene.dispose();
    babylon.dispose();
    engine.dispose();
  });

  it("lists this frame's captures with a probe view each, and captures each with the list chosen for it", () => {
    const n = GameObject.create("probe");
    n.transform!.position.set(1, 2, 3);
    n.addBehavior(ReflectionProbe, { size: new Vector3(4, 4, 4) });
    const sceneWide = [new Mesh("everything", scene)];
    engine.step(1 / 60);
    probes.sync(World.require(), sceneWide, true);
    const [capture, ...more] = probes.captures();
    expect(more).toEqual([]);
    expect(capture.position).toEqual([1, 2, 3]);
    expect(capture.resolution).toBe(PROBE_RESOLUTION[Graphics.tier.reflectionProbes]);
    const view = probeView(capture);
    expect(view).toMatchObject({ key: capture.key, kind: "probe", position: [1, 2, 3], heightPx: capture.resolution, persistent: false, occlusion: false, projection: "perspective" });
    expect(view.fovY).toBeCloseTo(Math.PI / 2);
    // Every point is inside every plane: a cube capture sees all round.
    for (let p = 0; p < 6; p++) expect(view.planes[p * 4] * 1e6 + view.planes[p * 4 + 1] * -1e6 + view.planes[p * 4 + 2] * 3 + view.planes[p * 4 + 3]).toBeGreaterThanOrEqual(0);
    const chosen = [new Mesh("level2", scene)];
    probes.capture(null, (key) => (key === capture.key ? chosen : null));
    expect(scene.reflectionProbes[0].renderList).toBe(chosen);
    // Without a list of its own, it captures what `sync` gave it.
    engine.step(1 / 60);
    probes.sync(World.require(), sceneWide, true);
    probes.capture(null, () => null);
    expect(scene.reflectionProbes[0].renderList).toBe(sceneWide);
  });
});
