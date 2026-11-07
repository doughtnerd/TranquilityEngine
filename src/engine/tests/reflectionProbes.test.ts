import { describe, expect, it } from "vitest";
import { Camera, ReflectionProbe } from "../index";
import { pickProbe, type ProbeBox } from "../render/probeBoxes";

const box = (id: number, size: number, x = 0, y = 0, z = 0): ProbeBox => ({ id, center: { x, y, z }, size: { x: size, y: size, z: size } });

describe("pickProbe", () => {
  it("returns the box containing the point", () => {
    expect(pickProbe({ x: 1, y: 1, z: 1 }, [box(1, 10)])?.id).toBe(1);
  });
  it("picks the smaller of nested boxes", () => {
    expect(pickProbe({ x: 0, y: 0, z: 0 }, [box(1, 20), box(2, 4)])?.id).toBe(2);
  });
  it("returns null outside every box", () => {
    expect(pickProbe({ x: 50, y: 0, z: 0 }, [box(1, 10)])).toBeNull();
    expect(pickProbe({ x: 0, y: 0, z: 0 }, [])).toBeNull();
  });
  it("includes the edges", () => {
    expect(pickProbe({ x: 5, y: -5, z: 5 }, [box(1, 10)])?.id).toBe(1);
  });
  it("breaks volume ties by lower id", () => {
    expect(pickProbe({ x: 0, y: 0, z: 0 }, [box(7, 10), box(3, 10)])?.id).toBe(3);
  });
});

describe("ReflectionProbe", () => {
  it("has defaults", () => {
    const p = new ReflectionProbe();
    expect([p.size.x, p.size.y, p.size.z]).toEqual([10, 10, 10]);
    expect(p.intensity).toBe(1);
    expect(p.refresh).toBe("onLoad");
  });
  it("capture() bumps the request counter", () => {
    const p = new ReflectionProbe();
    expect(p._captureRequests).toBe(0);
    p.capture();
    expect(p._captureRequests).toBe(1);
  });
});

describe("Camera viewport", () => {
  it("covers the whole canvas by default", () => {
    const c = new Camera();
    expect([c.viewportPosition.x, c.viewportPosition.y]).toEqual([0, 0]);
    expect([c.viewportSize.x, c.viewportSize.y]).toEqual([1, 1]);
  });
});

describe("blending between reflection probes (ADR 0110)", () => {
  const box = (id: number, cx: number, size: number, blendDistance = 1) => ({ id, center: { x: cx, y: 0, z: 0 }, size: { x: size, y: size, z: size }, blendDistance });

  it("fades from the smallest box towards the next one near its faces, in steps", async () => {
    const { blendProbes, BLEND_STEPS } = await import("../render/probeBoxes");
    const room = box(1, 0, 4, 1); // x from -2 to 2
    const hall = box(2, 0, 20, 1);
    expect(blendProbes({ x: 0, y: 0, z: 0 }, [room, hall])).toEqual({ primary: room, secondary: null, weight: 1 }); // deep inside
    const edge = blendProbes({ x: 1.5, y: 0, z: 0 }, [room, hall])!; // half a metre inside a face
    expect(edge.primary).toBe(room);
    expect(edge.secondary).toBe(hall);
    expect(edge.weight).toBe(0.5);
    expect((blendProbes({ x: 1.9, y: 0, z: 0 }, [room, hall])!.weight * BLEND_STEPS) % 1).toBe(0); // rounded to a step
    expect(blendProbes({ x: 5, y: 0, z: 0 }, [room, hall])).toEqual({ primary: hall, secondary: null, weight: 1 });
    expect(blendProbes({ x: 50, y: 0, z: 0 }, [room, hall])).toBeNull();
  });

  it("uses one probe alone with no neighbour, or with a blend distance of 0", async () => {
    const { blendProbes } = await import("../render/probeBoxes");
    expect(blendProbes({ x: 1.9, y: 0, z: 0 }, [box(1, 0, 4)])!.secondary).toBeNull();
    expect(blendProbes({ x: 1.9, y: 0, z: 0 }, [box(1, 0, 4, 0), box(2, 0, 20)])).toMatchObject({ secondary: null, weight: 1 });
  });

  it("adds a second cube sample to a probe copy's shader only while it blends", async () => {
    const { NullEngine } = await import("@babylonjs/core/Engines/nullEngine.js");
    const { Scene } = await import("@babylonjs/core/scene.js");
    const { PBRMaterial } = await import("@babylonjs/core/Materials/PBR/pbrMaterial.js");
    const { ShaderLanguage } = await import("@babylonjs/core/Materials/shaderLanguage.js");
    const { MycoProbeBlendPlugin } = await import("../render/babylon/probeBlend");
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const m = new PBRMaterial("m", scene);
    const state = { texture: null, weight: 0.5, intensityRatio: 1, box: null };
    const plugin = new MycoProbeBlendPlugin(m, state);
    const defines = { MYCO_PROBE_BLEND: true } as unknown as Parameters<typeof plugin.prepareDefines>[0];
    plugin.prepareDefines(defines, scene, null as never);
    expect((defines as unknown as { MYCO_PROBE_BLEND: boolean }).MYCO_PROBE_BLEND).toBe(false); // no neighbour texture
    for (const lang of [ShaderLanguage.WGSL, ShaderLanguage.GLSL]) {
      const code = plugin.getCustomCode("fragment", lang)!;
      const anchor = Object.keys(code).find((k) => k.startsWith("!"))!;
      // The anchor is found once in Babylon's PBR fragment shader, and the replacement keeps what it matched.
      const { ShaderStore } = await import("@babylonjs/core/Engines/shaderStore.js");
      await (lang === ShaderLanguage.WGSL ? import("@babylonjs/core/ShadersWGSL/pbr.fragment.js") : import("@babylonjs/core/Shaders/pbr.fragment.js"));
      const source = (lang === ShaderLanguage.WGSL ? ShaderStore.ShadersStoreWGSL : ShaderStore.ShadersStore)["pbrPixelShader"];
      expect(source.match(new RegExp(anchor.slice(1), "g"))).toHaveLength(1);
      expect(code[anchor]).toMatch(/^#define CUSTOM_REFLECTION\n#endif\n#endif\n/);
      expect(code[anchor]).toContain("sampleReflectionTexture(");
    }
    scene.dispose();
    engine.dispose();
  });
});
