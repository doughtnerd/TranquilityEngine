// ADR 0371 "Sprites and 2D" (T21): image sidecars' flipbooks and slice skins, flipbook clips and image sub-assets,
// the outline mesh (islands → outline → triangulation), automatic weights and the 2D skeleton model.
import { afterEach, describe, expect, it } from "vitest";
import { Assets } from "../../scene/Assets";
import { formatImportSettings, parseImportSettings } from "../../scene/importSettings";
import { affineApply, affineFromRows, affineMultiply } from "./affine2d";
import { autoWeights } from "./autoWeights";
import { flipbookClip, imageSubAsset, imageSubAssetKinds, imageSubAssets } from "./flipbook";
import { alphaIslands, type Pixels } from "./islands";
import { sliceOutlines } from "./outline";
import type { Bone2D, SpriteMesh } from "./sidecar";
import { boneBinds, skeleton2D, sliceFrame } from "./skeleton2d";
import { outlineMesh, rectMesh } from "./spriteMesh";
import { insidePolygon, polygonArea, triangulatePolygon, type Point2 } from "./triangulate";

afterEach(() => Assets.clearSources());

const SIDECAR = {
  format: "myco.import@1",
  pixelsPerUnit: 16,
  sprites: [
    { name: "run_0", rect: [0, 0, 16, 16], pivot: [0.5, 0] },
    { name: "run_1", rect: [16, 0, 16, 16], pivot: [0.5, 0] },
    {
      name: "torso",
      rect: [0, 16, 32, 32],
      pivot: [0.5, 0],
      skin: {
        bones: [
          { name: "hip", position: [16, 4], rotation: 90, length: 12 },
          { name: "chest", parent: "hip", position: [12, 0], length: 10 },
        ],
        mesh: { vertices: [0, 0, 32, 0, 32, 32, 0, 32], triangles: [0, 1, 2, 0, 2, 3] },
        weights: [[0, 1], [0, 1], [1, 1], [0, 0.25, 1, 0.75]],
      },
    },
  ],
  flipbooks: { run: { slices: ["run_0", "run_1"], fps: 8 }, once: { slices: ["run_1"], loop: false } },
};

describe("image sidecars: flipbooks and slice skins (ADR 0371)", () => {
  it("parse and write back unchanged", () => {
    const { settings, problems } = parseImportSettings(SIDECAR);
    expect(problems).toEqual([]);
    expect(settings.flipbooks).toEqual({ run: { slices: ["run_0", "run_1"], fps: 8, loop: true }, once: { slices: ["run_1"], fps: 12, loop: false } });
    const torso = settings.sprites[2]!;
    expect(torso.skin!.bones.map((b) => [b.name, b.parent])).toEqual([["hip", null], ["chest", "hip"]]);
    expect(torso.skin!.weights).toEqual([[0, 1], [0, 1], [1, 1], [1, 0.75, 0, 0.25]]);
    const text = formatImportSettings(settings);
    const again = parseImportSettings(JSON.parse(text));
    expect(again.problems).toEqual([]);
    expect(again.settings).toEqual(settings);
    // One flipbook and one slice per line.
    expect(text).toContain('    "run": { "slices": ["run_0","run_1"], "fps": 8 }');
    expect(text.split("\n").filter((l) => l.includes('"name": "torso"'))).toHaveLength(1);
  });

  it("is lenient: bad values fall back with one problem each", () => {
    const { settings, problems } = parseImportSettings({
      format: "myco.import@1",
      sprites: [
        {
          name: "a",
          rect: [0, 0, 8, 8],
          skin: {
            bones: [{ name: "x", parent: "ghost" }, { name: "x" }, { name: "y", parent: "z" }, { name: "z", parent: "y" }],
            mesh: { vertices: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 7] },
          },
        },
        { name: "b", rect: [8, 0, 8, 8], skin: { bones: [{ name: "r" }], mesh: { vertices: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2] }, weights: [[0, 1]] } },
      ],
      flipbooks: { "bad/name": { slices: ["a"] }, walk: { slices: ["a", 3, "nope"], fps: -2 } },
    });
    expect(settings.sprites[0]!.skin!.bones.map((b) => [b.name, b.parent])).toEqual([["x", null], ["y", null], ["z", "y"]]);
    expect(settings.sprites[0]!.skin!.mesh).toBeNull();
    expect(settings.sprites[1]!.skin!.weights).toBeNull();
    expect(settings.flipbooks).toEqual({ walk: { slices: ["a", "nope"], fps: 12, loop: true } });
    expect(problems.join("\n")).toMatch(/no bone named "ghost"/);
    expect(problems.join("\n")).toMatch(/already a bone named "x"/);
    expect(problems.join("\n")).toMatch(/makes a cycle/);
    expect(problems.join("\n")).toMatch(/triangles: must be vertex index triples/);
    expect(problems.join("\n")).toMatch(/weights: must list 3 vertices/);
    expect(problems.join("\n")).toMatch(/bad\/name: a name can't contain/);
    expect(problems.join("\n")).toMatch(/flipbooks.walk names slices the image doesn't have \(nope\)/);
  });
});

