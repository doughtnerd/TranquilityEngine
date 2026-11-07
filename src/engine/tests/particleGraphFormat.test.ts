import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PARTICLE_GRAPH_FORMAT, type ParticleGraph } from "../scene/particleGraph";
import {
  defaultParticleGraph,
  formatParticleGraph,
  migrateParticleEffect,
  newGraphId,
  parseParticleGraph,
  particleGraphJSON,
  systemTemplate,
} from "../scene/particleGraphFormat";
import { BEHAVIOR_TYPES, defaultBehavior, defaultEmitter, defaultParticleEffect, formatParticleEffect, type ParticleEffect } from "../scene/particles";

const ofType = (g: ParticleGraph, sys: number, ctx: "spawn" | "initialize" | "update" | "output", type: string) => g[ctx === "spawn" ? "systems" : "systems"][sys][ctx].blocks.filter((b) => b.type === type);

function richEffect(): ParticleEffect {
  const a = defaultEmitter("Main");
  a.enabled = true;
  a.gravity = 0.5;
  a.maxParticles = 321;
  a.space = "local";
  a.duration = 3;
  a.looping = false;
  a.startDelay = 0.5;
  a.prewarm = true;
  a.emission.rateOverDistance = 4;
  a.emission.bursts = [
    { time: 0.2, count: { random: [3, 6] }, cycles: 1, interval: 0.1, probability: 0.8 },
    { time: 1, count: 5, cycles: 4, interval: 0.25, probability: 1 },
  ];
  a.shape = { ...a.shape, type: "donut", radius: 0.5, donutRadius: 0.05, arc: 180, thickness: 0.4, mode: "loop", spread: 0.1, position: [1, 2, 3], rotation: [10, 20, 30] };
  a.behaviors = [...BEHAVIOR_TYPES.map((t) => defaultBehavior(t))];
  a.behaviors[1] = { ...a.behaviors[1], enabled: false };
  a.subEmitters = [{ emitter: "Embers", trigger: "death", probability: 0.5, inheritVelocity: true }];
  a.renderer = { ...a.renderer, mode: "stretched", material: "m.mat", texture: "t.png", blending: "alpha", tiles: [4, 2], startTile: { random: [0, 3] }, blendTiles: true, mesh: "builtin:sphere", speedScale: 0.3, lengthScale: 2, trailLength: { random: [10, 30] }, renderOrder: 3 };
  const b = defaultEmitter("Embers");
  b.enabled = false;
  b.shape.type = "point";
  b.renderer.mode = "billboard";
  return { emitters: [a, b], editor: { zoom: 2 } };
}

