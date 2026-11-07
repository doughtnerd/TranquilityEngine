/**
 * Compiles a particle graph (ADR 0060) into a `ParticleProgram`: what a backend runs. Each enabled
 * system becomes emitter settings in our own effect model (`particles.ts`, the data the quarks
 * backend already builds from), with every block input resolved:
 * - an inline value, or a wired per-particle source (Random Range, Curve, Gradient…), is written
 *   into the settings;
 * - a wired uniform expression (operators over time and properties) becomes a binding the backend
 *   evaluates each frame. Live bindings update quarks' value generators in place; the others
 *   rebuild the effect when their value changes;
 * - an operator chain over per-particle values can't run on the CPU: it's reported ("needs the GPU
 *   backend") and the input keeps its inline value.
 * Events become sub-emitters (Trigger Event blocks) and start/stop routes (event nodes).
 */
import { blockDef } from "./particleBlocks";
import type { GraphBlock, GraphInputValue, GraphProblem, OutputContext, ParticleGraph, ParticleGraphSystem } from "./particleGraph";
import { compileUniform, nodeDef, portRate, type EvalContext, type NodeValue } from "./particleNodes";
import {
  defaultEmitter,
  defaultRenderer,
  defaultShape,
  hexColor,
  type ParticleBehavior,
  type ParticleBurst,
  type ParticleColor,
  type ParticleEffect,
  type ParticleEmitterSettings,
  type ParticleNumber,
  type ParticleRenderMode,
  type ShapeType,
} from "./particles";

/** A block input driven by a uniform expression, evaluated each frame. */
export interface ParticleBinding {
  /** Index into `effect.emitters`. */
  emitter: number;
  /** The settings field it drives: `startSpeed`, `emission.rateOverTime`, `behaviors.2.size`, `shape.radius`… */
  path: string;
  kind: "number" | "color" | "vector";
  /** Live: the backend updates its generator in place each frame. Otherwise a change rebuilds the effect. */
  live: boolean;
  evaluate(ctx: EvalContext): NodeValue;
}

/** Which systems an event starts and stops (indices into `effect.emitters`). */
export interface EventRoute {
  start: number[];
  stop: number[];
}

export interface ParticleProgram {
  /** One emitter per enabled system, named by the system's id. */
  effect: ParticleEffect;
  /** The system id of each emitter. */
  systems: string[];
  bindings: ParticleBinding[];
  /** Per emitter: starts when the effect plays (no start wires, or wired from On Play). */
  autoStart: boolean[];
  /** Per emitter: the system's own random seed (`SystemSettings.seed`), or null to use the component's. Only the GPU backend applies it; the CPU backend seeds the whole effect from the component. */
  seeds: (number | null)[];
  onPlay: EventRoute;
  onStop: EventRoute;
  /** Custom events by name (`ParticleSystem.sendEvent`). */
  custom: Map<string, EventRoute>;
  /** Property names the program reads (an override change re-evaluates bindings). */
  properties: string[];
  problems: GraphProblem[];
  /** The (expanded) graph this was compiled from: kernel backends compile it too (ADR 0094). */
  source?: ParticleGraph;
}

/** Settings fields the quarks backend builds as value generators, so a binding can update them live. */
const LIVE = /^(startLife|startSpeed|startSize|startRotation|startColor|gravity|emission\.(rateOverTime|rateOverDistance|bursts\.\d+\.count)|behaviors\.\d+\.(color|size|speed|x|y|z|frequency|power|positionAmount|rotationAmount|frame|width))$/;

const RENDER_MODE: Record<OutputContext["type"], ParticleRenderMode> = { quad: "billboard", stretched: "stretched", horizontal: "horizontal", vertical: "vertical", mesh: "mesh", trail: "trail" };

const zeroContext: EvalContext = { time: 0, deltaTime: 0, playTime: 0, properties: new Map(), random: () => 0.5 };

