// Retarget selection and bake (ADR 0373; T54): "Bake retargeted clip" through the editor compile module's
// `retargetCompressed` (faked: the wasm is T19's) and the project writer (faked), checking what the bake hands the
// compiler (skeletons, profiles, maps in role order, the source clip's raw form), the file it writes, and the reasons it
// won't run.
import { describe, expect, it } from "vitest";
import type { ImportedSkeleton } from "../../../../engine/animation/import/skeleton";
import { emptySkeletonProfile, encodeSkeletonProfile, type SkeletonProfile } from "../../../../engine/animation/skeletonProfile";
import type { AnimationCompiler, ClipReport, RetargetSideInput } from "../compile/compiler";
import { uniqueName } from "../../../../engine/core/uniqueName";
import { humanoidProfile } from "./humanoidProfile";
import { bakeRetargetedClip, bakedClipPath, boneMapIndices, profileCompatible, sideProblem, sourceClipRef, type RetargetEnv, type RetargetModel, type RetargetRequest } from "./retargetLogic";

const profile = humanoidProfile();
const rest = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } as const;
const skeleton = (names: string[]): ImportedSkeleton => ({ bones: names.map((name, i) => ({ name, parent: i - 1, rest })), inverseBinds: new Float32Array(12 * names.length), roles: names.map(() => null), profile: null });

const REQUIRED = profile.roles.filter((r) => r.required).map((r) => r.name);
/** A model whose bone for each required role is `<prefix><role>`. */
function model(prefix: string, extra: Partial<RetargetModel> = {}): RetargetModel {
  const names = REQUIRED.map((r) => `${prefix}${r}`);
  return { skeleton: skeleton(names), bytes: new Uint8Array([1, 2, 3]), profile: null, boneMap: Object.fromEntries(REQUIRED.map((r) => [r, `${prefix}${r}`])), clips: ["Run", "Idle"], ...extra };
}

const REPORT: ClipReport = { rawSize: 4800, compressedSize: 1200, fileSize: 1300, maxError: 0.00004, worstBone: 3, worstFrame: 7, maxPropertyError: 0, worstTrack: -1, channels: [1, 2, 3], withinBounds: true, rotationFormat: "dropW" };

interface Calls {
  retarget: { source: RetargetSideInput; target: RetargetSideInput; options: { alignChains: boolean; rootAxes: number; ikWeights: Float32Array; record: Float32Array }; clip: Uint8Array }[];
  written: { path: string; bytes: Uint8Array }[];
}

function fakeEnv(models: Record<string, RetargetModel>, files: string[] = [], profiles: Record<string, SkeletonProfile> = {}): { env: RetargetEnv; calls: Calls } {
  const calls: Calls = { retarget: [], written: [] };
  const compiler = {
    retargetCompressed(source, target, options, clip) {
      calls.retarget.push({ source, target, options, clip });
      return { ok: true as const, bytes: new Uint8Array([9, 9, 9, 9]), report: REPORT };
    },
  } as AnimationCompiler;
  const env: RetargetEnv = {
    profile: async (ref) => (ref === null ? profile : (profiles[ref] ?? null)),
    model: async (path) => models[path] ?? null,
    sourceClip: async (clip) => (clip.endsWith("#Anim/Idle") ? { error: `${clip}: the clip can't be read.` } : { raw: new Uint8Array([7, 7]), record: new Float32Array([1, 2]), rootAxes: 5 }),
    compiler: async () => compiler,
    freeFilePath: (folder, stem, ext) => {
      const at = (name: string) => (folder ? `${folder}/${name}` : name);
      return at(uniqueName(stem, (s) => files.includes(at(`${s}${ext}`))) + ext);
    },
    writeBytes: async (path, bytes) => void calls.written.push({ path, bytes }),
  };
  return { env, calls };
}

const request: RetargetRequest = { source: "models/robot.glb", clip: "Run", target: { model: "models/hero.glb", profile: null, boneMap: model("hero:").boneMap } };

