// ADR 0078: Babylon.js is the default renderer and three.js stays as a toggle (?renderer=three, or
// localStorage "myco.renderer", which the editor's Settings writes).
import { afterEach, describe, expect, it, vi } from "vitest";
import { rendererChoice, setStoredRendererChoice, storedRendererChoice } from "../render/createRenderSurface";

function storage(value: string | null) {
  return { getItem: (k: string) => (k === "myco.renderer" ? value : null) };
}

afterEach(() => vi.unstubAllGlobals());

describe("rendererChoice (ADR 0078)", () => {
  it("defaults to Babylon.js", () => {
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("localStorage", storage(null));
    expect(rendererChoice()).toBe("babylon");
  });

  it("follows ?renderer= in the URL", () => {
    vi.stubGlobal("location", { search: "?sample=flappy&renderer=three" });
    vi.stubGlobal("localStorage", storage("babylon"));
    expect(rendererChoice()).toBe("three");
  });

  it("falls back to localStorage, and ignores unknown names", () => {
    vi.stubGlobal("location", { search: "?renderer=vulkan" });
    vi.stubGlobal("localStorage", storage("three"));
    expect(rendererChoice()).toBe("three");
    vi.stubGlobal("localStorage", storage("ogre"));
    expect(rendererChoice()).toBe("babylon");
  });

  it("stores the choice for the next load (the default as no entry)", () => {
    const map = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v), removeItem: (k: string) => map.delete(k) });
    setStoredRendererChoice("three");
    expect(storedRendererChoice()).toBe("three");
    expect(map.get("myco.renderer")).toBe("three");
    setStoredRendererChoice("babylon");
    expect(storedRendererChoice()).toBe("babylon");
    expect(map.has("myco.renderer")).toBe(false);
  });
});