/** Compile `graph`. Never throws: what can't be compiled is left out and reported. */
export function compileParticleGraph(graph: ParticleGraph): ParticleProgram {
  const problems: GraphProblem[] = [];
  const bindings: ParticleBinding[] = [];
  const systems = graph.systems.filter((s) => s.enabled !== false);
  const index = new Map(systems.map((s, i) => [s.id, i]));
  const wires = new Map(graph.edges.map((e) => [e.to, e.from]));
  const properties = new Set<string>();

  /** A block input's value: written into the settings, and a binding when it's a wired uniform expression. */
  const input = (sys: ParticleGraphSystem, emitter: number, block: GraphBlock, name: string, path: string, kind: ParticleBinding["kind"]): GraphInputValue => {
    const def = blockDef(block.type)?.inputs.find((i) => i.name === name);
    const own = block.inputs[name];
    // "@n1" is a wire reference some files keep inline; the wire itself is in `edges`.
    const inline = own !== undefined && !(typeof own === "string" && own.startsWith("@")) ? own : (def?.default ?? 0);
    const from = wires.get(`${sys.id}.${block.id}.${name}`);
    if (!from) return inline;
    let evaluate: (ctx: EvalContext) => NodeValue;
    try {
      evaluate = compileUniform(graph, from);
    } catch (err) {
      problems.push({ severity: "warning", message: `${(err as Error).message} The input uses its own value.`, at: `${sys.id}.${block.id}.${name}`, cpuOnly: portRate(graph, from) === "particle" || undefined });
      return inline;
    }
    const read = new Set<string>();
    collectProperties(graph, from, read);
    for (const name of read) properties.add(name);
    const initial = evaluate(zeroContext);
    if (portRate(graph, from) === "particle") {
      // A per-particle source: fixed, unless it's a property (a curve or gradient an instance can override).
      if (read.size > 0) bindings.push({ emitter, path, kind, live: false, evaluate });
      return asInput(initial, kind) ?? inline;
    }
    bindings.push({ emitter, path, kind, live: LIVE.test(path), evaluate });
    return asInput(initial, kind) ?? inline;
  };

  const effect: ParticleEffect = { emitters: systems.map((sys, i) => lowerSystem(sys, i, input, problems)) };

  /** Systems with a working start wire: they wait for it instead of starting on play. */
  const startWired = new Set<number>();
  // Sub-emitters: Trigger Event blocks wired to another system's start.
  for (const ev of graph.events) {
    const [fromId, blockId] = ev.from.split(".");
    const [toId, end] = ev.to.split(".");
    const parent = index.get(fromId);
    const child = index.get(toId);
    if (blockId === undefined) continue; // an event node: routed below
    const block = systems[parent ?? -1]?.update.blocks.find((b) => b.id === blockId) ?? systems[parent ?? -1]?.initialize.blocks.find((b) => b.id === blockId);
    if (parent === undefined || child === undefined || !block || end !== "start") {
      problems.push({ severity: "warning", message: `The event wire from "${ev.from}" to "${ev.to}" doesn't connect a Trigger Event block to a system's start.`, at: ev.from });
      continue;
    }
    startWired.add(child); // spawned by its parent's particles, even while the trigger block is off
    if (block.enabled === false) continue;
    const on = String(block.inputs.on ?? blockDef(block.type)?.inputs.find((i) => i.name === "on")?.default ?? "death");
    effect.emitters[parent].subEmitters.push({
      emitter: systems[child].id,
      trigger: on === "birth" || on === "frame" ? on : "death",
      probability: num(block.inputs.probability, 1),
      inheritVelocity: block.inputs.inheritVelocity === true,
    });
  }

  // Start and stop routes from event nodes.
  const onPlay: EventRoute = { start: [], stop: [] };
  const onStop: EventRoute = { start: [], stop: [] };
  const custom = new Map<string, EventRoute>();
  for (const ev of graph.events) {
    const [toId, end] = ev.to.split(".");
    const target = index.get(toId);
    if (target === undefined || (end !== "start" && end !== "stop")) continue;
    if (ev.from.includes(".")) continue; // a trigger block (above)
    const node = graph.nodes.find((n) => n.id === ev.from);
    let route: EventRoute | undefined;
    if (node?.type === "event.play") route = onPlay;
    else if (node?.type === "event.stop") route = onStop;
    else if (node?.type === "event.custom") {
      const name = String(node.settings?.name ?? "");
      if (!name) problems.push({ severity: "warning", message: "A Custom Event node has no name, so no script can send it.", at: node.id });
      route = custom.get(name) ?? { start: [], stop: [] };
      custom.set(name, route);
    }
    if (!route) {
      problems.push({ severity: "warning", message: `The event wire from "${ev.from}" doesn't start at an event node.`, at: ev.from });
      continue;
    }
    route[end].push(target);
    if (end === "start") startWired.add(target);
  }
  const autoStart = systems.map((_, i) => !startWired.has(i) || onPlay.start.includes(i));

  return { effect, systems: systems.map((s) => s.id), bindings, autoStart, seeds: systems.map((s) => s.settings.seed ?? null), onPlay, onStop, custom, properties: [...properties], problems, source: graph };
}

type InputFn = (sys: ParticleGraphSystem, emitter: number, block: GraphBlock, name: string, path: string, kind: ParticleBinding["kind"]) => GraphInputValue;

