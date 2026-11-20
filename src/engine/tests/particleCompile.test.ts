// ADR 0060, 0251: compiling a particle graph: each system's spawn settings and kernel, events, and the spawn bindings' runner.
import { describe, expect, it } from "vitest";
import { compileParticleGraph } from "../scene/particleCompile";
import { ProgramRunner, playTimes } from "../render/particles/programRunner";
import { defaultBlock } from "../scene/particleBlocks";
import { type ContextKind, type GraphEdge, type GraphEvent, type GraphInputValue, type GraphNode, type GraphProperty, type ParticleGraph, type ParticleGraphSystem } from "../scene/particleGraph";
import { defaultParticleGraph, newGraphId, systemTemplate, parseParticleGraph } from "../scene/particleGraphFormat";
import { defaultEmitter, defaultShape, type ParticleEffect, PARTICLES_FORMAT } from "../scene/particles";
import type { EvalContext } from "../scene/particleNodes";

/** A `myco.particles@1` effect as the graph reading its file gives (migrated). */
const migratedGraph = (effect: ParticleEffect): ParticleGraph => parseParticleGraph({ format: PARTICLES_FORMAT, ...effect }).graph;

const evalCtx = (over: Partial<EvalContext> = {}): EvalContext => ({ time: 0, deltaTime: 0, playTime: 0, properties: new Map(), random: () => 0.5, ...over });
const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, type, position: [0, 0], ...extra });
const edge = (from: string, to: string): GraphEdge => ({ from, to });

/** Adds a block to a system's context (output: `blocks` of the main output) with a fresh id. */
function addBlock(g: ParticleGraph, sys: ParticleGraphSystem, ctx: ContextKind, type: string, inputs: Record<string, GraphInputValue> = {}) {
  const b = defaultBlock(type, newGraphId(g, "b"));
  Object.assign(b.inputs, inputs);
  sys[ctx].blocks.push(b);
  return b;
}

/** A graph with one empty system. */
function emptyGraph(properties: GraphProperty[] = []): { g: ParticleGraph; sys: ParticleGraphSystem } {
  const g: ParticleGraph = { properties, systems: [], nodes: [], edges: [], events: [], notes: [], groups: [] };
  const sys = systemTemplate(g, "empty", [0, 0]);
  g.systems.push(sys);
  return { g, sys };
}

const addSystem = (g: ParticleGraph): ParticleGraphSystem => {
  const s = systemTemplate(g, "empty", [0, 0]);
  g.systems.push(s);
  return s;
};

