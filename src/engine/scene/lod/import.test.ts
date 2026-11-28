// ADR 0459 §1: the sidecar's `lod` and `occluder`, model loading with and without a generation host (the editor and a
// game), and `.mycomesh` version 5, driven through the sidecar parser, `loadMeshes`, `bakeModelFile` and
// `decodeBakedModel`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../Assets";
import { decodeBakedModel } from "../bakedModel";
import { defaultImportSettings, formatImportSettings, parseImportSettings, type ImportSettings } from "../importSettings";
import { bakeModelFile, loadMeshes, type ModelMesh } from "../models";
import { DEFAULT_LOD_SETTINGS } from "./types";
import { memoryLodCache, setLodHost } from "./cache";
import { generateLods } from "./generate";

describe("the sidecar's lod and occluder (ADR 0459 §1, 0460 §3)", () => {
  it("defaults to no levels and an automatic occluder, and an old sidecar writes back unchanged", () => {
    expect(defaultImportSettings().lod).toBeNull();
    expect(defaultImportSettings().occluder).toBe("auto");
    const raw = { format: "myco.import@1", scale: 2 };
    const { settings, problems } = parseImportSettings(raw, "rock.glb.meta.json");
    expect(problems).toEqual([]);
    expect(settings.lod).toBeNull();
    expect(settings.occluder).toBe("auto");
    expect(JSON.parse(formatImportSettings(settings))).toEqual(raw);
    expect(parseImportSettings({ format: "myco.import@1", lod: null }).settings.lod).toBeNull();
  });

  it("round-trips every key, writing lod whole and occluder only when not auto", () => {
    const lod = { levels: [{ ratio: 0.4, error: 0.02 }, { ratio: 0.1, error: 0.05 }], attributes: false, permissive: true, lockBorders: true, pixelError: 2.5 };
    for (const occluder of ["auto", "lod", "none"] as const) {
      const raw = { format: "myco.import@1", lod, ...(occluder !== "auto" ? { occluder } : {}) };
      const { settings, problems } = parseImportSettings(raw, "rock.glb.meta.json");
      expect(problems).toEqual([]);
      expect(settings.lod).toEqual(lod);
      expect(settings.occluder).toBe(occluder);
      expect(JSON.parse(formatImportSettings(settings))).toEqual(raw);
      expect(parseImportSettings(JSON.parse(formatImportSettings(settings))).settings).toEqual(settings);
    }
    // The import panel's switch writes the defaults.
    const defaults = { ...defaultImportSettings(), lod: DEFAULT_LOD_SETTINGS };
    expect(JSON.parse(formatImportSettings(defaults)).lod).toEqual(DEFAULT_LOD_SETTINGS);
  });

  it("fills missing keys from the defaults and reports bad ones", () => {
    const { settings, problems } = parseImportSettings(
      { format: "myco.import@1", lod: { levels: [{ ratio: 0.5, error: 0.01 }, { ratio: 1.5, error: 0.01 }, { ratio: 0.3, error: -1 }, { ratio: 0.6, error: 0.02 }, { ratio: 0.2, error: 0.03 }], permissive: "yes", pixelError: 0 }, occluder: "sloppy" },
      "r.meta.json",
    );
    expect(settings.lod).toEqual({ ...DEFAULT_LOD_SETTINGS, levels: [{ ratio: 0.5, error: 0.01 }, { ratio: 0.2, error: 0.03 }] });
    expect(settings.occluder).toBe("auto");
    expect(problems).toEqual([
      "r.meta.json: lod.levels[1].ratio should be a number between 0 and 1; level dropped.",
      "r.meta.json: lod.levels[2].error should be a number ≥ 0 (a fraction of the bounding-box diagonal); level dropped.",
      "r.meta.json: lod.levels[3].ratio should be below the level before it (0.5); level dropped.",
      "r.meta.json: lod.permissive should be true or false; using false.",
      "r.meta.json: lod.pixelError should be a number of pixels > 0; using 1.",
      'r.meta.json: "occluder" should be "auto", "lod" or "none"; using the default.',
    ]);
    expect(parseImportSettings({ format: "myco.import@1", lod: { pixelError: 3 } }).settings.lod).toEqual({ ...DEFAULT_LOD_SETTINGS, pixelError: 3 });
    const notObject = parseImportSettings({ format: "myco.import@1", lod: true }, "r.meta.json");
    expect(notObject.settings.lod).toBeNull();
    expect(notObject.problems).toHaveLength(1);
  });
});

// --- Model loading and .mycomesh v5 ------------------------------------------------------------------------------

