// The model loader reads an .obj's material libraries and an .mtl's texture maps as the Wavefront specifications
// define them (ADR 0394): every file of every `mtllib` (the first named searched first), and a map's one file name
// after its options, whatever arguments those take.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../index";
import { loadMeshes } from "../scene/models";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const text = (s: string) => `data:text/plain;base64,${Buffer.from(s).toString("base64")}`;

const OBJ = ["mtllib a.mtl \\", "  libs/b.mtl", "mtllib missing.mtl", "o Two", "v 0 0 0", "v 1 0 0", "v 0 1 0", "v 1 1 0", "usemtl Red", "f 1 2 3", "usemtl Blue", "f 2 4 3", ""].join("\n");

describe("Wavefront material libraries and maps (ADR 0394)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "models/two.obj": text(OBJ),
        // Red's map has options three.js's own reader would take as part of the name.
        "models/a.mtl": text("newmtl Red\nKd 1 0 0\nmap_Kd -clamp on -s 2 -imfchan r -o 0.5 0.5 red.png\n"),
        // Blue only here; Red here too, but a.mtl is named first, so its Red wins.
        "models/libs/b.mtl": text("newmtl Red\nKd 0 1 0\nnewmtl Blue\nKd 0 0 1\nmap_Kd\tblue.png\n"),
        "models/red.png": PNG,
        "models/blue.png": PNG,
      }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Assets.clearSources();
  });

  it("loads every mtllib file and each map's file after its options", async () => {
    const [mesh] = await loadMeshes("asset:models/two.obj#Two");
    expect(mesh.surfaces.map((s) => [s.name, s.map?.src ?? null])).toEqual([
      ["Red", Assets.url("models/red.png")],
      ["Blue", Assets.url("models/blue.png")],
    ]);
    expect(mesh.surfaces[0].color.slice(0, 3)).toEqual([1, 0, 0]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"missing.mtl"'));
  });
});