describe("spawn settings and kernels", () => {
  it("compiles a Simple Loop system", () => {
    const g = defaultParticleGraph();
    const p = compileParticleGraph(g);
    expect(p.problems).toEqual([]);
    expect(p.systems).toEqual([g.systems[0].id]);
    expect(p.spawns).toHaveLength(1);
    const s = p.spawns[0];
    expect(s.emission.rateOverTime).toBe(20);
    expect(s.lifetime).toEqual({ random: [1, 2] });
    expect(p.kernels.systems).toHaveLength(1);
    expect(p.kernels.systems[0].id).toBe(g.systems[0].id);
    expect(p.bindings).toEqual([]);
    expect(p.autoStart).toEqual([true]);
    expect(p.properties).toEqual([]);
    expect(p.simulation).toEqual([undefined]);
  });

  it("carries spawn settings, and the capacity, space and executor choice to the kernel", () => {
    const g = defaultParticleGraph();
    const s = g.systems[0];
    s.spawn.settings = { duration: 3, looping: false, startDelay: 0.5, prewarm: true };
    s.settings = { space: "local", capacity: 77, simulation: "cpu" };
    const p = compileParticleGraph(g);
    expect(p.spawns[0]).toMatchObject({ duration: 3, looping: false, startDelay: 0.5, prewarm: true });
    expect(p.kernels.systems[0]).toMatchObject({ capacity: 77, space: "local" });
    expect(p.simulation).toEqual(["cpu"]);
  });

  it("lowers rate over distance and bursts", () => {
    const { g, sys } = emptyGraph();
    addBlock(g, sys, "spawn", "spawn.rateOverDistance", { rate: 4 });
    addBlock(g, sys, "spawn", "spawn.burst", { time: 0.5, count: 12, probability: 0.5 });
    addBlock(g, sys, "spawn", "spawn.periodicBurst", { time: 1, count: 3, cycles: 4, interval: 0.25 });
    const e = compileParticleGraph(g).spawns[0];
    expect(e.emission.rateOverDistance).toBe(4);
    expect(e.emission.bursts).toEqual([
      { time: 0.5, count: 12, cycles: 1, interval: 0, probability: 0.5 },
      { time: 1, count: 3, cycles: 4, interval: 0.25, probability: 1 },
    ]);
  });

  it("takes the lifetime from Set Lifetime (a wired per-particle source too), for the alive estimate", () => {
    const { g, sys } = emptyGraph();
    expect(compileParticleGraph(g).spawns[0].lifetime).toBe(1);
    const b = addBlock(g, sys, "initialize", "init.lifetime", { lifetime: 3 });
    expect(compileParticleGraph(g).spawns[0].lifetime).toBe(3);
    g.nodes.push(node("n1", "randomRange", { inputs: { min: 1, max: 2 } }));
    g.edges.push(edge("n1.out", `${sys.id}.${b.id}.lifetime`));
    const p = compileParticleGraph(g);
    expect(p.spawns[0].lifetime).toEqual({ random: [1, 2] });
    expect(p.bindings).toEqual([]);
  });

  it("skips disabled blocks and disabled systems", () => {
    const g = defaultParticleGraph();
    const s = g.systems[0];
    s.spawn.blocks[0].enabled = false;
    const off = addSystem(g);
    off.enabled = false;
    const on = addSystem(g);
    const p = compileParticleGraph(g);
    expect(p.systems).toEqual([s.id, on.id]);
    expect(p.kernels.systems.map((k) => k.id)).toEqual([s.id, on.id]);
    expect(p.spawns[0].emission.rateOverTime).toBe(0);
    expect(p.autoStart).toEqual([true, true]);
    expect(p.problems).toEqual([]);
  });

  it("compiles every block type, extra outputs, Set Attribute and per-particle chains with nothing to report (every executor runs them, ADR 0251)", () => {
    const { g, sys } = emptyGraph();
    const types = [
      "colorOverLife", "sizeOverLife", "rotationOverLife", "speedOverLife", "forceOverLife", "gravityPoint", "noise",
      "turbulence", "orbit", "frameOverLife", "limitSpeed", "colorBySpeed", "sizeBySpeed", "collision", "collisionColliders", "collisionDepth", "gravity",
    ];
    for (const t of types) addBlock(g, sys, "update", `update.${t}`);
    for (const t of ["init.lifetime", "init.velocity", "init.size", "init.rotation", "init.color", "init.positionCone"]) addBlock(g, sys, "initialize", t);
    addBlock(g, sys, "output", "output.flipbook", { tiles: [2, 2] });
    const size = addBlock(g, sys, "update", "attribute.size", { mode: "set" });
    g.nodes.push(node("n1", "particle.ageFraction"), node("n2", "multiply", { inputs: { b: 2 } }));
    g.edges.push(edge("n1.out", "n2.a"), edge("n2.out", `${sys.id}.${size.id}.value`));
    sys.extraOutputs = [{ ...structuredClone(sys.output), type: "trail" }];
    const p = compileParticleGraph(g);
    expect(p.problems).toEqual([]);
    expect(p.kernels.systems[0].outputs.map((o) => o.type)).toEqual(["quad", "trail"]);
  });

  it("reports unknown block types and skips them", () => {
    const g = defaultParticleGraph();
    const s = g.systems[0];
    s.spawn.blocks.push({ id: "bx1", type: "spawn.bogus", inputs: {} });
    s.initialize.blocks.push({ id: "bx2", type: "init.bogus", inputs: {} });
    s.update.blocks.push({ id: "bx3", type: "update.bogus", inputs: {} });
    s.output.blocks.push({ id: "bx4", type: "output.bogus", inputs: {} });
    const p = compileParticleGraph(g);
    expect(p.problems.map((x) => x.at).sort()).toEqual([`${s.id}.bx1`, `${s.id}.bx2`, `${s.id}.bx3`, `${s.id}.bx4`]);
    for (const x of p.problems) expect(x.severity).toBe("warning");
    expect(p.problems.map((x) => x.message)).toContain(`"update.bogus" isn't an Update block this engine knows; it's skipped.`);
  });
});

