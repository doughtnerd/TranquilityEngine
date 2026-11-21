import { describe, expect, it } from "vitest";
import { isRelativeReference, relativePath, resolveRelative } from "./relativePaths";

describe("relative references", () => {
  it("are paths without a scheme or a root", () => {
    for (const ref of ["a.png", "./tex/a.png", "../a.png", "tex\\a.png"]) expect(isRelativeReference(ref), ref).toBe(true);
    for (const ref of ["", "data:application/octet-stream;base64,AA==", "https://x.org/a.png", "C:\\art\\a.png", "/abs/a.png", "\\\\server\\a.png"]) expect(isRelativeReference(ref), ref).toBe(false);
  });

  it("resolve against the file's folder, with . and .. and backslashes", () => {
    expect(resolveRelative("models/crate.mtl", "tex/crate.png")).toBe("models/tex/crate.png");
    expect(resolveRelative("models/crate.mtl", "./tex\\crate.png")).toBe("models/tex/crate.png");
    expect(resolveRelative("models/a/crate.mtl", "../../shared/crate.png")).toBe("shared/crate.png");
    expect(resolveRelative("crate.obj", "crate.mtl")).toBe("crate.mtl");
    expect(resolveRelative("crate.obj", "../crate.mtl")).toBe("crate.mtl");
  });

  it("are written from a file's folder to a target, and resolve back to it", () => {
    const cases: [string, string, string][] = [
      ["models/crate.mtl", "models/tex/crate.png", "tex/crate.png"],
      ["vehicles/car.gltf", "models/car.bin", "../models/car.bin"],
      ["crate.obj", "models/libs/crate.mtl", "models/libs/crate.mtl"],
      ["models/libs/crate.mtl", "models/tex/crate.png", "../tex/crate.png"],
      ["a/b/c.obj", "x.mtl", "../../x.mtl"],
    ];
    for (const [file, target, ref] of cases) {
      expect(relativePath(file, target), `${file} → ${target}`).toBe(ref);
      expect(resolveRelative(file, ref)).toBe(target);
    }
  });
});
