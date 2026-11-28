// ADR 0446 §2: placing a model whose meshes have generated levels adds an automatic LODGroup on its root, through the
// model kind's `addToScene` templates (the add's single undoable step builds nodes from them). Models without levels get none.
import { afterEach, describe, expect, it } from "vitest";
import { Assets } from "../../../engine/index";
import { memoryLodCache, setLodHost } from "../../../engine/scene/lod/cache";
import { generateLods } from "../../../engine/scene/lod/generate";
import { DEFAULT_LOD_SETTINGS } from "../../../engine/scene/lod/types";
import { loadModel } from "../../../engine/scene/models";
import { modelNodeTemplates } from "./modelNodes";

/** A bumpy latitude-longitude sphere as an OBJ. */
function sphereObj(name: string, rows = 24, columns = 32): string {
  const lines = [`o ${name}`];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= columns; c++) {
      const t = (r / rows) * Math.PI, p = (c / columns) * 2 * Math.PI;
      const k = 1 + 0.08 * Math.sin(5 * t) * Math.cos(3 * p);
      lines.push(`v ${(Math.sin(t) * Math.cos(p) * k).toFixed(5)} ${(Math.cos(t) * k).toFixed(5)} ${(Math.sin(t) * Math.sin(p) * k).toFixed(5)}`);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const i = r * (columns + 1) + c + 1;
      if (r > 0) lines.push(`f ${i} ${i + columns + 1} ${i + 1}`);
      if (r < rows - 1) lines.push(`f ${i + 1} ${i + columns + 1} ${i + columns + 2}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const url = (text: string) => `data:text/plain;base64,${Buffer.from(text).toString("base64")}`;
const types = (path: string) => modelNodeTemplates(path)[0].components!.map((c) => c.type);

describe("placing a model with LOD levels", () => {
  afterEach(() => {
    setLodHost(null);
    Assets.clearSources();
  });

  it("adds an automatic LODGroup on the root when the meshes have levels", async () => {
    setLodHost({ generate: generateLods, cache: memoryLodCache() });
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "models/rock.obj": url(sphereObj("Rock")), "models/rock.obj.meta.json": { format: "myco.import@1", lod: DEFAULT_LOD_SETTINGS } }));
    await loadModel("models/rock.obj");
    const root = modelNodeTemplates("models/rock.obj", [1, 2, 3])[0];
    expect(root.components!.map((c) => c.type)).toEqual(["engine.Transform", "engine.MeshRenderer", "engine.LODGroup"]);
    expect(root.components!.find((c) => c.type === "engine.Transform")!.data).toEqual({ position: [1, 2, 3] });
    expect(root.components!.find((c) => c.type === "engine.LODGroup")!.data).toEqual({});
  }, 60_000);

  it("adds none for a model without levels, or one that hasn't loaded", async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "models/plain.obj": url(sphereObj("Plain")), "models/unloaded.obj": url(sphereObj("U")) }));
    await loadModel("models/plain.obj");
    expect(types("models/plain.obj")).toEqual(["engine.Transform", "engine.MeshRenderer"]);
    expect(types("models/unloaded.obj")).toEqual(["engine.Transform", "engine.MeshRenderer"]);
  });
});