describe("migration round trip", () => {
  const rich = (): ParticleEffect => {
    const a = defaultEmitter("Fire");
    a.duration = 2;
    a.looping = false;
    a.startDelay = 0.25;
    a.prewarm = false;
    a.startLife = { random: [0.5, 1.5] };
    a.startSpeed = 3;
    a.startSize = { random: [0.1, 0.3] };
    a.startRotation = 15;
    a.startColor = "#ff8800";
    a.gravity = 0.4;
    a.space = "local";
    a.maxParticles = 321;
    a.emission = { rateOverTime: 33, rateOverDistance: 2, bursts: [
      { time: 0, count: 10, cycles: 1, interval: 0, probability: 1 },
      { time: 1, count: { random: [2, 4] }, cycles: 3, interval: 0.5, probability: 0.5 },
    ] };
    a.shape = { ...defaultShape(), type: "cone", radius: 0.7, angle: 30, arc: 270, thickness: 0.4, mode: "loop", spread: 0.2, position: [0, 1, 0], rotation: [0, 90, 0] };
    a.behaviors = [
      { type: "sizeOverLife", size: { curve: [[0, 1], [1, 0]] } },
      { type: "widthOverLength", width: 0.5 },
      { type: "noise", frequency: 2, power: 1, positionAmount: 1, rotationAmount: 0 } as never,
    ];
    a.renderer = { ...a.renderer, mode: "billboard", texture: "spark.png", blending: "alpha", tiles: [2, 2], startTile: 1, blendTiles: true, renderOrder: 4 };
    a.subEmitters = [{ emitter: "Smoke", trigger: "death", probability: 0.8, inheritVelocity: true }];
    const b = defaultEmitter("Smoke");
    b.renderer = { ...b.renderer, mode: "stretched", speedScale: 0.3 };
    return { emitters: [a, b] };
  };

  it("compiles to spawn settings and kernels equivalent to the original's settings", () => {
    const effect = rich();
    const p = compileParticleGraph(migratedGraph(effect));
    expect(p.problems).toEqual([]);
    expect(p.systems).toEqual(["s1", "s2"]);
    const [a] = p.spawns;
    const [oa] = effect.emitters;
    for (const k of ["duration", "looping", "startDelay", "prewarm"] as const) expect(a[k], k).toEqual(oa[k]);
    expect(a.emission).toEqual(oa.emission);
    expect(a.lifetime).toEqual(oa.startLife);
    const [ka, kb] = p.kernels.systems;
    expect(ka).toMatchObject({ capacity: 321, space: "local" });
    expect(ka.outputs[0]).toMatchObject({ type: "quad", tiles: [2, 2], blendTiles: true, settings: { texture: "spark.png", blending: "alpha", renderOrder: 4 } });
    expect(kb.outputs[0].type).toBe("stretched");
    // The sub-emitter is a GPU event of the child.
    expect(kb.event).toEqual({ parent: 0, trigger: "death", probability: 0.8, inheritVelocity: true });
    expect(p.autoStart).toEqual([true, false]);
  });

  it("migrates a disabled emitter to a skipped system", () => {
    const effect = rich();
    effect.emitters[1].enabled = false;
    const p = compileParticleGraph(migratedGraph(effect));
    expect(p.systems).toEqual(["s1"]);
    // The sub-emitter targets a disabled system: reported, not routed.
    expect(p.kernels.systems[0].event).toBeNull();
    expect(p.problems.some((x) => x.severity === "warning")).toBe(true);
  });
});

