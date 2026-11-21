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
