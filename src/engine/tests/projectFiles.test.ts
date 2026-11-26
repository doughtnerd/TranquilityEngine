// ADR 0254: one module says which files are project files and the asset value each loads as, and
// the typed reads on `Assets` answer by kind, so every host loads a file the same way.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../scene/Assets";
import { isProjectFile, loadProjectFiles, projectFileKind, skipsFolder } from "../scene/projectFiles";

describe("project files", () => {
  it.each([
    ["scenes/main.scene.json", "json"],
    ["images/bird.png.meta.json", "json"],
    ["DATA/A.JSON", "json"],
    ["data/level.xml", "text"],
    ["ui/theme.css", "text"],
    ["shaders/wave.wgsl", "text"],
    ["shaders/wave.glsl", "text"],
    ["notes.txt", "text"],
    ["tools/README.md", "text"],
    ["tools/gen.mjs", "text"],
    ["tools/a.js", "text"],
    ["tools/a.cjs", "text"],
    ["tools/a.mts", "text"],
    ["ui/Hud.svelte", "text"], // Svelte UI sources (ADR 0419): compiled from their text
    ["ui/store.svelte.ts", "text"],

    ["images/bird.png", "url"],
    ["audio/flap.wav", "url"],
    ["grade/warm.cube", "url"],
    ["models/robot.obj", "url"],
    ["models/robot.gltf", "url"],
    ["fonts/Pirata.ttf", "url"],
    ["levels/one.dat", "url"],
    ["LICENSE", "url"],
  ])("%s loads as %s", (path, kind) => {
    expect(projectFileKind(path)).toBe(kind);
  });

  it("leaves out hidden files and folders, dependency and build folders, and TypeScript", () => {
    for (const path of ["project.json", "images/a.png", "tools/gen.mjs", "data/dist.json", "levels/target", "ui/Hud.svelte", "ui/store.svelte.ts"]) expect(isProjectFile(path), path).toBe(true);
    for (const path of [".env", ".myco/state.json", "node_modules/x/index.js", "dist/web/index.html", "a/target/b.png", "scripts/Bird.ts", "src/x.tsx", "scripts/types.d.ts"]) expect(isProjectFile(path), path).toBe(false);
    for (const name of [".git", ".myco", "node_modules", "dist", "target", "test-results", "playwright-report"]) expect(skipsFolder(name), name).toBe(true);
    expect(skipsFolder("scenes")).toBe(false);
  });

  it("loads each file through the host's reader as its asset value, in the order given", async () => {
    const files: Record<string, string> = { "b.json": '{"x":1}', "ui/a.xml": "<ui/>", "bad.json": "{" };
    const loaded = await loadProjectFiles(["b.json", "ui/a.xml", "images/c.png", "bad.json"], {
      readText: async (p) => files[p],
      url: (p) => `blob:${p}`,
    });
    expect([...loaded.values]).toEqual([["b.json", { x: 1 }], ["ui/a.xml", "<ui/>"], ["images/c.png", "blob:images/c.png"]]);
    expect([...loaded.texts.keys()]).toEqual(["b.json", "ui/a.xml"]);
    expect(loaded.problems.map((p) => p.path)).toEqual(["bad.json"]);
  });
});

describe("Assets typed reads", () => {
  afterEach(() => {
    Assets.clearSources();
    vi.unstubAllGlobals();
  });

  it("read JSON, text and URLs by the file's kind, and refuse the wrong read", () => {
    Assets.addSource(Assets.fromObject({ "d.json": { a: 1 }, "s.wgsl": "fn f() {}", "i.png": "blob:i" }));
    expect(Assets.json("asset:d.json")).toEqual({ a: 1 });
    expect(Assets.text("s.wgsl")).toBe("fn f() {}");
    expect(Assets.url("i.png")).toBe("blob:i");
    expect(() => Assets.url("s.wgsl")).toThrow(/text file.*Assets\.text/);
    expect(() => Assets.url("d.json")).toThrow(/JSON file/);
    expect(() => Assets.text("i.png")).toThrow(/Assets\.bytes/);
    expect(() => Assets.json("s.wgsl")).toThrow(/not a JSON file/);
  });

  it("fetch a URL file's bytes", async () => {
    const fetchMock = vi.fn(async () => new Response("LUT_3D_SIZE 2"));
    vi.stubGlobal("fetch", fetchMock);
    Assets.addSource(Assets.fromObject({ "grade/id.cube": "blob:x" }));
    expect(new TextDecoder().decode(await Assets.bytes("asset:grade/id.cube"))).toBe("LUT_3D_SIZE 2");
    expect(fetchMock).toHaveBeenCalledWith("blob:x");
  });
});
