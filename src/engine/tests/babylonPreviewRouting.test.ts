// ADR 0075 stage 7, 0081: the editor's preview renderers are Babylon's, loaded on demand. The GPU
// renderers are mocked here.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../render/babylon/previews/ThumbnailRenderer", () => ({
  ThumbnailRenderer: { create: vi.fn(async (size?: number) => ({ renderer: "babylon", size })) },
}));

import * as editor from "../editor";
import { createThumbnailRenderer, loadParticleEffectPreview } from "../render/previewRouting";

describe("preview renderer routing (ADR 0075 stage 7)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses Babylon's thumbnail renderer, even when an old link asks for three.js", async () => {
    expect(await createThumbnailRenderer(128)).toMatchObject({ renderer: "babylon", size: 128 });
    vi.stubGlobal("location", { search: "?renderer=three" });
    expect(await createThumbnailRenderer()).toMatchObject({ renderer: "babylon" });
  });

  it("loads Babylon's effect preview", async () => {
    const babylon = await import("../render/babylon/previews/EffectPreview");
    expect((await loadParticleEffectPreview()).ParticleEffectPreview).toBe(babylon.ParticleEffectPreview);
  });

  it("is what the editor entry point hands out", async () => {
    expect(await editor.createThumbnailRenderer()).toMatchObject({ renderer: "babylon" });
    expect(editor.loadParticleEffectPreview).toBe(loadParticleEffectPreview);
    expect(typeof editor.MaterialPreview).toBe("function");
    expect(typeof editor.NodePreviewRenderer).toBe("function");
  });
});
