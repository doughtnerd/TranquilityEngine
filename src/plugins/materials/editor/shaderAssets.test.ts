// New Shader (ADR 0106): the Materials plugin's `shader` kind creates it (see shaderAssets.ts), in the folder the
// asset kind host gives it (ADR 0233).
import { describe, expect, it } from "vitest";
import { parseShaderAsset } from "../../../engine/scene/shaderAsset";
import { joinPath, openFolderProject } from "../../../editor/projects";
import { editor } from "../../../editor/sdk";
import { useEditorPlugins } from "../../testEditorPlugins";
import { materialsEditorPlugin } from ".";
import { currentProject } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";

useEditorPlugins([materialsEditorPlugin], "each");

describe("New Shader", () => {
  it("creates the shader asset with WGSL and GLSL beside it, under a free name, in shaders/ if present", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set(joinPath(ROOT, "project.json"), "{}");
    fs.files.set(joinPath(ROOT, "shaders/old.shader.json"), '{ "format": "myco.shader@1" }');
    const project = await openFolderProject(fs, ROOT);
    currentProject.value = project;
    try {
      const first = await editor.assets.create("shader");
      expect(first).toBe("shaders/New Shader.shader.json");
      for (const f of ["shaders/New Shader.wgsl", "shaders/New Shader.glsl"]) expect(fs.files.get(joinPath(ROOT, f))).toContain("surface(");
      const { shader, problems } = parseShaderAsset(JSON.parse(fs.files.get(joinPath(ROOT, first!)) as string));
      expect(problems).toEqual([]);
      expect(shader.properties.map((p) => p.name)).toEqual(["Tint"]);
      expect(shader.wgsl).toEqual({ file: "asset:shaders/New Shader.wgsl" });
      expect(shader.glsl).toEqual({ file: "asset:shaders/New Shader.glsl" });
      expect(await editor.assets.create("shader")).toBe("shaders/New Shader 2.shader.json");
      expect(await editor.assets.create("shader", { folder: "" })).toBe("New Shader.shader.json");
    } finally {
      currentProject.value = null;
    }
  });
});