describe("flipbook clips and image sub-assets (ADR 0371)", () => {
  it("one discrete sprite track over the slices at the flipbook's rate", () => {
    const clip = flipbookClip("sheets/hero.png", "run", { slices: ["run_0", "run_1", "run_2"], fps: 10, loop: false });
    expect(clip).toMatchObject({ name: "run", rate: 10, duration: 0.3, loop: false });
    expect(clip.tracks).toEqual([
      {
        kind: "discrete",
        target: { nodePath: "", component: "engine.SpriteRenderer", field: "sprite" },
        valueType: "asset",
        keys: [[0, "asset:sheets/hero.png#run_0"], [0.1, "asset:sheets/hero.png#run_1"], [0.2, "asset:sheets/hero.png#run_2"]],
      },
    ]);
  });

  it("`image.png#Flip/<name>` is an animclip and resolves to the flipbook's clip", () => {
    Assets.addSource(Assets.fromObject({ "hero.png": "data:,", "hero.png.meta.json": SIDECAR }));
    expect(imageSubAssetKinds("Flip/run")).toEqual(["animclip"]);
    expect(imageSubAssetKinds("run_0")).toEqual(["sprite"]);
    expect(imageSubAssets(Assets.importSettings("hero.png"))).toEqual(["Flip/run", "Flip/once"]);
    expect(imageSubAsset("asset:hero.png#Flip/run")).toMatchObject({ kind: "clip", clip: { name: "run", rate: 8, duration: 0.25, loop: true } });
    expect(imageSubAsset("asset:hero.png#Flip/walk")).toBeNull();
    expect(imageSubAsset("asset:hero.png#run_0")).toBeNull();
  });
});

// --- meshes ---------------------------------------------------------------------------------------------------------

const triArea = (pts: readonly Point2[], t: readonly number[], i: number) => {
  const a = pts[t[i]!]!, b = pts[t[i + 1]!]!, c = pts[t[i + 2]!]!;
  return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
};
const meshPoints = (m: SpriteMesh): Point2[] => Array.from({ length: m.vertices.length / 2 }, (_, i): Point2 => [m.vertices[i * 2]!, m.vertices[i * 2 + 1]!]);
const meshArea = (m: SpriteMesh) => {
  const pts = meshPoints(m);
  let s = 0;
  for (let i = 0; i < m.triangles.length; i += 3) s += triArea(pts, m.triangles, i);
  return s;
};
const minTriangle = (pts: readonly Point2[], t: readonly number[]) => {
  let min = Infinity;
  for (let i = 0; i < t.length; i += 3) min = Math.min(min, triArea(pts, t, i));
  return min;
};
const insideMesh = (m: SpriteMesh, p: Point2) => {
  const pts = meshPoints(m);
  for (let i = 0; i < m.triangles.length; i += 3) {
    const tri = [pts[m.triangles[i]!]!, pts[m.triangles[i + 1]!]!, pts[m.triangles[i + 2]!]!];
    if (insidePolygon(tri, p)) return true;
  }
  return false;
};

