// ADR 0080, 0459 §4: the pipeline warmer also draws a mesh with levels as a crossfade batch draws it (the fade plugin's
// variant, per-instance fade values, not a caster) while the tier crossfades, through `PipelineWarmer` on Babylon's
// NullEngine with a model whose levels come from the real import pipeline.
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, Graphics, SceneManager } from "../../index";
import type { MaterialInstancing } from "../../scene/material";
import { loadMeshes } from "../../scene/models";
import { memoryLodCache, setLodHost } from "../../scene/lod/cache";
import { generateLods } from "../../scene/lod/generate";
import { DEFAULT_LOD_SETTINGS } from "../../scene/lod/types";
import type { WarmMesh } from "../../scene/warmUp";
import { LOD_FADE_ATTRIBUTE } from "./lodFade";
import { PipelineWarmer, WARM_PREFIX, type WarmMaterials } from "./warmUp";

/** A latitude-longitude sphere as an OBJ, enough triangles for levels. */
function sphereObj(rows = 16, columns = 24): string {
  const lines = ["o Ball"];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= columns; c++) {
      const theta = (r / rows) * Math.PI, phi = (c / columns) * 2 * Math.PI;
      const k = 1 + 0.08 * Math.sin(5 * theta) * Math.cos(3 * phi);
      const x = Math.sin(theta) * Math.cos(phi), y = Math.cos(theta), z = Math.sin(theta) * Math.sin(phi);
      lines.push(`v ${(x * k * 0.5).toFixed(5)} ${(y * k * 0.5).toFixed(5)} ${(z * k * 0.5).toFixed(5)}`, `vn ${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)}`, `vt ${(c / columns).toFixed(5)} ${(1 - r / rows).toFixed(5)}`);
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

const BALL = "asset:models/ball.obj";
const warm = (mesh: string, castShadows = true): WarmMesh => ({ mesh, material: "", castShadows, receiveShadows: true, blended: false });

describe("pipeline warm-up of the crossfade variant (ADR 0080, 0459 §4)", () => {
  let engine: Engine;
  let babylon: NullEngine;
  let scene: Scene;
  let camera: TargetCamera;
  let mode: MaterialInstancing;
  /** Whether the World applies levels per view (the warmer's `levelsApplied`). */
  let levelsApplied = false;
  let warmer: PipelineWarmer;

  beforeEach(async () => {
    setLodHost({ generate: generateLods, cache: memoryLodCache() });
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "s.json": { format: "myco.scene@1", nodes: [] },
        "models/ball.obj": `data:text/plain;base64,${Buffer.from(sphereObj()).toString("base64")}`,
        "models/ball.obj.meta.json": { format: "myco.import@1", lod: DEFAULT_LOD_SETTINGS },
      }),
    );
    engine = await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    const [ball] = await loadMeshes(BALL);
    expect(ball.lods!.levels.length).toBeGreaterThan(1);
    await loadMeshes("builtin:cube");
    babylon = new NullEngine();
    scene = new Scene(babylon);
    camera = new TargetCamera("view", new Vector3(0, 2, 10), scene);
    camera.setTarget(Vector3.Zero());
    const material = new PBRMaterial("m", scene);
    mode = "auto";
    const materials: WarmMaterials = {
      material: () => null,
      slotMaterials: () => () => material,
      isGraph: () => false,
      fogless: () => false,
      loading: () => false,
      instancing: (_path, levelsApplied) => (mode === "auto" && levelsApplied ? "thin" : mode),
      warmVariants: () => [],
    };
    levelsApplied = false;
    warmer = new PipelineWarmer({ scene, materials, levelsApplied: () => levelsApplied });
  });
  afterEach(() => {
    warmer.dispose();
    Graphics.quality = Graphics.defaultQuality;
    scene.dispose();
    babylon.dispose();
    engine.dispose();
    setLodHost(null);
    Assets.clearSources();
  });

  /** Queue `items` and build the first batch: its warm source meshes and its casters. */
  function batch(...items: WarmMesh[]): { fades: Mesh[]; plain: Mesh[]; casters: AbstractMesh[] } {
    void warmer.add(items);
    const casters: AbstractMesh[] = [];
    warmer.beforeRender(camera, casters);
    const sources = scene.meshes.filter((m): m is Mesh => m.name.startsWith(WARM_PREFIX) && !(m instanceof InstancedMesh));
    return { fades: sources.filter((m) => m.name.endsWith(":fade")), plain: sources.filter((m) => !m.name.endsWith(":fade")), casters };
  }

  it("draws a mesh with levels as a fade batch too while the tier crossfades: the plugin's define, per-instance values, no shadow", () => {
    Graphics.quality = "High";
    const { fades, plain, casters } = batch(warm(BALL));
    expect(plain).toHaveLength(1);
    expect(fades).toHaveLength(1);
    const fade = fades[0];
    expect(fade.material!.pluginManager?.getPlugin("MycoLodFade")).toBeTruthy();
    fade.material!.isReadyForSubMesh(fade, fade.subMeshes[0], true);
    expect((fade.subMeshes[0].materialDefines as unknown as { MYCO_LOD_FADE: boolean }).MYCO_LOD_FADE).toBe(true);
    plain[0].material!.isReadyForSubMesh(plain[0], plain[0].subMeshes[0], true);
    expect((plain[0].subMeshes[0].materialDefines as unknown as { MYCO_LOD_FADE: boolean }).MYCO_LOD_FADE).toBe(false);
    expect(fade.instances[0].instancedBuffers[LOD_FADE_ATTRIBUTE]).toBe(0);
    expect(casters).toEqual([plain[0].instances[0]]);
  });

  it("gives a thin fade variant its fade buffer", () => {
    Graphics.quality = "High";
    mode = "thin";
    const { fades, casters } = batch(warm(BALL));
    expect(fades).toHaveLength(1);
    expect(fades[0].getVertexBuffer(LOD_FADE_ATTRIBUTE)?.getData()).toEqual(new Float32Array(1));
    expect(casters).not.toContain(fades[0]);
  });

  it("warms auto materials as thin instances while the World applies levels, as its renderers then draw them (ADR 0461)", () => {
    levelsApplied = true;
    const { plain, casters } = batch(warm(BALL));
    expect(plain).toHaveLength(1);
    expect(plain[0].instances).toHaveLength(0);
    expect(plain[0].thinInstanceCount).toBe(1);
    expect(casters).toEqual([plain[0]]);
  });

  it("draws no fade variant on a tier without crossfade, for a mesh without levels, or for meshes drawn on their own", () => {
    Graphics.quality = "Low";
    expect(batch(warm(BALL)).fades).toHaveLength(0);
    warmer.dispose();
    Graphics.quality = "High";
    expect(batch(warm("builtin:cube")).fades).toHaveLength(0);
    warmer.dispose();
    mode = "off";
    expect(batch(warm(BALL, false)).fades).toHaveLength(0);
  });
});