describe("wires", () => {
  it("time x constant into spawn.rate is one live binding", () => {
    const { g, sys } = emptyGraph();
    const b = addBlock(g, sys, "spawn", "spawn.rate");
    g.nodes.push(node("n1", "time"), node("n2", "multiply", { inputs: { b: 3 } }));
    g.edges.push(edge("n1.out", "n2.a"), edge("n2.out", `${sys.id}.${b.id}.rate`));
    const p = compileParticleGraph(g);
    expect(p.problems).toEqual([]);
    expect(p.bindings).toHaveLength(1);
    const bind = p.bindings[0];
    expect(bind).toMatchObject({ emitter: 0, path: "emission.rateOverTime", live: true });
    expect(bind.evaluate(evalCtx({ time: 2 }))).toBe(6);
    expect(bind.evaluate(evalCtx({ time: 0.5 }))).toBe(1.5);
    // The settings hold the value at time 0.
    expect(p.spawns[0].emission.rateOverTime).toBe(0);
    expect(p.properties).toEqual([]);
  });

  it("a uniform chain into a burst's time is a non-live binding", () => {
    const { g, sys } = emptyGraph();
    const b = addBlock(g, sys, "spawn", "spawn.burst");
    g.nodes.push(node("n1", "time"), node("n2", "add", { inputs: { b: 1 } }));
    g.edges.push(edge("n1.out", "n2.a"), edge("n2.out", `${sys.id}.${b.id}.time`));
    const p = compileParticleGraph(g);
    expect(p.problems).toEqual([]);
    expect(p.bindings).toHaveLength(1);
    expect(p.bindings[0]).toMatchObject({ emitter: 0, path: "emission.bursts.0.time", live: false });
    expect(p.bindings[0].evaluate(evalCtx({ time: 4 }))).toBe(5);
    expect(p.spawns[0].emission.bursts[0].time).toBe(1);
  });

  it("a per-particle combining chain into a spawn input is reported and keeps its inline value", () => {
    const { g, sys } = emptyGraph();
    const b = addBlock(g, sys, "spawn", "spawn.rate", { rate: 7 });
    g.nodes.push(node("n1", "randomRange", { inputs: { min: 1, max: 2 } }), node("n2", "multiply", { inputs: { b: 2 } }));
    g.edges.push(edge("n1.out", "n2.a"), edge("n2.out", `${sys.id}.${b.id}.rate`));
    const p = compileParticleGraph(g);
    expect(p.bindings).toEqual([]);
    expect(p.problems).toHaveLength(1);
    expect(p.problems[0]).toMatchObject({ severity: "warning", at: `${sys.id}.${b.id}.rate` });
    expect(p.problems[0].message).toMatch(/one value for the whole system/);
    expect(p.spawns[0].emission.rateOverTime).toBe(7);
  });

  it("a per-particle chain into an Initialize input is the kernel's, with no binding or problem", () => {
    const { g, sys } = emptyGraph();
    const b = addBlock(g, sys, "initialize", "init.size", { size: 0.7 });
    g.nodes.push(node("n1", "randomRange", { inputs: { min: 1, max: 2 } }), node("n2", "multiply", { inputs: { b: 2 } }));
    g.edges.push(edge("n1.out", "n2.a"), edge("n2.out", `${sys.id}.${b.id}.size`));
    const p = compileParticleGraph(g);
    expect(p.bindings).toEqual([]);
    expect(p.problems).toEqual([]);
    expect(p.kernels.systems[0].needs).toContain("a per-particle operator chain");
  });

  it("a property into a spawn input is a live binding; one into any block is listed", () => {
    const { g, sys } = emptyGraph([
      { name: "Rate", type: "number", value: 4, exposed: true },
      { name: "Speed", type: "number", value: 2, exposed: true },
    ]);
    const rate = addBlock(g, sys, "spawn", "spawn.rate");
    const vel = addBlock(g, sys, "initialize", "init.velocity");
    g.nodes.push(node("n1", "property", { settings: { name: "Rate" } }), node("n2", "property", { settings: { name: "Speed" } }));
    g.edges.push(edge("n1.out", `${sys.id}.${rate.id}.rate`), edge("n2.out", `${sys.id}.${vel.id}.speed`));
    const p = compileParticleGraph(g);
    expect(p.problems).toEqual([]);
    expect(p.bindings).toHaveLength(1);
    expect(p.bindings[0]).toMatchObject({ path: "emission.rateOverTime", live: true });
    expect(p.spawns[0].emission.rateOverTime).toBe(4);
    expect(p.properties.sort()).toEqual(["Rate", "Speed"]);
    expect(p.bindings[0].evaluate(evalCtx({ properties: new Map([["Rate", 9]]) }))).toBe(9);
  });

  it("an unknown property reports a warning and keeps the inline value, in a spawn input or another block", () => {
    const { g, sys } = emptyGraph();
    const b = addBlock(g, sys, "spawn", "spawn.rate", { rate: 5 });
    g.nodes.push(node("n1", "property", { settings: { name: "Nope" } }));
    g.edges.push(edge("n1.out", `${sys.id}.${b.id}.rate`));
    const p = compileParticleGraph(g);
    expect(p.bindings).toEqual([]);
    expect(p.problems).toHaveLength(1);
    expect(p.spawns[0].emission.rateOverTime).toBe(5);
    const v = addBlock(g, sys, "initialize", "init.velocity", { speed: 5 });
    g.edges.push(edge("n1.out", `${sys.id}.${v.id}.speed`));
    expect(compileParticleGraph(g).problems.map((x) => x.at)).toEqual([`${sys.id}.${b.id}.rate`, `${sys.id}.${v.id}.speed`]);
  });
});

