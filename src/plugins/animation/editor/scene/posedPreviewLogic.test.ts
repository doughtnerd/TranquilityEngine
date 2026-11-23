// The posed previews' pure side (ADR 0373, T18b): the playhead's normalised time, split ranges included, and the preview
// scene built from a model's node templates.
import { describe, expect, it } from "vitest";
import { hasSkeleton, normalizedTimeAt, placementX, previewScene } from "./posedPreviewLogic";

describe("the playhead's normalised time", () => {
  it("is the playhead over the clip's length, clamped to the clip", () => {
    expect(normalizedTimeAt(0, 2)).toBe(0);
    expect(normalizedTimeAt(0.5, 2)).toBe(0.25);
    expect(normalizedTimeAt(2, 2)).toBe(1);
    expect(normalizedTimeAt(5, 2)).toBe(1);
    expect(normalizedTimeAt(-1, 2)).toBe(0);
  });

  it("is 0 for a clip with no usable length or a playhead that isn't a number", () => {
    expect(normalizedTimeAt(1, 0)).toBe(0);
    expect(normalizedTimeAt(1, -3)).toBe(0);
    expect(normalizedTimeAt(1, Number.NaN)).toBe(0);
    expect(normalizedTimeAt(1, Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizedTimeAt(Number.NaN, 2)).toBe(0);
  });

  it("puts a split range's start at the playhead's zero and its end at the playhead's end", () => {
    const range = { from: 1, to: 1.5 }; // a split range of a 2 s take
    expect(normalizedTimeAt(0, 2, range)).toBe(0.5);
    expect(normalizedTimeAt(0.25, 2, range)).toBe(0.625);
    expect(normalizedTimeAt(0.5, 2, range)).toBe(0.75);
    expect(normalizedTimeAt(9, 2, range)).toBe(0.75); // past the range's end: the range's last pose
    expect(normalizedTimeAt(-1, 2, range)).toBe(0.5);
  });

  it("keeps a range inside its take", () => {
    expect(normalizedTimeAt(0, 2, { from: -1, to: 1 })).toBe(0);
    expect(normalizedTimeAt(5, 2, { from: -1, to: 1 })).toBe(0.5);
    expect(normalizedTimeAt(0, 2, { from: 3, to: 4 })).toBe(1); // wholly after the take: its end
    expect(normalizedTimeAt(1, 2, { from: 1.5, to: 0.5 })).toBe(0.75); // an inverted range is empty, at its start
  });
});

const skinned = [
  { components: [{ type: "engine.Transform", data: { position: [1, 0, 0] } }, { type: "engine.Skeleton", data: { skeleton: "asset:hero.glb#Skeleton" } }, { type: "engine.Animator", data: { defaultClip: "asset:hero.glb#Anim/Run", speed: 2 } }] },
  { parent: 0, name: "Body", components: [{ type: "engine.SkinnedMeshRenderer", data: { mesh: "asset:hero.glb#Body#model" } }] },
  { parent: 0, name: "Cam", components: [{ type: "engine.Camera", data: {} }, { type: "engine.Transform", data: {} }] },
];

describe("the preview scene", () => {
  it("names the root, links parts to their parents and gives the Animator no default clip, no root motion and no culling", () => {
    const scene = previewScene([{ name: "Preview", templates: skinned }]);
    expect(scene.format).toMatch(/^myco\.scene@\d+$/);
    expect(scene.nodes.map((n) => [n.id, n.name, n.parent])).toEqual([
      ["p0n0", "Preview", undefined],
      ["p0n1", "Body", "p0n0"],
      ["p0n2", "Cam", "p0n0"],
    ]);
    const animator = scene.nodes[0]!.components!.find((c) => c.type === "engine.Animator")!;
    expect(animator.data).toEqual({ speed: 2, rootMotion: "none", cullingMode: "always" });
    expect(scene.nodes[0]!.components!.find((c) => c.type === "engine.Skeleton")).toBeDefined();
  });

  it("leaves a model's cameras out", () => {
    const scene = previewScene([{ name: "Preview", templates: skinned }]);
    expect(scene.nodes.flatMap((n) => n.components!.map((c) => c.type))).not.toContain("engine.Camera");
  });

  it("gives a skinned root without an Animator one, and a model without a skeleton none", () => {
    const bare = [{ components: [{ type: "engine.Skeleton", data: {} }] }];
    expect(previewScene([{ name: "A", templates: bare }]).nodes[0]!.components!.map((c) => c.type)).toEqual(["engine.Skeleton", "engine.Animator"]);
    const still = [{ components: [{ type: "engine.MeshRenderer", data: {} }] }];
    expect(previewScene([{ name: "A", templates: still }]).nodes[0]!.components!.map((c) => c.type)).toEqual(["engine.MeshRenderer"]);
    expect(hasSkeleton(bare)).toBe(true);
    expect(hasSkeleton(still)).toBe(false);
    expect(hasSkeleton([])).toBe(false);
  });

  it("keeps two placements apart, with ids of their own", () => {
    const scene = previewScene([
      { name: "Source", templates: skinned },
      { name: "Target", templates: skinned },
    ]);
    expect(new Set(scene.nodes.map((n) => n.id)).size).toBe(6);
    expect(scene.nodes.filter((n) => n.parent === undefined).map((n) => n.name)).toEqual(["Source", "Target"]);
    expect(scene.nodes[4]!.parent).toBe("p1n0");
  });

  it("places models side by side, centred on the origin", () => {
    expect(placementX(0, 1)).toBe(0);
    expect(placementX(0, 2)).toBe(-0.8);
    expect(placementX(1, 2)).toBe(0.8);
    expect(placementX(1, 3, 2)).toBe(0);
  });
});
