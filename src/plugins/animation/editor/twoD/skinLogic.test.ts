// The 2D bone editor's rules (ADR 0371, 0373; T56): bone creation, moves and parenting, mesh, auto-weights summing to 1,
// brush strokes staying normalised, refusals with reasons, and the sidecar round trip of what the edits make. Positions are
// compared to 6 decimals: the edits round to 1e-6.
import { describe, expect, it } from "vitest";
import { refusalOf } from "../../../../editor/sdk";
import type { Pixels } from "../../../../engine/animation/sprites/islands";
import { parseSliceSkin, SPRITE_2D_LIMITS, sliceSkinToJson, type SliceSkin } from "../../../../engine/animation/sprites/sidecar";
import { rectMesh } from "../../../../engine/animation/sprites/spriteMesh";
import { defaultImportSettings, formatImportSettings, parseImportSettings } from "../../../../engine/scene/importSettings";
import {
  addBone,
  autoWeight,
  bonePoses,
  descendantsOf,
  EMPTY_SKIN,
  envelopeWeights,
  makeMesh,
  moveBone,
  moveVertex,
  paintWeights,
  removeBone,
  renameBone,
  reparentBone,
  setBoneTip,
  setMesh,
  skinProblem,
  toImagePoint,
  toSlicePoint,
  weightsOf,
  type BrushStroke,
} from "./skinLogic";

const ok = <T,>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};
const near = (a: readonly number[], b: readonly number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 6));
const weightSum = (w: readonly number[]) => w.filter((_, i) => i % 2 === 1).reduce((s, x) => s + x, 0);

/** A 64 × 64 slice with a hip (32, 8) pointing up 24 px and a chest on its tip pointing up 24 more. */
function rig(): SliceSkin {
  let skin = ok(addBone(EMPTY_SKIN, { name: "hip", parent: null, head: [32, 8], tip: [32, 32] }));
  skin = ok(addBone(skin, { name: "chest", parent: "hip", head: [32, 32], tip: [32, 56] }));
  return skin;
}
const meshed = (skin: SliceSkin): SliceSkin => ok(setMesh(skin, rectMesh(64, 64, 16)));

describe("creating bones", () => {
  it("a root takes the slice-frame position and the angle of its drag; length is the drag's", () => {
    const skin = ok(addBone(EMPTY_SKIN, { name: "hip", parent: null, head: [32, 8], tip: [32, 32] }));
    expect(skin.bones).toEqual([{ name: "hip", parent: null, position: [32, 8], rotation: 90, length: 24 }]);
  });

  it("a child is placed in its parent's frame: at the parent's tip it sits at (length, 0) with no turn", () => {
    const { bones } = rig();
    expect(bones[1]).toEqual({ name: "chest", parent: "hip", position: [24, 0], rotation: 0, length: 24 });
    near(bonePoses(rig())[1]!.tip, [32, 56]);
  });

  it("names a new bone bone_<n> avoiding taken names", () => {
    let skin = ok(addBone(EMPTY_SKIN, { parent: null, head: [0, 0], tip: [10, 0] }));
    skin = ok(addBone(skin, { name: "bone_3", parent: null, head: [0, 0], tip: [10, 0] }));
    skin = ok(addBone(skin, { parent: null, head: [0, 0], tip: [10, 0] }));
    expect(skin.bones.map((b) => b.name)).toEqual(["bone_1", "bone_3", "bone_4"]);
  });

  it("refuses with a reason", () => {
    const skin = rig();
    expect(refusalOf(addBone(skin, { name: "hip", parent: null, head: [0, 0], tip: [5, 0] }))).toMatch(/already a bone named "hip"/);
    expect(refusalOf(addBone(skin, { name: " ", parent: null, head: [0, 0], tip: [5, 0] }))).toMatch(/needs a name/);
    expect(refusalOf(addBone(skin, { parent: "tail", head: [0, 0], tip: [5, 0] }))).toMatch(/no bone named "tail"/);
    expect(refusalOf(addBone(skin, { parent: null, head: [0, 0], tip: [0.5, 0] }))).toMatch(/at least 1 pixel/);
    expect(refusalOf(addBone(skin, { parent: null, head: [Number.NaN, 0], tip: [5, 0] }))).toMatch(/numbers/);
    const full: SliceSkin = { ...EMPTY_SKIN, bones: Array.from({ length: SPRITE_2D_LIMITS.bones }, (_, i) => ({ name: `b${i}`, parent: null, position: [0, 0], rotation: 0, length: 1 })) };
    expect(refusalOf(addBone(full, { parent: null, head: [0, 0], tip: [5, 0] }))).toMatch(/at most 128 bones/);
  });
});