describe("the bone map as the core's input", () => {
  it("is one bone index per role of the profile, 0xFFFF where unmapped", () => {
    const m = boneMapIndices(profile, { Hips: "b", Head: "a", Wing: "a" }, ["a", "b"]);
    expect(m).toHaveLength(profile.roles.length);
    expect(m[profile.roles.findIndex((r) => r.name === "Hips")]).toBe(1);
    expect(m[profile.roles.findIndex((r) => r.name === "Head")]).toBe(0);
    expect(m.filter((b) => b !== 0xffff)).toHaveLength(2);
  });
});

describe("Bake retargeted clip", () => {
  it("retargets the source clip through both sides' skeletons and maps, with chain alignment, and writes the compressed clip beside the target", async () => {
    const { env, calls } = fakeEnv({ "models/robot.glb": model("robot:"), "models/hero.glb": model("hero:") });
    const out = await bakeRetargetedClip(env, request);
    expect(out).toEqual({ ok: true, path: "models/Run.hero.anim.bin", size: 4, report: REPORT });
    expect(calls.written).toEqual([{ path: "models/Run.hero.anim.bin", bytes: new Uint8Array([9, 9, 9, 9]) }]);
    const [call] = calls.retarget;
    expect(call.clip).toEqual(new Uint8Array([7, 7]));
    expect(call.options).toMatchObject({ alignChains: true, rootAxes: 5 });
    expect(call.options.record).toEqual(new Float32Array([1, 2]));
    expect(call.source.profile).toHaveLength(0); // the Humanoid: the core's own
    expect(call.source.map).toHaveLength(profile.roles.length);
    expect(call.target.map[profile.roles.findIndex((r) => r.name === "Hips")]).toBe(REQUIRED.indexOf("Hips"));
  });

  it("uses the target's draft bone map and profile, encoding a custom profile for the core", async () => {
    const custom: SkeletonProfile = { ...emptySkeletonProfile(), name: "Biped", roles: [{ name: "Hips", mirror: "Hips", flip: "auto", range: null, required: true }] };
    const ref = "rigs/biped.skelprofile.json";
    const { env, calls } = fakeEnv({ "models/robot.glb": model("robot:"), "models/hero.glb": model("hero:") }, [], { [ref]: custom });
    const out = await bakeRetargetedClip(env, { ...request, target: { model: "models/hero.glb", profile: ref, boneMap: { Hips: "hero:Hips" } } });
    expect(out.ok).toBe(true);
    const encoded = encodeSkeletonProfile(custom);
    expect(calls.retarget[0].target.profile).toEqual("bytes" in encoded ? encoded.bytes : null);
    expect(Array.from(calls.retarget[0].target.map)).toEqual([REQUIRED.indexOf("Hips")]);
  });

  it("names the file after the clip and the target, and doesn't overwrite one that exists", async () => {
    const asked = (folder: string, stem: string, ext: string) => `${folder}|${stem}|${ext}`;
    expect(bakedClipPath("models/hero.glb", "Run", asked)).toBe("models|Run.hero|.anim.bin");
    expect(bakedClipPath("hero.glb", "Run/Fast", asked)).toBe("|Run_Fast.hero|.anim.bin");
    expect(bakedClipPath("models/hero.glb", "Run", fakeEnv({}, ["models/Run.hero.anim.bin", "models/Run.hero 2.anim.bin"]).env.freeFilePath)).toBe("models/Run.hero 3.anim.bin");
    const { env, calls } = fakeEnv({ "models/robot.glb": model("robot:"), "models/hero.glb": model("hero:") }, ["models/Run.hero.anim.bin"]);
    const out = await bakeRetargetedClip(env, request);
    expect(out.ok && out.path).toBe("models/Run.hero 2.anim.bin");
    expect(calls.written).toHaveLength(1);
  });

  it("doesn't bake, and says why, for a missing skeleton, clip, profile, bone map or source clip", async () => {
    const both = { "models/robot.glb": model("robot:"), "models/hero.glb": model("hero:") };
    const why = async (models: Record<string, RetargetModel>, req = request, profiles: Record<string, SkeletonProfile> = {}) => {
      const { env, calls } = fakeEnv(models, [], profiles);
      const out = await bakeRetargetedClip(env, req);
      expect(calls.written).toEqual([]);
      expect(calls.retarget).toEqual([]);
      return out.ok ? "" : out.error;
    };
    expect(await why({ "models/hero.glb": model("hero:") })).toMatch(/robot\.glb has no skeleton/);
    expect(await why({ "models/robot.glb": model("robot:") })).toMatch(/hero\.glb has no skeleton/);
    expect(await why(both, { ...request, clip: "Fly" })).toMatch(/no clip "Fly"/);
    expect(await why({ ...both, "models/robot.glb": model("robot:", { profile: "rigs/x.skelprofile.json" }) })).toMatch(/source's skeleton profile .* can't be read/);
    expect(await why(both, { ...request, target: { ...request.target, profile: "rigs/y.skelprofile.json" } })).toMatch(/target's skeleton profile/);
    expect(await why({ ...both, "models/robot.glb": model("robot:", { boneMap: {} }) })).toMatch(/source's bone map is empty/);
    expect(await why(both, { ...request, target: { ...request.target, boneMap: { Hips: "hero:Hips" } } })).toMatch(/target has no bone for the required roles/);
    expect(await why({ ...both, "models/robot.glb": model("robot:", { clips: ["Idle"] }) }, { ...request, clip: "Idle" })).toMatch(/can't be read/);
  });

  it("reports a compile that fails, and one that throws, without writing", async () => {
    const both = { "models/robot.glb": model("robot:"), "models/hero.glb": model("hero:") };
    const failing = fakeEnv(both);
    failing.env = { ...failing.env, compiler: async () => ({ retargetCompressed: () => ({ ok: false as const, error: "the maps disagree" }) }) as unknown as AnimationCompiler };
    expect(await bakeRetargetedClip(failing.env, request)).toEqual({ ok: false, error: "the retarget bake failed: the maps disagree" });
    const throwing = fakeEnv(both);
    throwing.env = { ...throwing.env, compiler: async () => { throw new Error("wasm didn't load"); } };
    expect(await bakeRetargetedClip(throwing.env, request)).toEqual({ ok: false, error: "the retarget bake failed: wasm didn't load" });
    expect(failing.calls.written.length + throwing.calls.written.length).toBe(0);
  });
});

describe("the source's side and compatibility", () => {
  it("names a model's clip for the bake", () => {
    expect(sourceClipRef("models/robot.glb", "Run")).toBe("models/robot.glb#Anim/Run");
  });

  it("a side with an empty map or a required role unmapped has a problem", () => {
    expect(sideProblem("target", profile, {}, ["a"])).toMatch(/empty/);
    expect(sideProblem("target", profile, { Hips: "a" }, ["a"])).toMatch(/Spine/);
    const m = model("x:");
    expect(sideProblem("target", profile, m.boneMap, m.skeleton.bones.map((b) => b.name))).toBeNull();
  });

  it("characters are profile-compatible with the same profile and every required role mapped", () => {
    const a = model("a:");
    const b = model("b:");
    const side = (m: RetargetModel, p: string | null = m.profile) => ({ profile: p, boneMap: m.boneMap, bones: m.skeleton.bones.map((x) => x.name) });
    expect(profileCompatible(profile, side(a), side(b))).toBe(true);
    expect(profileCompatible(profile, side(a), side(b, "rigs/x.skelprofile.json"))).toBe(false);
    expect(profileCompatible(profile, side(a), { ...side(b), boneMap: { Hips: "b:Hips" } })).toBe(false);
  });
});
