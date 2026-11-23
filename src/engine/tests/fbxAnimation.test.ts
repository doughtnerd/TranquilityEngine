// ADR 0371 (T14): FBX skinned meshes, bones, animation stacks and blend shapes through three's FBXLoader output, via
// `loadModel`, on a Blender-style and a Mixamo-style rig (`fixtures/fbx/skinnedFbx.ts`), and the bind-pose identity on
// both formats: every bone's model-space rest times its inverse bind is the identity (the skin draws the bind pose).
// Tolerances: 1e-4 (FBX values pass through float32 and degree/radian conversions).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../index";
import { compose, fromRowMajor3x4, identity, mul, type Matrix } from "../animation/import/space";
import type { ImportedSkeleton } from "../animation/import/skeleton";
import type { BoneTrack, CurveTrack } from "../animation/tracks";
import { loadModel } from "../scene/models";
import { skinnedFbx } from "./fixtures/fbx/skinnedFbx";
import { skinnedGltf } from "./fixtures/gltf/skinnedGltf";

const dataUrl = (text: string) => `data:application/octet-stream;base64,${Buffer.from(text).toString("base64")}`;
const close = (a: ArrayLike<number>, b: readonly number[], eps = 1e-4) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < b.length; i++) expect(Math.abs(a[i] - b[i]), `index ${i}: ${a[i]} vs ${b[i]}`).toBeLessThan(eps);
};

/** Each bone's model-space rest matrix, from the parents-first locals. */
function modelRests(s: ImportedSkeleton): Matrix[] {
  const out: Matrix[] = [];
  s.bones.forEach((b, i) => {
    const local = compose(b.rest.position, b.rest.rotation, b.rest.scale);
    out[i] = b.parent < 0 ? local : mul(out[b.parent], local);
  });
  return out;
}

function expectBindPose(s: ImportedSkeleton) {
  modelRests(s).forEach((m, i) => close(mul(m, fromRowMajor3x4(s.inverseBinds, i * 12)), Array.from(identity())));
}

describe("FBX animation import (ADR 0371)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    Assets.clearSources();
    vi.restoreAllMocks();
  });

  for (const style of ["blender", "mixamo"] as const) {
    describe(`a ${style}-style rig`, () => {
      const path = `models/${style}.fbx`;
      const hips = style === "blender" ? "Hips" : "mixamorig:Hips";
      const spine = style === "blender" ? "Spine" : "mixamorig:Spine";
      const load = () => {
        Assets.clearSources();
        Assets.addSource(Assets.fromObject({ [path]: dataUrl(skinnedFbx(style)) }));
        return loadModel(path);
      };

      it("imports the bones (file names kept), parents first, at their bind pose", async () => {
        const skeleton = (await load()).animation!.skeleton!;
        expect(skeleton.bones.map((b) => [b.name, b.parent])).toEqual([[hips, -1], [spine, 0]]);
        expectBindPose(skeleton);
        // The hips sit at y 1 in the model whatever the armature above them (folded into the root bone).
        close(modelRests(skeleton)[0].subarray(12, 15), [0, 1, 0]);
        close(modelRests(skeleton)[1].subarray(12, 15), [0, 1.5, 0]);
      });

      it("imports the skin's weights, normalised, and the blend shape", async () => {
        const body = (await load()).meshes.find((m) => m.name === "Body")!;
        const skin = body.skin!;
        expect(skin.influences).toBe(4);
        const count = body.data.positions.length / 3;
        for (let v = 0; v < count; v++) close([skin.weights.slice(v * 4, v * 4 + 4).reduce((a, b) => a + b, 0)], [1]);
        // The vertex at (1, 2, 0): Spine 0.75, Hips 0.25.
        const at = [...Array(count).keys()].find((v) => Math.abs(body.data.positions[v * 3] + 1) < 1e-6 && Math.abs(body.data.positions[v * 3 + 1] - 2) < 1e-6)!;
        expect(Array.from(skin.joints.slice(at * 4, at * 4 + 2))).toEqual([1, 0]);
        close(skin.weights.slice(at * 4, at * 4 + 2), [0.75, 0.25]);
        expect(body.morphTargets!.map((t) => t.name)).toEqual(["Smile"]);
        const moved = [...Array(count).keys()].filter((v) => Math.abs(body.morphTargets![0].positions![v * 3 + 1] - 0.5) < 1e-6);
        expect(moved.length).toBeGreaterThan(0);
      });

      it("imports the animation stack as a take: bone tracks in engine space and the blend shape's weight", async () => {
        const model = await load();
        const take = model.animation!.takes[0];
        expect([take.name, take.duration]).toEqual(["Take 001", 1]);
        const h = take.tracks.find((t): t is BoneTrack => t.kind === "bone" && t.bone === hips)!;
        // The hips move 1 along the file's +X (mirrored to -X) and keep y 1, through the armature in the Blender rig.
        const rests = modelRests(model.animation!.skeleton!);
        close(h.translation[h.translation.length - 1].slice(1), [-1, 1, 0]);
        close(h.translation[0].slice(1), Array.from(rests[0].subarray(12, 15)));
        const s = take.tracks.find((t): t is BoneTrack => t.kind === "bone" && t.bone === spine)!;
        expect(s.rotation.length).toBeGreaterThanOrEqual(2);
        const smile = take.tracks.find((t): t is CurveTrack => t.kind === "morph")!;
        // One mesh and nothing else: the drop makes one node (ADR 0118), so the mesh is the Animator's own node, path "".
        expect([smile.target.nodePath, smile.target.field]).toEqual(["", "Smile"]);
        close(smile.curves[0].map((k) => k[1]), [0, 1]);
        expect(model.animation!.clips.map((c) => c.name)).toEqual(["Take 001"]);
      });
    });
  }

  it("a glTF skeleton is at its bind pose too", async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "models/bind.gltf": dataUrl(skinnedGltf()) }));
    expectBindPose((await loadModel("models/bind.gltf")).animation!.skeleton!);
  });
});