describe("moving bones", () => {
  it("moves a bone's head keeping its direction; children go with it", () => {
    const moved = ok(moveBone(rig(), "hip", [40, 10]));
    const poses = bonePoses(moved);
    near(poses[0]!.head, [40, 10]);
    near(poses[0]!.tip, [40, 34]);
    near(poses[1]!.head, [40, 34]); // still on the hip's tip
    expect(poses[1]!.angle).toBeCloseTo(90, 6);
  });

  it("moves a child's head in its parent's frame", () => {
    const moved = ok(moveBone(rig(), "chest", [36, 30]));
    near(bonePoses(moved)[1]!.head, [36, 30]);
    expect(moved.bones[0]).toEqual(rig().bones[0]);
  });

  it("turns and resizes by the tip, the head staying", () => {
    const turned = ok(setBoneTip(rig(), "hip", [56, 8]));
    expect(turned.bones[0]!.rotation).toBeCloseTo(0, 6);
    expect(turned.bones[0]!.length).toBeCloseTo(24, 6);
    near(bonePoses(turned)[0]!.head, [32, 8]);
    const longer = ok(setBoneTip(rig(), "chest", [32, 80]));
    expect(longer.bones[1]!.length).toBeCloseTo(48, 6);
    expect(longer.bones[1]!.rotation).toBeCloseTo(0, 6); // relative to the hip's own 90°
  });

  it("refuses with a reason", () => {
    expect(refusalOf(moveBone(rig(), "tail", [0, 0]))).toMatch(/no bone named "tail"/);
    expect(refusalOf(moveBone(rig(), "hip", [Number.NaN, 0]))).toMatch(/numbers/);
    expect(refusalOf(setBoneTip(rig(), "hip", [32, 8.2]))).toMatch(/at least 1 pixel/);
    expect(refusalOf(setBoneTip(rig(), "tail", [0, 0]))).toMatch(/no bone named "tail"/);
  });
});

describe("parenting", () => {
  it("reparenting keeps the bone where it is on the sprite, and its children too", () => {
    let skin = ok(addBone(rig(), { name: "arm", parent: null, head: [10, 40], tip: [10, 60] }));
    skin = ok(addBone(skin, { name: "hand", parent: "arm", head: [10, 60], tip: [10, 70] }));
    const before = bonePoses(skin);
    const moved = ok(reparentBone(skin, "arm", "chest"));
    expect(moved.bones.find((b) => b.name === "arm")!.parent).toBe("chest");
    const after = bonePoses(moved);
    for (let i = 0; i < before.length; i++) {
      near(after[i]!.head, before[i]!.head);
      near(after[i]!.tip, before[i]!.tip);
    }
    const root = ok(reparentBone(moved, "arm", null));
    expect(root.bones.find((b) => b.name === "arm")!.parent).toBeNull();
    near(bonePoses(root)[2]!.head, before[2]!.head);
    expect(ok(reparentBone(skin, "arm", null))).toBe(skin);
  });

  it("refuses itself, a cycle and unknown names with a reason", () => {
    const skin = rig();
    expect(refusalOf(reparentBone(skin, "hip", "hip"))).toMatch(/own parent/);
    expect(refusalOf(reparentBone(skin, "hip", "chest"))).toMatch(/cycle/);
    expect(refusalOf(reparentBone(skin, "hip", "tail"))).toMatch(/no bone named "tail"/);
    expect(refusalOf(reparentBone(skin, "tail", null))).toMatch(/no bone named "tail"/);
    expect(descendantsOf(skin, "hip")).toEqual(["chest"]);
  });

  it("renames and moves the children's parent name; refuses taken and empty names", () => {
    const renamed = ok(renameBone(rig(), "hip", "pelvis"));
    expect(renamed.bones.map((b) => [b.name, b.parent])).toEqual([["pelvis", null], ["chest", "pelvis"]]);
    expect(refusalOf(renameBone(rig(), "hip", "chest"))).toMatch(/already a bone named "chest"/);
    expect(refusalOf(renameBone(rig(), "hip", ""))).toMatch(/needs a name/);
    expect(ok(renameBone(rig(), "hip", "hip"))).toEqual(rig());
  });

  it("removing a bone lifts its children to its parent in place and remaps weights", () => {
    let skin = meshed(rig());
    skin = ok(addBone(skin, { name: "head", parent: "chest", head: [32, 56], tip: [32, 63] }));
    skin = ok(autoWeight(skin));
    const before = bonePoses(skin);
    const removed = ok(removeBone(skin, "chest"));
    expect(removed.bones.map((b) => [b.name, b.parent])).toEqual([["hip", null], ["head", "hip"]]);
    near(bonePoses(removed)[1]!.head, before[2]!.head);
    expect(skinProblem(removed)).toBeNull();
    for (const w of removed.weights!) {
      expect(w.every((x, i) => i % 2 === 1 || x < 2)).toBe(true);
      expect(weightSum(w)).toBeCloseTo(1, 9);
    }
    expect(refusalOf(removeBone(skin, "tail"))).toMatch(/no bone named "tail"/);
    // The last bone's weights go with it.
    const onlyHip = ok(removeBone(ok(removeBone(skin, "head")), "chest"));
    expect(skinProblem(ok(removeBone(onlyHip, "hip")))).toBeNull();
    expect(ok(removeBone(onlyHip, "hip")).weights).toBeNull();
  });
});

