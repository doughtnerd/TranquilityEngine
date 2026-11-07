// Test graphs for the kernel parity check and the benchmark (ADR 0094).
import { defaultBlock } from "../../src/engine/scene/particleBlocks";
import type { ContextKind, GraphInputValue, GraphNode, ParticleGraph, ParticleGraphSystem } from "../../src/engine/scene/particleGraph";
import { newGraphId, systemTemplate } from "../../src/engine/scene/particleGraphFormat";

export function addBlock(g: ParticleGraph, sys: ParticleGraphSystem, c: ContextKind, type: string, inputs: Record<string, GraphInputValue> = {}) {
  const b = defaultBlock(type, newGraphId(g, "b"));
  Object.assign(b.inputs, inputs);
  sys[c].blocks.push(b);
  return b;
}
const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, type, position: [0, 0], ...extra });

export function emptyGraph(): ParticleGraph {
  return { properties: [], systems: [], nodes: [], edges: [], events: [], notes: [], groups: [] };
}

/** A fountain using most update steps, per-particle operators and a GPU event child. */
export function parityGraph(capacity: number): ParticleGraph {
  const g = emptyGraph();
  const sys = systemTemplate(g, "empty", [0, 0]);
  g.systems.push(sys);
  sys.settings.capacity = capacity;
  sys.settings.space = "world";
  sys.settings.simulation = "gpu";
  addBlock(g, sys, "spawn", "spawn.rate", { rate: capacity / 2 });
  addBlock(g, sys, "initialize", "init.lifetime", { lifetime: { random: [0.5, 1.5] } });
  addBlock(g, sys, "initialize", "init.velocity", { speed: { random: [2, 4] } });
  addBlock(g, sys, "initialize", "init.size", { size: { random: [0.05, 0.2] } });
  addBlock(g, sys, "initialize", "init.color", { color: { random: ["#ff8800", "#ffee88"] } });
  addBlock(g, sys, "initialize", "init.positionCone", { radius: 0.5, angle: 25 });
  addBlock(g, sys, "update", "update.gravity", { strength: 0.5 });
  addBlock(g, sys, "update", "update.turbulence", { scale: [1, 1, 1], octaves: 2, velocity: [1, 1, 1], timeScale: [1, 1, 1] });
  addBlock(g, sys, "update", "update.noise", { frequency: 2, power: 0.2, positionAmount: 1, rotationAmount: 1 });
  addBlock(g, sys, "update", "update.orbit", { speed: 45, axis: [0, 1, 0] });
  addBlock(g, sys, "update", "update.limitSpeed", { speed: 5, dampen: 0.5 });
  addBlock(g, sys, "update", "update.speedOverLife", { speed: { curve: [[0, 1], [1, 0.3]] } });
  addBlock(g, sys, "update", "update.collision", { height: -0.5, bounce: 0.5, kill: false });
  addBlock(g, sys, "update", "update.rotationOverLife", { speed: 90 });
  addBlock(g, sys, "update", "update.sizeOverLife", { size: { curve: [[0, 0.2], [1, 1]] } });
  addBlock(g, sys, "update", "update.colorOverLife", { color: { gradient: { colors: [[0, "#ffffff"], [1, "#ff0000"]], alphas: [[0, 1], [1, 0]] } } });
  // Per-particle operators: velocity += (sin(age × 5) × 0.5, 0, 0)
  const set = addBlock(g, sys, "update", "attribute.velocity", { mode: "add" });
  g.nodes.push(node("age", "particle.age"), node("m5", "multiply", { inputs: { b: 5 } }), node("sin", "sine"), node("h", "multiply", { inputs: { b: 0.05 } }), node("v", "compose3", { inputs: { y: 0, z: 0 } }));
  g.edges.push({ from: "age.out", to: "m5.a" }, { from: "m5.out", to: "sin.x" }, { from: "sin.out", to: "h.a" }, { from: "h.out", to: "v.x" }, { from: "v.out", to: `${sys.id}.${set.id}.value` });
  const trig = addBlock(g, sys, "update", "update.triggerEvent", { on: "death" });
  // Child: sparks from each dying particle.
  const child = systemTemplate(g, "empty", [0, 0]);
  g.systems.push(child);
  child.settings.capacity = capacity * 2;
  child.settings.space = "world";
  child.settings.simulation = "gpu";
  addBlock(g, child, "spawn", "spawn.burst", { time: 0, count: 2 });
  addBlock(g, child, "initialize", "init.lifetime", { lifetime: 0.4 });
  addBlock(g, child, "initialize", "init.velocity", { speed: 1 });
  addBlock(g, child, "initialize", "init.positionSphere", { radius: 0.05 });
  addBlock(g, child, "update", "update.gravity", { strength: 1 });
  g.events.push({ from: `${sys.id}.${trig.id}`, to: `${child.id}.start` });
  return g;
}

/** A plain fountain for the benchmark: `capacity` particles alive at once. */
export function benchGraph(capacity: number, simulation: "cpu" | "gpu"): ParticleGraph {
  const g = emptyGraph();
  const sys = systemTemplate(g, "empty", [0, 0]);
  g.systems.push(sys);
  sys.settings.capacity = capacity;
  sys.settings.space = "world";
  sys.settings.simulation = simulation;
  addBlock(g, sys, "spawn", "spawn.rate", { rate: capacity / 2 });
  addBlock(g, sys, "initialize", "init.lifetime", { lifetime: 2 });
  addBlock(g, sys, "initialize", "init.velocity", { speed: { random: [2, 5] } });
  addBlock(g, sys, "initialize", "init.size", { size: 0.05 });
  addBlock(g, sys, "initialize", "init.positionCone", { radius: 0.2, angle: 30 });
  addBlock(g, sys, "update", "update.gravity", { strength: 0.6 });
  addBlock(g, sys, "update", "update.turbulence", { scale: [2, 2, 2], octaves: 1, velocity: [1, 1, 1], timeScale: [1, 1, 1] });
  addBlock(g, sys, "update", "update.colorOverLife", { color: { gradient: { colors: [[0, "#ffcc66"], [1, "#ff3300"]], alphas: [[0, 1], [1, 0]] } } });
  return g;
}