describe("events", () => {
  it("a Trigger Event block wired to a system's start is the child's GPU event", () => {
    const { g, sys: a } = emptyGraph();
    const trig = addBlock(g, a, "update", "update.triggerEvent", { on: "death", probability: 0.5, inheritVelocity: true });
    const b = addSystem(g);
    g.events.push({ from: `${a.id}.${trig.id}`, to: `${b.id}.start` });
    const p = compileParticleGraph(g);
    expect(p.problems).toEqual([]);
    expect(p.kernels.systems[1].event).toEqual({ parent: 0, trigger: "death", probability: 0.5, inheritVelocity: true });
    expect(p.autoStart).toEqual([true, false]);
  });

  it("maps the trigger's birth and frame settings", () => {
    for (const on of ["birth", "frame", "death"]) {
      const { g, sys: a } = emptyGraph();
      const trig = addBlock(g, a, "update", "update.triggerEvent", { on });
      const b = addSystem(g);
      g.events.push({ from: `${a.id}.${trig.id}`, to: `${b.id}.start` });
      expect(compileParticleGraph(g).kernels.systems[1].event!.trigger).toBe(on);
    }
  });

  it("routes On Play, On Stop and custom events", () => {
    const { g } = emptyGraph();
    const c = addSystem(g);
    const d = addSystem(g);
    const e = addSystem(g);
    const first = g.systems[0];
    g.nodes.push(node("n1", "event.play"), node("n2", "event.custom", { settings: { name: "boom" } }), node("n3", "event.stop"));
    const ev: GraphEvent[] = [
      { from: "n1", to: `${c.id}.start` },
      { from: "n2", to: `${d.id}.start` },
      { from: "n3", to: `${e.id}.start` },
    ];
    g.events.push(...ev);
    const p = compileParticleGraph(g);
    expect(p.problems).toEqual([]);
    expect(p.onPlay.start).toEqual([1]);
    expect(p.custom.get("boom")).toEqual({ start: [2], stop: [] });
    expect(p.onStop.start).toEqual([3]);
    // C stays auto-start because On Play starts it; D and E wait for their events; the first system has no start wire.
    expect(p.systems[0]).toBe(first.id);
    expect(p.autoStart).toEqual([true, true, false, false]);
  });

  it("routes stop wires", () => {
    const { g, sys: a } = emptyGraph();
    const b = addSystem(g);
    g.nodes.push(node("n1", "event.stop"), node("n2", "event.custom", { settings: { name: "halt" } }));
    g.events.push({ from: "n1", to: `${b.id}.stop` }, { from: "n2", to: `${a.id}.stop` });
    const p = compileParticleGraph(g);
    expect(p.onStop.stop).toEqual([1]);
    expect(p.custom.get("halt")!.stop).toEqual([0]);
    expect(p.autoStart).toEqual([true, true]); // stop wires don't affect auto-start
  });

  it("a custom event with no name is reported", () => {
    const { g, sys } = emptyGraph();
    g.nodes.push(node("n1", "event.custom"));
    g.events.push({ from: "n1", to: `${sys.id}.start` });
    const p = compileParticleGraph(g);
    expect(p.problems.some((x) => x.at === "n1" && x.severity === "warning")).toBe(true);
  });

  it("a system with no start wire auto-starts", () => {
    const g = defaultParticleGraph();
    addSystem(g);
    expect(compileParticleGraph(g).autoStart).toEqual([true, true]);
  });

  it("malformed event wires are reported", () => {
    const { g, sys: a } = emptyGraph();
    const trig = addBlock(g, a, "update", "update.triggerEvent");
    const b = addSystem(g);
    // Missing block, bad end, unknown target, from something that isn't an event node.
    g.events.push({ from: `${a.id}.nope`, to: `${b.id}.start` });
    g.events.push({ from: `${a.id}.${trig.id}`, to: `${b.id}.stop` });
    g.events.push({ from: `${a.id}.${trig.id}`, to: "zz.start" });
    g.events.push({ from: "missingNode", to: `${b.id}.start` });
    const p = compileParticleGraph(g);
    expect(p.problems.length).toBeGreaterThanOrEqual(4);
    for (const x of p.problems) expect(x.severity).toBe("warning");
    expect(p.kernels.systems[1].event).toBeNull();
  });
});

