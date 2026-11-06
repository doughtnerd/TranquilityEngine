// ADR 0075 stage 7, 0078: the editor picks its preview renderers by `rendererChoice()`: Babylon by default,
// three.js with `?renderer=three`, each loaded only when chosen. The GPU renderers are mocked here.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../render/babylon/previews/ThumbnailRenderer", () => ({
  ThumbnailRenderer: { create: vi.fn(async (size?: number) => ({ renderer: "babylon", size })) },
}));
vi.mock("../render/ThumbnailRenderer", () => ({
  ThumbnailRenderer: class {
    renderer = "three";
    constructor(readonly size?: number) {}
  },
}));

import * as editor from "../editor";
import { createThumbnailRenderer, loadParticleEffectPreview } from "../render/previewRouting";

describe("preview renderer routing (ADR 0075 stage 7)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses Babylon's thumbnail renderer by default, and three.js's when asked", async () => {
    expect(await createThumbnailRenderer(128)).toMatchObject({ renderer: "babylon", size: 128 });
    vi.stubGlobal("location", { search: "?renderer=three" });
    expect(await createThumbnailRenderer(128)).toMatchObject({ renderer: "three", size: 128 });
    vi.stubGlobal("location", { search: "?renderer=babylon" });
    expect(await createThumbnailRenderer()).toMatchObject({ renderer: "babylon" });
  });

  it("loads the effect preview of the chosen renderer", async () => {
    const three = await import("../render/particles/EffectPreview");
    const babylon = await import("../render/babylon/previews/EffectPreview");
    expect((await loadParticleEffectPreview()).ParticleEffectPreview).toBe(babylon.ParticleEffectPreview);
    vi.stubGlobal("location", { search: "?renderer=three" });
    expect((await loadParticleEffectPreview()).ParticleEffectPreview).toBe(three.ParticleEffectPreview);
  });

  it("is what the editor entry point hands out", async () => {
    vi.stubGlobal("location", { search: "?renderer=babylon" });
    expect(await editor.createThumbnailRenderer()).toMatchObject({ renderer: "babylon" });
    expect(editor.loadParticleEffectPreview).toBe(loadParticleEffectPreview);
    expect(typeof editor.MaterialPreview).toBe("function");
    expect(typeof editor.NodePreviewRenderer).toBe("function");
  });
});
