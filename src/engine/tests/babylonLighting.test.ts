// ADR 0075 stages 2–3: Light components, shadows and the default studio environment on the Babylon
// backend, run headless on Babylon's NullEngine.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer.js";
import type { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import type { PointLight } from "@babylonjs/core/Lights/pointLight.js";
import type { SpotLight } from "@babylonjs/core/Lights/spotLight.js";
import { RGBE_ReadHeader, RGBE_ReadPixels } from "@babylonjs/core/Misc/HighDynamicRange/hdr.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SHADOW_MAP_SIZE } from "../core/graphics";
import { World } from "../core/World";
import { Assets, Color, Engine, GameObject, Graphics, Light, SceneManager } from "../index";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import type { ShadowRequest } from "../render/babylon/frameGraph";
import { BabylonLighting, reclusterForNextCamera } from "../render/babylon/lighting";
import { studioHdr } from "../render/babylon/studioEnvironment";

describe("the studio environment (ADR 0075)", () => {
  it("is a Radiance .hdr image Babylon reads, brighter overhead than below", () => {
    const bytes = studioHdr(64);
    const info = RGBE_ReadHeader(bytes);
    expect([info.width, info.height]).toEqual([64, 32]);
    const pixels = RGBE_ReadPixels(bytes, info);
    expect(pixels.length).toBe(64 * 32 * 3);
    const row = (r: number) => {
      let sum = 0;
      for (let x = 0; x < 64; x++) sum += pixels[(r * 64 + x) * 3];
      return sum / 64;
    };
    expect(row(2)).toBeGreaterThan(row(29)); // ceiling over floor
    expect(Math.max(...pixels)).toBeGreaterThan(2); // soft boxes are brighter than white
  });
});

describe("lights on the Babylon backend (ADR 0075 stage 2)", () => {
  let engine: Engine;
  let babylon: NullEngine;
  let scene: Scene;
  let lighting: BabylonLighting;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    babylon = new NullEngine();
    scene = new Scene(babylon);
    scene.useRightHandedSystem = true;
    lighting = new BabylonLighting(scene);
  });

  afterEach(() => {
    Graphics.quality = Graphics.defaultQuality; // the tier is global: leave it as other tests expect
    scene.dispose();
    babylon.dispose();
    engine.dispose();
  });

  const light = (props: Record<string, unknown>, pos: [number, number, number] = [0, 0, 0], euler?: [number, number, number]) => {
    const node = GameObject.create(`light ${String(props.type)}`);
    node.transform!.position.set(...pos);
    if (euler) node.transform!.eulerAngles = euler;
    return node.addBehavior(Light, props);
  };
  let shadows: ShadowRequest[] = [];
  const sync = () => {
    engine.step(1 / 60);
    shadows = lighting.syncLights(World.require(), null);
  };
  const byName = (name: string) => scene.lights.find((l) => l.name === name);

  it("lights a World without Lights with the default ambient and sun", () => {
    sync();
    expect(byName("myco.default.ambient")!.isEnabled()).toBe(true);
    expect(byName("myco.default.sun")!.isEnabled()).toBe(true);
  });

  it("mirrors each Light's type, colour, intensity and pose, and drops the defaults", () => {
    light({ type: "directional", intensity: 2 }, [0, 5, 0], [-90, 0, 0]); // looking straight down
    light({ type: "point", range: 7, color: new Color(1, 0, 0, 1) }, [1, 2, 3]);
    light({ type: "spot", spotAngle: 60, spotSoftness: 0.5 });
    light({ type: "ambient", intensity: 0.3 });
    sync();
    expect(byName("myco.default.sun")!.isEnabled()).toBe(false);
    const sun = byName("light:light directional") as DirectionalLight;
    expect(sun.getClassName()).toBe("DirectionalLight");
    expect(sun.intensity).toBe(2);
    expect(sun.direction.y).toBeCloseTo(-1); // the node's -Z
    const point = byName("light:light point") as PointLight;
    expect(point.position.asArray()).toEqual([1, 2, 3]);
    expect(point.range).toBe(7);
    expect(point.diffuse.r).toBeCloseTo(1);
    expect(point.diffuse.g).toBeCloseTo(0);
    const spot = byName("light:light spot") as SpotLight;
    expect(spot.angle).toBeCloseTo(Math.PI / 3);
    expect(spot.innerAngle).toBeCloseTo(Math.PI / 6);
    expect(byName("light:light ambient")!.getClassName()).toBe("HemisphericLight");
  });

  it("picks the main light for Main Light nodes as three.js does: shadow-casting directional first, toward the light, linear × intensity", () => {
    sync();
    const len = Math.hypot(4, 10, 6);
    expect(lighting.mainLight.direction.map((v) => +v.toFixed(4))).toEqual([4 / len, 10 / len, 6 / len].map((v) => +v.toFixed(4))); // the default sun
    light({ type: "ambient", intensity: 0.3 }); // made first, so Babylon's light0 isn't directional
    light({ type: "point" });
    light({ type: "directional", intensity: 3, color: new Color(1, 0, 0, 1) }, [0, 0, 0], [0, 0, 0]); // faces -Z: light travels -Z
    light({ type: "directional", intensity: 2, color: new Color(0.5, 0.5, 0.5, 1), castShadows: true }, [0, 5, 0], [-90, 0, 0]); // looking down
    sync();
    const [dx, dy, dz] = lighting.mainLight.direction;
    expect(dx).toBeCloseTo(0);
    expect(dy).toBeCloseTo(1); // toward the shadow caster, which shines down
    expect(dz).toBeCloseTo(0);
    const half = Math.pow(0.5, 2.2); // sRGB 0.5 in linear, by Babylon's toLinearSpace
    expect(lighting.mainLight.color[0]).toBeCloseTo(half * 2, 3);
    expect(lighting.mainLight.color[1]).toBeCloseTo(half * 2, 3);
  });

  it("falls back to (0.4, 1, 0.6) and white when the World's Lights include no directional one", () => {
    light({ type: "point" });
    sync();
    const len = Math.hypot(0.4, 1, 0.6);
    expect(lighting.mainLight.direction[1]).toBeCloseTo(1 / len);
    expect(lighting.mainLight.color).toEqual([1, 1, 1]);
  });

  it("centres and sizes the one skybox for each camera before it draws, inside that camera's far plane", () => {
    // The studio map can't load on NullEngine, so the box is put where `syncEnvironment` keeps it.
    const box = CreateBox("myco.skybox", { size: 1 }, scene);
    (lighting as unknown as { skybox: typeof box }).skybox = box;
    const near = new TargetCamera("inset", new Vector3(3, 4, 5), scene);
    near.maxZ = 100;
    lighting.fitSky(near);
    expect(box!.getAbsolutePosition().asArray()).toEqual([3, 4, 5]);
    const corner = 0.5 * box!.scaling.x * Math.sqrt(3);
    expect(corner).toBeLessThan(100);
    expect(corner).toBeGreaterThan(50);
    const far = new TargetCamera("view", new Vector3(0, 0, 0), scene);
    far.maxZ = 2000;
    lighting.fitSky(far);
    expect(0.5 * box!.scaling.x * Math.sqrt(3)).toBeGreaterThan(1000); // the editor view keeps its distant meshes in front of the sky
  });

  it("brings the defaults back when the World's Lights are disabled", () => {
    const l = light({ type: "point" });
    sync();
    expect(byName("myco.default.sun")!.isEnabled()).toBe(false);
    l.enabled = false;
    sync();
    expect(byName("myco.default.sun")!.isEnabled()).toBe(true);
  });

  it("keeps the light set steady as Lights come, go and switch off, so materials keep their compiled shaders", () => {
    // A material's shader is compiled per light count and types; a change recompiles every lit material.
    const first = light({ type: "point", intensity: 2 }, [1, 0, 0]);
    first.node.name = "first";
    light({ type: "spot" }, [2, 0, 0]);
    sync();
    const enabled = () => scene.lights.filter((l) => l.isEnabled() && !l.name.startsWith("myco.default"));
    const before = enabled();
    const babylonFirst = byName("light:first")!;
    expect(babylonFirst.intensity).toBe(2);

    first.enabled = false;
    sync();
    expect(enabled()).toEqual(before); // still there, dark
    expect(babylonFirst.intensity).toBe(0);
    expect(byName("myco.default.sun")!.isEnabled()).toBe(false); // the spot still lights the World

    first.enabled = true;
    GameObject.destroy(first.node);
    lighting.release(first); // as the renderer does when a component goes
    sync();
    expect(enabled()).toEqual(before); // parked at zero intensity, not disposed
    expect(babylonFirst.intensity).toBe(0);

    const spot = light({ type: "spot", intensity: 3 }, [5, 6, 7]);
    spot.node.name = "second spot";
    sync();
    expect(enabled()).toHaveLength(before.length); // a parked point light made room for a type there wasn't one of
    const next = light({ type: "point", intensity: 4 }, [5, 6, 7]);
    next.node.name = "lantern";
    const settled = enabled();
    sync();
    expect(enabled()).toEqual(settled); // a parked light took it: no new light, no recompile
    const lantern = byName("light:lantern") as PointLight;
    expect(lantern.intensity).toBe(4);
    expect(lantern.position.asArray()).toEqual([5, 6, 7]);
  });

  it("reserves dark point lights up to a material's 8 once there's one, so later lanterns don't recompile", () => {
    light({ type: "directional" });
    light({ type: "point" });
    sync();
    const lights = () => scene.lights.filter((l) => l.isEnabled() && !l.name.startsWith("myco.default"));
    const reserved = lights();
    expect(reserved).toHaveLength(8);
    expect(reserved.filter((l) => l.intensity === 0)).toHaveLength(6);
    for (let i = 0; i < 5; i++) light({ type: "point" }, [i, 0, 0]);
    sync();
    expect(lights()).toEqual(reserved); // every new lantern took a reserved slot
    light({ type: "spot" }); // a new type gives up the last reserved slot rather than fall past the 8
    sync();
    expect(lights()).toHaveLength(8);
    expect(byName("light:light spot")!.isEnabled()).toBe(true);
  });

  it("reserves nothing for a World without point lights", () => {
    light({ type: "directional" });
    sync();
    expect(scene.lights.filter((l) => l.name === "myco.parked")).toHaveLength(0);
  });

  it("disposes of a gone Light's Babylon light rather than keep more than a material can use", () => {
    const lights = Array.from({ length: 9 }, (_, i) => light({ type: "point" }, [i, 0, 0]));
    sync();
    for (const l of lights) {
      GameObject.destroy(l.node);
      lighting.release(l);
    }
    sync();
    expect(scene.lights.filter((l) => !l.name.startsWith("myco.default")).length).toBeLessThanOrEqual(8);
  });

  it("asks for a shadow map the tier's size for a shadow-casting light, covering its shadow area", () => {
    Graphics.quality = "High";
    light({ type: "directional", castShadows: true, shadowArea: 30 }, [0, 10, 0], [-90, 0, 0]);
    sync();
    const sun = byName("light:light directional") as DirectionalLight;
    expect(shadows).toHaveLength(1);
    expect(shadows[0].light).toBe(sun);
    expect(shadows[0].cascaded).toBe(false); // cascades follow a camera; there is none here
    expect(shadows[0].mapSize).toBe(SHADOW_MAP_SIZE[Graphics.tier.shadows]);
    expect([sun.orthoLeft, sun.orthoRight]).toEqual([-15, 15]);
    expect(sun.shadowMinZ).toBe(0);
    expect(sun.shadowMaxZ).toBe(60);
    expect(sun.position.y).toBeCloseTo(40); // moved back along the light by twice the half-area
  });

  it("takes the shadow map away when the tier turns shadows off", () => {
    Graphics.quality = "High";
    light({ type: "directional", castShadows: true });
    sync();
    expect(shadows).toHaveLength(1);
    const off = Graphics.tiers.find((name) => {
      Graphics.quality = name;
      return Graphics.tier.shadows === "off";
    });
    if (!off) return; // every tier has shadows in this project
    sync();
    expect(shadows).toEqual([]);
  });

  it("leaves shadowEnabled on only for lights with a shadow map, so Babylon's per-render toggle never dirties meshes", () => {
    Graphics.quality = "High";
    light({ type: "directional", castShadows: true }, [0, 10, 0], [-90, 0, 0]);
    light({ type: "point" }, [1, 2, 3]);
    sync();
    expect(byName("light:light directional")!.shadowEnabled).toBe(true);
    expect(byName("light:light point")!.shadowEnabled).toBe(false);
    expect(byName("myco.default.sun")!.shadowEnabled).toBe(false);
    // A frame changes nothing, so no mesh is marked as needing its shader defines rebuilt.
    let marked = 0;
    for (const l of scene.lights) {
      const mark = l._markMeshesAsLightDirty.bind(l);
      l._markMeshesAsLightDirty = () => {
        marked++;
        mark();
      };
    }
    sync();
    expect(marked).toBe(0);
  });
});

