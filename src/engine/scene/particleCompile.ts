/**
 * Compiles a particle graph (ADR 0060) into a `ParticleProgram`: what the effect player runs. Every
 * enabled system runs on a kernel executor (ADR 0094, 0251), so the program is its kernels
 * (`compileParticleKernels`) plus what stays on the CPU: each system's spawn settings (rate, rate over
 * distance, bursts, duration, looping, delay, prewarm), which the kernel spawner turns into a count each
 * frame, and the events' start and stop routes.
 * - a spawn block input's inline value, or a wired per-particle source, is written into the settings;
 * - a wired uniform expression becomes a binding evaluated each frame: live bindings (the rates and
 *   burst counts) write boxes the spawner reads, the others rebuild the effect when their value changes.
 * The problems are the spawn inputs' and events', then the kernels'.
 */
import { blockDef } from "./particleBlocks";
import type { GraphBlock, GraphInputValue, GraphProblem, ParticleGraph, ParticleGraphSystem, SimulationChoice } from "./particleGraph";
import { compileParticleKernels, type KernelProgram } from "./particleKernel";
import { compileUniform, nodeDef, portRate, type EvalContext, type NodeValue } from "./particleNodes";
import { type ParticleBurst, type ParticleEmission, type ParticleNumber } from "./particles";

/** A spawn input driven by a uniform expression, evaluated each frame. */
export interface ParticleBinding {
  /** Index into `spawns`. */
  emitter: number;
  /** The spawn settings field it drives: `emission.rateOverTime`, `emission.bursts.0.count`… */
  path: string;
  /** Live: the spawner reads its value each frame. Otherwise a change rebuilds the effect. */
  live: boolean;
  evaluate(ctx: EvalContext): NodeValue;
}

/** Which systems an event starts and stops (indices into `spawns`). */
export interface EventRoute {
  start: number[];
  stop: number[];
}

/** What a system's spawner reads (ADR 0094): when and how many particles it spawns. */
export interface SpawnSettings {
  /** Seconds a cycle lasts. */
  duration: number;
  looping: boolean;
  startDelay: number;
  /** Looping systems: start as if a cycle had already run. */
  prewarm: boolean;
  emission: ParticleEmission;
  /** The particles' lifetime (Set Lifetime's value), for the estimate of how many are alive. */
  lifetime: ParticleNumber;
}

export interface ParticleProgram {
  /** Each enabled system's spawn settings. */
  spawns: SpawnSettings[];
  /** Each enabled system's kernel (same order), and the kernels' problems. */
  kernels: KernelProgram;
  /** The system id of each. */
  systems: string[];
  /** Each system's executor choice (`SystemSettings.simulation`). */
  simulation: (SimulationChoice | undefined)[];
  bindings: ParticleBinding[];
  /** Per system: starts when the effect plays (no start wires, or wired from On Play). */
  autoStart: boolean[];
  /** Per system: its own random seed (`SystemSettings.seed`), or null to use the component's. */
  seeds: (number | null)[];
  onPlay: EventRoute;
  onStop: EventRoute;
  /** Custom events by name (`ParticleSystem.sendEvent`). */
  custom: Map<string, EventRoute>;
  /** Property names the program reads (an override change re-evaluates bindings). */
  properties: string[];
  problems: GraphProblem[];
}

/** Spawn fields the spawner reads from a live box each frame, so a binding updates them without a rebuild. */
const LIVE = /^emission\.(rateOverTime|rateOverDistance|bursts\.\d+\.count)$/;

const zeroContext: EvalContext = { time: 0, deltaTime: 0, playTime: 0, properties: new Map(), random: () => 0.5 };

