// ADR 0075 stages 2–3: Light components, shadows and the default studio environment on the Babylon
// backend, run headless on Babylon's NullEngine.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import type { PointLight } from "@babylonjs/core/Lights/pointLight.js";
import type { SpotLight } from "@babylonjs/core/Lights/spotLight.js";
import { RGBE_ReadHeader, RGBE_ReadPixels } from "@babylonjs/core/Misc/HighDynamicRange/hdr.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SHADOW_MAP_SIZE } from "../core/graphics";
import { World } from "../core/World";
import { Assets, Color, Engine, GameObject, Graphics, Light, SceneManager } from "../index";
import type { ShadowRequest } from "../render/babylon/frameGraph";
import { BabylonLighting } from "../render/babylon/lighting";
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

  it("brings the defaults back when the World's Lights are disabled", () => {
    const l = light({ type: "point" });
    sync();
    expect(byName("myco.default.sun")!.isEnabled()).toBe(false);
    l.enabled = false;
    sync();
    expect(byName("myco.default.sun")!.isEnabled()).toBe(true);
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