describe("constrained triangulation", () => {
  // An L with a notch: concave, so plain Delaunay of the points would cover the notch.
  const L: Point2[] = [[0, 0], [10, 0], [10, 3], [3, 3], [3, 10], [0, 10]];

  it("covers the polygon exactly, counter-clockwise, with no degenerate triangle, keeping the outline's edges", () => {
    const interior: Point2[] = [[1.5, 1.5], [5, 1.5], [8, 1.5], [1.5, 5], [1.5, 8], [20, 20]];
    const t = triangulatePolygon([...L].reverse(), interior);
    expect(t.points).toHaveLength(L.length + 5); // the point outside is dropped
    let sum = 0;
    for (let i = 0; i < t.triangles.length; i += 3) sum += triArea(t.points, t.triangles, i);
    expect(sum).toBeCloseTo(polygonArea(L), 9);
    expect(minTriangle(t.points, t.triangles)).toBeGreaterThan(0.1);
    // No triangle covers the notch.
    for (let i = 0; i < t.triangles.length; i += 3) {
      const c: Point2 = [0, 1].map((k) => (t.points[t.triangles[i]!]![k]! + t.points[t.triangles[i + 1]!]![k]! + t.points[t.triangles[i + 2]!]![k]!) / 3) as unknown as Point2;
      expect(insidePolygon(L, c)).toBe(true);
    }
  });

  it("splits the two triangles beside an edge a point lies on", () => {
    // The square's diagonal from ear clipping runs through (1, 1).
    const t = triangulatePolygon([[0, 0], [2, 0], [2, 2], [0, 2]], [[1, 1]]);
    expect(t.triangles.length / 3).toBe(4);
    expect(minTriangle(t.points, t.triangles)).toBeCloseTo(1, 9);
  });
});

/** A `w` × `h` image whose pixels are opaque where `on(x, y)` (rows from the top). */
function image(w: number, h: number, on: (x: number, y: number) => boolean): Pixels {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[(y * w + x) * 4 + 3] = on(x, y) ? 255 : 0;
  return { width: w, height: h, data };
}

describe("outline meshes (islands → outline → triangulation)", () => {
  // A square with a notch out of its top right and a one-pixel hole, plus two pixels touching its bottom right corner
  // only diagonally, inside the slice [4, 2, 24, 24] of a 32 × 32 image (rows from the top).
  const square = (x: number, y: number) => x >= 8 && x < 20 && y >= 6 && y < 18 && !(x >= 14 && y < 10) && !(x === 10 && y === 14);
  const disc = (x: number, y: number) => square(x, y) || (x === 20 && y === 18) || (x === 21 && y === 19);
  const px = image(32, 32, disc);
  const rect: [number, number, number, number] = [4, 2, 24, 24];

  it("finds islands (diagonal neighbours join), as the Sprite Editor's auto-slice does", () => {
    const islands = alphaIslands(px, 0, rect);
    expect(islands.boxes).toHaveLength(1);
    expect(islands.boxes[0]).toEqual([8, 6, 14, 14]);
  });

  it("covers every opaque pixel's centre with non-degenerate triangles that add up to the outline's area", () => {
    const mesh = outlineMesh(px, rect, { tolerance: 0.4, spacing: 4 });
    const outline = sliceOutlines(px, rect, { tolerance: 0.4 })[0]!;
    expect(meshArea(mesh)).toBeCloseTo(polygonArea(outline), 6);
    expect(minTriangle(meshPoints(mesh), mesh.triangles)).toBeGreaterThan(1e-3);
    expect(mesh.vertices.length / 2).toBeGreaterThan(outline.length); // interior points
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        if (!disc(x, y)) continue;
        // Image pixel (x, y from the top) → the slice's frame (y up from the rect's bottom edge).
        expect(insideMesh(mesh, [x + 0.5 - rect[0], rect[1] + rect[3] - (y + 0.5)])).toBe(true);
      }
    }
  });

  it("simplifies within the tolerance", () => {
    const round = image(32, 32, (x, y) => (x - 15.5) ** 2 + (y - 13.5) ** 2 <= 81);
    const rough = sliceOutlines(round, rect, { tolerance: 0 })[0]!;
    const smooth = sliceOutlines(round, rect, { tolerance: 1.5 })[0]!;
    expect(smooth.length).toBeLessThan(rough.length / 2);
    expect(polygonArea(smooth)).toBeGreaterThan(0);
  });

  it("meshes the rectangle when nothing is opaque", () => {
    const mesh = outlineMesh(image(8, 8, () => false), [0, 0, 8, 8], { spacing: 2 });
    expect(meshArea(mesh)).toBeCloseTo(64, 9);
    expect(meshArea(rectMesh(10, 6, 2))).toBeCloseTo(60, 9);
    expect(minTriangle(meshPoints(mesh), mesh.triangles)).toBeGreaterThan(0.1);
  });
});

