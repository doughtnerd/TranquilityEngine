// The Animation plugin's runtime half (ADR 0370, 0372, 0374, 0375; T01): it is in the catalogue with both halves, claims
// its Components, registers its built-in systems in 0370's frame order (predicted root motion only with physics), activates
// with and without its optional dependencies, and offers the ragdoll contribution point. Everything goes through the
// plugin set (`applyTestPlugins`), the runtime activator, the system catalogue and a World's public system list.
import { afterEach, describe, expect, it } from "vitest";
import { Animator, BoneAttachment, Engine, GameObject, Skeleton, Skeleton2D, SkinnedMeshRenderer, TimelineDirector, getComponentClass } from "../../myco";
import { listSystemCatalog } from "../../engine/core/systems";
import { FIRST_PARTY } from "../catalogue";
import { EDITOR_PLUGINS } from "../editor";
import { RUNTIME_PLUGINS } from "../runtime";
import { isRuntimePluginActive, pluginOfComponent, runtimeActivator, type RuntimePlugin } from "../runtimeContext";
import { applyTestPlugins } from "../testPlugins";
import { animationEditorPlugin } from "./editor";
import { animationManifest } from "./manifest";
import { animationRuntimePlugin, PHYSICAL_ANIMATION, type PhysicalAnimationSource } from "./runtime";

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  applyTestPlugins(); // as Vitest's setup file leaves it
});

const catalogue = () => new Map(listSystemCatalog().map((s) => [s.name, s]));
const FRAME_SYSTEMS = ["animation.Timeline", "animation.Gather", "animation.Evaluate", "animation.Apply"];

describe("the Animation plugin's manifest and halves", () => {
  it("is the catalogue's `animation` entry, with physics and audio as optional dependencies", () => {
    expect(FIRST_PARTY.animation).toBe(animationManifest);
    expect(animationManifest.name).toBe("myco.animation");
    expect(animationManifest.dependencies).toBeUndefined();
    expect(Object.keys(animationManifest.optionalDependencies ?? {}).sort()).toEqual(["myco.audio", "myco.physics"]);
  });

  it("lists both halves on one manifest", () => {
    expect(RUNTIME_PLUGINS).toContain(animationRuntimePlugin);
    expect(EDITOR_PLUGINS).toContain(animationEditorPlugin);
    expect(animationEditorPlugin.manifest).toBe(animationRuntimePlugin.manifest);
  });

  it("is active by default and claims its Components", () => {
    expect(isRuntimePluginActive("myco.animation")).toBe(true);
    const components: [string, unknown][] = [
      ["engine.Skeleton", Skeleton],
      ["engine.SkinnedMeshRenderer", SkinnedMeshRenderer],
      ["engine.Skeleton2D", Skeleton2D],
      ["engine.Animator", Animator],
      ["engine.BoneAttachment", BoneAttachment],
      ["engine.TimelineDirector", TimelineDirector],
    ];
    for (const [id, cls] of components) {
      expect(getComponentClass(id)).toBe(cls);
      expect(pluginOfComponent(id)).toBe("myco.animation");
    }
  });
});

describe("the built-in systems (ADR 0370's frame order)", () => {
  it("are in the catalogue as engine built-ins in their phases, for every World", () => {
    const cat = catalogue();
    expect(cat.get("animation.FixedEvaluate")).toMatchObject({ phase: "fixedUpdate", builtin: true, worlds: ["*"] });
    for (const name of FRAME_SYSTEMS) expect(cat.get(name)).toMatchObject({ phase: "lateUpdate", builtin: true, worlds: ["*"] });
    expect(cat.get("animation.PredictedRootMotion")).toMatchObject({ phase: "fixedUpdate", builtin: true });
  });

  it("run in order: fixed animation after scripts and navigation, before the physics pushes; frame animation before lateUpdate scripts", async () => {
    const engine = await Engine.create({ headless: true });
    engines.push(engine);
    const names = Engine.findWorld("Default")!.systems();
    const at = (n: string) => names.indexOf(n);
    for (const n of [...FRAME_SYSTEMS, "animation.FixedEvaluate", "animation.PredictedRootMotion"]) expect(at(n)).toBeGreaterThanOrEqual(0);
    // fixedUpdate
    expect(at("engine.FixedUpdateScripts")).toBeLessThan(at("animation.PredictedRootMotion"));
    expect(at("engine.PredictionTick")).toBeLessThan(at("animation.PredictedRootMotion"));
    expect(at("engine.NavWriteBack")).toBeLessThan(at("animation.PredictedRootMotion"));
    expect(at("animation.PredictedRootMotion")).toBeLessThan(at("animation.FixedEvaluate"));
    expect(at("animation.FixedEvaluate")).toBeLessThan(at("engine.PhysicsPush"));
    expect(at("animation.FixedEvaluate")).toBeLessThan(at("engine.Physics3DPush"));
    // update scripts, then (lateUpdate) Timeline, Gather, Evaluate, Apply, then lateUpdate scripts
    const late = names.slice(at("animation.Timeline"), at("engine.LateUpdateScripts") + 1);
    expect(late).toEqual([...FRAME_SYSTEMS, "engine.LateUpdateScripts"]);
    expect(at("engine.UpdateScripts")).toBeLessThan(at("animation.Timeline"));
  });

  it("step a World with every animation component without effect before the core lands", async () => {
    const engine = await Engine.create({ headless: true });
    engines.push(engine);
    const rig = GameObject.create("Rig");
    rig.addComponent(Skeleton);
    rig.addComponent(Animator);
    rig.addComponent(SkinnedMeshRenderer);
    rig.addComponent(Skeleton2D);
    rig.addComponent(TimelineDirector);
    GameObject.create("Prop").addComponent(BoneAttachment);
    for (let i = 0; i < 3; i++) engine.step(1 / 60);
    GameObject.destroy(rig);
    engine.step(1 / 60);
  });
});