describe("particle graph migration (@1 to @2)", () => {
  it("migrates the default effect", () => {
    const g = migrateParticleEffect(defaultParticleEffect());
    expect(g.systems).toHaveLength(1);
    const s = g.systems[0];
    expect(s.id).toBe("s1");
    expect(s.name).toBe("Emitter");
    expect(s.enabled).toBeUndefined();
    expect(s.position).toEqual([0, 0]);
    expect(s.settings).toEqual({ space: "world", capacity: 1000 });
    expect(s.spawn.settings).toEqual({ duration: 5, looping: true, startDelay: 0, prewarm: false });
    expect(s.spawn.blocks.map((b) => b.type)).toEqual(["spawn.rate"]);
    expect(s.spawn.blocks[0].inputs.rate).toBe(20);
    expect(s.initialize.blocks.map((b) => b.type)).toEqual(["init.lifetime", "init.velocity", "init.size", "init.rotation", "init.color", "init.positionCone"]);
    expect(s.initialize.blocks[0].inputs.lifetime).toEqual({ random: [1, 2] });
    expect(s.initialize.blocks[5].inputs).toMatchObject({ radius: 0.2, angle: 20, arc: 360, thickness: 1, mode: "random", spread: 0, offset: [0, 0, 0], rotation: [0, 0, 0] });
    expect(s.update.blocks.map((b) => b.type)).toEqual(["update.colorOverLife"]);
    expect(s.output.type).toBe("quad");
    expect(s.output.blocks).toEqual([]);
    expect(s.output.settings).toMatchObject({ blending: "additive", mesh: "builtin:cube", trailLength: 20 });
    // ids are unique across the document
    const ids = [s.id, ...[s.spawn, s.initialize, s.update, s.output].flatMap((c) => c.blocks.map((b) => b.id))];
    expect(new Set(ids).size).toBe(ids.length);
    expect(parseParticleGraph(JSON.parse(formatParticleGraph(g))).problems).toEqual([]);
  });

  it("migrates a rich effect", () => {
    const effect = richEffect();
    const g = migrateParticleEffect(effect);
    expect(g.systems.map((s) => s.name)).toEqual(["Main", "Embers"]);
    expect(g.systems.map((s) => s.position)).toEqual([[0, 0], [420, 0]]);
    expect(g.systems[1].enabled).toBe(false);
    expect(g.editor).toEqual({ zoom: 2 });
    const s = g.systems[0];
    expect(s.settings).toEqual({ space: "local", capacity: 321 });
    expect(s.spawn.settings).toEqual({ duration: 3, looping: false, startDelay: 0.5, prewarm: true });
    expect(s.spawn.blocks.map((b) => b.type)).toEqual(["spawn.rate", "spawn.rateOverDistance", "spawn.burst", "spawn.periodicBurst"]);
    expect(s.spawn.blocks[2].inputs).toEqual({ time: 0.2, count: { random: [3, 6] }, probability: 0.8 });
    expect(s.spawn.blocks[3].inputs).toEqual({ time: 1, count: 5, cycles: 4, interval: 0.25, probability: 1 });
    const donut = ofType(g, 0, "initialize", "init.positionDonut")[0];
    expect(donut.inputs).toEqual({ radius: 0.5, donutRadius: 0.05, arc: 180, thickness: 0.4, mode: "loop", spread: 0.1, offset: [1, 2, 3], rotation: [10, 20, 30] });

    // gravity first, then behaviours in order; widthOverLength moved to the output; trigger last
    const update = s.update.blocks.map((b) => b.type);
    expect(update[0]).toBe("update.gravity");
    expect(s.update.blocks[0].inputs.strength).toBe(0.5);
    expect(update.slice(1, -1)).toEqual(BEHAVIOR_TYPES.filter((t) => t !== "widthOverLength").map((t) => `update.${t}`));
    expect(update[update.length - 1]).toBe("update.triggerEvent");
    expect(s.update.blocks[2].enabled).toBe(false); // sizeOverLife
    expect(s.update.blocks[1].enabled).toBeUndefined();
    const force = ofType(g, 0, "update", "update.forceOverLife")[0];
    expect(force.inputs).toEqual({ x: 0, y: 1, z: 0 });
    const turb = ofType(g, 0, "update", "update.turbulence")[0];
    expect(turb.inputs).toEqual({ scale: [1, 1, 1], octaves: 2, velocity: [1, 1, 1], timeScale: [0.5, 0.5, 0.5] });

    const trigger = s.update.blocks[s.update.blocks.length - 1];
    expect(trigger.inputs).toEqual({ on: "death", probability: 0.5, inheritVelocity: true });
    expect(g.events).toEqual([{ from: `s1.${trigger.id}`, to: "s2.start" }]);

    expect(s.output.type).toBe("stretched");
    expect(s.output.settings).toEqual({ material: "m.mat", texture: "t.png", blending: "alpha", renderOrder: 3, mesh: "builtin:sphere", speedScale: 0.3, lengthScale: 2, trailLength: 20 });
    expect(s.output.blocks.map((b) => b.type)).toEqual(["output.flipbook", "output.widthOverLength"]);
    expect(s.output.blocks[0].inputs).toEqual({ tiles: [4, 2], startTile: { random: [0, 3] }, blendTiles: true });
    expect(g.systems[1].output.type).toBe("quad");
    expect(g.systems[1].output.blocks).toEqual([]);
    expect(g.systems[1].update.blocks.map((b) => b.type)).toEqual(["update.colorOverLife"]);

    // block ids are numbered across the document and unique
    const ids = g.systems.flatMap((sys) => [sys.id, ...[sys.spawn, sys.initialize, sys.update, sys.output].flatMap((c) => c.blocks.map((b) => b.id))]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(g.systems[1].spawn.blocks[0].id).toBe(`b${g.systems[0].spawn.blocks.length + 6 + s.update.blocks.length + s.output.blocks.length + 1}`);

    // lossless through the file
    const { graph: back, problems, migrated } = parseParticleGraph(JSON.parse(formatParticleGraph(g)));
    expect(problems).toEqual([]);
    expect(migrated).toBe(false);
    expect(back).toEqual(g);
  });

  it("keeps non-constant trail lengths as their average and skips unreachable sub-emitters", () => {
    const e = defaultEmitter("A");
    e.renderer.mode = "trail";
    e.renderer.trailLength = { random: [10, 30] };
    e.subEmitters = [{ emitter: "Missing", trigger: "birth", probability: 1, inheritVelocity: false }];
    const g = migrateParticleEffect({ emitters: [e] });
    expect(g.systems[0].output.type).toBe("trail");
    expect(g.systems[0].output.settings.trailLength).toBe(20);
    expect(g.events).toEqual([]);
    expect(g.systems[0].update.blocks.some((b) => b.type === "update.triggerEvent")).toBe(false);
  });

  it("reads the playground campfire (converted to a graph) with no problems and three systems", () => {
    const raw = JSON.parse(readFileSync(new URL("../../../samples/playground3d/effects/campfire.particles.json", import.meta.url), "utf8"));
    const { graph, problems, migrated } = parseParticleGraph(raw);
    expect(migrated).toBe(false);
    expect(problems).toEqual([]);
    expect(graph.systems).toHaveLength(3);
    expect(graph.systems.map((s) => s.name)).toEqual(["Flames", "Smoke", "Sparks"]);
    expect(ofType(graph, 2, "spawn", "spawn.burst")).toHaveLength(1);
  });
});

describe("particle graph parsing and writing", () => {
  it("detects @1 documents, with or without a format", () => {
    const text = JSON.parse(formatParticleEffect(defaultParticleEffect()));
    expect(parseParticleGraph(text).migrated).toBe(true);
    delete text.format;
    const r = parseParticleGraph(text);
    expect(r.migrated).toBe(true);
    expect(r.graph.systems).toHaveLength(1);
  });

  it("carries @1 problems over as warnings", () => {
    const r = parseParticleGraph({ format: "myco.particles@1", emitters: [{ name: "X", duration: "long" }] });
    expect(r.migrated).toBe(true);
    expect(r.problems.some((p) => p.severity === "warning" && p.message.includes("duration"))).toBe(true);
  });

  it("rejects other formats with an error and an empty graph", () => {
    const r = parseParticleGraph({ format: "something@9" });
    expect(r.problems[0].severity).toBe("error");
    expect(r.graph.systems).toEqual([]);
    expect(parseParticleGraph(42).problems[0].severity).toBe("error");
  });

  it("writes the format tag first and ends with a newline", () => {
    const text = formatParticleGraph(defaultParticleGraph());
    expect(text.endsWith("\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))[0]).toBe("format");
    expect(JSON.parse(text).format).toBe(PARTICLE_GRAPH_FORMAT);
    expect(particleGraphJSON(defaultParticleGraph()).format).toBe(PARTICLE_GRAPH_FORMAT);
  });

  it("round-trips every template, with notes, groups, properties, nodes and wires", () => {
    const g = defaultParticleGraph();
    for (const kind of ["empty", "burst", "trail"] as const) g.systems.push(systemTemplate(g, kind, [g.systems.length * 420, 0]));
    g.properties.push({ name: "Tint", type: "color", value: "#ff0000", exposed: true }, { name: "Ramp", type: "gradient", value: { gradient: { colors: [[0, "#000000"]], alphas: [[0, 1]] } }, exposed: false });
    g.nodes.push({ id: "n1", type: "gradient", position: [-300, 40], settings: { colors: [[0, "#ffd27a"]] } });
    g.edges.push({ from: "n1.out", to: `s1.${g.systems[0].update.blocks[0].id}.color` });
    g.events.push({ from: `s1.${g.systems[0].spawn.blocks[0].id}`, to: "s2.start" });
    g.notes.push({ id: "note1", position: [0, 200], size: [200, 80], text: "hi" });
    g.groups.push({ id: "g1", title: "G", members: ["s1", "n1"] });
    g.editor = { view: [1, 2, 3] };
    g.systems[0].enabled = false;
    g.systems[1].extraOutputs = [{ type: "mesh", settings: { ...g.systems[1].output.settings }, blocks: [] }];
    const r = parseParticleGraph(JSON.parse(formatParticleGraph(g)));
    expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(r.graph).toEqual(g);
    expect(formatParticleGraph(r.graph)).toBe(formatParticleGraph(g));
  });

  it("round-trips editor.collapsed and drops systems that no longer exist when saving", () => {
    const g = defaultParticleGraph();
    const id = g.systems[0].id;
    g.editor = { zoom: 2, collapsed: [id, "gone"] };
    const back = parseParticleGraph(JSON.parse(formatParticleGraph(g))).graph;
    expect(back.editor).toEqual({ zoom: 2, collapsed: [id] });
    g.editor = { collapsed: ["gone"] };
    expect(JSON.parse(formatParticleGraph(g)).editor).toBeUndefined();
  });

  it("keeps unknown block types, inputs, settings and nodes with warnings", () => {
    const g = defaultParticleGraph();
    const json = JSON.parse(formatParticleGraph(g));
    json.systems[0].update.blocks.push({ id: "bx", type: "update.future", inputs: { power: { random: [1, 2] }, label: "x" } });
    json.systems[0].update.blocks[0].inputs.bogus = 5;
    json.systems[0].settings.seed = 7;
    json.systems[0].spawn.settings.mystery = true;
    json.nodes = [{ id: "n9", type: "hyperNode", position: [1, 2], settings: { k: 1 } }];
    const r = parseParticleGraph(json, "x", { knownNodeTypes: new Set(["gradient"]) });
    const ats = r.problems.map((p) => p.at);
    expect(ats).toContain("s1.bx");
    expect(ats).toContain("s1.b6.bogus"); // the first update block
    expect(ats).toContain("s1.settings.seed");
    expect(ats).toContain("s1.spawn.mystery");
    expect(ats).toContain("n9");
    expect(r.problems.every((p) => p.severity === "warning")).toBe(true);
    const sys = r.graph.systems[0];
    expect(sys.update.blocks.at(-1)).toEqual({ id: "bx", type: "update.future", inputs: { power: { random: [1, 2] }, label: "x" } });
    expect(sys.update.blocks[0].inputs.bogus).toBe(5);
    expect((sys.settings as unknown as Record<string, unknown>).seed).toBe(7);
    expect(r.graph.nodes[0]).toEqual({ id: "n9", type: "hyperNode", position: [1, 2], settings: { k: 1 } });
    // and survive a round trip
    const again = parseParticleGraph(JSON.parse(formatParticleGraph(r.graph)), "x", { knownNodeTypes: new Set(["gradient"]) });
    expect(again.graph).toEqual(r.graph);
  });

  it("warns about bad values with id paths and falls back to defaults", () => {
    const g = defaultParticleGraph();
    const json = JSON.parse(formatParticleGraph(g));
    const spawn = json.systems[0].spawn.blocks[0];
    spawn.inputs.rate = "fast";
    json.systems[0].initialize.blocks[1].type = "init.positionCone"; // placed in the wrong context (and it's a cone already)
    const cone = json.systems[0].initialize.blocks.find((b: { type: string }) => b.type === "init.positionCone");
    cone.inputs.mode = "zigzag";
    cone.inputs.offset = [1, 2];
    cone.inputs.angle = 200;
    json.systems[0].update.blocks[0].inputs.color = "red";
    json.systems[0].settings.space = "orbit";
    const r = parseParticleGraph(json);
    const at = (a: string) => r.problems.find((p) => p.at === a);
    expect(at(`s1.${spawn.id}.rate`)?.severity).toBe("warning");
    expect(at(`s1.${cone.id}.mode`)).toBeDefined();
    expect(at(`s1.${cone.id}.offset`)).toBeDefined();
    expect(at(`s1.${json.systems[0].update.blocks[0].id}.color`)).toBeDefined();
    expect(at("s1.settings.space")).toBeDefined();
    const sys = r.graph.systems[0];
    expect(sys.spawn.blocks[0].inputs.rate).toBe(20);
    const c = sys.initialize.blocks.find((b) => b.id === cone.id)!;
    expect(c.inputs.mode).toBe("random");
    expect(c.inputs.offset).toEqual([0, 0, 0]);
    expect(c.inputs.angle).toBe(90); // clamped
    expect(sys.settings.space).toBe("world");
  });

  it("flags blocks in the wrong context but keeps them", () => {
    const json = JSON.parse(formatParticleGraph(defaultParticleGraph()));
    json.systems[0].spawn.blocks.push({ id: "bz", type: "update.noise", inputs: {} });
    const r = parseParticleGraph(json);
    expect(r.problems.find((p) => p.at === "s1.bz")?.message).toContain("context");
    expect(r.graph.systems[0].spawn.blocks.at(-1)?.type).toBe("update.noise");
  });

  it("reports duplicate ids as errors and dangling wires as warnings, keeping both", () => {
    const json = JSON.parse(formatParticleGraph(defaultParticleGraph()));
    json.systems[0].update.blocks.push({ id: "b1", type: "update.gravity", inputs: {} });
    json.nodes = [{ id: "n1", type: "gradient", position: [0, 0] }];
    json.edges = [{ from: "n1.out", to: "s1.nope.color" }, { from: "ghost.out", to: "n1.in" }];
    json.events = [{ from: "s1.zzz", to: "s7.start" }];
    const r = parseParticleGraph(json);
    expect(r.problems.filter((p) => p.severity === "error").map((p) => p.at)).toEqual(["b1"]);
    expect(r.graph.edges).toHaveLength(2);
    expect(r.graph.events).toHaveLength(1);
    expect(r.problems.filter((p) => p.severity === "warning").length).toBeGreaterThanOrEqual(4);
  });

  it("accepts a wired input reference as an inline value", () => {
    const json = JSON.parse(formatParticleGraph(defaultParticleGraph()));
    json.systems[0].update.blocks[0].inputs.color = "@n1";
    const r = parseParticleGraph(json);
    expect(r.graph.systems[0].update.blocks[0].inputs.color).toBe("@n1");
    expect(r.problems.some((p) => p.at?.endsWith(".color"))).toBe(false);
  });
});

describe("ids and templates", () => {
  it("hands out ids unused in the graph", () => {
    const g = defaultParticleGraph();
    expect(newGraphId(g, "s")).toBe("s2");
    expect(newGraphId(g, "b")).toBe("b7");
    expect(newGraphId(g, "n")).toBe("n1");
    expect(newGraphId(g, "note")).toBe("note1");
    g.nodes.push({ id: "n4", type: "x", position: [0, 0] });
    expect(newGraphId(g, "n")).toBe("n5");
  });

  it("builds templates whose ids don't clash with the graph", () => {
    const g = defaultParticleGraph();
    for (const kind of ["empty", "simpleLoop", "burst", "trail"] as const) {
      const sys = systemTemplate(g, kind, [10, 20], kind === "empty" ? "Mine" : undefined);
      g.systems.push(sys);
      expect(sys.position).toEqual([10, 20]);
    }
    const ids = g.systems.flatMap((s) => [s.id, ...[s.spawn, s.initialize, s.update, s.output].flatMap((c) => c.blocks.map((b) => b.id))]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(parseParticleGraph(JSON.parse(formatParticleGraph(g))).problems).toEqual([]);
    expect(g.systems[1].name).toBe("Mine");
  });

  it("matches the template descriptions", () => {
    const g = defaultParticleGraph();
    const loop = g.systems[0];
    expect(loop.name).toBe("Simple Loop");
    expect(loop.spawn.blocks[0]).toMatchObject({ type: "spawn.rate", inputs: { rate: 20 } });
    expect(loop.initialize.blocks.map((b) => b.type)).toEqual(["init.lifetime", "init.positionCone", "init.velocity", "init.size"]);
    const burst = systemTemplate(g, "burst", [0, 0]);
    expect(burst.spawn.settings).toMatchObject({ looping: false, duration: 1 });
    expect(burst.spawn.blocks[0]).toMatchObject({ type: "spawn.burst", inputs: { count: 50 } });
    expect(burst.initialize.blocks.map((b) => b.type)).toContain("init.positionSphere");
    expect(systemTemplate(g, "trail", [0, 0]).output.type).toBe("trail");
    const empty = systemTemplate(g, "empty", [0, 0]);
    expect([empty.spawn.blocks, empty.initialize.blocks, empty.update.blocks, empty.output.blocks]).toEqual([[], [], [], []]);
    expect(empty.output.type).toBe("quad");
  });
});
