import { describe, expect, it } from "vitest";
import { compileParticleGraph } from "../scene/particleCompile";
import { ProgramRunner, playTimes } from "../render/particles/programRunner";
import { defaultBlock } from "../scene/particleBlocks";
import { OUTPUT_TYPES, type ContextKind, type GraphEdge, type GraphEvent, type GraphInputValue, type GraphNode, type GraphProperty, type ParticleGraph, type ParticleGraphSystem } from "../scene/particleGraph";
import { defaultParticleGraph, migrateParticleEffect, newGraphId, systemTemplate } from "../scene/particleGraphFormat";
import { defaultEmitter, defaultShape, type ParticleEffect } from "../scene/particles";
import type { EvalContext } from "../scene/particleNodes";

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

describe("lowering", () => {
  it("lowers a Simple Loop system", () => {
    const g = defaultParticleGraph();
    const p = compileParticleGraph(g);
    expect(p.problems).toEqual([]);
    expect(p.systems).toEqual([g.systems[0].id]);
    expect(p.effect.emitters).toHaveLength(1);
    const e = p.effect.emitters[0];
    expect(e.name).toBe(g.systems[0].id);
    expect(e.emission.rateOverTime).toBe(20);
    expect(e.startLife).toEqual({ random: [1, 2] });
    expect(e.shape.type).toBe("cone");
    expect(e.shape).toEqual({ ...defaultShape(), type: "cone" });
    expect(e.startSpeed).toBe(2);
    expect(e.startSize).toBe(0.2);
    expect(e.behaviors).toHaveLength(1);
    expect(e.behaviors[0]).toMatchObject({ type: "colorOverLife" });
    expect((e.behaviors[0] as { color: { gradient: unknown } }).color.gradient).toEqual({ colors: [[0, "#ffffff"], [1, "#ffffff"]], alphas: [[0, 1], [1, 0]] });
    expect(e.renderer.mode).toBe("billboard");
    expect(p.bindings).toEqual([]);
    expect(p.autoStart).toEqual([true]);
    expect(p.properties).toEqual([]);
  });

  it("lowers spawn settings, capacity and space", () => {
    const g = defaultParticleGraph();
    const s = g.systems[0];
    s.spawn.settings = { duration: 3, looping: false, startDelay: 0.5, prewarm: true };
    s.settings = { space: "local", capacity: 77 };
    const e = compileParticleGraph(g).effect.emitters[0];
    expect(e).toMatchObject({ duration: 3, looping: false, startDelay: 0.5, prewarm: true, space: "local", maxParticles: 77 });
  });

  it("lowers rate over distance and bursts", () => {
    const { g, sys } = emptyGraph();
    addBlock(g, sys, "spawn", "spawn.rateOverDistance", { rate: 4 });
    addBlock(g, sys, "spawn", "spawn.burst", { time: 0.5, count: 12, probability: 0.5 });
    addBlock(g, sys, "spawn", "spawn.periodicBurst", { time: 1, count: 3, cycles: 4, interval: 0.25 });
    const e = compileParticleGraph(g).effect.emitters[0];
    expect(e.emission.rateOverDistance).toBe(4);
    expect(e.emission.bursts).toEqual([
      { time: 0.5, count: 12, cycles: 1, interval: 0, probability: 0.5 },
      { time: 1, count: 3, cycles: 4, interval: 0.25, probability: 1 },
    ]);
  });

  it("lowers init blocks and gravity", () => {
    const { g, sys } = emptyGraph();
    addBlock(g, sys, "initialize", "init.lifetime", { lifetime: 3 });
    addBlock(g, sys, "initialize", "init.rotation", { rotation: 45 });
    addBlock(g, sys, "initialize", "init.color", { color: "#ff0000" });
    addBlock(g, sys, "update", "update.gravity", { strength: 0.5 });
    const p = compileParticleGraph(g);
    const e = p.effect.emitters[0];
    expect(e).toMatchObject({ startLife: 3, startRotation: 45, startColor: "#ff0000", gravity: 0.5 });
    expect(e.behaviors).toEqual([]); // gravity is a field, not a behaviour
  });

  it("skips disabled blocks and disabled systems", () => {
    const g = defaultParticleGraph();
    const s = g.systems[0];
    s.spawn.blocks[0].enabled = false;
    s.initialize.blocks.find((b) => b.type === "init.velocity")!.enabled = false;
    s.update.blocks[0].enabled = false;
    const off = addSystem(g);
    off.enabled = false;
    const on = addSystem(g);
    const p = compileParticleGraph(g);
    expect(p.systems).toEqual([s.id, on.id]);
    expect(p.effect.emitters.map((e) => e.name)).toEqual([s.id, on.id]);
    const e = p.effect.emitters[0];
    expect(e.emission.rateOverTime).toBe(0);
    expect(e.startSpeed).toBe(0);
    expect(e.behaviors).toEqual([]);
    expect(p.autoStart).toEqual([true, true]);
    expect(p.problems).toEqual([]);
  });

  it("lowers every update block type to its behaviour, in order", () => {
    const { g, sys } = emptyGraph();
    const types = [
      "colorOverLife", "sizeOverLife", "rotationOverLife", "speedOverLife", "forceOverLife", "gravityPoint", "noise",
      "turbulence", "orbit", "frameOverLife", "limitSpeed", "colorBySpeed", "sizeBySpeed", "collision",
    ];
    for (const t of types) addBlock(g, sys, "update", `update.${t}`);
    const p = compileParticleGraph(g);
    expect(p.problems).toEqual([]);
    const behaviors = p.effect.emitters[0].behaviors;
    expect(behaviors.map((b) => b.type)).toEqual(types);
    // Fields carry the block's input values.
    const col = behaviors.find((b) => b.type === "collision") as unknown as Record<string, unknown>;
    expect(col).toMatchObject({ bounce: expect.any(Number), kill: expect.any(Boolean), height: expect.any(Number) });
    const lim = addBlock(g, sys, "update", "update.limitSpeed", { speed: 9, dampen: 0.3 });
    expect(lim.type).toBe("update.limitSpeed");
    const again = compileParticleGraph(g).effect.emitters[0].behaviors;
    expect(again[again.length - 1]).toMatchObject({ type: "limitSpeed", speed: 9, dampen: 0.3 });
  });

  it("order of behaviours follows block order", () => {
    const { g, sys } = emptyGraph();
    addBlock(g, sys, "update", "update.noise");
    addBlock(g, sys, "update", "update.gravity");
    addBlock(g, sys, "update", "update.orbit");
    const e = compileParticleGraph(g).effect.emitters[0];
    expect(e.behaviors.map((b) => b.type)).toEqual(["noise", "orbit"]);
  });

  it("maps output types to render modes", () => {
    for (const t of OUTPUT_TYPES) {
      const g = defaultParticleGraph();
      g.systems[0].output.type = t;
      const mode = compileParticleGraph(g).effect.emitters[0].renderer.mode;
      expect(mode, t).toBe(t === "quad" ? "billboard" : t);
    }
  });

  it("copies output settings to the renderer", () => {
    const g = defaultParticleGraph();
    g.systems[0].output.settings = { material: "m.mat", texture: "t.png", blending: "alpha", renderOrder: 3, mesh: "builtin:sphere", speedScale: 0.4, lengthScale: 2, trailLength: 8 };
    expect(compileParticleGraph(g).effect.emitters[0].renderer).toMatchObject({
      material: "m.mat", texture: "t.png", blending: "alpha", renderOrder: 3, mesh: "builtin:sphere", speedScale: 0.4, lengthScale: 2, trailLength: 8,
    });
  });

  it("lowers the flipbook output block", () => {
    const { g, sys } = emptyGraph();
    addBlock(g, sys, "output", "output.flipbook", { tiles: [4, 2], startTile: 3, blendTiles: true });
    const r = compileParticleGraph(g).effect.emitters[0].renderer;
    expect(r.tiles).toEqual([4, 2]);
    expect(r.startTile).toBe(3);
    expect(r.blendTiles).toBe(true);
  });

  it("lowers width over length to a behaviour after the update behaviours", () => {
    const g = defaultParticleGraph();
    const s = g.systems[0];
    addBlock(g, s, "output", "output.widthOverLength", { width: { curve: [[0, 1], [1, 0]] } });
    const e = compileParticleGraph(g).effect.emitters[0];
    expect(e.behaviors.map((b) => b.type)).toEqual(["colorOverLife", "widthOverLength"]);
    expect(e.behaviors[1]).toEqual({ type: "widthOverLength", width: { curve: [[0, 1], [1, 0]] } });
  });

  it("lowers position blocks to the shape", () => {
    const { g, sys } = emptyGraph();
    addBlock(g, sys, "initialize", "init.positionCone", { radius: 2, angle: 40, arc: 180, thickness: 0.5, mode: "loop", spread: 0.1, offset: [1, 2, 3], rotation: [10, 20, 30] });
    const s = compileParticleGraph(g).effect.emitters[0].shape;
    expect(s).toMatchObject({ type: "cone", radius: 2, angle: 40, arc: 180, thickness: 0.5, mode: "loop", spread: 0.1, position: [1, 2, 3], rotation: [10, 20, 30] });

    for (const [type, name] of [["Point", "point"], ["Sphere", "sphere"], ["Hemisphere", "hemisphere"], ["Circle", "circle"], ["Donut", "donut"], ["Rectangle", "rectangle"], ["Grid", "grid"]]) {
      const { g: g2, sys: s2 } = emptyGraph();
      addBlock(g2, s2, "initialize", `init.position${type}`);
      expect(compileParticleGraph(g2).effect.emitters[0].shape.type).toBe(name);
    }
    const { g: g3, sys: s3 } = emptyGraph();
    addBlock(g3, s3, "initialize", "init.positionGrid", { width: 3, height: 4, columns: 7, rows: 8 });
    expect(compileParticleGraph(g3).effect.emitters[0].shape).toMatchObject({ type: "grid", width: 3, height: 4, columns: 7, rows: 8 });
    const { g: g4, sys: s4 } = emptyGraph();
    addBlock(g4, s4, "initialize", "init.positionDonut", { radius: 2, donutRadius: 0.3 });
    expect(compileParticleGraph(g4).effect.emitters[0].shape).toMatchObject({ radius: 2, donutRadius: 0.3 });
  });

  it("with no position block the shape is a point", () => {
    const { g } = emptyGraph();
    expect(compileParticleGraph(g).effect.emitters[0].shape.type).toBe("point");
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
    expect(p.effect.emitters[0].behaviors.map((b) => b.type)).toEqual(["colorOverLife"]);
  });

  it("warns that extra outputs need the GPU backend", () => {
    const g = defaultParticleGraph();
    const s = g.systems[0];
    s.extraOutputs = [structuredClone(s.output)];
    const p = compileParticleGraph(g);
    expect(p.problems).toHaveLength(1);
    expect(p.problems[0]).toMatchObject({ severity: "warning", at: s.id });
    expect(p.problems[0].message).toMatch(/GPU/);
    expect(p.effect.emitters).toHaveLength(1);
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

  it("compiles to emitters equivalent to the original's settings", () => {
    const effect = rich();
    const graph = migrateParticleEffect(effect);
    const p = compileParticleGraph(graph);
    expect(p.problems).toEqual([]);
    expect(p.effect.emitters).toHaveLength(2);
    const [a, b] = p.effect.emitters;
    const [oa, ob] = effect.emitters;

    expect(p.systems).toEqual(["s1", "s2"]);
    expect(a.name).toBe("s1");
    expect(b.name).toBe("s2");
    for (const k of ["duration", "looping", "startDelay", "prewarm", "startLife", "startSpeed", "startSize", "startRotation", "startColor", "gravity", "space", "maxParticles"] as const) {
      expect(a[k], k).toEqual(oa[k]);
    }
    expect(a.emission).toEqual(oa.emission);
    expect(a.shape).toEqual(oa.shape);
    // Behaviours: widthOverLength moves to the output but comes back at the end.
    expect(a.behaviors.map((x) => x.type)).toEqual(["sizeOverLife", "noise", "widthOverLength"]);
    expect(a.behaviors[0]).toEqual(oa.behaviors[0]);
    expect(a.behaviors[1]).toEqual(oa.behaviors[2]);
    expect(a.behaviors[2]).toEqual(oa.behaviors[1]);
    expect(a.renderer).toMatchObject({ mode: "billboard", texture: "spark.png", blending: "alpha", tiles: [2, 2], startTile: 1, blendTiles: true, renderOrder: 4 });
    // Sub-emitters reference by system id.
    expect(a.subEmitters).toEqual([{ emitter: "s2", trigger: "death", probability: 0.8, inheritVelocity: true }]);
    expect(b.renderer).toMatchObject({ mode: "stretched", speedScale: 0.3 });
    expect(ob.subEmitters).toEqual([]);
    expect(p.autoStart).toEqual([true, false]);
  });

  it("migrates a disabled emitter to a skipped system", () => {
    const effect = rich();
    effect.emitters[1].enabled = false;
    const p = compileParticleGraph(migrateParticleEffect(effect));
    expect(p.systems).toEqual(["s1"]);
    // The sub-emitter targets a disabled system: reported, not routed.
    expect(p.effect.emitters[0].subEmitters).toEqual([]);
    expect(p.problems.some((x) => x.severity === "warning")).toBe(true);
  });
});

describe("wires", () => {
  it("a gradient node into colorOverLife is the behaviour's colour, with no binding", () => {
    const g = defaultParticleGraph();
    const s = g.systems[0];
    const block = s.update.blocks[0];
    const gradient = { colors: [[0, "#ff0000"], [1, "#0000ff"]] as [number, string][], alphas: [[0, 1], [1, 1]] as [number, number][] };
    g.nodes.push(node("n1", "gradient", { settings: { gradient } }));
    g.edges.push(edge("n1.out", `${s.id}.${block.id}.color`));
    const p = compileParticleGraph(g);
    expect(p.problems).toEqual([]);
    expect(p.bindings).toEqual([]);
    expect(p.effect.emitters[0].behaviors[0]).toEqual({ type: "colorOverLife", color: { gradient } });
  });

  it("time x constant into spawn.rate is one live number binding", () => {
    const { g, sys } = emptyGraph();
    const b = addBlock(g, sys, "spawn", "spawn.rate");
    g.nodes.push(node("n1", "time"), node("n2", "multiply", { inputs: { b: 3 } }));
    g.edges.push(edge("n1.out", "n2.a"), edge("n2.out", `${sys.id}.${b.id}.rate`));
    const p = compileParticleGraph(g);
    expect(p.problems).toEqual([]);
    expect(p.bindings).toHaveLength(1);
    const bind = p.bindings[0];
    expect(bind).toMatchObject({ emitter: 0, path: "emission.rateOverTime", kind: "number", live: true });
    expect(bind.evaluate(evalCtx({ time: 2 }))).toBe(6);
    expect(bind.evaluate(evalCtx({ time: 0.5 }))).toBe(1.5);
    // The settings hold the value at time 0.
    expect(p.effect.emitters[0].emission.rateOverTime).toBe(0);
    expect(p.properties).toEqual([]);
  });

  it("a uniform chain into a non-live field is a non-live binding", () => {
    const { g, sys } = emptyGraph();
    const b = addBlock(g, sys, "initialize", "init.positionSphere");
    g.nodes.push(node("n1", "time"), node("n2", "add", { inputs: { b: 1 } }));
    g.edges.push(edge("n1.out", "n2.a"), edge("n2.out", `${sys.id}.${b.id}.radius`));
    const p = compileParticleGraph(g);
    expect(p.problems).toEqual([]);
    expect(p.bindings).toHaveLength(1);
    expect(p.bindings[0]).toMatchObject({ emitter: 0, path: "shape.radius", kind: "number", live: false });
    expect(p.bindings[0].evaluate(evalCtx({ time: 4 }))).toBe(5);
    expect(p.effect.emitters[0].shape.radius).toBe(1);
  });

  it("a per-particle combining chain is reported and keeps its inline value", () => {
    const { g, sys } = emptyGraph();
    const b = addBlock(g, sys, "initialize", "init.size", { size: 0.7 });
    g.nodes.push(node("n1", "randomRange", { inputs: { min: 1, max: 2 } }), node("n2", "multiply", { inputs: { b: 2 } }));
    g.edges.push(edge("n1.out", "n2.a"), edge("n2.out", `${sys.id}.${b.id}.size`));
    const p = compileParticleGraph(g);
    expect(p.bindings).toEqual([]);
    expect(p.problems).toHaveLength(1);
    expect(p.problems[0]).toMatchObject({ severity: "warning", at: `${sys.id}.${b.id}.size` });
    expect(p.problems[0].message).toMatch(/GPU backend/);
    expect(p.effect.emitters[0].startSize).toBe(0.7);
  });

  it("a bare per-particle source is written into the settings with no binding", () => {
    const { g, sys } = emptyGraph();
    const b = addBlock(g, sys, "initialize", "init.size");
    g.nodes.push(node("n1", "randomRange", { inputs: { min: 1, max: 2 } }));
    g.edges.push(edge("n1.out", `${sys.id}.${b.id}.size`));
    const p = compileParticleGraph(g);
    expect(p.bindings).toEqual([]);
    expect(p.problems).toEqual([]);
    expect(p.effect.emitters[0].startSize).toEqual({ random: [1, 2] });
  });

  it("a property node into init.velocity.speed is a live binding and lists the property", () => {
    const { g, sys } = emptyGraph([{ name: "Speed", type: "number", value: 4, exposed: true }]);
    const b = addBlock(g, sys, "initialize", "init.velocity");
    g.nodes.push(node("n1", "property", { settings: { name: "Speed" } }));
    g.edges.push(edge("n1.out", `${sys.id}.${b.id}.speed`));
    const p = compileParticleGraph(g);
    expect(p.problems).toEqual([]);
    expect(p.bindings).toHaveLength(1);
    expect(p.bindings[0]).toMatchObject({ path: "startSpeed", kind: "number", live: true });
    expect(p.properties).toEqual(["Speed"]);
    expect(p.effect.emitters[0].startSpeed).toBe(4);
    expect(p.bindings[0].evaluate(evalCtx({ properties: new Map([["Speed", 9]]) }))).toBe(9);
  });

  // BUG: portRate() treats a curve/gradient-typed property as "uniform" (particleNodes.ts rateIn only
  // promotes number/colour properties with object values), so compile makes it a live binding. The
  // runner only writes numbers/colours into live boxes, so a curve override never reaches the effect.
  it("a curve property into an over-life input is a non-live binding", () => {
    const curve = { curve: [[0, 1], [1, 0]] as [number, number][] };
    const { g, sys } = emptyGraph([{ name: "Fade", type: "curve", value: curve, exposed: true }]);
    const b = addBlock(g, sys, "update", "update.sizeOverLife");
    g.nodes.push(node("n1", "property", { settings: { name: "Fade" } }));
    g.edges.push(edge("n1.out", `${sys.id}.${b.id}.size`));
    const p = compileParticleGraph(g);
    expect(p.problems).toEqual([]);
    expect(p.properties).toEqual(["Fade"]);
    expect(p.bindings).toHaveLength(1);
    expect(p.bindings[0]).toMatchObject({ path: "behaviors.0.size", live: false });
    expect(p.effect.emitters[0].behaviors[0]).toEqual({ type: "sizeOverLife", size: curve });
  });

  it("an unknown property reports a warning and keeps the inline value", () => {
    const { g, sys } = emptyGraph();
    const b = addBlock(g, sys, "initialize", "init.velocity", { speed: 5 });
    g.nodes.push(node("n1", "property", { settings: { name: "Nope" } }));
    g.edges.push(edge("n1.out", `${sys.id}.${b.id}.speed`));
    const p = compileParticleGraph(g);
    expect(p.bindings).toEqual([]);
    expect(p.problems).toHaveLength(1);
    expect(p.effect.emitters[0].startSpeed).toBe(5);
  });
});

describe("events", () => {
  it("a Trigger Event block wired to a system's start is a sub-emitter", () => {
    const { g, sys: a } = emptyGraph();
    const trig = addBlock(g, a, "update", "update.triggerEvent", { on: "death", probability: 0.5, inheritVelocity: true });
    const b = addSystem(g);
    g.events.push({ from: `${a.id}.${trig.id}`, to: `${b.id}.start` });
    const p = compileParticleGraph(g);
    expect(p.problems).toEqual([]);
    expect(p.effect.emitters[0].subEmitters).toEqual([{ emitter: b.id, trigger: "death", probability: 0.5, inheritVelocity: true }]);
    expect(p.effect.emitters[0].behaviors).toEqual([]);
    expect(p.autoStart).toEqual([true, false]);
  });

  it("maps the trigger's birth and frame settings", () => {
    for (const on of ["birth", "frame", "death"]) {
      const { g, sys: a } = emptyGraph();
      const trig = addBlock(g, a, "update", "update.triggerEvent", { on });
      const b = addSystem(g);
      g.events.push({ from: `${a.id}.${trig.id}`, to: `${b.id}.start` });
      expect(compileParticleGraph(g).effect.emitters[0].subEmitters[0].trigger).toBe(on);
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
    expect(p.effect.emitters[0].subEmitters).toEqual([]);
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
    expect(runner.live(0, "startSpeed")).toBeUndefined();
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

  it("gives each emitter its own play time, by its own duration", () => {
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

  it("writes colour bindings as linear RGBA", () => {
    const { g, sys } = emptyGraph();
    const b = addBlock(g, sys, "initialize", "init.color");
    g.nodes.push(node("n1", "constant.color", { settings: { value: "#808080" } }));
    g.edges.push(edge("n1.out", `${sys.id}.${b.id}.color`));
    const p = compileParticleGraph(g);
    expect(p.bindings[0]).toMatchObject({ kind: "color", live: true, path: "startColor" });
    const runner = new ProgramRunner(p);
    runner.update(0, 0, () => 0);
    const v = runner.live(0, "startColor")!.value as number[];
    expect(v).toHaveLength(4);
    expect(v[0]).toBeCloseTo(0.214, 2);
    expect(v[1]).toBeCloseTo(0.214, 2);
    expect(v[2]).toBeCloseTo(0.214, 2);
    expect(v[3]).toBeCloseTo(1, 5);
  });

  const propGraph = () => {
    const { g, sys } = emptyGraph([{ name: "Speed", type: "number", value: 1, exposed: true }]);
    const b = addBlock(g, sys, "initialize", "init.velocity");
    g.nodes.push(node("n1", "property", { settings: { name: "Speed" } }));
    g.edges.push(edge("n1.out", `${sys.id}.${b.id}.speed`));
    return g;
  };

  it("applies property overrides on the next update", () => {
    const runner = new ProgramRunner(compileParticleGraph(propGraph()));
    const box = runner.live(0, "startSpeed")!;
    runner.update(0, 0, () => 0);
    expect(box.value).toBe(1);
    runner.setOverrides({ Speed: 7, Unrelated: 3 });
    expect(box.value).toBe(1); // not until update
    runner.update(0, 0, () => 0);
    expect(box.value).toBe(7);
    runner.setOverrides({});
    runner.update(0, 0, () => 0);
    expect(box.value).toBe(1);
  });

  it("keeps the last value when an override has the wrong type", () => {
    const runner = new ProgramRunner(compileParticleGraph(propGraph()));
    const box = runner.live(0, "startSpeed")!;
    runner.setOverrides({ Speed: 5 });
    runner.update(0, 0, () => 0);
    runner.setOverrides({ Speed: "oops" });
    expect(() => runner.update(0, 0, () => 0)).not.toThrow();
    expect(box.value).toBe(5);
  });

  const radiusGraph = () => {
    const { g, sys } = emptyGraph([{ name: "R", type: "number", value: 1, exposed: true }]);
    const b = addBlock(g, sys, "initialize", "init.positionSphere");
    g.nodes.push(node("n1", "property", { settings: { name: "R" } }));
    g.edges.push(edge("n1.out", `${sys.id}.${b.id}.radius`));
    return g;
  };

  it("reports a baked binding stale only after its value changes", () => {
    const p = compileParticleGraph(radiusGraph());
    expect(p.bindings[0].live).toBe(false);
    const runner = new ProgramRunner(p);
    runner.setOverrides({ R: 2 });
    runner.effect();
    expect(runner.update(1, 0.016, () => 0, true)).toBe(false);
    expect(runner.update(2, 0.016, () => 0, true)).toBe(false);
    runner.setOverrides({ R: 5 });
    expect(runner.update(3, 0.016, () => 0, true)).toBe(true);
    // Still stale until the effect is rebuilt.
    expect(runner.update(4, 0.016, () => 0, true)).toBe(true);
    runner.effect();
    expect(runner.update(5, 0.016, () => 0, true)).toBe(false);
    // Without checkBaked it never reports.
    runner.setOverrides({ R: 9 });
    expect(runner.update(6, 0.016, () => 0)).toBe(false);
  });

  it("effect() bakes non-live bindings into a clone", () => {
    const p = compileParticleGraph(radiusGraph());
    const original = p.effect.emitters[0].shape.radius;
    const runner = new ProgramRunner(p);
    runner.setOverrides({ R: 3 });
    const built = runner.effect();
    expect(built).not.toBe(p.effect);
    expect(built.emitters[0].shape.radius).toBe(3);
    expect(p.effect.emitters[0].shape.radius).toBe(original);
    expect(original).not.toBe(3);
  });

  it("effect() bakes colour bindings as hex", () => {
    const { g, sys } = emptyGraph([{ name: "Tint", type: "color", value: "#ff0000", exposed: true }]);
    const b = addBlock(g, sys, "initialize", "init.positionSphere");
    expect(b).toBeDefined();
    // A colour into a non-live colour path: colorBySpeed.color is not in the live list.
    const c = addBlock(g, sys, "update", "update.colorBySpeed");
    g.nodes.push(node("n1", "property", { settings: { name: "Tint" } }));
    g.edges.push(edge("n1.out", `${sys.id}.${c.id}.color`));
    const p = compileParticleGraph(g);
    const bind = p.bindings.find((x) => x.kind === "color")!;
    expect(bind.path).toBe("behaviors.0.color");
    const runner = new ProgramRunner(p);
    runner.setOverrides({ Tint: "#00ff00" });
    const built = runner.effect();
    if (bind.live) expect(runner.live(0, bind.path)).toBeDefined();
    else expect((built.emitters[0].behaviors[0] as unknown as { color: string }).color).toBe("#00ff00");
  });
});
