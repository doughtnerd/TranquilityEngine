// ADR 0090: models baked for game builds load without a model loader, as the same meshes.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../index";
import { BAKED_SUFFIX, decodeBakedModel, isBakedModel } from "../scene/bakedModel";
import { defaultImportSettings } from "../scene/importSettings";
import { bakeModelFile, clearModelCache, loadMeshes } from "../scene/models";

const sample = (p: string) => readFileSync(new URL(`../../../samples/playground3d/${p}`, import.meta.url));
const dataUrl = (bytes: Uint8Array | Buffer) => `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

function use(files: Record<string, unknown>) {
  clearModelCache();
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(files));
}

const OBJ = "mtllib quad.mtl\no Quad\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nusemtl Painted\nf 1/1 2/2 3/3 4/4\n";
const MTL = "newmtl Painted\nKd 1 0.5 0\nmap_Kd textures/paint.png\n";

describe("baked models (ADR 0090)", () => {
  afterEach(() => {
    clearModelCache();
    Assets.clearSources();
    vi.restoreAllMocks();
  });

  it("round-trips a glTF's meshes, node paths, groups and surfaces", async () => {
    use({ "models/lamp.glb": dataUrl(sample("models/lamp.glb")) });
    const { bytes, dropped } = await bakeModelFile("models/lamp.glb");
    expect(dropped).toEqual([]);
    expect(isBakedModel(bytes.buffer as ArrayBuffer)).toBe(true);
    const original = await loadMeshes("asset:models/lamp.glb");
    const baked = decodeBakedModel(bytes.buffer as ArrayBuffer, defaultImportSettings(), (p) => p)!;
    expect(baked.meshes.map((m) => m.name)).toEqual(original.map((m) => m.name));
    for (const [i, m] of baked.meshes.entries()) {
      const o = original[i];
      expect(m.path).toEqual(o.path);
      expect(Array.from(m.data.positions)).toEqual(Array.from(o.data.positions));
      expect(Array.from(m.data.indices)).toEqual(Array.from(o.data.indices));
      expect(m.data.groups).toEqual(o.data.groups);
      expect(m.surfaces.map((s) => s.name)).toEqual(o.surfaces.map((s) => s.name));
      expect(m.geometry.boundingBox!.max.toArray()).toEqual(o.geometry.boundingBox!.max.toArray());
    }
    expect(baked.meshes[2].surfaces[0].emissive).toEqual(original[2].surfaces[0].emissive);
    // The shared Metal material stays one surface (one slot, ADR 0089).
    expect(baked.meshes[0].surfaces[1]).toBe(baked.meshes[1].surfaces[0]);
  });

  it("keeps project textures by path, even headless", async () => {
    use({ "models/quad.obj": dataUrl(Buffer.from(OBJ)), "models/quad.mtl": dataUrl(Buffer.from(MTL)), "models/textures/paint.png": `data:image/png;base64,${PNG}` });
    const { bytes, dropped } = await bakeModelFile("models/quad.obj");
    expect(dropped).toEqual([]);
    const baked = decodeBakedModel(bytes.buffer as ArrayBuffer, defaultImportSettings(), (p) => `url:${p}`)!;
    expect(baked.meshes[0].surfaces[0].map).toMatchObject({ path: "models/textures/paint.png", src: "url:models/textures/paint.png" });
  });

  it("is what loading uses when it's beside the model, unless it was baked with other import settings", async () => {
    use({ "models/lamp.glb": dataUrl(sample("models/lamp.glb")) });
    const { bytes } = await bakeModelFile("models/lamp.glb");
    // The baked file alone (the model file is garbage): loading must not touch the loader.
    use({ "models/lamp.glb": dataUrl(Buffer.from("not a model")), [`models/lamp.glb${BAKED_SUFFIX}`]: dataUrl(bytes) });
    expect((await loadMeshes("asset:models/lamp.glb")).map((m) => m.name)).toEqual(["Base", "Pole", "Bulb", "Shade"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    use({ "models/lamp.glb": dataUrl(sample("models/lamp.glb")), [`models/lamp.glb${BAKED_SUFFIX}`]: dataUrl(bytes), "models/lamp.glb.meta.json": { format: "myco.import@1", scale: 2 } });
    const [base] = await loadMeshes("asset:models/lamp.glb#Base");
    expect(base.geometry.boundingBox!.max.y).toBeCloseTo(0.6); // 0.3 × 2: loaded from the .glb with the new scale
    expect(warn.mock.calls.flat().join("\n")).toMatch(/baked with other import settings/);
  });
});
