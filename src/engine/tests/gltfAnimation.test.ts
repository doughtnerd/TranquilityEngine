// ADR 0371 (T14): glTF skins, skeletons, clips, morph targets, KHR_animation_pointer and KHR_node_visibility, imported
// through `loadModel` (the public scene path every renderer and the editor use) from the fixture in
// `fixtures/gltf/skinnedGltf.ts`. Tolerances: 1e-5 on floats the import computes (float32 storage, quaternion maths).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../index";
import { decodeBakedModel } from "../scene/bakedModel";
import { defaultImportSettings, parseImportSettings } from "../scene/importSettings";
import { bakeModelFile, loadModel, loadModelSubAsset, modelSubAssetKinds, modelSubAssets } from "../scene/models";
import type { BoneTrack, CurveTrack, QuatTrack, Track } from "../animation/tracks";
import { skinnedGltf } from "./fixtures/gltf/skinnedGltf";
import { boneMapGuesser, setBoneMapGuesser } from "../animation/import/boneMapGuess";

const dataUrl = (text: string) => `data:application/octet-stream;base64,${Buffer.from(text).toString("base64")}`;
const close = (a: ArrayLike<number>, b: readonly number[], eps = 1e-5) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < b.length; i++) expect(Math.abs(a[i] - b[i]), `index ${i}: ${a[i]} vs ${b[i]}`).toBeLessThan(eps);
};
const Q = Math.SQRT1_2;

function use(files: Record<string, unknown>) {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(files));
}

const track = <T extends Track>(tracks: readonly Track[], test: (t: Track) => boolean): T => {
  const t = tracks.find(test);
  if (!t) throw new Error("no such track");
  return t as T;
};
const bone = (tracks: readonly Track[], name: string) => track<BoneTrack>(tracks, (t) => t.kind === "bone" && t.bone === name);
const field = (tracks: readonly Track[], nodePath: string, f: string) => track<CurveTrack | QuatTrack>(tracks, (t) => "target" in t && t.target.nodePath === nodePath && t.target.field === f);

