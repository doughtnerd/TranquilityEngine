import { Color as ThreeColor, Fog as ThreeFog, FogExp2, MeshBasicMaterial, MeshStandardMaterial, Scene, Texture } from "three";
import { describe, expect, it } from "vitest";
import { Color } from "../core/math";
import { Fog } from "../render/components";
import { applyFog } from "../render/fog";
import { parseMaterial } from "../scene/material";

const clear = new ThreeColor(0x000000);

describe("Fog component (ADR 0071)", () => {
  it("has the documented defaults", () => {
    const f = new Fog();
    expect(f.mode).toBe("linear");
    expect(f.affectsSkybox).toBe(false);
    expect(f.skyboxFog).toBe(1);
    expect(f.near).toBeLessThan(f.far);
  });
});

describe("applying fog to a scene", () => {
  it("makes linear fog that materials in the scene take by default", () => {
    const scene = new Scene();
    const fog = new Fog();
    fog.color = new Color(1, 0, 0, 1);
    fog.near = 5;
    fog.far = 50;
    applyFog(scene, fog, clear);
    expect(scene.fog).toBeInstanceOf(ThreeFog);
    const f = scene.fog as ThreeFog;
    expect([f.near, f.far]).toEqual([5, 50]);
    expect(f.color.r).toBeCloseTo(1);
    // three applies scene fog to every material whose `fog` is true: the built-in materials all are.
    expect(new MeshStandardMaterial().fog).toBe(true);
    expect(new MeshBasicMaterial().fog).toBe(true);
  });

  it("updates the fog object in place so nothing recompiles, and replaces it only for a mode change", () => {
    const scene = new Scene();
    const fog = new Fog();
    applyFog(scene, fog, clear);
    const first = scene.fog;
    fog.far = 300;
    fog.color = new Color(0, 1, 0, 1);
    applyFog(scene, fog, clear);
    expect(scene.fog).toBe(first);
    expect((scene.fog as ThreeFog).far).toBe(300);
    expect(scene.fog!.color.g).toBeCloseTo(1);
    fog.mode = "exponential";
    fog.density = 0.1;
    applyFog(scene, fog, clear);
    expect(scene.fog).toBeInstanceOf(FogExp2);
    expect((scene.fog as FogExp2).density).toBeCloseTo(0.1);
    const exp = scene.fog;
    fog.density = 0.3;
    applyFog(scene, fog, clear);
    expect(scene.fog).toBe(exp);
    expect((scene.fog as FogExp2).density).toBeCloseTo(0.3);
  });

  it("removes fog when there is no enabled Fog", () => {
    const scene = new Scene();
    applyFog(scene, new Fog(), clear);
    applyFog(scene, null, clear);
    expect(scene.fog).toBeNull();
  });

  it("leaves the sky alone unless affectsSkybox, then fades it by skyboxFog", () => {
    const fog = new Fog();
    fog.color = new Color(1, 1, 1, 1);
    const plain = new Scene();
    applyFog(plain, fog, clear);
    expect(plain.background).toBeNull();

    fog.affectsSkybox = true;
    fog.skyboxFog = 0.5;
    const flat = new Scene();
    applyFog(flat, fog, clear); // no skybox: the clear colour lerps to the fog colour
    expect((flat.background as ThreeColor).r).toBeCloseTo(0.5);

    const sky = new Scene();
    sky.background = new Texture();
    sky.backgroundIntensity = 1;
    applyFog(sky, fog, clear);
    expect(sky.backgroundIntensity).toBeCloseTo(0.5);
    fog.skyboxFog = 1;
    sky.background = new Texture();
    sky.backgroundIntensity = 1;
    applyFog(sky, fog, clear);
    expect(sky.background).toBeInstanceOf(ThreeColor);
  });
});

describe("material opt-out", () => {
  const raw = (extra: object) => ({ format: "myco.material@1", ...extra });
  it('reads "fog": false and defaults to taking fog', () => {
    expect(parseMaterial(raw({})).settings.fog).toBe(true);
    expect(parseMaterial(raw({ fog: false })).settings.fog).toBe(false);
    expect(parseMaterial(raw({ fog: "no" })).problems.length).toBe(1);
  });
});
