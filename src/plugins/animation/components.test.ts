// The Animation plugin's Components and public API (ADR 0370–0372; T01's contract): scene data loads into every field
// through the registry (node references, quaternions, asset references, lists), absent fields keep their defaults,
// field options (replicated, hidden, animatable) are declared, the tween data component and the buffers exist, and every
// declared but unbuilt method throws an error naming the task that builds it. Through the public `myco` API and scene files.
import { afterEach, describe, expect, it } from "vitest";
import {
  AnimationEvents,
  Animator,
  AnimatorStateChanges,
  Assets,
  BoneAttachment,
  Engine,
  GameObject,
  Quaternion,
  RootMotion,
  SceneManager,
  Skeleton,
  Skeleton2D,
  SkinnedMeshRenderer,
  TimelineDirector,
  Tweens,
  Vector3,
  animatorParams,
  getFields,
  parallel,
  sequence,
  tween,
  type Tween,
} from "../../myco";
import { getDataComponentDef } from "../../engine/core/data";
import { isFieldAnimatable, type ComponentClass } from "../../engine/core/registry";

const FULL = "scenes/full.scene.json";
const EMPTY = "scenes/empty.scene.json";

const FILES: Record<string, unknown> = {
  [FULL]: {
    format: "myco.scene@1",
    nodes: [
      { id: "target", name: "Target" },
      {
        id: "rig",
        name: "Rig",
        components: [
          { type: "engine.Skeleton", data: { skeleton: "asset:hero.glb#Skeleton", profile: "asset:humanoid.skelprofile.json", retargetSource: "asset:mixamo.skelprofile.json" } },
          {
            type: "engine.Animator",
            data: {
              graph: "asset:hero.animgraph.json",
              defaultClip: "asset:hero.glb#Anim/Idle",
              linkedGraphNodes: ["Weapon"],
              linkedGraphs: ["asset:sword.animgraph.json"],
              parameters: { speed: 2, grounded: true, aim: [0, 1, 0] },
              updateMode: "fixed",
              cullingMode: "whenVisible",
              rootMotion: "characterController",
              lodMetric: "distance",
              lodEvery2: 10,
              lodEvery4: 30,
              rigCullDistance: 50,
              lodSearchMultiplier: 3,
              ikTargets: ["LeftHand"],
              ikTargetNodes: [{ $node: "target" }],
              netStates: "Base=1",
            },
          },
          { type: "engine.TimelineDirector", data: { timeline: "asset:intro.timeline.json", bindingTracks: ["Door"], bindingNodes: [{ $node: "target" }], playOnStart: false, wrapMode: "loop", playhead: 1.5 } },
        ],
      },
      {
        id: "body",
        name: "Body",
        parent: "rig",
        components: [
          {
            type: "engine.SkinnedMeshRenderer",
            data: { mesh: "asset:hero.glb#Body", materials: ["asset:skin.material.json"], skeleton: { $node: "rig" }, boundsMode: "fixed", boundsSize: [1, 2, 1], morphWeights: [0.5, 0], castShadows: false },
          },
        ],
      },
      { id: "sword", name: "Sword", parent: "rig", components: [{ type: "engine.BoneAttachment", data: { skeleton: { $node: "rig" }, bone: "hand_r", offsetPosition: [0, 0.1, 0], offsetRotation: [0, 0, 0, 1], follow: "position" } }] },
      { id: "paper", name: "Paper", components: [{ type: "engine.Skeleton2D", data: { bones: "asset:paper.png#torso" } }] },
    ],
  },
  [EMPTY]: {
    format: "myco.scene@1",
    nodes: [
      {
        id: "all",
        name: "All",
        components: ["engine.Skeleton", "engine.SkinnedMeshRenderer", "engine.Skeleton2D", "engine.Animator", "engine.BoneAttachment", "engine.TimelineDirector"].map((type) => ({ type })),
      },
    ],
  },
};

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

async function load(path: string): Promise<GameObject> {
  const engine = await Engine.create({ headless: true, assets: Assets.fromObject(FILES) });
  engines.push(engine);
  return SceneManager.load(path);
}

