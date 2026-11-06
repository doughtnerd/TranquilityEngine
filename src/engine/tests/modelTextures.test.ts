// A model's own textures (an OBJ's `.mtl` `map_Kd`) reach the renderer-neutral surfaces the Babylon
// backend draws from (ADR 0044, 0075 stage 7). The loaders hand textures back at once and decode
// their images later, so a model must wait for them before its surfaces are described; it didn't,
// and every model in the pirates sample drew white on Babylon (three.js reads the live texture).
import { readFileSync } from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../index";
import { surfaceMaterial } from "../render/babylon/materials";
import { clearModelCache, loadMeshes } from "../scene/models";

const file = (path: string) => readFileSync(new URL(`../../../samples/pirates/${path}`, import.meta.url));
const dataUrl = (path: string, type = "application/octet-stream") => `data:${type};base64,${file(path).toString("base64")}`;

/** A browser-like `document` whose images decode a few milliseconds after their `src` is set, as in a browser. */
function stubDocument(): void {
  const createElementNS = (_ns: string, name: string) => {
    if (name !== "img") throw new Error(`unexpected element ${name}`);
    const listeners = new Map<string, (this: unknown) => void>();
    const img = {
      currentSrc: "",
      width: 1,
      height: 1,
      addEventListener: (type: string, fn: (this: unknown) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
      set src(url: string) {
        setTimeout(() => {
          img.currentSrc = url;
          listeners.get("load")?.call(img);
        }, 5);
      },
    };
    return img;
  };
  vi.stubGlobal("document", { createElementNS });
}

describe("model textures (ADR 0044, 0075)", () => {
  beforeEach(() => {
    stubDocument();
    clearModelCache();
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "models/rock1.obj": dataUrl("models/rock1.obj"),
        "models/ship.obj": dataUrl("models/ship.obj"),
        "models/pirates.mtl": dataUrl("models/pirates.mtl"),
        "textures/rock.png": dataUrl("textures/rock.png", "image/png"),
        "textures/wood.png": dataUrl("textures/wood.png", "image/png"),
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearModelCache();
    Assets.clearSources();
  });

  it("describes an OBJ surface with the texture its material library names, once it has decoded", async () => {
    const [rock] = await loadMeshes("asset:models/rock1.obj#Rock1");
    expect(rock.surfaces[0].name).toBe("Rock");
    expect(rock.surfaces[0].map?.src).toBe(Assets.url("textures/rock.png"));
    // A mesh with several surfaces: only the textured one has a map.
    const [hull] = await loadMeshes("asset:models/ship.obj#Hull");
    expect(hull.surfaces.map((s) => [s.name, s.map?.src ?? null])).toEqual([
      ["Wood", Assets.url("textures/wood.png")],
      ["Gold", null],
      ["Iron", null],
    ]);
  });

  it("gives the Babylon material of a textured model surface an albedo texture", async () => {
    const [rock] = await loadMeshes("asset:models/rock1.obj#Rock1");
    vi.unstubAllGlobals(); // Babylon's engine reads the real (absent) document
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const m = surfaceMaterial(scene, new WeakMap(), rock.surfaces[0], rock.name) as PBRMaterial;
      expect(m.albedoTexture).not.toBeNull();
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