function lowerSystem(sys: ParticleGraphSystem, i: number, input: InputFn, problems: GraphProblem[]): ParticleEmitterSettings {
  const base = defaultEmitter(sys.id);
  const e: ParticleEmitterSettings = {
    ...base,
    duration: sys.spawn.settings.duration,
    looping: sys.spawn.settings.looping,
    startDelay: sys.spawn.settings.startDelay,
    prewarm: sys.spawn.settings.prewarm,
    space: sys.settings.space,
    maxParticles: sys.settings.capacity,
    startLife: 1,
    startSpeed: 0,
    startSize: 0.1,
    startRotation: 0,
    startColor: "#ffffffff",
    gravity: 0,
    emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [] },
    shape: { ...defaultShape(), type: "point" },
    behaviors: [],
    subEmitters: [],
    renderer: defaultRenderer(),
  };
  const n = (b: GraphBlock, name: string, path: string) => input(sys, i, b, name, path, "number") as ParticleNumber;
  const c = (b: GraphBlock, name: string, path: string) => input(sys, i, b, name, path, "color") as ParticleColor;
  const v = (b: GraphBlock, name: string, path: string) => input(sys, i, b, name, path, "vector") as number[];
  const unknown = (b: GraphBlock, where: string) =>
    problems.push({ severity: "warning", message: `"${b.type}" isn't a ${where} block this engine knows; it's skipped.`, at: `${sys.id}.${b.id}` });
  const on = (b: GraphBlock) => b.enabled !== false;
  /** Set Attribute blocks (ADR 0095) run only on kernel backends. */
  const kernelOnly = (b: GraphBlock): boolean => {
    if (!b.type.startsWith("attribute.")) return false;
    problems.push({ severity: "warning", message: `${blockDef(b.type)?.label ?? b.type} needs a kernel (GPU) backend; the CPU simulation skips it.`, at: `${sys.id}.${b.id}`, cpuOnly: true });
    return true;
  };

  for (const b of sys.spawn.blocks.filter(on)) {
    switch (b.type) {
      case "spawn.rate":
        e.emission.rateOverTime = n(b, "rate", "emission.rateOverTime");
        break;
      case "spawn.rateOverDistance":
        e.emission.rateOverDistance = n(b, "rate", "emission.rateOverDistance");
        break;
      case "spawn.burst":
      case "spawn.periodicBurst": {
        const k = e.emission.bursts.length;
        const burst: ParticleBurst = {
          time: num(input(sys, i, b, "time", `emission.bursts.${k}.time`, "number"), 0),
          count: n(b, "count", `emission.bursts.${k}.count`),
          cycles: b.type === "spawn.burst" ? 1 : num(input(sys, i, b, "cycles", `emission.bursts.${k}.cycles`, "number"), 1),
          interval: b.type === "spawn.burst" ? 0 : num(input(sys, i, b, "interval", `emission.bursts.${k}.interval`, "number"), 0.1),
          probability: num(input(sys, i, b, "probability", `emission.bursts.${k}.probability`, "number"), 1),
        };
        e.emission.bursts.push(burst);
        break;
      }
      default:
        unknown(b, "Spawn");
    }
  }

  for (const b of sys.initialize.blocks.filter(on)) {
    if (kernelOnly(b)) continue;
    if (b.type.startsWith("init.position")) {
      const type = b.type.slice("init.position".length).toLowerCase() as ShapeType;
      const shape = { ...defaultShape(), type };
      for (const key of ["radius", "angle", "arc", "thickness", "width", "height", "donutRadius", "columns", "rows", "spread"] as const) {
        if (blockDef(b.type)?.inputs.some((x) => x.name === key)) shape[key] = num(input(sys, i, b, key, `shape.${key}`, "number"), shape[key]);
      }
      const mode = input(sys, i, b, "mode", "shape.mode", "number");
      if (typeof mode === "string" && ["random", "loop", "pingpong", "burst"].includes(mode)) shape.mode = mode as typeof shape.mode;
      shape.position = vec3(v(b, "offset", "shape.position"), [0, 0, 0]);
      shape.rotation = vec3(v(b, "rotation", "shape.rotation"), [0, 0, 0]);
      e.shape = shape;
      continue;
    }
    switch (b.type) {
      case "init.lifetime":
        e.startLife = n(b, "lifetime", "startLife");
        break;
      case "init.velocity":
        e.startSpeed = n(b, "speed", "startSpeed");
        break;
      case "init.size":
        e.startSize = n(b, "size", "startSize");
        break;
      case "init.rotation":
        e.startRotation = n(b, "rotation", "startRotation");
        break;
      case "init.color":
        e.startColor = c(b, "color", "startColor");
        break;
      case "update.triggerEvent":
        break; // a sub-emitter, wired in compileParticleGraph
      default:
        unknown(b, "Initialize");
    }
  }

  for (const b of sys.update.blocks.filter(on)) {
    if (kernelOnly(b)) continue;
    if (b.type === "update.collisionDepth") {
      problems.push({ severity: "warning", message: "Collide with depth buffer needs a kernel (GPU) backend; the CPU simulation skips it.", at: `${sys.id}.${b.id}`, cpuOnly: true });
      continue;
    }
    if (b.type === "update.gravity") {
      e.gravity = num(input(sys, i, b, "strength", "gravity", "number"), 1);
      continue;
    }
    if (b.type === "update.triggerEvent") continue;
    const behavior = lowerBehavior(b, e.behaviors.length, (name, path, kind) => input(sys, i, b, name, path, kind));
    if (behavior) e.behaviors.push(behavior);
    else unknown(b, "Update");
  }

  lowerOutput(sys, sys.output, e, (b, name, path, kind) => input(sys, i, b, name, path, kind), problems);
  if (sys.extraOutputs?.length) {
    problems.push({ severity: "warning", message: `${sys.name} has ${sys.extraOutputs.length + 1} outputs; the CPU simulation draws only the first (more need a kernel (GPU) backend).`, at: sys.id, cpuOnly: true });
  }
  return e;
}