describe("clustered point and spot lights (ADR 0079)", () => {
  let engine: Engine;
  let babylon: NullEngine;
  let scene: Scene;
  let lighting: BabylonLighting;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    babylon = new NullEngine();
    // What Babylon checks before clustering on WebGL2 (NullEngine says no to all of it).
    Object.assign((babylon as unknown as { _caps: object })._caps, { texelFetch: true, colorBufferFloat: true, blendFloat: true, shaderFloatPrecision: 23, maxVaryingVectors: 28 });
    Object.defineProperty(babylon, "version", { get: () => 2 });
    scene = new Scene(babylon);
    scene.useRightHandedSystem = true;
    lighting = new BabylonLighting(scene);
  });

  afterEach(() => {
    Graphics.quality = Graphics.defaultQuality;
    scene.dispose();
    babylon.dispose();
    engine.dispose();
  });

  const light = (props: Record<string, unknown>, name: string, pos: [number, number, number] = [0, 0, 0]) => {
    const node = GameObject.create(name);
    node.transform!.position.set(...pos);
    return node.addBehavior(Light, props);
  };
  const sync = () => {
    engine.step(1 / 60);
    lighting.syncLights(World.require(), null);
  };
  const container = () => scene.lights.find((l) => l.getClassName() === "ClusteredLightContainer") as ClusteredLightContainer | undefined;
  const ownLights = () => scene.lights.filter((l) => l.isEnabled() && !l.name.startsWith("myco.default"));

  it("puts point and spot lights without shadows in one container, which is the only light materials see for them", () => {
    light({ type: "directional" }, "sun");
    light({ type: "point", range: 7 }, "lantern", [1, 2, 3]);
    light({ type: "spot" }, "beam");
    sync();
    expect(ownLights().map((l) => l.name)).toEqual(["light:sun", "myco.clustered"]);
    const lantern = container()!.lights.find((l) => l.name === "light:lantern") as PointLight;
    expect(lantern.position.asArray()).toEqual([1, 2, 3]);
    expect(lantern.range).toBe(7);
    expect(container()!.lights.map((l) => l.name)).toContain("light:beam");
    expect(scene.lights.filter((l) => l.name === "myco.parked")).toHaveLength(0); // nothing to reserve
  });

  it("lets lanterns come, go and switch off without touching the scene's light list (so no shader changes)", () => {
    light({ type: "directional" }, "sun");
    const first = light({ type: "point" }, "first");
    sync();
    const before = [...scene.lights];
    let marked = 0;
    for (const l of scene.lights) {
      const mark = l._markMeshesAsLightDirty.bind(l);
      l._markMeshesAsLightDirty = () => {
        marked++;
        mark();
      };
    }
    const lanterns = Array.from({ length: 12 }, (_, i) => light({ type: "point" }, `lantern ${i}`, [i, 0, 0])); // past 8: no limit
    sync();
    first.enabled = false;
    sync();
    const babylonFirst = container()!.lights.find((l) => l.name === "light:first") as PointLight;
    expect(babylonFirst.intensity).toBe(0);
    expect(babylonFirst.range).toBeLessThan(0.01); // in almost no cluster
    for (const l of lanterns.slice(0, 6)) {
      GameObject.destroy(l.node);
      lighting.release(l);
    }
    sync();
    expect(scene.lights).toEqual(before);
    expect(marked).toBe(0);
    expect(container()!.lights).toHaveLength(13); // gone ones parked in the container
    light({ type: "point", intensity: 2 }, "late");
    sync();
    expect(container()!.lights).toHaveLength(13); // the late lantern took a parked light
    expect((container()!.lights.find((l) => l.name === "light:late") as PointLight).intensity).toBe(2);
  });

  it("keeps regular lights on a device with only WebGPU's minimum 16 values between shader stages", () => {
    (babylon as unknown as { _caps: { maxVaryingVectors: number } })._caps.maxVaryingVectors = 16;
    light({ type: "point" }, "lantern");
    sync();
    expect(container()).toBeUndefined();
    expect(ownLights().map((l) => l.name)).toContain("light:lantern");
  });

  it("keeps a shadow-casting point light a light of the scene's own", () => {
    Graphics.quality = "High";
    light({ type: "point", castShadows: true }, "torch");
    sync();
    expect(ownLights().map((l) => l.name)).toContain("light:torch");
    expect(container()?.lights.some((l) => l.name === "light:torch") ?? false).toBe(false);
  });

  it("clusters again for each camera in a frame (Babylon caches the first camera's)", () => {
    light({ type: "point" }, "lantern");
    sync();
    const c = container() as unknown as { _lightDataRenderId: number };
    c._lightDataRenderId = scene.getRenderId();
    reclusterForNextCamera(scene);
    expect(c._lightDataRenderId).toBe(-1);
  });
});
