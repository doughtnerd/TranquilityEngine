// The Meshes plugin's model reference formats (ADR 0148, 0314), through the kinds' `references`.
import { describe, expect, it } from "vitest";
import type { ReferenceMoves } from "../../../editor/sdk";
import { materialLibraryReferences, modelReferences } from "./modelReferences";

/** Moves as a file's rewrite sees them: the file was at `from`, and `moved` maps the files that moved. */
const moves = (from: string, moved: Record<string, string> = {}): ReferenceMoves => ({ from, to: (p) => moved[p] ?? p });
const rewrite = (references: typeof modelReferences, path: string, text: string, m: ReferenceMoves) => references.rewrite!(path, text, m);

describe("Wavefront references", () => {
  const mtl = "# exported\r\nnewmtl a\r\nmap_Kd -bm 1 -o 0 0 tex\\crate.png\r\n  bump ./tex/n.png  \r\nmap_Ks C:\\art\\spec.png\r\n";

  it("reads every material library, each map's file after its options, and skips absolute paths", () => {
    expect(modelReferences.read("models/crate.obj", "mtllib a.mtl b.mtl\nv 0 0 0\nusemtl a\n")).toEqual(["models/a.mtl", "models/b.mtl"]);
    expect(materialLibraryReferences.read("models/crate.mtl", mtl)).toEqual(["models/tex/crate.png", "models/tex/n.png"]);
  });

  it("rewrites only the file names, keeping options, comments, spacing and line endings", () => {
    const next = rewrite(materialLibraryReferences, "models/crate.mtl", mtl, moves("models/crate.mtl", { "models/tex/crate.png": "shared/crate.png" }));
    expect(next).toBe(mtl.replace("tex\\crate.png", "../shared/crate.png"));
  });

  it("reads the map file as the word after the specification's options, whatever their argument counts (ADR 0394)", () => {
    const opts = [
      "newmtl a",
      "map_Kd -o 0.5 -s 2 2 -clamp on -mm 0 1 -imfchan r -texres 512 -blendu off -blendv on -cc on -boost 1.5 a.png",
      "map_Ks -t 1 2 3 b.png",
      "bump -bm 0.2 -s 1 c.png extra.png",
      "refl -type sphere d.png",
      "decal e.png",
      "disp -mm 0.1 f.png",
      "map_aat on",
      "# map_Kd commented.png",
      "map_d \\",
      "  g.png",
    ].join("\n");
    expect(materialLibraryReferences.read("m/x.mtl", opts)).toEqual(["m/a.png", "m/b.png", "m/c.png", "m/d.png", "m/e.png", "m/f.png", "m/g.png"]);
    // A numeric-looking file after a ranged option is still the file: an option leaves the last word.
    expect(materialLibraryReferences.read("m/x.mtl", "map_Kd -o 1 2 3")).toEqual(["m/3"]);
  });

  it("reads every file of every mtllib statement, continuation lines included, and rewrites each in place", () => {
    const obj = "mtllib a.mtl\tb.mtl\nmtllib \\\n  sub/c.mtl\nv 0 0 0\n";
    expect(modelReferences.read("models/m.obj", obj)).toEqual(["models/a.mtl", "models/b.mtl", "models/sub/c.mtl"]);
    const next = rewrite(modelReferences, "models/m.obj", obj, moves("models/m.obj", { "models/b.mtl": "libs/b.mtl", "models/sub/c.mtl": "libs/c.mtl" }));
    expect(next).toBe("mtllib a.mtl\t../libs/b.mtl\nmtllib \\\n  ../libs/c.mtl\nv 0 0 0\n");
  });

  it("rewrites a map's file, not the options' arguments or words after the file", () => {
    const text = "map_Kd -s 1 1 1 -o 2 tex.png trailing\n";
    expect(rewrite(materialLibraryReferences, "m/x.mtl", text, moves("m/x.mtl", { "m/tex.png": "t/tex.png" }))).toBe("map_Kd -s 1 1 1 -o 2 ../t/tex.png trailing\n");
  });

  it("keeps a moved file's references at their targets, and changes nothing when nothing they name moved", () => {
    expect(rewrite(materialLibraryReferences, "crate.mtl", mtl, moves("models/crate.mtl"))).toBe(mtl.replace("tex\\crate.png", "models/tex/crate.png").replace("./tex/n.png", "models/tex/n.png"));
    expect(rewrite(materialLibraryReferences, "models/crate.mtl", mtl, moves("models/crate.mtl", { "other.png": "x.png" }))).toBeNull();
  });
});

describe("glTF references", () => {
  const text = `{\n  "asset": { "version": "2.0" },\n  "buffers": [ { "uri": "car.bin", "byteLength": 4 }, { "uri": "data:application/octet-stream;base64,AA==" } ],\n  "images": [ { "uri": "./tex/paint%20red.png" }, { "uri": "https://x.org/a.png" } ]\n}\n`;

  it("reads the buffers and images that are relative paths, decoded", () => {
    expect(modelReferences.read("models/car.gltf", text)).toEqual(["models/car.bin", "models/tex/paint red.png"]);
    expect(modelReferences.read("models/car.glb", text)).toEqual([]);
  });

  it("rewrites URIs in place, encoded, keeping the file's layout", () => {
    const next = rewrite(modelReferences, "vehicles/car.gltf", text, moves("models/car.gltf", { "models/tex/paint red.png": "models/textures/paint red.png" }));
    expect(next).toBe(text.replace('"car.bin"', '"../models/car.bin"').replace('"./tex/paint%20red.png"', '"../models/textures/paint%20red.png"'));
  });
});