describe("scene data through the registry", () => {
  it("loads every field: assets, choices, numbers, lists, node references, quaternions and plain objects", async () => {
    const scene = await load(FULL);
    const rig = scene.find("Rig")!;
    const target = scene.find("Target")!;

    const skel = rig.getComponent(Skeleton)!;
    expect([skel.skeleton, skel.profile, skel.retargetSource]).toEqual(["hero.glb#Skeleton", "humanoid.skelprofile.json", "mixamo.skelprofile.json"]);

    const anim = rig.getComponent(Animator)!;
    expect(anim.graph).toBe("hero.animgraph.json");
    expect(anim.defaultClip).toBe("hero.glb#Anim/Idle");
    expect(anim.linkedGraphNodes).toEqual(["Weapon"]);
    expect(anim.linkedGraphs).toEqual(["sword.animgraph.json"]);
    expect(anim.parameters).toEqual({ speed: 2, grounded: true, aim: [0, 1, 0] });
    expect([anim.updateMode, anim.cullingMode, anim.rootMotion, anim.lodMetric]).toEqual(["fixed", "whenVisible", "characterController", "distance"]);
    expect([anim.lodEvery2, anim.lodEvery4, anim.rigCullDistance, anim.lodSearchMultiplier]).toEqual([10, 30, 50, 3]);
    expect(anim.ikTargets).toEqual(["LeftHand"]);
    expect(anim.ikTargetNodes).toEqual([target]);
    expect(anim.netStates).toBe("Base=1");

    const dir = rig.getComponent(TimelineDirector)!;
    expect([dir.timeline, dir.playOnStart, dir.wrapMode, dir.playhead]).toEqual(["intro.timeline.json", false, "loop", 1.5]);
    expect(dir.bindingTracks).toEqual(["Door"]);
    expect(dir.bindingNodes).toEqual([target]);

    const skin = rig.find("Body")!.getComponent(SkinnedMeshRenderer)!;
    expect([skin.mesh, skin.materials, skin.skeleton, skin.boundsMode]).toEqual(["hero.glb#Body", ["skin.material.json"], rig, "fixed"]);
    expect(skin.boundsSize.toArray()).toEqual([1, 2, 1]);
    expect(skin.morphWeights).toEqual([0.5, 0]);
    expect(skin.castShadows).toBe(false);

    const att = rig.find("Sword")!.getComponent(BoneAttachment)!;
    expect([att.skeleton, att.bone, att.follow]).toEqual([rig, "hand_r", "position"]);
    expect(att.offsetPosition.toArray()).toEqual([0, 0.1, 0]);
    expect(att.offsetRotation).toBeInstanceOf(Quaternion);

    expect(scene.find("Paper")!.getComponent(Skeleton2D)!.bones).toBe("paper.png#torso");
  });

  it("keeps every default when a scene gives no data", async () => {
    const all = (await load(EMPTY)).find("All")!;
    const skel = all.getComponent(Skeleton)!;
    expect([skel.skeleton, skel.profile, skel.retargetSource]).toEqual(["", "", ""]);
    const anim = all.getComponent(Animator)!;
    expect(anim).toMatchObject({
      graph: "",
      defaultClip: "",
      linkedGraphNodes: [],
      linkedGraphs: [],
      parameters: {},
      updateMode: "normal",
      cullingMode: "always",
      rootMotion: "none",
      lodMetric: "off",
      lodEvery2: 20,
      lodEvery4: 40,
      rigCullDistance: 0,
      lodSearchMultiplier: 2,
      ikTargets: [],
      ikTargetNodes: [],
      netStates: "",
      netSlots: "",
      netLinks: "",
      netParameters: "",
    });
    const skin = all.getComponent(SkinnedMeshRenderer)!;
    expect(skin).toMatchObject({ mesh: "", material: "", materials: [], skeleton: null, boundsMode: "bones", morphWeights: [], castShadows: true, receiveShadows: true });
    expect(skin.boundsCenter.toArray()).toEqual([0, 1, 0]);
    expect(skin.boundsSize.toArray()).toEqual([2, 2, 2]);
    expect(all.getComponent(Skeleton2D)!.bones).toBe("");
    const att = all.getComponent(BoneAttachment)!;
    expect(att).toMatchObject({ skeleton: null, bone: "", follow: "both" });
    expect(att.offsetPosition.toArray()).toEqual([0, 0, 0]);
    expect(att.offsetRotation.toArray()).toEqual([0, 0, 0, 1]);
    expect(all.getComponent(TimelineDirector)!).toMatchObject({ timeline: "", bindingTracks: [], bindingNodes: [], playOnStart: true, wrapMode: "hold", playhead: 0 });
  });
});