/** A bumpy sphere as an OBJ (latitude-longitude grid, normals and UVs; the loader de-indexes it, so it must be welded). */
function bumpyObj(rows = 40, columns = 64): string {
  const lines = ["o Rock"];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= columns; c++) {
      const theta = (r / rows) * Math.PI, phi = (c / columns) * 2 * Math.PI;
      const k = 1 + 0.08 * Math.sin(5 * theta) * Math.cos(3 * phi) + 0.04 * Math.sin(11 * phi + theta);
      const x = Math.sin(theta) * Math.cos(phi), y = Math.cos(theta), z = Math.sin(theta) * Math.sin(phi);
      lines.push(`v ${(x * k).toFixed(5)} ${(y * k).toFixed(5)} ${(z * k).toFixed(5)}`, `vn ${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)}`, `vt ${(c / columns).toFixed(5)} ${(1 - r / rows).toFixed(5)}`);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const i = r * (columns + 1) + c + 1;
      const [a, b, d, e] = [i, i + 1, i + columns + 1, i + columns + 2];
      const f = (...v: number[]) => `f ${v.map((x) => `${x}/${x}/${x}`).join(" ")}`;
      if (r > 0) lines.push(f(a, d, b));
      if (r < rows - 1) lines.push(f(b, d, e));
    }
  }
  return `${lines.join("\n")}\n`;
}

const OBJ_URL = `data:text/plain;base64,${Buffer.from(bumpyObj()).toString("base64")}`;
const SIDECAR = { format: "myco.import@1", lod: DEFAULT_LOD_SETTINGS };

/** A baked file with its JSON changed by `edit` (re-padded to 4 bytes; the binary data, its offsets relative to the JSON's end, kept). */
function withJson(bytes: Uint8Array, edit: (json: Record<string, unknown> & { meshes: unknown[] }) => void): Uint8Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + length)));
  edit(json);
  const text = new TextEncoder().encode(JSON.stringify(json));
  const padded = Math.ceil(text.length / 4) * 4;
  const out = new Uint8Array(16 + padded + (bytes.length - 16 - length)).fill(0x20, 16, 16 + padded);
  out.set(bytes.subarray(0, 12));
  new DataView(out.buffer).setUint32(12, padded, true);
  out.set(text, 16);
  out.set(bytes.subarray(16 + length), 16 + padded);
  return out;
}

function use(files: Record<string, unknown>): void {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(files));
}

const settingsWithLod = (): ImportSettings => ({ ...defaultImportSettings(), lod: DEFAULT_LOD_SETTINGS });

/** The level meshes share LOD0's vertex arrays and have their own indices. */
function expectShared(mesh: ModelMesh): void {
  const lods = mesh.lods!;
  expect(lods.levels[0].mesh).toBe(mesh);
  for (const level of lods.levels.slice(1)) {
    expect(level.mesh.data.positions).toBe(mesh.data.positions);
    expect(level.mesh.data.normals).toBe(mesh.data.normals);
    expect(level.mesh.data.uvs).toBe(mesh.data.uvs);
    expect(level.mesh.surfaces).toBe(mesh.surfaces);
    expect(level.mesh.data.indices.length).toBe(level.triangles * 3);
    expect(level.mesh.lods).toBeUndefined();
  }
}