describe("ProgramRunner", () => {
  const rateGraph = () => {
    const { g, sys } = emptyGraph();
    const b = addBlock(g, sys, "spawn", "spawn.rate");
    g.nodes.push(node("n1", "time"), node("n2", "multiply", { inputs: { b: 3 } }));
    g.edges.push(edge("n1.out", "n2.a"), edge("n2.out", `${sys.id}.${b.id}.rate`));
    return g;
  };

  it("writes evaluated numbers into live boxes", () => {
    const runner = new ProgramRunner(compileParticleGraph(rateGraph()));
    const box = runner.live(0, "emission.rateOverTime")!;
    expect(box).toBeDefined();
    expect(box.value).toBe(0);
    expect(runner.update(2, 0.016, () => 0)).toBe(false);
    expect(box.value).toBe(6);
    runner.update(5, 0.016, () => 0);
    expect(box.value).toBe(15);
    expect(runner.live(0, "emission.rateOverDistance")).toBeUndefined();
    expect(runner.live(1, "emission.rateOverTime")).toBeUndefined();
  });

  it("passes play time to the bindings", () => {
    const { g, sys } = emptyGraph();
    const b = addBlock(g, sys, "spawn", "spawn.rate");
    g.nodes.push(node("n1", "playTime"));
    g.edges.push(edge("n1.out", `${sys.id}.${b.id}.rate`));
    const runner = new ProgramRunner(compileParticleGraph(g));
    runner.update(10, 0.016, () => 1.25);
    expect(runner.live(0, "emission.rateOverTime")!.value).toBe(1.25);
  });

  it("gives each system its own play time, by its own duration", () => {
    const { g, sys } = emptyGraph();
    const sys2 = addSystem(g);
    sys.spawn.settings.duration = 2;
    sys2.spawn.settings.duration = 5;
    for (const s of [sys, sys2]) {
      const b = addBlock(g, s, "spawn", "spawn.rate");
      const n = `n${s.id}`;
      g.nodes.push(node(n, "playTime"));
      g.edges.push(edge(`${n}.out`, `${s.id}.${b.id}.rate`));
    }
    const p = compileParticleGraph(g);
    const runner = new ProgramRunner(p);
    runner.update(7, 0.016, playTimes(p, 7));
    expect(runner.live(0, "emission.rateOverTime")!.value).toBeCloseTo(1); // 7 mod 2
    expect(runner.live(1, "emission.rateOverTime")!.value).toBeCloseTo(2); // 7 mod 5
    sys2.spawn.settings.duration = 0;
    const q = compileParticleGraph(g);
    expect(playTimes(q, 7)(1)).toBe(7); // no duration: the whole time
  });

  it("carries a system's own seed into the program", () => {
    const { g, sys } = emptyGraph();
    addSystem(g);
    sys.settings.seed = 9;
    expect(compileParticleGraph(g).seeds).toEqual([9, null]);
  });

  const propGraph = () => {
    const { g, sys } = emptyGraph([{ name: "Rate", type: "number", value: 1, exposed: true }]);
    const b = addBlock(g, sys, "spawn", "spawn.rate");
    g.nodes.push(node("n1", "property", { settings: { name: "Rate" } }));
    g.edges.push(edge("n1.out", `${sys.id}.${b.id}.rate`));
    return g;
  };

  it("applies property overrides on the next update, and keeps them in the context the kernels evaluate with", () => {
    const runner = new ProgramRunner(compileParticleGraph(propGraph()));
    const box = runner.live(0, "emission.rateOverTime")!;
    runner.update(0, 0, () => 0);
    expect(box.value).toBe(1);
    runner.setOverrides({ Rate: 7, Unrelated: 3 });
    expect(box.value).toBe(1); // not until update
    runner.update(0, 0, () => 0);
    expect(box.value).toBe(7);
    expect([...runner.context.properties.keys()]).toEqual(["Rate"]);
    runner.setOverrides({});
    runner.update(0, 0, () => 0);
    expect(box.value).toBe(1);
  });

  it("keeps the last value when an override has the wrong type", () => {
    const runner = new ProgramRunner(compileParticleGraph(propGraph()));
    const box = runner.live(0, "emission.rateOverTime")!;
    runner.setOverrides({ Rate: 5 });
    runner.update(0, 0, () => 0);
    runner.setOverrides({ Rate: "oops" });
    expect(() => runner.update(0, 0, () => 0)).not.toThrow();
    expect(box.value).toBe(5);
  });

  const intervalGraph = () => {
    const { g, sys } = emptyGraph([{ name: "Gap", type: "number", value: 1, exposed: true }]);
    const b = addBlock(g, sys, "spawn", "spawn.periodicBurst");
    g.nodes.push(node("n1", "property", { settings: { name: "Gap" } }));
    g.edges.push(edge("n1.out", `${sys.id}.${b.id}.interval`));
    return g;
  };

  it("reports a baked binding stale only after its value changes", () => {
    const p = compileParticleGraph(intervalGraph());
    expect(p.bindings[0]).toMatchObject({ path: "emission.bursts.0.interval", live: false });
    const runner = new ProgramRunner(p);
    runner.setOverrides({ Gap: 2 });
    runner.spawns();
    expect(runner.update(1, 0.016, () => 0, true)).toBe(false);
    expect(runner.update(2, 0.016, () => 0, true)).toBe(false);
    runner.setOverrides({ Gap: 5 });
    expect(runner.update(3, 0.016, () => 0, true)).toBe(true);
    // Still stale until the effect is rebuilt.
    expect(runner.update(4, 0.016, () => 0, true)).toBe(true);
    runner.spawns();
    expect(runner.update(5, 0.016, () => 0, true)).toBe(false);
    // Without checkBaked it never reports.
    runner.setOverrides({ Gap: 9 });
    expect(runner.update(6, 0.016, () => 0)).toBe(false);
  });

  it("spawns() bakes non-live bindings into a clone", () => {
    const p = compileParticleGraph(intervalGraph());
    const original = p.spawns[0].emission.bursts[0].interval;
    const runner = new ProgramRunner(p);
    runner.setOverrides({ Gap: 3 });
    const built = runner.spawns();
    expect(built).not.toBe(p.spawns);
    expect(built[0].emission.bursts[0].interval).toBe(3);
    expect(p.spawns[0].emission.bursts[0].interval).toBe(original);
    expect(original).not.toBe(3);
  });
});