/** Compile `graph`. Never throws: what can't be compiled is left out and reported. */
export function compileParticleGraph(graph: ParticleGraph): ParticleProgram {
  const problems: GraphProblem[] = [];
  const bindings: ParticleBinding[] = [];
  const systems = graph.systems.filter((s) => s.enabled !== false);
  const index = new Map(systems.map((s, i) => [s.id, i]));
  const wires = new Map(graph.edges.map((e) => [e.to, e.from]));
  const properties = new Set<string>();

  // Every wired block input's properties (the kernels read them too).
  for (const sys of systems) {
    for (const b of [...sys.spawn.blocks, ...sys.initialize.blocks, ...sys.update.blocks, ...sys.output.blocks, ...(sys.extraOutputs ?? []).flatMap((o) => o.blocks)]) {
      for (const field of blockDef(b.type)?.inputs ?? []) {
        const from = wires.get(`${sys.id}.${b.id}.${field.name}`);
        if (from) collectProperties(graph, from, properties);
      }
    }
  }

  /** A spawn input's value: written into the settings, and a binding when it's a wired uniform expression (unless `bind` is false). */
  const input = (sys: ParticleGraphSystem, emitter: number, block: GraphBlock, name: string, path: string, bind = true): GraphInputValue => {
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
      // Set Lifetime's wire is the kernel's to report.
      if (bind) problems.push({ severity: "warning", message: `${(err as Error).message} The input uses its own value.`, at: `${sys.id}.${block.id}.${name}` });
      return inline;
    }
    const initial = evaluate(zeroContext);
    if (bind && portRate(graph, from) !== "particle") bindings.push({ emitter, path, live: LIVE.test(path), evaluate });
    return Array.isArray(initial) ? inline : (initial as GraphInputValue);
  };

  const spawns = systems.map((sys, i) => lowerSpawn(sys, i, input));
  const kernels = compileParticleKernels(graph);

  /** Systems with a working start wire: they wait for it instead of starting on play. */
  const startWired = new Set<number>();
  // Trigger Event blocks wired to another system's start (the kernels' GPU events).
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

  return {
    spawns,
    kernels,
    systems: systems.map((s) => s.id),
    simulation: systems.map((s) => s.settings.simulation),
    bindings,
    autoStart,
    seeds: systems.map((s) => s.settings.seed ?? null),
    onPlay,
    onStop,
    custom,
    properties: [...properties],
    problems: [...problems, ...kernels.problems],
  };
}

type InputFn = (sys: ParticleGraphSystem, emitter: number, block: GraphBlock, name: string, path: string, bind?: boolean) => GraphInputValue;

/** A system's spawn settings, from its Spawn blocks, spawn settings and Set Lifetime. */
function lowerSpawn(sys: ParticleGraphSystem, i: number, input: InputFn): SpawnSettings {
  const s: SpawnSettings = {
    duration: sys.spawn.settings.duration,
    looping: sys.spawn.settings.looping,
    startDelay: sys.spawn.settings.startDelay,
    prewarm: sys.spawn.settings.prewarm,
    emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [] },
    lifetime: 1,
  };
  const on = (b: GraphBlock) => b.enabled !== false;
  const n = (b: GraphBlock, name: string, path: string) => input(sys, i, b, name, path) as ParticleNumber;
  for (const b of sys.spawn.blocks.filter(on)) {
    switch (b.type) {
      case "spawn.rate":
        s.emission.rateOverTime = n(b, "rate", "emission.rateOverTime");
        break;
      case "spawn.rateOverDistance":
        s.emission.rateOverDistance = n(b, "rate", "emission.rateOverDistance");
        break;
      case "spawn.burst":
      case "spawn.periodicBurst": {
        const k = s.emission.bursts.length;
        const burst: ParticleBurst = {
          time: num(input(sys, i, b, "time", `emission.bursts.${k}.time`), 0),
          count: n(b, "count", `emission.bursts.${k}.count`),
          cycles: b.type === "spawn.burst" ? 1 : num(input(sys, i, b, "cycles", `emission.bursts.${k}.cycles`), 1),
          interval: b.type === "spawn.burst" ? 0 : num(input(sys, i, b, "interval", `emission.bursts.${k}.interval`), 0.1),
          probability: num(input(sys, i, b, "probability", `emission.bursts.${k}.probability`), 1),
        };
        s.emission.bursts.push(burst);
        break;
      }
    }
  }
  const life = sys.initialize.blocks.filter(on).find((b) => b.type === "init.lifetime");
  if (life) s.lifetime = input(sys, i, life, "lifetime", "lifetime", false) as ParticleNumber;
  return s;
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
