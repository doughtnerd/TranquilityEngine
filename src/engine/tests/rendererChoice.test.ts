// ADR 0075: three.js stays the default renderer until the Babylon backend reaches parity; the dev
// flag (?renderer=babylon, or localStorage "myco.renderer") switches a page to Babylon.
import { afterEach, describe, expect, it, vi } from "vitest";
import { rendererChoice } from "../render/createRenderSurface";

function storage(value: string | null) {
  return { getItem: (k: string) => (k === "myco.renderer" ? value : null) };
}

afterEach(() => vi.unstubAllGlobals());

describe("rendererChoice (ADR 0075)", () => {
  it("defaults to three.js", () => {
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("localStorage", storage(null));
    expect(rendererChoice()).toBe("three");
  });

  it("follows ?renderer= in the URL", () => {
    vi.stubGlobal("location", { search: "?sample=flappy&renderer=babylon" });
    vi.stubGlobal("localStorage", storage("three"));
    expect(rendererChoice()).toBe("babylon");
  });

  it("falls back to localStorage, and ignores unknown names", () => {
    vi.stubGlobal("location", { search: "?renderer=vulkan" });
    vi.stubGlobal("localStorage", storage("babylon"));
    expect(rendererChoice()).toBe("babylon");
    vi.stubGlobal("localStorage", storage("ogre"));
    expect(rendererChoice()).toBe("three");
  });
});
