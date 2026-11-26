// ADR 0415: 2D light volumes, the meshes and the renderer-neutral volume batches against a fake quad-batch host.
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Color, Engine, GameObject, Light2D, SceneManager, Vector2 } from "../../../myco";
import type { QuadBatch, QuadBatchHost } from "../../../engine/render/quadBatches";
import { pointAttenuation } from "../../../engine/render/lights2D/lightShapes";
import { Lights2DVolumes } from "./volumeRenderer";
import { spriteVolume, volumeLayer, volumeMesh, type VolumeLight } from "./volumes";

const POINT: VolumeLight = {
  type: "point",
  color: { r: 1, g: 0.5, b: 0.25 },
  intensity: 2,
  volumeIntensity: 0.25,
  innerRadius: 0,
  outerRadius: 4,
  innerAngle: 360,
  outerAngle: 360,
  falloff: 0.5,
  shape: [],
  falloffSize: 0.5,
};

describe("light volume meshes", () => {
  it("sample a point light's falloff on a polar grid, at intensity × volumeIntensity", () => {
    const m = volumeMesh(POINT)!;
    expect(Array.from(m.colors.slice(0, 4))).toEqual([1, 0.5, 0.25, 0.5]); // the centre: full brightness, 2 × 0.25
    for (let v = 0; v < m.positions.length / 3; v++) {
      const x = m.positions[v * 3]!, y = m.positions[v * 3 + 1]!;
      expect(m.colors[v * 4 + 3]).toBeCloseTo(pointAttenuation(POINT, x, y) * 0.5, 5);
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(4 + 1e-5);
    }
    expect(Math.max(...m.indices)).toBe(m.positions.length / 3 - 1);
  });

  it("cover only a spot light's cone, both edges included", () => {
    const m = volumeMesh({ ...POINT, outerAngle: 90, innerAngle: 45 })!;
    for (let v = 1; v < m.positions.length / 3; v++) {
      const x = m.positions[v * 3]!, y = m.positions[v * 3 + 1]!;
      expect((Math.acos(y / Math.hypot(x, y)) * 180) / Math.PI).toBeLessThanOrEqual(45 + 1e-3); // within half the cone of +Y
    }
  });

  it("fill a freeform light's polygon and falloff band; none for a global light or with no volume", () => {
    const shape: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const m = volumeMesh({ ...POINT, type: "freeform", shape })!;
    expect(m.indices.length % 3).toBe(0);
    expect(Math.max(...Array.from(m.colors).filter((_, i) => i % 4 === 3))).toBeCloseTo(0.5);
    expect(volumeMesh({ ...POINT, type: "global" })).toBeNull();
    expect(volumeMesh({ ...POINT, volumeIntensity: 0 })).toBeNull();
    expect(spriteVolume({ ...POINT, volumeIntensity: 4 }, [-1, -1, 1, 1], [0, 0, 1, 1])!.colors[3]).toBe(1); // capped at full
  });

  it("draw at the top of the light's highest target layer (every layer: the last)", () => {
    expect(volumeLayer(["Back", "Default", "Front"], ["Default", "Back"])).toBe("Default");
    expect(volumeLayer(["Back", "Default", "Front"], [])).toBe("Front");
  });
});

function fakeQuads() {
  const batches: (QuadBatch & { positions: Float32Array | null; colors: Float32Array | null; texture: string; order: [string, number]; material: string | null; visible: boolean; disposed: boolean; matrix: number[]; blend: string })[] = [];
  const quads: QuadBatchHost = {
    createBatch() {
      const b: (typeof batches)[number] = {
        positions: null, colors: null, texture: "", order: ["", 0], material: null, visible: false, disposed: false, matrix: [], blend: "alpha",
        setMaterial(m) { b.material = m; },
        setBlend(m) { b.blend = m; },
        setQuads() {},
        setTriangles(t, p) { b.texture = t; b.positions = p; },
        setMask() {},
        setMatrix(x, o = 0) { b.matrix = Array.from(x).slice(o, o + 16); },
        setOrder(layer, inLayer) { b.order = [layer, inLayer]; },
        setTint() {},
        setVisible(v) { b.visible = v; },
        dispose() { b.disposed = true; },
      };
      batches.push(b);
      return b;
    },
    textureSize: () => [1, 1],
  };
  return { quads, batches };
}

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

async function headless(): Promise<Engine> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  const engine = await Engine.create({ headless: true, project: { render: { sortingLayers: ["Back", "Default", "Front"] } } });
  engines.push(engine);
  await SceneManager.load("s.json");
  return engine;
}

describe("light volume batches (ADR 0415)", () => {
  it("draw a volume light additively at its node, over its target layers, and follow its fields", async () => {
    const engine = await headless();
    const { quads, batches } = fakeQuads();
    let lit = true;
    const volumes = new Lights2DVolumes({ quads, lit: () => lit });
    const node = GameObject.create("torch");
    node.transform!.position.set(3, 1, 0);
    const l = Object.assign(node.addComponent(Light2D), { volumeIntensity: 0.5, targetSortingLayers: ["Default"], color: new Color(1, 0, 0, 1) });
    const plain = GameObject.create("plain").addComponent(Light2D); // no volume: no batch
    void plain;
    volumes.sync(engine.world);
    expect(batches).toHaveLength(1);
    const b = batches[0]!;
    expect(b).toMatchObject({ blend: "additive", visible: true, order: ["Default", 9999], material: null }); // unlit, on top of its highest target layer
    expect(b.matrix.slice(12, 14)).toEqual([3, 1]);
    const first = b.positions;
    volumes.sync(engine.world);
    expect(b.positions).toBe(first); // unchanged fields: not rebuilt
    l.outerRadius = 6;
    volumes.sync(engine.world);
    expect(b.positions).not.toBe(first);
    lit = false; // the scene view's 2D Lighting off
    volumes.sync(engine.world);
    expect(b.disposed).toBe(true);
    lit = true;
    volumes.sync(engine.world);
    l.type = "freeform";
    l.shape = [new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 1)];
    volumes.sync(engine.world);
    expect(batches[1]!.positions!.length).toBeGreaterThan(0);
    l.volumeIntensity = 0;
    volumes.sync(engine.world);
    expect(volumes.count()).toBe(0);
    expect(batches[1]!.disposed).toBe(true);
  });
});
