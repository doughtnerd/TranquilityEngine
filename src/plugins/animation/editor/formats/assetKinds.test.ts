/**
 * The animation asset kinds through the editor's asset-kind registry, registered by the Animation plugin's editor half
 * (`activate` → `formats/register.ts`; ADR 0143, 0148, 0233, 0302, 0314, D95): what `assetKind` resolves, the field
 * kinds the components declare, the formats and reference readers as the registry holds them, and a move rewriting
 * the references inside a file of every kind.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assetKind, fieldKindKnown, registeredKind, satisfiesFieldKind } from "../../../../editor/assetKindLookup";
import { assetsForKinds } from "../../../../editor/assetFieldKinds";
import { assetDependencies, assetUsers, rewriteReferences } from "../../../../editor/assetReferences";
import { activatePlugin, deactivatePlugin } from "../../../../editor/sdk/plugins";
import { closeTestProject, openTestProject, ROOT, useCoreAssetKinds } from "../../../../editor/testing";
import { joinPath } from "../../../../editor/projects";
import { emptyAnimSource, formatAnimSource, parseAnimSource, type AnimSource } from "../../../../engine/animation/animSource";
import { emptyAnimGraph, formatAnimGraph, parseAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { emptyTimeline, formatTimeline, parseTimeline } from "../../../../engine/animation/timeline";
import { formatMask, parseMask } from "../../../../engine/animation/mask";
import { emptySkeletonProfile, formatSkeletonProfile } from "../../../../engine/animation/skeletonProfile";
import { emptyPoseDatabase, formatPoseDatabase, parsePoseDatabase } from "../../../../engine/animation/poseDatabase";
import { animationEditorPlugin } from "..";

useCoreAssetKinds();
beforeAll(() => activatePlugin(animationEditorPlugin, { isActive: () => false }));
afterAll(() => deactivatePlugin("myco.animation"));
afterEach(() => closeTestProject());

const NO_TARGET = { nodePath: "", component: "", field: "" };

function clip(): AnimSource {
  return {
    ...emptyAnimSource(),
    tracks: [
      { kind: "discrete", target: { nodePath: "", component: "engine.SpriteRenderer", field: "sprite" }, valueType: "asset", keys: [[0, "asset:sprites/sheet.png#run_0"]] },
      // A node path that looks like a project file isn't a reference: the clip's reader leaves it out.
      { kind: "audio", target: { nodePath: "audio/step.wav", component: "", field: "" }, keys: [{ time: 0.2, audio: "audio/step.wav" }] },
      { kind: "subclip", target: NO_TARGET, keys: [{ time: 0, end: 1, clip: "asset:clips/wave.anim.json", offset: 0, speed: 1, blendIn: 0, blendOut: 0 }] },
    ],
  };
}

function graph(): AnimGraph {
  return {
    ...emptyAnimGraph(),
    skeleton: "asset:models/hero.glb#Skeleton",
    output: "run",
    nodes: [
      { id: "run", family: "sources", kind: "clipPlayer", name: "", inputs: [], params: { clip: "asset:clips/run.anim.json" } },
      { id: "weapon", family: "slots", kind: "linked", name: "", inputs: [], params: {}, linked: { name: "Weapon", graph: "asset:graphs/sword.animgraph.json" } },
    ],
    layers: [{ name: "Upper", root: "weapon", mask: "asset:masks/upper.mask.json", mode: "override", weight: 1, weightParameter: null }],
  };
}

const TIMELINE = formatTimeline({ ...emptyTimeline(), tracks: [{ kind: "subclip", target: { nodePath: "Hero", component: "", field: "" }, keys: [{ time: 0, end: 2, clip: "asset:clips/run.anim.json", offset: 0, speed: 1, blendIn: 0, blendOut: 0 }] }] });
const MASK = formatMask({ format: "myco.mask@1", profile: "asset:rigs/quad.skelprofile.json", entries: [{ role: "Hips", weight: 1, recursive: true }] });
const POSEDB = formatPoseDatabase({ ...emptyPoseDatabase(), skeleton: "asset:models/hero.glb#Skeleton", sources: [{ clip: "asset:clips/run.anim.json", ranges: [{ from: 0, to: 1, tags: ["run"] }], mirror: false }] });

describe("the animation asset kinds", () => {
  it.each([
    ["clips/Run.Anim.json", "animclip", "Animation Clip"],
    ["graphs/loco.animgraph.json", "animgraph", "Animation Graph"],
    ["cutscenes/intro.timeline.json", "timeline", "Timeline"],
    ["masks/upper.mask.json", "avatarmask", "Avatar Mask"],
    ["rigs/quad.skelprofile.json", "skelprofile", "Skeleton Profile"],
    ["anim/loco.posedb.json", "posedb", "Pose Database"],
    ["build/hero.skel.bin", "compiledskeleton", "Skeleton (compiled)"],
    ["build/run.anim.bin", "compiledclip", "Animation Clip (compiled)"],
    ["build/loco.animgraph.bin", "compiledgraph", "Animation Graph (compiled)"],
    ["anim/loco.posedb.bin", "posedbbake", "Pose Database (baked)"],
  ])("resolve %s by its ending, ahead of plain JSON", (path, id, label) => {
    expect(assetKind(path)).toBe(id);
    expect(registeredKind(id)).toMatchObject({ label });
  });

  it("satisfy the asset field kinds the animation components declare (D95)", () => {
    for (const k of ["animclip", "animgraph", "timeline", "skelprofile", "skeleton", "sprite"]) expect(fieldKindKnown(k), k).toBe(true);
    const files = ["clips/run.anim.json", "graphs/loco.animgraph.json", "cutscenes/intro.timeline.json", "rigs/quad.skelprofile.json", "build/hero.skel.bin", "build/run.anim.bin", "masks/upper.mask.json", "notes.json"];
    expect(assetsForKinds(["animclip"], files)).toEqual(["clips/run.anim.json"]);
    expect(assetsForKinds(["animgraph"], files)).toEqual(["graphs/loco.animgraph.json"]);
    expect(assetsForKinds(["timeline"], files)).toEqual(["cutscenes/intro.timeline.json"]);
    expect(assetsForKinds(["skelprofile"], files)).toEqual(["rigs/quad.skelprofile.json"]);
    expect(assetsForKinds(["skeleton"], files)).toEqual(["build/hero.skel.bin"]);
    expect(satisfiesFieldKind("sprite", "sprites/sheet.png")).toBe(true);
  });

  it("read and write their files through the engine's formats, and make new files that read back clean", () => {
    const cases: [string, string][] = [
      ["animclip", formatAnimSource(clip())],
      ["animgraph", formatAnimGraph(graph())],
      ["timeline", TIMELINE],
      ["avatarmask", MASK],
      ["skelprofile", formatSkeletonProfile(emptySkeletonProfile())],
      ["posedb", POSEDB],
    ];
    for (const [id, text] of cases) {
      const f = registeredKind(id)!.format!;
      const read = f.parse(JSON.parse(text), `x/${id}`);
      expect(read.problems, id).toEqual([]);
      expect(f.format(read.value), id).toBe(text);
      expect(f.parse(JSON.parse(f.format(f.empty())), "x").problems, id).toEqual([]);
      expect(registeredKind(id)!.create, id).toMatchObject({ what: expect.any(String) });
    }
    expect(registeredKind("animclip")!.format!.parse({ duration: 1 }, "a.anim.json").problems).toEqual([{ message: 'a.anim.json: format: expected "myco.anim-source@1"; reading it anyway.' }]);
  });

  it("say what their files name", () => {
    const read = (id: string, text: string) => registeredKind(id)!.references!.read(`x/${id}`, text);
    expect(read("animclip", formatAnimSource(clip()))).toEqual(["sprites/sheet.png", "audio/step.wav", "clips/wave.anim.json"]);
    expect(read("animgraph", formatAnimGraph(graph()))).toEqual(["models/hero.glb", "clips/run.anim.json", "graphs/sword.animgraph.json", "masks/upper.mask.json"]);
    expect(read("timeline", TIMELINE)).toEqual(["clips/run.anim.json"]);
    expect(read("avatarmask", MASK)).toEqual(["rigs/quad.skelprofile.json"]);
    expect(read("skelprofile", formatSkeletonProfile(emptySkeletonProfile()))).toEqual([]);
    expect(read("posedb", POSEDB)).toEqual(["models/hero.glb", "clips/run.anim.json"]);
    expect(read("animgraph", "{ nope")).toEqual([]);
  });

  it("are dependencies and users in the project, and a move rewrites the references in a file of every kind", async () => {
    const { project, fs } = await openTestProject({
      "clips/run.anim.json": formatAnimSource(clip()),
      "clips/wave.anim.json": formatAnimSource(emptyAnimSource()),
      "graphs/loco.animgraph.json": formatAnimGraph(graph()),
      "graphs/sword.animgraph.json": formatAnimGraph(emptyAnimGraph()),
      "cutscenes/intro.timeline.json": TIMELINE,
      "masks/upper.mask.json": MASK,
      "rigs/quad.skelprofile.json": formatSkeletonProfile(emptySkeletonProfile()),
      "anim/loco.posedb.json": POSEDB,
      "sprites/sheet.png": new Uint8Array([1]),
      "audio/step.wav": new Uint8Array([1]),
      "models/hero.glb": new Uint8Array([1]),
    });
    const source = { files: project.files, text: (p: string) => project.textOf(p) };
    expect(assetDependencies(source, "clips/run.anim.json").sort()).toEqual(["audio/step.wav", "clips/wave.anim.json", "sprites/sheet.png"]);
    expect(assetDependencies(source, "graphs/loco.animgraph.json").sort()).toEqual(["clips/run.anim.json", "graphs/sword.animgraph.json", "masks/upper.mask.json", "models/hero.glb"]);
    expect((await assetUsers(project, ["clips/run.anim.json"])).sort()).toEqual(["anim/loco.posedb.json", "cutscenes/intro.timeline.json", "graphs/loco.animgraph.json"]);
    expect(await assetUsers(project, ["rigs/quad.skelprofile.json"])).toEqual(["masks/upper.mask.json"]);

    const moves: [string, string][] = [
      ["clips/run.anim.json", "clips/loco/run.anim.json"],
      ["clips/wave.anim.json", "clips/emotes/wave.anim.json"],
      ["sprites/sheet.png", "art/sheet.png"],
      ["audio/step.wav", "sfx/step.wav"],
      ["models/hero.glb", "models/hero/hero.glb"],
      ["graphs/sword.animgraph.json", "graphs/weapons/sword.animgraph.json"],
      ["masks/upper.mask.json", "masks/body/upper.mask.json"],
      ["rigs/quad.skelprofile.json", "rigs/q.skelprofile.json"],
    ];
    for (const [from, to] of moves) await project.move(from, to);
    const { updated, notRewritten } = await rewriteReferences(project, moves, "Move");
    expect(updated.sort()).toEqual(["anim/loco.posedb.json", "clips/loco/run.anim.json", "cutscenes/intro.timeline.json", "graphs/loco.animgraph.json", "masks/body/upper.mask.json"]);
    expect(notRewritten).toEqual([]);

    const read = (path: string) => JSON.parse(fs.files.get(joinPath(ROOT, path)) as string) as unknown;
    const c = parseAnimSource(read("clips/loco/run.anim.json"));
    expect(c.problems).toEqual([]);
    // The keys' references follow the moves. (The move itself is the shell's JSON walk, ADR 0302: it rewrites every
    // string equal to a moved path, so it is the readers above, not the move, that keep look-alike node paths out.)
    expect(c.value.tracks.map((t) => (t as { keys: unknown }).keys)).toEqual([
      [[0, "asset:art/sheet.png#run_0"]],
      [{ time: 0.2, audio: "sfx/step.wav" }],
      [{ time: 0, end: 1, clip: "asset:clips/emotes/wave.anim.json", offset: 0, speed: 1, blendIn: 0, blendOut: 0 }],
    ]);
    const g = parseAnimGraph(read("graphs/loco.animgraph.json"));
    expect(g.problems).toEqual([]);
    expect(g.value.skeleton).toBe("asset:models/hero/hero.glb#Skeleton");
    expect(g.value.nodes[0].params.clip).toBe("asset:clips/loco/run.anim.json");
    expect(g.value.nodes[1].linked!.graph).toBe("asset:graphs/weapons/sword.animgraph.json");
    expect(g.value.layers[0].mask).toBe("asset:masks/body/upper.mask.json");
    const t = parseTimeline(read("cutscenes/intro.timeline.json"));
    expect(t.value.tracks[0]).toMatchObject({ keys: [{ clip: "asset:clips/loco/run.anim.json" }] });
    expect(parseMask(read("masks/body/upper.mask.json")).value.profile).toBe("asset:rigs/q.skelprofile.json");
    const db = parsePoseDatabase(read("anim/loco.posedb.json")).value;
    expect([db.skeleton, db.sources[0].clip]).toEqual(["asset:models/hero/hero.glb#Skeleton", "asset:clips/loco/run.anim.json"]);
  });
});