describe("models with generated levels", () => {
  afterEach(() => {
    setLodHost(null);
    Assets.clearSources();
    vi.restoreAllMocks();
  });

  it("load without levels and say so once where nothing generates them (a game)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    use({ "models/game-rock.obj": OBJ_URL, "models/game-rock.obj.meta.json": SIDECAR });
    const [mesh] = await loadMeshes("asset:models/game-rock.obj");
    expect(mesh.lods).toBeUndefined();
    expect(warn.mock.calls.flat().filter((m) => /game-rock\.obj asks for LOD levels/.test(String(m)))).toHaveLength(1);
  });

  it("get their levels through the editor's host, LOD0 welded and every level sharing its vertices", async () => {
    const generate = vi.fn(generateLods);
    setLodHost({ generate, cache: memoryLodCache() });
    use({ "models/editor-rock.obj": OBJ_URL, "models/editor-rock.obj.meta.json": SIDECAR });
    const [mesh] = await loadMeshes("asset:models/editor-rock.obj");
    const lods = mesh.lods!;
    expect(generate).toHaveBeenCalledTimes(1);
    expect(lods.levels).toHaveLength(4);
    expect(lods.pixelError).toBe(1);
    expect(lods.levels[0].triangles).toBe(64 * 2 * 39);
    expect(mesh.data.positions.length / 3).toBeLessThan(lods.levels[0].triangles * 3); // welded (the OBJ loader de-indexes)
    expect(lods.levels[1].triangles).toBeLessThan(lods.levels[0].triangles * 0.6);
    expect(lods.occluder!.indices.length).toBeLessThanOrEqual(lods.levels[3].mesh.data.indices.length);
    expect(lods.occluder!.triangleErrors.length).toBe(lods.occluder!.indices.length / 3);
    expect(lods.occluder!.neighbors.length).toBe(lods.occluder!.indices.length);
    expectShared(mesh);
  }, 60_000);

  it("bake into .mycomesh version 5 and decode to the same levels, re-baked when the lod settings change", async () => {
    use({ "models/baked-rock.obj": OBJ_URL, "models/baked-rock.obj.meta.json": SIDECAR });
    setLodHost({ generate: generateLods, cache: memoryLodCache() });
    const [loaded] = await loadMeshes("asset:models/baked-rock.obj");
    setLodHost(null); // the export bakes inline without the editor's host
    const { bytes } = await bakeModelFile("models/baked-rock.obj");
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true)).toBe(5);
    const decoded = decodeBakedModel(bytes.slice().buffer, settingsWithLod(), (p) => p)!;
    const [mesh] = decoded.meshes;
    expectShared(mesh);
    expect(Array.from(mesh.data.positions)).toEqual(Array.from(loaded.data.positions));
    expect(Array.from(mesh.data.indices)).toEqual(Array.from(loaded.data.indices));
    const want = loaded.lods!, got = mesh.lods!;
    expect(got.bounds).toEqual(want.bounds);
    expect(got.pixelError).toBe(want.pixelError);
    expect(got.levels.map((l) => [l.error, l.triangles, Array.from(l.mesh.data.indices), l.mesh.data.groups])).toEqual(want.levels.map((l) => [l.error, l.triangles, Array.from(l.mesh.data.indices), l.mesh.data.groups]));
    expect(got.occluder!.error).toBe(want.occluder!.error);
    expect(got.occluder!.indices).toBeInstanceOf(Uint32Array);
    expect(Array.from(got.occluder!.indices)).toEqual(Array.from(want.occluder!.indices));
    expect(want.occluder!.triangleErrors.length).toBeGreaterThan(0);
    expect(got.occluder!.triangleErrors).toBeInstanceOf(Float32Array);
    expect(Array.from(got.occluder!.triangleErrors)).toEqual(Array.from(want.occluder!.triangleErrors));
    expect(got.occluder!.neighbors).toBeInstanceOf(Uint32Array);
    expect(Array.from(got.occluder!.neighbors)).toEqual(Array.from(want.occluder!.neighbors));
    // Other lod or occluder settings: the caller loads the model file instead.
    expect(decodeBakedModel(bytes.slice().buffer, defaultImportSettings(), (p) => p)).toBeNull();
    expect(decodeBakedModel(bytes.slice().buffer, { ...settingsWithLod(), occluder: "none" }, (p) => p)).toBeNull();
    expect(decodeBakedModel(bytes.slice().buffer, { ...settingsWithLod(), lod: { ...DEFAULT_LOD_SETTINGS, pixelError: 2 } }, (p) => p)).toBeNull();
    // Without lod, the occluder setting doesn't matter, and the file has no levels.
    use({ "models/plain-rock.obj": OBJ_URL });
    const plain = await bakeModelFile("models/plain-rock.obj");
    const plainMesh = decodeBakedModel(plain.bytes.slice().buffer, { ...defaultImportSettings(), occluder: "none" }, (p) => p)!.meshes[0];
    expect(plainMesh.lods).toBeUndefined();
  }, 60_000);

  it("load a version 5 stand-in baked without its per-triangle arrays (before hole trimming) as no occluder", async () => {
    use({ "models/untrimmed-rock.obj": OBJ_URL, "models/untrimmed-rock.obj.meta.json": SIDECAR });
    const { bytes } = await bakeModelFile("models/untrimmed-rock.obj");
    const old = withJson(bytes, (json) => {
      for (const m of json.meshes as { occluder?: Record<string, unknown> }[]) {
        expect(m.occluder?.triangleErrors).toBeDefined();
        delete m.occluder!.triangleErrors;
        delete m.occluder!.neighbors;
      }
    });
    const [mesh] = decodeBakedModel(old.buffer, settingsWithLod(), (p) => p)!.meshes;
    expect(mesh.lods!.levels).toHaveLength(4);
    expect(mesh.lods!.occluder).toBeNull();
    expect(decodeBakedModel(bytes.slice().buffer, settingsWithLod(), (p) => p)!.meshes[0].lods!.occluder).not.toBeNull();
  }, 60_000);

  it("refuse a version 4 file", async () => {
    use({ "models/old-rock.obj": OBJ_URL });
    const { bytes } = await bakeModelFile("models/old-rock.obj");
    const old = bytes.slice();
    new DataView(old.buffer).setUint32(8, 4, true);
    expect(() => decodeBakedModel(old.buffer, defaultImportSettings(), (p) => p)).toThrow(/version 4; this engine reads 5/);
  });

  it("load a game's baked levels without generating anything", async () => {
    use({ "models/shipped-rock.obj": OBJ_URL, "models/shipped-rock.obj.meta.json": SIDECAR });
    const { bytes } = await bakeModelFile("models/shipped-rock.obj");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The baked file alone (the model file is garbage) and no host: the levels come from the file.
    use({ "models/shipped-rock.obj": "data:text/plain;base64,", "models/shipped-rock.obj.mycomesh": `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`, "models/shipped-rock.obj.meta.json": SIDECAR });
    const [mesh] = await loadMeshes("asset:models/shipped-rock.obj");
    expect(mesh.lods!.levels).toHaveLength(4);
    expectShared(mesh);
    expect(warn).not.toHaveBeenCalled();
  }, 60_000);
});
