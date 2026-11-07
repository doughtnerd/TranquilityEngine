// ADR 0075 stage 6: reflection probes on the Babylon backend, headless on Babylon's NullEngine.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Engine, GameObject, Graphics, ReflectionProbe, SceneManager, Vector3 } from "../index";
import { BabylonProbes } from "../render/babylon/probes";

describe("reflection probes on the Babylon backend (ADR 0075 stage 6)", () => {
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
    Graphics.quality = "High"; // probes on
  });

  afterEach(() => {
    Graphics.quality = Graphics.defaultQuality;
    probes.dispose();
    scene.dispose();
    babylon.dispose();
    engine.dispose();
  });

  const probe = (pos: [number, number, number], size: [number, number, number], props: Record<string, unknown> = {}) => {
    const n = GameObject.create("probe");
    n.transform!.position.set(...pos);
    return n.addBehavior(ReflectionProbe, { size: new Vector3(...size), ...props });
  };
  const sync = (ready = true) => {
    engine.step(1 / 60);
    probes.sync(World.require(), [], ready);
  };

  it("captures once the scene is ready, and then reflects into the smallest box holding a point", () => {
    probe([0, 0, 0], [20, 20, 20]);
    probe([2, 0, 0], [4, 4, 4]);
    sync(false);
    expect(probes.state(0).captured).toBe(0); // not before the scene has loaded
    expect(probes.lookup(0, 0, 0)).toBeNull();
    sync(true);
    expect(probes.state(0)).toMatchObject({ captured: 2, probes: 2 });
    const small = probes.lookup(2, 0, 0);
    const big = probes.lookup(-8, 0, 0);
    expect(small).not.toBeNull();
    expect(big).not.toBeNull();
    expect(small!.texture).not.toBe(big!.texture);
    expect(probes.lookup(50, 0, 0)).toBeNull(); // outside every box
  });

  it("uses the probe's intensity, and drops probes when the tier turns them off", () => {
    probe([0, 0, 0], [10, 10, 10], { intensity: 0.5 });
    sync();
    expect(probes.lookup(0, 0, 0)!.intensity).toBe(0.5);
    const off = Graphics.tiers.find((name) => {
      Graphics.quality = name;
      return Graphics.tier.reflectionProbes === "off";
    });
    if (!off) return;
    sync();
    expect(probes.lookup(0, 0, 0)).toBeNull();
  });

  it("box-projects a probe's map when asked, and stops when not (ADR 0110)", () => {
    const p = probe([1, 2, 3], [4, 5, 6], { boxProjection: true });
    sync();
    const tex = probes.lookup(1, 2, 3)!.texture as unknown as { boundingBoxSize: { x: number; y: number; z: number } | null; boundingBoxPosition: { x: number; y: number; z: number } };
    expect(tex.boundingBoxSize).toMatchObject({ x: 4, y: 5, z: 6 });
    expect(tex.boundingBoxPosition).toMatchObject({ x: 1, y: 2, z: 3 });
    p.boxProjection = false;
    sync();
    expect(tex.boundingBoxSize).toBeFalsy();
  });

  it("names a neighbour to blend towards near a box's faces (ADR 0110)", () => {
    probe([0, 0, 0], [20, 20, 20]);
    probe([0, 0, 0], [4, 4, 4], { blendDistance: 1, intensity: 2 });
    sync();
    expect(probes.lookup(0, 0, 0)!.blend).toBeNull();
    const hit = probes.lookup(1.5, 0, 0)!;
    expect(hit.intensity).toBe(2);
    expect(hit.blend).toMatchObject({ weight: 0.5, intensity: 1, box: null });
  });

  it("gives the warm-up every probe, plus a blended hit for each probe that can blend (ADR 0080, 0110)", () => {
    probe([0, 0, 0], [20, 20, 20], { blendDistance: 1 }); // the biggest: nothing bigger to blend towards
    probe([0, 0, 0], [4, 4, 4], { blendDistance: 1 }); // inside the big one: blends towards it
    probe([50, 0, 0], [4, 4, 4], { blendDistance: 1 }); // alone: nothing to blend towards
    sync();
    const hits = probes.warmHits();
    expect(hits.filter((h) => !h.blend)).toHaveLength(3);
    const blended = hits.filter((h) => h.blend);
    expect(blended).toHaveLength(1);
    expect(blended[0]!.texture).toBe(probes.lookup(1.5, 0, 0)!.texture);
    expect(blended[0]!.blend!.texture).toBe(probes.lookup(1.5, 0, 0)!.blend!.texture); // the neighbour a mesh there blends towards
    expect(blended[0]!.blend!.weight).toBeGreaterThan(0);
    expect(blended[0]!.blend!.weight).toBeLessThan(1); // so the copy defines MYCO_PROBE_BLEND
  });

  it("uses a baked map instead of capturing, and captures when it isn't in the project (ADR 0110)", () => {
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: string) => warnings.push(m);
    try {
      probe([0, 0, 0], [10, 10, 10], { refresh: "baked", bakedMap: "probes/missing.env" });
      sync();
      expect(warnings.some((w) => w.includes("missing.env"))).toBe(true);
      expect(probes.state(0).captured).toBe(1); // captured instead
    } finally {
      console.warn = warn;
    }
  });

  it("forgets a probe whose component is gone", () => {
    const p = probe([0, 0, 0], [10, 10, 10]);
    sync();
    expect(probes.state(0).probes).toBe(1);
    GameObject.destroy(p.node);
    sync();
    expect(probes.state(0).probes).toBe(0);
  });
});