describe("mesh", () => {
  const OPAQUE: Pixels = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4).fill(255) };

  it("a mesh from the slice's pixels is its outline; without pixels the rectangle", () => {
    const fromPixels = makeMesh({ rect: [0, 0, 16, 16] }, OPAQUE, 8);
    expect(fromPixels.vertices.length).toBeGreaterThanOrEqual(8);
    const fromRect = makeMesh({ rect: [0, 0, 32, 16] }, null, 8);
    expect(Math.max(...fromRect.vertices.filter((_, i) => i % 2 === 0))).toBe(32);
  });

  it("setting a mesh computes the weights from the bones, none without bones", () => {
    const withBones = ok(setMesh(rig(), rectMesh(64, 64, 16)));
    expect(withBones.weights).toHaveLength(withBones.mesh!.vertices.length / 2);
    expect(ok(setMesh(EMPTY_SKIN, rectMesh(64, 64, 16))).weights).toBeNull();
  });

  it("refuses a mesh past the limits", () => {
    const big = { vertices: Array.from({ length: (SPRITE_2D_LIMITS.vertices + 1) * 2 }, () => 0), triangles: [0, 1, 2] };
    expect(refusalOf(setMesh(rig(), big))).toMatch(/at most 4096 vertices/);
    const tooMany = { vertices: [0, 0, 1, 0, 0, 1], triangles: Array.from({ length: (SPRITE_2D_LIMITS.triangles + 1) * 3 }, () => 0) };
    expect(refusalOf(setMesh(rig(), tooMany))).toMatch(/at most 8192 triangles/);
  });

  it("moves one vertex and keeps its weights; refuses without a mesh or for a missing vertex", () => {
    const skin = ok(autoWeight(meshed(rig())));
    const moved = ok(moveVertex(skin, 0, [3, 4]));
    expect(moved.mesh!.vertices.slice(0, 2)).toEqual([3, 4]);
    expect(moved.weights).toBe(skin.weights);
    expect(refusalOf(moveVertex(rig(), 0, [0, 0]))).toMatch(/no mesh/);
    expect(refusalOf(moveVertex(skin, 9999, [0, 0]))).toMatch(/no vertex 9999/);
    expect(refusalOf(moveVertex(skin, 0, [Number.NaN, 0]))).toMatch(/numbers/);
  });

  it("converts between image pixels (y down) and the slice frame (y up)", () => {
    const rect = [16, 32, 20, 10] as const;
    expect(toSlicePoint(rect, 16, 42)).toEqual([0, 0]);
    expect(toSlicePoint(rect, 36, 32)).toEqual([20, 10]);
    expect(toImagePoint(rect, ...toSlicePoint(rect, 25, 37))).toEqual([25, 37]);
  });
});