// --- bones ----------------------------------------------------------------------------------------------------------

const ARM: Bone2D[] = [
  { name: "upper", parent: null, position: [4, 8], rotation: 0, length: 10 },
  { name: "lower", parent: "upper", position: [10, 0], rotation: 0, length: 10 },
];

describe("automatic weights by bone distance", () => {
  it("are normalised, at most 4, and favour the nearest bone", () => {
    const bones: Bone2D[] = [...ARM, { name: "a", parent: null, position: [0, 0], rotation: 45, length: 3 }, { name: "b", parent: null, position: [30, 0], rotation: 0, length: 0 }, { name: "c", parent: null, position: [0, 16], rotation: 0, length: 2 }];
    const vertices = [5, 9, 20, 7, 14, 8, 12, 2];
    const w = autoWeights(vertices, bones);
    expect(w).toHaveLength(4);
    for (const pairs of w) {
      expect(pairs.length / 2).toBeLessThanOrEqual(4);
      expect(pairs.filter((_, i) => i % 2 === 1).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
    }
    expect(w[0]![0]).toBe(0); // beside the upper arm
    expect(w[0]![1]).toBeGreaterThan(0.5);
    expect(w[1]![0]).toBe(1); // beside the lower arm
    expect(w[2]).toEqual([0, 1]); // on both bones (the joint): the first takes it
    expect(autoWeights([1, 1], [])).toEqual([[]]);
  });
});

describe("the 2D skeleton model", () => {
  it("binds bones in the slice's units and inverts them for the core", () => {
    const frame = sliceFrame({ rect: [0, 0, 32, 16], pivot: [0.5, 0] }, 0, 16); // pivot at pixel (16, 0)
    const binds = boneBinds([{ ...ARM[1]!, parent: "upper" }, { ...ARM[0]!, rotation: 90 }], frame);
    // upper: (4 - 16, 8) / 16 turned 90°; lower: 10 px along upper's x axis, i.e. up.
    expect(affineApply(binds[1]!, 0, 0)).toEqual([-0.75, 0.5]);
    const lower = affineApply(binds[0]!, 0, 0);
    expect(lower[0]).toBeCloseTo(-0.75, 9);
    expect(lower[1]).toBeCloseTo(0.5 + 10 / 16, 9);
    // Declared child-first: the skeleton puts the parent first, and bind × inverse bind is the identity.
    const model = skeleton2D([{ ...ARM[1]!, parent: "upper" }, { ...ARM[0]!, rotation: 90 }], frame);
    expect(model.skeleton.bones.map((b) => [b.name, b.parent])).toEqual([["upper", -1], ["lower", 0]]);
    expect(model.order).toEqual([1, 0]);
    model.skeleton.bones.forEach((b, i) => {
      const id = affineMultiply(model.binds[i]!, affineFromRows(model.skeleton.inverseBinds, i * 12));
      [1, 0, 0, 1, 0, 0].forEach((v, k) => expect(id[k]).toBeCloseTo(v, 6));
      expect(b.rest.position[2]).toBe(0);
    });
    expect(model.skeleton.bones[0]!.rest.rotation[2]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(model.skeleton.bones[1]!.rest.position).toEqual([10 / 16, 0, 0]);
  });
});
