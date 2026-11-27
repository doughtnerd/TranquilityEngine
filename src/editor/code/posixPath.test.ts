import { describe, expect, it } from "vitest";
import { posix as nodePosix } from "node:path";
import path, { basename, dirname, extname, format, join, normalize, parse, relative, resolve } from "./posixPath";

describe("POSIX path for the browser", () => {
  it("names files and folders as Node's path.posix does", () => {
    expect(basename("ui/Hud.svelte")).toBe("Hud.svelte");
    expect(basename("ui/Hud.svelte", ".svelte")).toBe("Hud");
    expect(dirname("ui/Hud.svelte")).toBe("ui");
    expect(dirname("Hud.svelte")).toBe(".");
    expect(dirname("/Hud.svelte")).toBe("/");
    expect(extname("ui/score.svelte.ts")).toBe(".ts");
    expect(extname(".hidden")).toBe("");
  });

  it("joins, folds and relates paths", () => {
    expect(normalize("a//b/./c/../d")).toBe("a/b/d");
    expect(normalize("../a")).toBe("../a");
    expect(join("ui", "../scripts", "A.ts")).toBe("scripts/A.ts");
    expect(resolve("/project", "ui", "Hud.svelte")).toBe("/project/ui/Hud.svelte");
    expect(resolve("/a", "/b", "c")).toBe("/b/c");
    expect(relative("/project/ui", "/project/scripts/A.ts")).toBe("../scripts/A.ts");
    expect(path.posix).toBe(path);
  });

  it("parses and formats as Node's path.posix does (svelte2tsx names a component's class from parse().name)", () => {
    for (const p of ["ui/Hud.svelte", "Hud.svelte", "/ui/Hud.svelte", "ui/score.svelte.ts", ".hidden", "ui/", "/", "a/b/c.d.e", ""]) {
      expect(parse(p), p).toEqual(nodePosix.parse(p));
      expect(format(parse(p)), p).toBe(nodePosix.format(nodePosix.parse(p)));
    }
    expect(path.parse("ui/Music.svelte").name).toBe("Music");
  });
});