describe("auto-weights", () => {
  for (const mode of ["distance", "envelope"] as const) {
    it(`${mode}: every vertex has at most 4 bones whose weights sum to 1`, () => {
      let skin = rig();
      for (const [name, y] of [["a", 5], ["b", 20], ["c", 40], ["d", 60], ["e", 30]] as const) skin = ok(addBone(skin, { name, parent: null, head: [10, y], tip: [12, y + 6] }));
      const weighted = ok(autoWeight(meshed(skin), mode));
      expect(weighted.weights).toHaveLength(weighted.mesh!.vertices.length / 2);
      for (const w of weighted.weights!) {
        expect(w.length).toBeGreaterThan(0);
        expect(w.length).toBeLessThanOrEqual(8);
        expect(weightSum(w)).toBeCloseTo(1, 9);
      }
      expect(skinProblem(weighted)).toBeNull();
    });
  }

  it("distance: a vertex on a bone takes it alone; the nearest bone dominates", () => {
    const skin = ok(autoWeight({ ...rig(), mesh: { vertices: [32, 20, 32, 70], triangles: [0, 1, 0] } }, "distance"));
    expect(skin.weights![0]).toEqual([0, 1]);
    expect(skin.weights![1]![0]).toBe(1); // nearer the chest than the hip
  });

  it("envelope: a vertex far from a bone is untouched by it; outside every reach takes the nearest bone", () => {
    const bones = rig().bones;
    const w = envelopeWeights([32, 12, 0, 0], bones);
    expect(w[0]).toEqual([0, 1]); // inside the hip's reach only
    expect(w[1]).toEqual([0, 1]); // far from both: nearest (the hip is closer to the origin corner)
    const overlap = envelopeWeights([32, 32], bones)[0]!; // the joint: both reaches hold it
    expect(overlap.filter((_, i) => i % 2 === 0).sort()).toEqual([0, 1]);
    expect(weightSum(overlap)).toBeCloseTo(1, 9);
  });

  it("refuses without bones or a mesh, saying which", () => {
    expect(refusalOf(autoWeight(EMPTY_SKIN))).toMatch(/add a bone first/);
    expect(refusalOf(autoWeight(rig()))).toMatch(/no mesh/);
  });
});