describe("glTF animation import (ADR 0371)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    Assets.clearSources();
    vi.restoreAllMocks();
  });

  it("builds one skeleton, parents first, reordered from the skin's joint order, with rest poses and inverse binds", async () => {
    use({ "models/rig.gltf": dataUrl(skinnedGltf()) });
    const { animation } = await loadModel("models/rig.gltf");
    const skeleton = animation!.skeleton!;
    expect(skeleton.bones.map((b) => b.name)).toEqual(["Hips", "Spine", "Chest", "Neck", "Head", "Jaw"]);
    expect(skeleton.bones.map((b) => b.parent)).toEqual([-1, 0, 1, 2, 3, 4]);
    skeleton.bones.forEach((b, i) => expect(b.parent).toBeLessThan(i));
    close(skeleton.bones[0].rest.position, [0, 1, 0]);
    close(skeleton.bones[1].rest.position, [0, 0.5, 0]);
    close(skeleton.bones[1].rest.rotation, [0, 0, 0, 1]);
    // Row-major 3×4 (D10): Hips at y 1 binds with ty = -1; Jaw (y 3.5) with -3.5.
    close(skeleton.inverseBinds.subarray(0, 12), [1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 1, 0]);
    close(skeleton.inverseBinds.subarray(60, 72), [1, 0, 0, 0, 0, 1, 0, -3.5, 0, 0, 1, 0]);
  });

  it("limits skin influences to 4, normalises them and remaps joints into the skeleton", async () => {
    use({ "models/rig.gltf": dataUrl(skinnedGltf()) });
    const body = (await loadModel("models/rig.gltf")).meshes.find((m) => m.name === "Body")!;
    expect(body.skin!.influences).toBe(4);
    // Vertex 0: Hips 2, Spine 1, Chest 1 → 0.5, 0.25, 0.25. Vertices 2 and 3: Head (4) and Jaw (5), whose skin indices were 0 and 3.
    expect(Array.from(body.skin!.joints.slice(0, 4))).toEqual([0, 1, 2, 0]);
    close(body.skin!.weights.slice(0, 4), [0.5, 0.25, 0.25, 0]);
    expect([body.skin!.joints[8], body.skin!.joints[12]]).toEqual([4, 5]);
    expect(body.skin!.inverseBinds).toBeUndefined(); // bound at the skeleton's own bind pose
  });

  it("keeps 8 influences when the sidecar asks, else drops the smallest of the extra ones", async () => {
    use({ "models/rig.gltf": dataUrl(skinnedGltf({ eight: true })) });
    const four = (await loadModel("models/rig.gltf")).meshes.find((m) => m.name === "Body")!.skin!;
    // Hips .3, Spine .2, Chest .15, Neck .1 (JOINTS_0) and Head .15, Jaw .1 (JOINTS_1): Neck and Jaw go, the rest sum to .8.
    expect(Array.from(four.joints.slice(0, 4))).toEqual([0, 1, 2, 4]);
    close(four.weights.slice(0, 4), [0.375, 0.25, 0.1875, 0.1875]);
    use({ "models/rig.gltf": dataUrl(skinnedGltf({ eight: true })), "models/rig.gltf.meta.json": { format: "myco.import@1", animation: { influences: 8 } } });
    const eight = (await loadModel("models/rig.gltf")).meshes.find((m) => m.name === "Body")!.skin!;
    expect(eight.influences).toBe(8);
    expect(Array.from(eight.joints.slice(0, 8))).toEqual([0, 1, 2, 4, 3, 5, 0, 0]);
    close(eight.weights.slice(0, 8), [0.3, 0.2, 0.15, 0.15, 0.1, 0.1, 0, 0]);
  });

  it("imports morph targets (positions, normals, tangents) and tangents, through the handedness mirror", async () => {
    use({ "models/rig.gltf": dataUrl(skinnedGltf()) });
    const body = (await loadModel("models/rig.gltf")).meshes.find((m) => m.name === "Body")!;
    const [smile, blink] = body.morphTargets!;
    expect([smile.name, blink.name]).toEqual(["Smile", "Blink"]);
    close(smile.positions!, [0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0]);
    close(smile.normals!, [0, 0, 0, 0, 0, 0, -0.5, 0, 0, 0, 0, 0]); // x mirrored
    close(blink.positions!, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    close(blink.tangents!, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.25]);
    // Tangents mirror too: x flips and the bitangent sign (w) with it.
    close(body.tangents!.slice(0, 4), [-1, 0, 0, -1]);
  });

  it("turns TRS and weight channels into bone, node and morph tracks (LINEAR)", async () => {
    use({ "models/rig.gltf": dataUrl(skinnedGltf()) });
    const walk = (await loadModel("models/rig.gltf")).animation!.takes.find((t) => t.name === "Walk")!;
    expect(walk.duration).toBe(1);
    const hips = bone(walk.tracks, "Hips");
    expect(hips.translation.length).toBe(2);
    close(hips.translation[1], [1, -1, 1, 0]); // x mirrored
    const spine = bone(walk.tracks, "Spine");
    close(spine.rotation[0], [0, 0, 0, 0, 1]);
    close(spine.rotation[spine.rotation.length - 1], [1, 0, -Q, 0, Q]); // 90° about y, mirrored: y flips
    expect(spine.rotation.length).toBeGreaterThan(2); // a wide LINEAR arc is refined so nlerp keeps it
    const smile = track<CurveTrack>(walk.tracks, (t) => t.kind === "morph" && t.target.field === "Smile");
    expect(smile.target.nodePath).toBe("Body");
    expect(smile.curves).toEqual([[[0, 0], [1, 1]]]);
    expect(track<CurveTrack>(walk.tracks, (t) => t.kind === "morph" && t.target.field === "Blink").curves).toEqual([[[0, 0], [1, 0.5]]]);
  });

  it("holds STEP keys and maps every KHR_animation_pointer channel per 0371, warning once with the unmapped ones", async () => {
    use({ "models/wave.gltf": dataUrl(skinnedGltf()) });
    const model = await loadModel("models/wave.gltf");
    const wave = model.animation!.takes.find((t) => t.name === "Wave")!;
    expect(wave.duration).toBe(2);
    const head = bone(wave.tracks, "Head").rotation;
    expect(head.map((k) => +k[0].toFixed(4))).toEqual([0, 0.4999, 0.5, 1.9999, 2]);
    close(head[1], [head[1][0], 0, 0, 0, 1]); // held until just before the next key
    close(head[2], [0.5, Q, 0, 0, Q]);
    const colour = field(wave.tracks, "Body", "materials[0].color") as CurveTrack;
    expect(colour.kind).toBe("color");
    expect(colour.target.component).toBe("engine.MeshRenderer");
    expect(colour.curves[0]).toEqual([[0, 1], [0.5, 0], [2, 0]]);
    const offset = field(wave.tracks, "Prop", "materials[0].textureTransform.offset") as CurveTrack;
    expect([offset.kind, offset.curves[0]]).toEqual(["vec2", [[0, 0], [0.5, 0.5], [2, 1]]]);
    const intensity = field(wave.tracks, "Lamp", "intensity") as CurveTrack;
    expect([intensity.target.component, intensity.curves[0]]).toEqual(["engine.Light", [[0, 1], [0.5, 4], [2, 2]]]);
    close((field(wave.tracks, "Lamp", "spotAngle") as CurveTrack).curves[0].map((k) => k[1]), [57.29578, 28.64789, 57.29578], 1e-4);
    expect(track(wave.tracks, (t) => t.kind === "activation")).toEqual({ kind: "activation", target: { nodePath: "Lamp", component: "", field: "" }, keys: [{ time: 0, end: 0.5 }, { time: 2, end: 2 }] });
    const warnings = warn.mock.calls.flat().filter((m: unknown) => String(m).includes("animation pointer"));
    expect(warnings).toEqual(["[myco] models/wave.gltf: 2 animation pointers target properties the engine doesn't import, so they aren't animated: /materials/0/extensions/KHR_materials_unknown/factor, /asset/version."]);
  });

  it("keeps an animated texture transform live (flagged, not baked into UVs) and hides KHR_node_visibility nodes", async () => {
    use({ "models/rig.gltf": dataUrl(skinnedGltf()) });
    const prop = (await loadModel("models/rig.gltf")).meshes.find((m) => m.name === "Prop")!;
    expect(prop.surfaces[0].animatedTextureTransform).toEqual({ offset: [0.25, 0], scale: [2, 2], rotation: 0 });
    close(prop.data.uvs!, [0, 1, 1, 1, 0, 0]); // the file's UVs, only V flipped
    expect(prop.hidden).toBe(true);
  });

  it("keeps CUBICSPLINE weights as Bézier keys and resamples CUBICSPLINE bone channels", async () => {
    use({ "models/rig.gltf": dataUrl(skinnedGltf()) });
    const bounce = (await loadModel("models/rig.gltf")).animation!.takes.find((t) => t.name === "Bounce")!;
    const hips = bone(bounce.tracks, "Hips").translation;
    expect(hips.length).toBe(31); // 30 Hz over 1 s, both ends
    // Hermite at u = .5 with out-tangent 3, in-tangent 0: .125·3 + .5·1 = .875 (x mirrored).
    close(hips.find((k) => Math.abs(k[0] - 0.5) < 1e-9)!, [0.5, -0.875, 1, 0]);
    const smile = track<CurveTrack>(bounce.tracks, (t) => t.kind === "morph" && t.target.field === "Smile");
    expect(smile.curves[0]).toEqual([
      [0, 0, "bezier", { in: [0, 0], out: [1 / 3, 2 / 3] }],
      [1, 1, "bezier", { in: [-1 / 3, 0], out: [0, 0] }],
    ]);
  });

  it("cuts clips from takes by the sidecar, and exposes #Skeleton and #Anim/<clip> sub-assets", async () => {
    const sidecar = { format: "myco.import@1", animation: { clips: { Walk: [{ name: "WalkStart", to: 0.5, loop: true }, { name: "WalkEnd", from: 0.5 }] } } };
    use({ "models/rig.gltf": dataUrl(skinnedGltf()), "models/rig.gltf.meta.json": sidecar });
    const model = await loadModel("models/rig.gltf");
    const clips = model.animation!.clips;
    expect(clips.map((c) => [c.name, c.take, c.source.duration, c.source.loop])).toEqual([
      ["WalkStart", "Walk", 0.5, true],
      ["WalkEnd", "Walk", 0.5, false],
      ["Wave", "Wave", 2, false],
      ["Bounce", "Bounce", 1, false],
    ]);
    const start = bone(clips[0].source.tracks, "Hips").translation;
    close(start[start.length - 1], [0.5, -0.5, 1, 0]);
    const end = bone(clips[1].source.tracks, "Hips").translation;
    close(end[0], [0, -0.5, 1, 0]);
    expect(modelSubAssets(model)).toEqual(["Skeleton", "Anim/WalkStart", "Anim/WalkEnd", "Anim/Wave", "Anim/Bounce"]);
    expect(await loadModelSubAsset("asset:models/rig.gltf#Anim/WalkEnd")).toMatchObject({ kind: "clip", clip: { name: "WalkEnd" } });
    expect(await loadModelSubAsset("asset:models/rig.gltf#Skeleton")).toMatchObject({ kind: "skeleton", skeleton: { bones: expect.any(Array) } });
    expect(await loadModelSubAsset("asset:models/rig.gltf#Anim/Run")).toBeNull();
    expect([modelSubAssetKinds("Skeleton"), modelSubAssetKinds("Anim/Run"), modelSubAssetKinds("Body")]).toEqual([["skeleton"], ["animclip"], []]);
  });

  it("uses the sidecar's bone map for roles, and says once when there is no guesser (the Animation plugin off)", async () => {
    const installed = boneMapGuesser();
    setBoneMapGuesser(null);
    try {
      use({ "models/plain.gltf": dataUrl(skinnedGltf()) });
      const none = (await loadModel("models/plain.gltf")).animation!;
      expect([none.boneMapSource, none.skeleton!.roles.every((r) => r === null)]).toEqual(["none", true]);
      expect(warn.mock.calls.flat().join("\n")).toMatch(/models\/plain\.gltf: its bone map wasn't guessed \(the Animation plugin isn't active\)/);
    } finally {
      setBoneMapGuesser(installed);
    }
    use({ "models/mapped.gltf": dataUrl(skinnedGltf()), "models/mapped.gltf.meta.json": { format: "myco.import@1", animation: { boneMap: { Hips: "Hips", Head: "Head", Spine: "Nope" } } } });
    const mapped = (await loadModel("models/mapped.gltf")).animation!;
    expect(mapped.boneMapSource).toBe("sidecar");
    expect(mapped.skeleton!.roles).toEqual(["Hips", null, null, null, "Head", null]);
    expect(warn.mock.calls.flat().join("\n")).toMatch(/names bones the skeleton lacks \(roles Spine\)/);
  });

  it("round-trips skins, morphs, tangents, the skeleton, takes and clips through a baked model (version 5)", async () => {
    const sidecar = { format: "myco.import@1", animation: { clips: { Walk: [{ name: "WalkStart", to: 0.5 }] } } };
    use({ "models/rig.gltf": dataUrl(skinnedGltf()), "models/rig.gltf.meta.json": sidecar });
    const original = await loadModel("models/rig.gltf");
    const { bytes } = await bakeModelFile("models/rig.gltf");
    const settings = parseImportSettings(sidecar).settings;
    const baked = decodeBakedModel(bytes.buffer as ArrayBuffer, settings, (p) => p)!;
    const ob = original.meshes.find((m) => m.name === "Body")!, bb = baked.meshes.find((m) => m.name === "Body")!;
    expect(Array.from(bb.skin!.joints)).toEqual(Array.from(ob.skin!.joints));
    expect(Array.from(bb.skin!.weights)).toEqual(Array.from(ob.skin!.weights));
    expect(bb.morphTargets!.map((t) => [t.name, Array.from(t.positions!), Array.from(t.normals!), Array.from(t.tangents!)])).toEqual(ob.morphTargets!.map((t) => [t.name, Array.from(t.positions!), Array.from(t.normals!), Array.from(t.tangents!)]));
    expect(Array.from(bb.tangents!)).toEqual(Array.from(ob.tangents!));
    expect(baked.meshes.find((m) => m.name === "Prop")!.hidden).toBe(true);
    expect(baked.animation!.skeleton!.bones).toEqual(original.animation!.skeleton!.bones);
    expect(Array.from(baked.animation!.skeleton!.inverseBinds)).toEqual(Array.from(original.animation!.skeleton!.inverseBinds));
    expect(baked.animation!.takes).toEqual(original.animation!.takes);
    expect(baked.animation!.clips).toEqual(original.animation!.clips);
    // Baked with other animation settings: refused (the caller loads the file instead).
    expect(decodeBakedModel(bytes.buffer as ArrayBuffer, defaultImportSettings(), (p) => p)).toBeNull();
    // Another version, older or newer, is refused.
    for (const version of [4, 6]) {
      const copy = bytes.slice();
      new DataView(copy.buffer).setUint32(8, version, true);
      expect(() => decodeBakedModel(copy.buffer as ArrayBuffer, settings, (p) => p)).toThrow(new RegExp(`version ${version}; this engine reads 5`));
    }
  });
});
