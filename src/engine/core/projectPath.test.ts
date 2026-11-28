import { describe, expect, it } from "vitest";
import { fileName, folderOf, resolveRelative } from "./projectPath";

describe("project paths at runtime (ADR 0466)", () => {
  it("splits a path into its folder and file name", () => {
    expect(fileName("models/hero.gltf")).toBe("hero.gltf");
    expect(folderOf("models/hero.gltf")).toBe("models");
    expect(folderOf("hero.gltf")).toBe("");
  });

  it("resolves a path relative to the file that names it, folding . and .. and reading backslashes as /", () => {
    expect(resolveRelative("models/a.gltf", "a.bin")).toBe("models/a.bin");
    expect(resolveRelative("models/a.gltf", "./tex/../b.png")).toBe("models/b.png");
    expect(resolveRelative("models/a.gltf", "..\\tex\\b.png")).toBe("tex/b.png");
    expect(resolveRelative("a.gltf", "b.bin")).toBe("b.bin");
  });

  it("names nothing above the project folder", () => {
    expect(resolveRelative("models/a.gltf", "../x.bin")).toBe("x.bin");
    expect(resolveRelative("models/a.gltf", "../../x.bin")).toBeNull();
    expect(resolveRelative("ui/a.css", "/../x.png", { leadingSlash: "projectRoot" })).toBeNull();
  });

  it("reads a drive letter as another machine's path, and a leading / as the caller says", () => {
    expect(resolveRelative("models/a.obj", "C:/t.png")).toBeNull();
    expect(resolveRelative("models/a.obj", "c:\\t.png")).toBeNull();
    expect(resolveRelative("models/a.obj", "/abs/x.png")).toBeNull();
    expect(resolveRelative("models/a.obj", "/abs/x.png", { leadingSlash: "outside" })).toBeNull();
    expect(resolveRelative("ui/hud/a.css", "/images/x.png", { leadingSlash: "projectRoot" })).toBe("images/x.png");
  });
});