describe("painting weights", () => {
  const stroke = (patch: Partial<BrushStroke> = {}): BrushStroke => ({ center: [32, 56], radius: 20, strength: 0.5, bone: "chest", mode: "add", ...patch });
  const base = () => ok(autoWeight(meshed(rig()), "envelope"));

  it("a stroke leaves every touched vertex normalised (≤ 4 bones, sum 1) and moves weight toward the bone", () => {
    let skin = base();
    skin = ok(addBone(skin, { name: "x", parent: null, head: [5, 5], tip: [9, 9] }));
    skin = ok(addBone(skin, { name: "y", parent: null, head: [50, 5], tip: [55, 9] }));
    skin = ok(addBone(skin, { name: "z", parent: null, head: [5, 50], tip: [9, 55] }));
    skin = ok(autoWeight(skin, "distance"));
    const chest = skin.bones.findIndex((b) => b.name === "chest");
    const before = skin.weights!.map((w) => [...w]);
    let painted = skin;
    for (let i = 0; i < 6; i++) painted = ok(paintWeights(painted, stroke({ strength: 0.6 })));
    for (const w of painted.weights!) {
      expect(w.length).toBeLessThanOrEqual(8);
      expect(weightSum(w)).toBeCloseTo(1, 9);
    }
    const of = (w: readonly number[], b: number) => w.find((_, i) => i % 2 === 0 && w[i] === b) === undefined ? 0 : w[w.indexOf(b) + 1]!;
    const v = painted.mesh!.vertices;
    const dist = (i: number) => Math.hypot(v[i * 2]! - 32, v[i * 2 + 1]! - 56);
    let centre = 0;
    for (let i = 0; i < painted.weights!.length; i++) if (dist(i) < dist(centre)) centre = i;
    expect(of(painted.weights![centre]!, chest)).toBeGreaterThan(of(before[centre]!, chest));
    expect(skinProblem(painted)).toBeNull();
  });

  it("vertices outside the radius keep their weights exactly", () => {
    const skin = base();
    const painted = ok(paintWeights(skin, stroke({ radius: 10 })));
    const v = skin.mesh!.vertices;
    skin.weights!.forEach((w, i) => {
      if (Math.hypot(v[i * 2]! - 32, v[i * 2 + 1]! - 56) > 10) expect(painted.weights![i]).toEqual(w);
    });
  });

  it("add reaches 1 for a full-strength stroke on the centre vertex; subtract hands it back", () => {
    const skin = ok(setMesh(rig(), { vertices: [32, 20, 40, 20, 32, 28], triangles: [0, 1, 2] }));
    const full = ok(paintWeights(skin, { center: [32, 20], radius: 5, strength: 1, bone: "chest", mode: "add" }));
    expect(full.weights![0]).toEqual([1, 1]);
    const back = ok(paintWeights(full, { center: [32, 20], radius: 5, strength: 1, bone: "chest", mode: "subtract" }));
    // Chest was the only influence there, so a vertex never loses its last one.
    expect(back.weights![0]).toEqual([1, 1]);
    const half = ok(paintWeights(skin, { center: [32, 20], radius: 5, strength: 0.5, bone: "chest", mode: "add" }));
    const sub = ok(paintWeights(half, { center: [32, 20], radius: 5, strength: 1, bone: "chest", mode: "subtract" }));
    expect(weightSum(sub.weights![0]!)).toBeCloseTo(1, 9);
    expect(sub.weights![0]![0]).toBe(0);
  });

  it("smooth blends toward the neighbours and stays normalised", () => {
    let skin = ok(autoWeight(meshed(rig()), "envelope"));
    skin = ok(paintWeights(skin, stroke({ center: [10, 10], radius: 6, strength: 1, bone: "chest" })));
    const smoothed = ok(paintWeights(skin, stroke({ center: [10, 10], radius: 20, strength: 1, mode: "smooth" })));
    for (const w of smoothed.weights!) expect(weightSum(w)).toBeCloseTo(1, 9);
    expect(smoothed.weights).not.toEqual(skin.weights);
  });

  it("makes weights by distance first when the skin has none", () => {
    const skin = meshed(rig());
    const noWeights: SliceSkin = { ...skin, weights: null };
    const painted = ok(paintWeights(noWeights, stroke()));
    expect(painted.weights).toHaveLength(skin.mesh!.vertices.length / 2);
    expect(weightsOf(noWeights)).toHaveLength(skin.mesh!.vertices.length / 2);
  });

  it("refuses with a reason", () => {
    expect(refusalOf(paintWeights(rig(), stroke()))).toMatch(/no mesh/);
    expect(refusalOf(paintWeights(ok(setMesh(EMPTY_SKIN, rectMesh(8, 8, 4))), stroke()))).toMatch(/add a bone first/);
    expect(refusalOf(paintWeights(base(), stroke({ bone: "tail" })))).toMatch(/no bone named "tail"/);
    expect(refusalOf(paintWeights(base(), stroke({ radius: 0 })))).toMatch(/radius/);
    expect(refusalOf(paintWeights(base(), stroke({ radius: Number.NaN })))).toMatch(/radius/);
    expect(refusalOf(paintWeights(base(), stroke({ strength: 0 })))).toMatch(/strength/);
    expect(refusalOf(paintWeights(base(), stroke({ strength: 1.5 })))).toMatch(/strength/);
    expect(refusalOf(paintWeights(base(), stroke({ center: [500, 500] })))).toMatch(/touches no vertices/);
  });
});

describe("the sidecar round trip", () => {
  it("a skin the edits make is read back unchanged from the formatted sidecar", () => {
    let skin = rig();
    skin = ok(addBone(skin, { name: "arm", parent: "chest", head: [32, 50], tip: [50, 50] }));
    skin = ok(reparentBone(skin, "arm", "hip"));
    skin = ok(moveBone(skin, "arm", [20, 30]));
    skin = ok(autoWeight(meshed(skin), "envelope"));
    skin = ok(paintWeights(skin, { center: [20, 30], radius: 12, strength: 0.7, bone: "arm", mode: "add" }));
    skin = ok(moveVertex(skin, 3, [7.25, 9.5]));
    expect(skinProblem(skin)).toBeNull();
    const text = formatImportSettings({ ...defaultImportSettings(), sprites: [{ name: "torso", rect: [0, 0, 64, 64], pivot: [0.5, 0], skin }] });
    const read = parseImportSettings(JSON.parse(text), "rig.png.meta.json");
    expect(read.problems).toEqual([]);
    const back = read.settings.sprites[0]!.skin!;
    expect(back.bones).toEqual(skin.bones);
    expect(back.mesh).toEqual(skin.mesh);
    expect(back.weights).toHaveLength(skin.weights!.length);
    back.weights!.forEach((w, i) => near(w, skin.weights![i]!));
    // The skin's own JSON parses to the same skin.
    const problems: string[] = [];
    expect(parseSliceSkin(JSON.parse(JSON.stringify(sliceSkinToJson(skin))), "skin", problems)?.bones).toEqual(skin.bones);
    expect(problems).toEqual([]);
  });
});