/** An Update block as a behaviour: its inputs have the behaviour's field names. */
function lowerBehavior(b: GraphBlock, index: number, input: (name: string, path: string, kind: ParticleBinding["kind"]) => GraphInputValue): ParticleBehavior | null {
  const type = b.type.startsWith("update.") ? b.type.slice("update.".length) : "";
  const def = blockDef(b.type);
  if (!def || !type) return null;
  const out: Record<string, unknown> = { type };
  for (const field of def.inputs) {
    const kind = field.type === "color" ? "color" : field.type === "vector3" || field.type === "vector2" ? "vector" : "number";
    out[field.name] = input(field.name, `behaviors.${index}.${field.name}`, kind);
  }
  return out as unknown as ParticleBehavior;
}

function lowerOutput(
  sys: ParticleGraphSystem,
  output: OutputContext,
  e: ParticleEmitterSettings,
  input: (b: GraphBlock, name: string, path: string, kind: ParticleBinding["kind"]) => GraphInputValue,
  problems: GraphProblem[],
): void {
  const r = e.renderer;
  r.mode = RENDER_MODE[output.type] ?? "billboard";
  r.material = output.settings.material;
  r.texture = output.settings.texture;
  r.blending = output.settings.blending;
  r.renderOrder = output.settings.renderOrder;
  r.mesh = output.settings.mesh;
  r.speedScale = output.settings.speedScale;
  r.lengthScale = output.settings.lengthScale;
  r.trailLength = output.settings.trailLength;
  for (const b of output.blocks) {
    if (b.enabled === false) continue;
    if (b.type === "output.flipbook") {
      const tiles = input(b, "tiles", "renderer.tiles", "vector");
      if (Array.isArray(tiles)) r.tiles = [Math.max(1, Math.round(tiles[0] ?? 1)), Math.max(1, Math.round(tiles[1] ?? 1))];
      r.startTile = input(b, "startTile", "renderer.startTile", "number") as ParticleNumber;
      r.blendTiles = input(b, "blendTiles", "renderer.blendTiles", "number") === true;
    } else if (b.type === "output.widthOverLength") {
      e.behaviors.push({ type: "widthOverLength", width: input(b, "width", `behaviors.${e.behaviors.length}.width`, "number") as ParticleNumber });
    } else if (b.type.startsWith("attribute.")) {
      problems.push({ severity: "warning", message: `${blockDef(b.type)?.label ?? b.type} needs a kernel (GPU) backend; the CPU simulation skips it.`, at: `${sys.id}.${b.id}`, cpuOnly: true });
    } else {
      problems.push({ severity: "warning", message: `"${b.type}" isn't an Output block this engine knows; it's skipped.`, at: `${sys.id}.${b.id}` });
    }
  }
}

/** A node's value as an input value of `kind`: colours as `#rrggbbaa`. Null if it doesn't fit. */
function asInput(v: NodeValue, kind: ParticleBinding["kind"]): GraphInputValue | null {
  if (kind === "color" && Array.isArray(v)) return hexColor(v[0] ?? 1, v[1] ?? 1, v[2] ?? 1, v[3] ?? 1);
  if (kind === "number" && Array.isArray(v)) return null;
  return v as GraphInputValue;
}

/** Property names read by the expression ending at `from`. */
function collectProperties(graph: ParticleGraph, from: string, out: Set<string>, seen = new Set<string>()): void {
  const id = from.split(".")[0];
  if (seen.has(id)) return;
  seen.add(id);
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return;
  if (node.type === "property") out.add(String(node.settings?.name ?? ""));
  for (const p of nodeDef(node.type)?.inputs ?? []) {
    const wire = graph.edges.find((e) => e.to === `${id}.${p.name}`);
    if (wire) collectProperties(graph, wire.from, out, seen);
  }
}

const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const vec3 = (v: unknown, fallback: [number, number, number]): [number, number, number] =>
  Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === "number") ? [v[0], v[1], v[2]] : fallback;
