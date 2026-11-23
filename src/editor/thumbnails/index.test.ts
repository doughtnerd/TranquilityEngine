import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { materialsEditorPlugin } from "../../plugins/materials/editor";
import type { EditorProject } from "../projects";
import { activatePlugins, deactivatePlugin } from "../sdk/plugins";
import { currentProject } from "../state";
import { contentKeyFor, installThumbnails } from "./index";
import { ThumbnailService } from "./service";

describe("the open project's thumbnail service (ADR 0061)", () => {
  afterEach(() => {
    currentProject.value = null;
    vi.restoreAllMocks();
  });

  it("lets the service go (its URLs and caches) when the project closes", async () => {
    const dispose = vi.spyOn(ThumbnailService.prototype, "dispose");
    const stop = installThumbnails();
    try {
      const project = { files: [], canSave: false, root: null, fileSystem: null, assets: new Map(), textOf: () => undefined, sizeOf: () => undefined } as unknown as EditorProject;
      currentProject.value = project;
      expect(dispose).not.toHaveBeenCalled();
      currentProject.value = null; // Close Project
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  describe("a material drawn by a hand-written shader (ADR 0106)", () => {
    beforeAll(() => activatePlugins([materialsEditorPlugin]));
    afterAll(() => deactivatePlugin(materialsEditorPlugin.manifest.name));

    /** An open project as the editor serves one (ADR 0254): JSON and text files by their text, other files by URL. */
    function openProject(texts: Record<string, string>): EditorProject {
      const values = new Map<string, unknown>(Object.entries(texts).map(([p, t]) => [p, p.endsWith(".json") ? JSON.parse(t) : t]));
      return {
        files: Object.keys(texts).sort(),
        canSave: false,
        root: null,
        fileSystem: null,
        assets: { has: (p: string) => values.has(p), get: (p: string) => values.get(p) },
        textOf: (p: string) => texts[p],
        sizeOf: (p: string) => texts[p]?.length,
      } as unknown as EditorProject;
    }

    const files = {
      "materials/rim.material.json": JSON.stringify({ format: "myco.material@1", shader: "asset:shaders/rim.shader.json", keywords: { RIM: true } }),
      "shaders/rim.shader.json": JSON.stringify({ format: "myco.shader@1", keywords: [{ name: "RIM" }], wgsl: "asset:shaders/rim.wgsl", glsl: "asset:shaders/rim.glsl" }),
      "shaders/rim.wgsl": "// WGSL\nfn surface() {}\n",
      "shaders/rim.glsl": "// GLSL\nvoid surface() {}\n",
    };

    it("has a thumbnail key: its shader's code files are read as the text the project serves, not fetched as URLs", async () => {
      const fetched = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("not a URL"));
      currentProject.value = openProject(files);
      expect(await contentKeyFor("materials/rim.material.json")).toMatch(/^[0-9a-f]{20}$/);
      expect(fetched).not.toHaveBeenCalled();
    });

    it("gets a new key when its shader's code changes", async () => {
      currentProject.value = openProject(files);
      const before = await contentKeyFor("materials/rim.material.json");
      currentProject.value = openProject({ ...files, "shaders/rim.wgsl": "// WGSL, edited\nfn surface() {}\n" });
      const after = await contentKeyFor("materials/rim.material.json");
      expect(after).not.toBeNull();
      expect(after).not.toBe(before);
    });
  });
});
