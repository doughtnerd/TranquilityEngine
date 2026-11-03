import { Color, DirectionalLight, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { CascadedShadows, type CascadeSettings } from "../render/cascadedShadows";

function settings(over: Partial<CascadeSettings> = {}): CascadeSettings {
  return { cascades: 3, distance: 80, mapSize: 1024, color: new Color(1, 0.9, 0.8), intensity: 2, direction: new Vector3(0, -1, 0.5).normalize(), castShadows: true, ...over };
}

const lightsOf = (scene: Scene) => scene.children.filter((c): c is DirectionalLight => c instanceof DirectionalLight);

async function make(over: Partial<CascadeSettings> = {}) {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1.5, 0.1, 500);
  const s = settings(over);
  const csm = await CascadedShadows.create(camera, scene, s);
  return { scene, camera, s, csm };
}

/** Invokes a material's compile hook with a minimal fake shader; returns the shader. */
function compile(material: MeshStandardMaterial): { uniforms: Record<string, unknown> } {
  const shader = { uniforms: {}, vertexShader: "", fragmentShader: "", defines: {} };
  (material.onBeforeCompile as (s: unknown, r: unknown) => void)(shader, undefined);
  return shader;
}

describe("cascaded shadows (ADR 0053)", () => {
  it("adds one light per cascade, with the light's colour and intensity", async () => {
    const { scene, csm } = await make();
    const lights = lightsOf(scene);
    expect(lights.length).toBe(3);
    expect(lights[0].intensity).toBe(2);
    expect(lights[0].color.g).toBeCloseTo(0.9);
    expect(lights[0].shadow.normalBias).toBe(0.02);
    csm.dispose();
  });

  it("chains the material's own onBeforeCompile ahead of CSM's and extends the cache key", async () => {
    const { csm } = await make();
    const material = new MeshStandardMaterial();
    const calls: string[] = [];
    material.onBeforeCompile = () => void calls.push("own");
    material.customProgramCacheKey = () => "own-key";
    csm.setupMaterial(material);
    const shader = compile(material);
    expect(calls).toEqual(["own"]);
    expect(shader.uniforms.CSM_cascades).toBeDefined(); // CSM's hook ran too
    expect(material.defines?.USE_CSM).toBe(1);
    expect(material.defines?.CSM_CASCADES).toBe(3);
    expect(material.customProgramCacheKey()).toBe("own-key|csm3");
    csm.dispose();
  });

  it("is idempotent per material and works over the default no-op hook", async () => {
    const { csm } = await make();
    const material = new MeshStandardMaterial();
    csm.setupMaterial(material);
    const hook = material.onBeforeCompile;
    csm.setupMaterial(material);
    expect(material.onBeforeCompile).toBe(hook);
    expect(compile(material).uniforms.CSM_cascades).toBeDefined();
    csm.dispose();
  });

  it("needsRebuild only for structural changes", async () => {
    const { camera, s, csm } = await make();
    expect(csm.needsRebuild(camera, s)).toBe(false);
    expect(csm.needsRebuild(camera, { ...s, color: new Color(0, 0, 1), intensity: 5, direction: new Vector3(1, 0, 0), distance: 10, castShadows: false })).toBe(false);
    expect(csm.needsRebuild(camera, { ...s, cascades: 2 })).toBe(true);
    expect(csm.needsRebuild(camera, { ...s, mapSize: 2048 })).toBe(true);
    expect(csm.needsRebuild(new PerspectiveCamera(), s)).toBe(true);
    csm.dispose();
  });

  it("update pushes colour, intensity and shadow state into the lights", async () => {
    const { scene, s, csm } = await make();
    csm.update({ ...s, color: new Color(0, 0, 1), intensity: 7, castShadows: false, distance: 40 });
    const light = lightsOf(scene)[0];
    expect(light.intensity).toBe(7);
    expect(light.color.b).toBe(1);
    expect(light.castShadow).toBe(false);
    csm.dispose();
  });

  it("dispose restores the original hook and removes the lights", async () => {
    const { scene, csm } = await make();
    const material = new MeshStandardMaterial();
    const own = () => {};
    material.onBeforeCompile = own;
    const plain = new MeshStandardMaterial();
    csm.setupMaterial(material);
    csm.setupMaterial(plain);
    csm.dispose();
    expect(material.onBeforeCompile).toBe(own);
    expect(material.defines?.USE_CSM).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(plain, "onBeforeCompile")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(plain, "customProgramCacheKey")).toBe(false);
    expect(lightsOf(scene).length).toBe(0);
  });
});
