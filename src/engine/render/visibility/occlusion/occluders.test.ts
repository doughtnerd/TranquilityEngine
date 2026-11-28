// Occluder geometry for the occlusion core (ADR 0447 §3): edge neighbours, world triangles in the core's winding with
// neighbours reordered and errors in world units doubled, opacity rules, and the core's loader.
import { describe, expect, it, vi } from "vitest";
import { Assets } from "../../../scene/Assets";
import type { ModelMesh } from "../../../scene/models";
import { createOcclusionCoreLoader, loadOcclusionCore } from "./core";
import { edgeNeighbors, NO_NEIGHBOR } from "./neighbors";
import { opaqueMaterial, worldOccluder, type OccluderGeometry } from "./occluders";
import { makeView } from "../views";

const N = NO_NEIGHBOR;

describe("edge neighbours", () => {
  it("joins two triangles across their shared edge and leaves the rest as boundaries", () => {
    // A quad: (0, 1, 2) and (0, 2, 3) share 0–2: edge c→a of the first, a→b of the second.
    expect([...edgeNeighbors([0, 1, 2, 0, 2, 3])]).toEqual([N, N, 1, 0, N, N]);
  });

  it("treats an edge three triangles share as a boundary on every side", () => {
    expect([...edgeNeighbors([0, 1, 2, 1, 0, 3, 0, 1, 4])]).toEqual([N, N, N, N, N, N, N, N, N]);
  });
});

describe("world occluders", () => {
  const quad: OccluderGeometry = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    errors: new Float32Array([0.001, 0.002]),
    neighbors: edgeNeighbors([0, 1, 2, 0, 2, 3]),
    diagonal: 2,
  };
  // Scale 3, then move by (10, 0, 0): column-major.
  const m = new Float32Array([3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 10, 0, 0, 1]);

  it("writes corners a, c, b in world space, reorders neighbours to match, and doubles errors in world units", () => {
    const w = worldOccluder([quad], m, 0);
    expect(w.count).toBe(2);
    expect([...w.triangles.subarray(0, 9)]).toEqual([10, 0, 0, 13, 3, 0, 13, 0, 0]); // a=(0,0) c=(1,1) b=(1,0), ×3 +10
    // Old edges (a→b, b→c, c→a) = (N, N, 1) become (a→c, c→b, b→a) = (1, N, N); the second: (0, N, N) → (N, N, 0).
    expect([...w.neighbors]).toEqual([1, N, N, N, N, 0]);
    expect(w.errors[0]).toBeCloseTo(0.001 * 2 * 2 * 3, 6);
    expect(w.errors[1]).toBeCloseTo(0.002 * 2 * 2 * 3, 6);
  });

  it("rebases neighbours when meshes are concatenated", () => {
    const w = worldOccluder([quad, quad], m, 0);
    expect([...w.neighbors.subarray(6)]).toEqual([3, N, N, N, N, 2]);
  });

  it("is rasterised by the core and hides what it covers (the winding the core keeps)", async () => {
    const load = await loadOcclusionCore(256, 128);
    if (load.status !== "ready") throw new Error("the occlusion core didn't load");
    const view = makeView({ key: "t", kind: "camera", position: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1], projection: "perspective", fovY: Math.PI / 2, orthoHalfHeight: 0, near: 0.1, far: 1000, widthPx: 256, heightPx: 128, persistent: false, occlusion: true });
    // A quad facing the camera as a model mesh winds it (right-hand normal inward, away from the camera): 40 × 40 at z = 4.
    const wall: OccluderGeometry = { ...quad, positions: new Float32Array([-20, -20, 4, 20, -20, 4, 20, 20, 4, -20, 20, 4]), errors: new Float32Array(2), diagonal: 0 };
    const w = worldOccluder([wall], new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 0);
    const hidden = new Uint8Array(1);
    const run = load.core.occlude(view, { near: view.near, far: view.far, sx: view.sx, sy: view.sy, eye: view.position }, w.triangles, w.errors, w.neighbors, new Float32Array([-1, -1, 9, 1, 1, 11]), hidden);
    expect(run.rasterised).toBeGreaterThan(0);
    expect(hidden[0]).toBe(1);
  });
});

describe("occluder opacity", () => {
  const mesh = (surfaces: Partial<ModelMesh["surfaces"][number]>[]) => ({ surfaces: surfaces.map((s) => ({ name: "s", color: [1, 1, 1], opacity: 1, transparent: false, metalness: 0, roughness: 0.5, doubleSided: false, map: null, ...s })) }) as unknown as ModelMesh;

  it("follows a material asset's alpha mode and colour", () => {
    Assets.addSource(
      Assets.fromObject({
        "opaque.material.json": { format: "myco.material@1", alphaMode: "opaque" },
        "auto.material.json": { format: "myco.material@1", color: "#ffffff" },
        "faded.material.json": { format: "myco.material@1", color: "#ffffff80" },
        "mask.material.json": { format: "myco.material@1", alphaMode: "mask" },
        "blend.material.json": { format: "myco.material@1", alphaMode: "blend" },
      }),
    );
    expect(opaqueMaterial("opaque.material.json", [])).toBe(true);
    expect(opaqueMaterial("auto.material.json", [])).toBe(true);
    expect(opaqueMaterial("faded.material.json", [])).toBe(false);
    expect(opaqueMaterial("mask.material.json", [])).toBe(false);
    expect(opaqueMaterial("blend.material.json", [])).toBe(false);
    expect(opaqueMaterial("missing.material.json", [])).toBe(false);
  });

  it("without an asset, needs every model surface opaque", () => {
    expect(opaqueMaterial("", [mesh([{}, {}])])).toBe(true);
    expect(opaqueMaterial("", [mesh([{}, { transparent: true }])])).toBe(false);
    expect(opaqueMaterial("", [mesh([{ alphaMode: "mask" }])])).toBe(false);
    expect(opaqueMaterial("", [mesh([{ opacity: 0.5, alphaMode: "opaque" }])])).toBe(false);
  });
});

describe("the occlusion core's loader", () => {
  it("warns once and stays off without SIMD, never instantiating the module", async () => {
    const warn = vi.fn(), instantiate = vi.fn();
    const load = createOcclusionCoreLoader({ supportsSimd: () => false, instantiate, warn });
    expect((await load(256, 128)).status).toBe("unsupported");
    expect((await load(256, 128)).status).toBe("unsupported");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(instantiate).not.toHaveBeenCalled();
  });

  it("warns and stays off when the module fails to load", async () => {
    const warn = vi.fn();
    const load = createOcclusionCoreLoader({ supportsSimd: () => true, instantiate: () => Promise.reject(new Error("404")), warn });
    expect((await load(256, 128)).status).toBe("unsupported");
    expect(warn.mock.calls[0][0]).toContain("404");
  });
});