describe("field options", () => {
  const option = (cls: ComponentClass, name: string) => getFields(cls).find((f) => f.name === name)?.options;

  it("replicates the Animator's state fields (ADR 0370), hidden from the Inspector and not animatable", () => {
    for (const name of ["netStates", "netSlots", "netLinks", "netParameters"]) {
      expect(option(Animator, name)).toMatchObject({ replicate: true, hidden: true, animatable: false });
    }
    const replicated = getFields(Animator).filter((f) => f.options?.replicate).map((f) => f.name);
    expect(replicated).toEqual(["netStates", "netSlots", "netLinks", "netParameters"]);
  });

  it("lets clips drive what can change every frame, and not what would break an invariant", () => {
    const animatable: [ComponentClass, string][] = [
      [SkinnedMeshRenderer, "morphWeights"],
      [SkinnedMeshRenderer, "material"],
      [SkinnedMeshRenderer, "castShadows"],
      [BoneAttachment, "offsetPosition"],
      [BoneAttachment, "offsetRotation"],
      [BoneAttachment, "follow"],
      [TimelineDirector, "playhead"],
    ];
    for (const [cls, name] of animatable) expect(isFieldAnimatable(cls, name), name).toBe(true);
    const fixed: [ComponentClass, string][] = [
      [Skeleton, "skeleton"],
      [Skeleton, "profile"],
      [SkinnedMeshRenderer, "mesh"],
      [SkinnedMeshRenderer, "skeleton"],
      [SkinnedMeshRenderer, "boundsMode"],
      [Skeleton2D, "bones"],
      [Animator, "graph"],
      [Animator, "updateMode"],
      [Animator, "cullingMode"],
      [Animator, "rootMotion"],
      [Animator, "lodMetric"],
      [BoneAttachment, "skeleton"],
      [TimelineDirector, "timeline"],
      [TimelineDirector, "wrapMode"],
    ];
    for (const [cls, name] of fixed) expect(isFieldAnimatable(cls, name), name).toBe(false);
  });

  it("names the asset kinds its references take", () => {
    expect(option(Animator, "graph")?.kind).toBe("animgraph");
    expect(option(Animator, "defaultClip")?.kind).toBe("animclip");
    expect(option(Skeleton, "skeleton")?.kind).toBe("skeleton");
    expect(option(Skeleton, "profile")?.kind).toBe("skelprofile");
    expect(option(TimelineDirector, "timeline")?.kind).toBe("timeline");
    expect(option(Skeleton2D, "bones")?.kind).toBe("sprite");
  });
});

describe("the tween data component and the buffers", () => {
  it("defines animation.Tweens with tween handles, addable to a node", async () => {
    await load(EMPTY);
    expect(getDataComponentDef("animation.Tweens")).toBe(Tweens);
    expect(Tweens.key).toBe("tweens");
    const node = GameObject.create("Tweened");
    const view = node.addData(Tweens, { count: 1, head: 7 });
    expect([view.count, view.head]).toEqual([1, 7]);
  });

  it("declares the three buffers, empty while nothing animates", async () => {
    const engine = await Engine.create({ headless: true });
    engines.push(engine);
    expect([AnimationEvents.id, AnimatorStateChanges.id, RootMotion.id]).toEqual(["animation.AnimationEvents", "animation.AnimatorStateChanges", "animation.RootMotion"]);
    engine.step(1 / 60);
    expect(AnimationEvents.read()).toEqual([]);
    expect(AnimatorStateChanges.read()).toEqual([]);
    expect(RootMotion.read()).toEqual([]);
  });
});

describe("declared methods name the task that builds them", () => {
  const notBuilt = (what: string, task: string) => new RegExp(`^Animation: ${what.replace(/[.()`]/g, "\\$&")} is not built yet \\(${task}\\)\\.$`);

  it("Animator", async () => {
    await load(EMPTY);
    const node = GameObject.create("Hero");
    const anim = node.addComponent(Animator);
    const cases: [string, string, () => unknown][] = [
      ["Animator.ik", "T40t", () => anim.ik("LeftHand")],
      ["Animator.warp", "T40t", () => anim.warp("Vault", { position: new Vector3(0, 1, 2) })],
    ];
    for (const [what, task, call] of cases) expect(call, what).toThrow(notBuilt(what, task));
  });

  it("TimelineDirector", async () => {
    await load(EMPTY);
    const dir = GameObject.create("Cutscene").addComponent(TimelineDirector);
    expect(() => dir.play()).toThrow(notBuilt("TimelineDirector.play", "T22t"));
    expect(() => dir.pause()).toThrow(notBuilt("TimelineDirector.pause", "T22t"));
    expect(() => dir.stop()).toThrow(notBuilt("TimelineDirector.stop", "T22t"));
  });

  it("tween, sequence and parallel", async () => {
    await load(EMPTY);
    const node = GameObject.create("Box");
    expect(() => tween(node.transform!, "position", [0, 2, 0], { duration: 0.4, ease: "outBack" })).toThrow(notBuilt("tween", "T22t"));
    const fake = {} as Tween;
    expect(() => sequence(fake, fake)).toThrow(notBuilt("sequence", "T22t"));
    expect(() => parallel(fake, fake)).toThrow(notBuilt("parallel", "T22t"));
  });
});