describe("optional dependencies (ADR 0374)", () => {
  it("without physics: activates, and predicted root motion isn't registered", () => {
    applyTestPlugins(["myco.physics"]);
    expect(isRuntimePluginActive("myco.physics")).toBe(false);
    expect(isRuntimePluginActive("myco.animation")).toBe(true);
    const cat = catalogue();
    expect(cat.has("animation.PredictedRootMotion")).toBe(false);
    for (const name of ["animation.FixedEvaluate", ...FRAME_SYSTEMS]) expect(cat.has(name)).toBe(true);
    applyTestPlugins(); // physics back: the plugin activates again with it
    expect(catalogue().has("animation.PredictedRootMotion")).toBe(true);
  });

  it("without audio: activates with every system", () => {
    applyTestPlugins(["myco.audio"]);
    expect(isRuntimePluginActive("myco.audio")).toBe(false);
    expect(isRuntimePluginActive("myco.animation")).toBe(true);
    expect(catalogue().has("animation.PredictedRootMotion")).toBe(true);
  });

  it("without either: activates, and its Components stay registered", () => {
    applyTestPlugins(["myco.physics", "myco.audio"]);
    expect(isRuntimePluginActive("myco.animation")).toBe(true);
    expect(getComponentClass("engine.Animator")).toBe(Animator);
  });

  it("asks for exactly its two optional dependencies at activation", () => {
    const asked: string[] = [];
    runtimeActivator.deactivate("myco.animation");
    runtimeActivator.activate(animationRuntimePlugin, { isActive: (name) => (asked.push(name), false) });
    expect(asked.sort()).toEqual(["myco.audio", "myco.physics"]);
    expect(catalogue().has("animation.PredictedRootMotion")).toBe(false);
    runtimeActivator.deactivate("myco.animation");
    runtimeActivator.activate(animationRuntimePlugin); // as the plugin set had it
    expect(catalogue().has("animation.PredictedRootMotion")).toBe(true);
  });

  it("disabled itself: its Components load as missing and its systems leave the catalogue", () => {
    applyTestPlugins(["myco.animation"]);
    expect(isRuntimePluginActive("myco.animation")).toBe(false);
    expect(getComponentClass("engine.Animator")).toBeUndefined();
    const cat = catalogue();
    for (const name of ["animation.FixedEvaluate", "animation.PredictedRootMotion", ...FRAME_SYSTEMS]) expect(cat.has(name)).toBe(false);
  });
});

describe("the ragdoll contribution point (ADR 0375)", () => {
  /** A ragdoll-shaped plugin contributing a client, as `myco.ragdoll`'s runtime half will. */
  function ragdollPlugin(log: string[], seen: { source: PhysicalAnimationSource | null }): RuntimePlugin {
    return {
      manifest: { name: "t.ragdoll", version: "1.0.0", dependencies: { "myco.animation": "1.0.0", "myco.physics": "1.0.0" } },
      activate(context) {
        context.contribute(PHYSICAL_ANIMATION, {
          id: "t.ragdoll",
          connect: (source) => {
            seen.source = source;
            log.push("connect");
          },
          disconnect: () => log.push("disconnect"),
        });
      },
    };
  }

  it("connects a contributed client to the source, and disconnects it when its plugin deactivates", () => {
    const log: string[] = [];
    const seen: { source: PhysicalAnimationSource | null } = { source: null };
    runtimeActivator.activate(ragdollPlugin(log, seen));
    expect(log).toEqual(["connect"]);
    expect(PHYSICAL_ANIMATION.id).toBe("myco.animation.physical");
    runtimeActivator.deactivate("t.ragdoll");
    expect(log).toEqual(["connect", "disconnect"]);
  });

  it("refuses a second client with the same id", () => {
    const log: string[] = [];
    const undo = PHYSICAL_ANIMATION.register({ id: "t.twice", connect: () => log.push("a"), disconnect: () => log.push("a off") });
    expect(() => PHYSICAL_ANIMATION.register({ id: "t.twice", connect: () => log.push("b"), disconnect: () => {} })).toThrow(/already connected/);
    undo();
    expect(log).toEqual(["a", "a off"]);
  });

  it("offers a source whose methods name T44 until it is built", async () => {
    const seen: { source: PhysicalAnimationSource | null } = { source: null };
    runtimeActivator.activate(ragdollPlugin([], seen));
    const engine = await Engine.create({ headless: true });
    engines.push(engine);
    const anim = GameObject.create("Rig").addComponent(Animator);
    const source = seen.source!;
    const notBuilt = /^Animation: PhysicalAnimationSource\.\w+ is not built yet \(T44\)\.$/;
    expect(() => source.attach(anim, { bones: [], front: "+z" })).toThrow(notBuilt);
    expect(() => source.detach(anim)).toThrow(notBuilt);
    expect(() => source.control(anim, { strength: 1 })).toThrow(notBuilt);
    expect(() => source.drives(anim)).toThrow(notBuilt);
    expect(() => source.setPhysicalPose(anim, [])).toThrow(notBuilt);
    expect(() => source.captureSnapshot(anim, "Physical", "GetUp")).toThrow(notBuilt);
    runtimeActivator.deactivate("t.ragdoll");
  });
});
