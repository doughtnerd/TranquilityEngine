/**
 * Reading, writing and migrating particle graph documents (ADR 0060): `myco.particles@2` parsing
 * with id-path problems, `myco.particles@1` → `@2` migration, stable file text, and the new-system
 * templates. Types are in `particleGraph.ts`, block types in `particleBlocks.ts`.
 *
 * Parsing is lenient like `particles.ts`: bad values read as their defaults with a warning. Unknown
 * block types, node types, inputs and settings are kept as they are and reported, never dropped.
 */
import { blockDef, defaultBlock, type BlockInputDef } from "./particleBlocks";
import {
  GRAPH_PROPERTY_TYPES,
  OUTPUT_TYPES,
  PARTICLE_GRAPH_FORMAT,
  type BlockContext,
  type ContextKind,
  type GraphBlock,
  type GraphEdge,
  type GraphEvent,
  type GraphGroup,
  type GraphInputValue,
  type GraphNode,
  type GraphNote,
  type GraphProblem,
  type GraphProperty,
  type GraphPropertyType,
  type OutputContext,
  type OutputSettings,
  type OutputType,
  type ParticleGraph,
  type ParticleGraphSystem,
  type SpawnContext,
  type SpawnSettings,
  type SystemSettings,
  type Vec2,
} from "./particleGraph";
import {
  PARTICLES_FORMAT,
  defaultRenderer,
  numberKind,
  parseParticleColor,
  parseParticleEffect,
  parseParticleNumber,
  type ParticleColor,
  type ParticleEffect,
  type ParticleNumber,
} from "./particles";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clone = <T>(v: T): T => structuredClone(v);

export const emptyParticleGraph = (): ParticleGraph => ({ properties: [], systems: [], nodes: [], edges: [], events: [], notes: [], groups: [] });

// --- ids ---------------------------------------------------------------------------------------------

function collectIds(graph: ParticleGraph): Set<string> {
  const ids = new Set<string>();
  for (const s of graph.systems) {
    ids.add(s.id);
    for (const c of [s.spawn, s.initialize, s.update, s.output, ...(s.extraOutputs ?? [])]) for (const b of c.blocks) ids.add(b.id);
  }
  for (const n of graph.nodes) ids.add(n.id);
  for (const n of graph.notes) ids.add(n.id);
  for (const g of graph.groups) ids.add(g.id);
  return ids;
}

/** Hands out ids unused in a set, counting up from the highest number already used with the prefix. */
class IdAllocator {
  private readonly next = new Map<string, number>();
  constructor(private readonly used: Set<string>) {}
  take(prefix: string): string {
    let n = this.next.get(prefix);
    if (n === undefined) {
      n = 0;
      const re = new RegExp(`^${prefix}(\\d+)$`);
      for (const id of this.used) {
        const m = re.exec(id);
        if (m) n = Math.max(n, Number(m[1]));
      }
    }
    let id: string;
    do id = `${prefix}${++n}`;
    while (this.used.has(id));
    this.next.set(prefix, n);
    this.used.add(id);
    return id;
  }
}

/** An id unused in the graph, like `b7`. */
export function newGraphId(graph: ParticleGraph, prefix: "s" | "b" | "n" | "note" | "g"): string {
  return new IdAllocator(collectIds(graph)).take(prefix);
}

// --- defaults and construction -----------------------------------------------------------------------

const defaultSpawnSettings = (): SpawnSettings => ({ duration: 5, looping: true, startDelay: 0, prewarm: false });
const defaultSystemSettings = (): SystemSettings => ({ space: "world", capacity: 1000 });
const defaultOutputSettings = (): OutputSettings => {
  const r = defaultRenderer();
  return { material: "", texture: "", blending: r.blending, renderOrder: r.renderOrder, mesh: r.mesh, speedScale: r.speedScale, lengthScale: r.lengthScale, trailLength: 20 };
};

function emptySystem(id: string, name: string, position: Vec2): ParticleGraphSystem {
  return {
    id,
    name,
    position,
    settings: defaultSystemSettings(),
    spawn: { settings: defaultSpawnSettings(), blocks: [] },
    initialize: { blocks: [] },
    update: { blocks: [] },
    output: { type: "quad", settings: defaultOutputSettings(), blocks: [] },
  };
}

type TemplateKind = "empty" | "simpleLoop" | "burst" | "trail";

/** A new system from a template, with ids unused in `graph` (the caller adds it). */
export function systemTemplate(graph: ParticleGraph, kind: TemplateKind, position: Vec2, name?: string): ParticleGraphSystem {
  const ids = new IdAllocator(collectIds(graph));
  const sys = emptySystem(ids.take("s"), name ?? { empty: "System", simpleLoop: "Simple Loop", burst: "Burst", trail: "Trail" }[kind], [position[0], position[1]]);
  const add = (ctx: BlockContext, type: string, inputs: Record<string, GraphInputValue> = {}) => {
    const b = defaultBlock(type, ids.take("b"));
    Object.assign(b.inputs, inputs);
    ctx.blocks.push(b);
  };
  switch (kind) {
    case "empty":
      break;
    case "simpleLoop":
      add(sys.spawn, "spawn.rate", { rate: 20 });
      add(sys.initialize, "init.lifetime", { lifetime: { random: [1, 2] } });
      add(sys.initialize, "init.positionCone");
      add(sys.initialize, "init.velocity", { speed: 2 });
      add(sys.initialize, "init.size", { size: 0.2 });
      add(sys.update, "update.colorOverLife", { color: { gradient: { colors: [[0, "#ffffff"], [1, "#ffffff"]], alphas: [[0, 1], [1, 0]] } } });
      break;
    case "burst":
      sys.spawn.settings = { duration: 1, looping: false, startDelay: 0, prewarm: false };
      add(sys.spawn, "spawn.burst", { time: 0, count: 50 });
      add(sys.initialize, "init.lifetime", { lifetime: { random: [0.8, 1.5] } });
      add(sys.initialize, "init.positionSphere", { radius: 0.1 });
      add(sys.initialize, "init.velocity", { speed: { random: [2, 4] } });
      add(sys.initialize, "init.size", { size: 0.2 });
      add(sys.update, "update.sizeOverLife", { size: { curve: [[0, 1], [1, 0]] } });
      break;
    case "trail":
      sys.output.type = "trail";
      add(sys.spawn, "spawn.rate", { rate: 10 });
      add(sys.initialize, "init.lifetime", { lifetime: 2 });
      add(sys.initialize, "init.positionPoint");
      add(sys.initialize, "init.velocity", { speed: 1 });
      add(sys.initialize, "init.size", { size: 0.1 });
      add(sys.output, "output.widthOverLength");
      break;
  }
  return sys;
}

/** A new graph: one "Simple Loop" system. */
export function defaultParticleGraph(): ParticleGraph {
  const graph = emptyParticleGraph();
  graph.systems.push(systemTemplate(graph, "simpleLoop", [0, 0]));
  return graph;
}

// --- @1 → @2 migration -------------------------------------------------------------------------------

/** One @1 number as a plain number (non-constants: their average). */
function scalarOf(v: ParticleNumber): number {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  switch (numberKind(v)) {
    case "constant":
      return v as number;
    case "random":
      return mean((v as { random: [number, number] }).random);
    case "curve":
      return mean((v as { curve: [number, number][] }).curve.map((k) => k[1]));
    default:
      return mean((v as { randomCurves: [number, number][][] }).randomCurves.flatMap((c) => c.map((k) => k[1])));
  }
}

/** Migrate a `myco.particles@1` effect: one emitter becomes one system, in order. */
export function migrateParticleEffect(effect: ParticleEffect): ParticleGraph {
  let blockCount = 0;
  const mk = (type: string, inputs: Record<string, unknown>, enabled?: boolean): GraphBlock => {
    const b = defaultBlock(type, `b${++blockCount}`);
    Object.assign(b.inputs, clone(inputs));
    if (enabled === false) b.enabled = false;
    return b;
  };
  const systemIds = new Map<string, string>(); // the first emitter of a name
  effect.emitters.forEach((e, i) => {
    if (!systemIds.has(e.name)) systemIds.set(e.name, `s${i + 1}`);
  });
  const events: GraphEvent[] = [];

  const systems = effect.emitters.map((e, i): ParticleGraphSystem => {
    const id = `s${i + 1}`;
    const spawn: GraphBlock[] = [mk("spawn.rate", { rate: e.emission.rateOverTime })];
    if (e.emission.rateOverDistance !== 0) spawn.push(mk("spawn.rateOverDistance", { rate: e.emission.rateOverDistance }));
    for (const burst of e.emission.bursts) {
      if (burst.cycles <= 1) spawn.push(mk("spawn.burst", { time: burst.time, count: burst.count, probability: burst.probability }));
      else spawn.push(mk("spawn.periodicBurst", { time: burst.time, count: burst.count, cycles: burst.cycles, interval: burst.interval, probability: burst.probability }));
    }

    const s = e.shape;
    const shapeType = `init.position${s.type[0].toUpperCase()}${s.type.slice(1)}`;
    const shapeInputs: Record<string, unknown> = {};
    for (const input of blockDef(shapeType)?.inputs ?? []) shapeInputs[input.name] = input.name === "offset" ? s.position : input.name === "rotation" ? s.rotation : (s as unknown as Record<string, unknown>)[input.name];
    const initialize = [
      mk("init.lifetime", { lifetime: e.startLife }),
      mk("init.velocity", { speed: e.startSpeed }),
      mk("init.size", { size: e.startSize }),
      mk("init.rotation", { rotation: e.startRotation }),
      mk("init.color", { color: e.startColor }),
      mk(shapeType, shapeInputs),
    ];

    const update: GraphBlock[] = [];
    if (e.gravity !== 0) update.push(mk("update.gravity", { strength: e.gravity }));
    const widths = e.behaviors.filter((b) => b.type === "widthOverLength");
    for (const b of e.behaviors) {
      if (b.type === "widthOverLength") continue;
      const { type, enabled, ...rest } = b as { type: string; enabled?: boolean } & Record<string, unknown>;
      update.push(mk(`update.${type}`, rest, enabled));
    }
    for (const sub of e.subEmitters) {
      const target = systemIds.get(sub.emitter);
      if (!target) continue;
      const trigger = mk("update.triggerEvent", { on: sub.trigger, probability: sub.probability, inheritVelocity: sub.inheritVelocity });
      update.push(trigger);
      events.push({ from: `${id}.${trigger.id}`, to: `${target}.start` });
    }

    const r = e.renderer;
    const output: GraphBlock[] = [];
    if (r.tiles[0] !== 1 || r.tiles[1] !== 1 || r.startTile !== 0) output.push(mk("output.flipbook", { tiles: r.tiles, startTile: r.startTile, blendTiles: r.blendTiles }));
    for (const w of widths) output.push(mk("output.widthOverLength", { width: (w as { width: ParticleNumber }).width }, w.enabled));

    const system: ParticleGraphSystem = {
      id,
      name: e.name,
      position: [i * 420, 0],
      settings: { space: e.space, capacity: e.maxParticles },
      spawn: { settings: { duration: e.duration, looping: e.looping, startDelay: e.startDelay, prewarm: e.prewarm }, blocks: spawn },
      initialize: { blocks: initialize },
      update: { blocks: update },
      output: {
        type: r.mode === "billboard" ? "quad" : r.mode,
        settings: {
          material: r.material,
          texture: r.texture,
          blending: r.blending,
          renderOrder: r.renderOrder,
          mesh: r.mesh,
          speedScale: r.speedScale,
          lengthScale: r.lengthScale,
          trailLength: scalarOf(r.trailLength),
        },
        blocks: output,
      },
    };
    if (!e.enabled) system.enabled = false;
    return system;
  });

  const graph: ParticleGraph = { properties: [], systems, nodes: [], edges: [], events, notes: [], groups: [] };
  if (effect.editor) graph.editor = clone(effect.editor);
  return graph;
}

// --- parsing -----------------------------------------------------------------------------------------

export interface ParseGraphOptions {
  /** Node types the caller knows (from `particleNodes.ts`); other node types are reported as unknown. Without it node types aren't checked. */
  knownNodeTypes?: ReadonlySet<string>;
}

interface Ctx {
  problems: GraphProblem[];
  /** Ids claimed so far, and every id the document mentions (so generated ids never clash). */
  seen: Set<string>;
  reserved: Set<string>;
  ids: IdAllocator;
}

const warn = (ctx: Ctx, message: string, at?: string) => ctx.problems.push(at ? { message, severity: "warning", at } : { message, severity: "warning" });
const fail = (ctx: Ctx, message: string, at?: string) => ctx.problems.push(at ? { message, severity: "error", at } : { message, severity: "error" });

function takeId(raw: unknown, prefix: string, at: string, ctx: Ctx): string {
  if (typeof raw !== "string" || !raw) {
    warn(ctx, `${at}: missing "id"; one was made up.`, at);
    return ctx.ids.take(prefix);
  }
  if (ctx.seen.has(raw)) fail(ctx, `Duplicate id "${raw}".`, raw);
  ctx.seen.add(raw);
  return raw;
}

function reserveIds(raw: Record<string, unknown>): Set<string> {
  const used = new Set<string>();
  const add = (v: unknown) => {
    if (isObj(v) && typeof v.id === "string") used.add(v.id);
  };
  const each = (v: unknown, f: (x: unknown) => void) => {
    if (Array.isArray(v)) v.forEach(f);
  };
  each(raw.systems, (s) => {
    add(s);
    if (!isObj(s)) return;
    for (const key of ["spawn", "initialize", "update", "output"]) if (isObj(s[key])) each((s[key] as Record<string, unknown>).blocks, add);
    each(s.extraOutputs, (o) => isObj(o) && each(o.blocks, add));
  });
  for (const key of ["nodes", "notes", "groups"]) each(raw[key], add);
  return used;
}

function parseVector(raw: unknown, length: number, fallback: number[], at: string, ctx: Ctx): number[] {
  if (Array.isArray(raw) && raw.length === length && raw.every(finite)) return [...raw] as number[];
  warn(ctx, `${at} should be a list of ${length} numbers.`, at);
  return clone(fallback);
}

/** One block input's value by its definition; a `"@node"` wire reference is kept for any input. */
function parseInput(def: BlockInputDef, raw: unknown, at: string, ctx: Ctx): GraphInputValue {
  if (raw === undefined) return clone(def.default);
  if (typeof raw === "string" && raw.startsWith("@")) return raw;
  const tmp: string[] = [];
  let out: GraphInputValue;
  switch (def.type) {
    case "number": {
      out = parseParticleNumber(raw, def.default as ParticleNumber, at, tmp);
      if (typeof out === "number") {
        if (def.min !== undefined) out = Math.max(def.min, out);
        if (def.max !== undefined) out = Math.min(def.max, out);
        if (def.step === 1) out = Math.round(out);
      }
      break;
    }
    case "color":
      out = parseParticleColor(raw, def.default as ParticleColor, at, tmp);
      break;
    case "vector2":
    case "vector3": {
      const v = parseVector(raw, def.type === "vector2" ? 2 : 3, def.default as number[], at, ctx);
      out = def.min !== undefined ? v.map((x) => Math.max(def.min as number, x)) : v;
      if (def.step === 1) out = (out as number[]).map(Math.round);
      break;
    }
    case "bool":
      if (typeof raw === "boolean") out = raw;
      else {
        warn(ctx, `${at} should be true or false.`, at);
        out = def.default;
      }
      break;
    case "enum":
      if (typeof raw === "string" && def.choices?.includes(raw)) out = raw;
      else {
        warn(ctx, `${at} should be one of ${def.choices?.join(", ")}.`, at);
        out = def.default;
      }
      break;
    default:
      if (typeof raw === "string") out = raw;
      else {
        warn(ctx, `${at} should be text.`, at);
        out = def.default;
      }
  }
  for (const m of tmp) warn(ctx, m, at);
  return clone(out);
}

function parseBlocks(raw: unknown, kind: ContextKind, systemId: string, ctx: Ctx): GraphBlock[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warn(ctx, `${systemId}.${kind}: "blocks" should be a list.`, `${systemId}.${kind}`);
    return [];
  }
  const blocks: GraphBlock[] = [];
  raw.forEach((rb, i) => {
    const where = `${systemId}.${kind}[${i}]`;
    if (!isObj(rb)) {
      warn(ctx, `${where} should be an object; it's left out.`, where);
      return;
    }
    if (typeof rb.type !== "string") {
      warn(ctx, `${where} has no "type"; it's left out.`, where);
      return;
    }
    const id = takeId(rb.id, "b", where, ctx);
    const at = `${systemId}.${id}`;
    const block: GraphBlock = { id, type: rb.type, inputs: {} };
    if (rb.enabled === false) block.enabled = false;
    else if (rb.enabled !== undefined && rb.enabled !== true) warn(ctx, `${at}: "enabled" should be true or false.`, at);
    const rawInputs = isObj(rb.inputs) ? rb.inputs : {};
    if (rb.inputs !== undefined && !isObj(rb.inputs)) warn(ctx, `${at}: "inputs" should be an object.`, at);
    const def = blockDef(rb.type);
    if (!def) {
      warn(ctx, `Unknown block type "${rb.type}"; it's kept as it is.`, at);
      block.inputs = clone(rawInputs) as Record<string, GraphInputValue>;
    } else {
      if (!def.contexts.includes(kind)) warn(ctx, `${def.label} doesn't belong in the ${kind} context.`, at);
      const known = new Set<string>();
      for (const input of def.inputs) {
        known.add(input.name);
        block.inputs[input.name] = parseInput(input, rawInputs[input.name], `${at}.${input.name}`, ctx);
      }
      for (const [key, value] of Object.entries(rawInputs)) {
        if (known.has(key)) continue;
        warn(ctx, `${def.label} has no input "${key}"; it's kept as it is.`, `${at}.${key}`);
        block.inputs[key] = clone(value) as GraphInputValue;
      }
    }
    blocks.push(block);
  });
  return blocks;
}

/** The keys of `raw` not in `known`, kept with a warning. */
function extraSettings(raw: Record<string, unknown>, known: readonly string[], at: string, ctx: Ctx): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (known.includes(key)) continue;
    warn(ctx, `Unknown setting "${key}"; it's kept as it is.`, `${at}.${key}`);
    extra[key] = clone(value);
  }
  return extra;
}

function numberSetting(raw: Record<string, unknown>, key: string, fallback: number, at: string, ctx: Ctx, min = -Infinity, max = Infinity): number {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (!finite(v)) {
    warn(ctx, `${at}.${key} should be a number.`, `${at}.${key}`);
    return fallback;
  }
  return Math.min(max, Math.max(min, v));
}

function boolSetting(raw: Record<string, unknown>, key: string, fallback: boolean, at: string, ctx: Ctx): boolean {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") {
    warn(ctx, `${at}.${key} should be true or false.`, `${at}.${key}`);
    return fallback;
  }
  return v;
}

function textSetting(raw: Record<string, unknown>, key: string, fallback: string, at: string, ctx: Ctx): string {
  const v = raw[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string") {
    warn(ctx, `${at}.${key} should be text.`, `${at}.${key}`);
    return fallback;
  }
  return v;
}

function choiceSetting<T extends string>(raw: Record<string, unknown>, key: string, choices: readonly T[], fallback: T, at: string, ctx: Ctx): T {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (!choices.includes(v as T)) {
    warn(ctx, `${at}.${key} should be one of ${choices.join(", ")}.`, `${at}.${key}`);
    return fallback;
  }
  return v as T;
}

function parseOutput(raw: unknown, systemId: string, ctx: Ctx): OutputContext {
  const at = `${systemId}.output`;
  const o = isObj(raw) ? raw : {};
  if (raw !== undefined && !isObj(raw)) warn(ctx, `${at} should be an object.`, at);
  const d = defaultOutputSettings();
  const s = isObj(o.settings) ? o.settings : {};
  const known = Object.keys(d);
  const settings: OutputSettings = {
    material: textSetting(s, "material", d.material, `${at}.settings`, ctx),
    texture: textSetting(s, "texture", d.texture, `${at}.settings`, ctx),
    blending: choiceSetting(s, "blending", ["additive", "alpha", "premultiplied"] as const, d.blending, `${at}.settings`, ctx),
    renderOrder: numberSetting(s, "renderOrder", d.renderOrder, `${at}.settings`, ctx),
    mesh: textSetting(s, "mesh", d.mesh, `${at}.settings`, ctx),
    speedScale: numberSetting(s, "speedScale", d.speedScale, `${at}.settings`, ctx),
    lengthScale: numberSetting(s, "lengthScale", d.lengthScale, `${at}.settings`, ctx),
    trailLength: numberSetting(s, "trailLength", d.trailLength, `${at}.settings`, ctx, 1),
    ...extraSettings(s, known, `${at}.settings`, ctx),
  };
  return {
    type: choiceSetting(o, "type", OUTPUT_TYPES as readonly OutputType[], "quad", at, ctx),
    settings,
    blocks: parseBlocks(o.blocks, "output", systemId, ctx),
  };
}

function parseSystem(raw: unknown, index: number, ctx: Ctx): ParticleGraphSystem | null {
  if (!isObj(raw)) {
    warn(ctx, `System ${index + 1} should be an object; it's left out.`);
    return null;
  }
  const id = takeId(raw.id, "s", `system ${index + 1}`, ctx);
  const at = id;
  const name = typeof raw.name === "string" && raw.name ? raw.name : `System ${index + 1}`;
  const pos = Array.isArray(raw.position) && raw.position.length === 2 && raw.position.every(finite) ? ([raw.position[0], raw.position[1]] as Vec2) : null;
  if (raw.position !== undefined && !pos) warn(ctx, `${at}.position should be [x, y].`, `${at}.position`);
  const system: ParticleGraphSystem = {
    id,
    name,
    position: pos ?? [index * 420, 0],
    settings: defaultSystemSettings(),
    spawn: { settings: defaultSpawnSettings(), blocks: [] },
    initialize: { blocks: [] },
    update: { blocks: [] },
    output: { type: "quad", settings: defaultOutputSettings(), blocks: [] },
  };
  if (raw.enabled === false) system.enabled = false;

  const ss = isObj(raw.settings) ? raw.settings : {};
  const sd = defaultSystemSettings();
  system.settings = {
    space: choiceSetting(ss, "space", ["local", "world"] as const, sd.space, `${at}.settings`, ctx),
    capacity: Math.round(numberSetting(ss, "capacity", sd.capacity, `${at}.settings`, ctx, 1)),
    ...extraSettings(ss, ["space", "capacity"], `${at}.settings`, ctx),
  };

  const sp = isObj(raw.spawn) ? raw.spawn : {};
  const spd = defaultSpawnSettings();
  const sps = isObj(sp.settings) ? sp.settings : {};
  system.spawn = {
    settings: {
      duration: numberSetting(sps, "duration", spd.duration, `${at}.spawn`, ctx, 0.01),
      looping: boolSetting(sps, "looping", spd.looping, `${at}.spawn`, ctx),
      startDelay: numberSetting(sps, "startDelay", spd.startDelay, `${at}.spawn`, ctx, 0),
      prewarm: boolSetting(sps, "prewarm", spd.prewarm, `${at}.spawn`, ctx),
      ...extraSettings(sps, Object.keys(spd), `${at}.spawn`, ctx),
    },
    blocks: parseBlocks(sp.blocks, "spawn", id, ctx),
  };
  system.initialize = { blocks: parseBlocks(isObj(raw.initialize) ? raw.initialize.blocks : undefined, "initialize", id, ctx) };
  system.update = { blocks: parseBlocks(isObj(raw.update) ? raw.update.blocks : undefined, "update", id, ctx) };
  system.output = parseOutput(raw.output, id, ctx);
  if (Array.isArray(raw.extraOutputs) && raw.extraOutputs.length) system.extraOutputs = raw.extraOutputs.map((o) => parseOutput(o, id, ctx));
  return system;
}

function parseProperty(raw: unknown, index: number, ctx: Ctx): GraphProperty | null {
  if (!isObj(raw) || typeof raw.name !== "string" || !raw.name) {
    warn(ctx, `Property ${index + 1} needs a "name"; it's left out.`);
    return null;
  }
  const at = `property ${raw.name}`;
  const type: GraphPropertyType = GRAPH_PROPERTY_TYPES.includes(raw.type as GraphPropertyType) ? (raw.type as GraphPropertyType) : "number";
  if (raw.type !== undefined && type !== raw.type) warn(ctx, `${at}: "type" should be one of ${GRAPH_PROPERTY_TYPES.join(", ")}.`, raw.name);
  const tmp: string[] = [];
  let value: GraphInputValue;
  switch (type) {
    case "number":
    case "curve":
      value = parseParticleNumber(raw.value, type === "curve" ? { curve: [[0, 1], [1, 1]] } : 0, at, tmp);
      break;
    case "color":
    case "gradient":
      value = parseParticleColor(raw.value, type === "gradient" ? { gradient: { colors: [[0, "#ffffff"], [1, "#ffffff"]], alphas: [[0, 1], [1, 1]] } } : "#ffffff", at, tmp);
      break;
    case "vector2":
    case "vector3": {
      const n = type === "vector2" ? 2 : 3;
      value = raw.value === undefined ? new Array(n).fill(0) : parseVector(raw.value, n, new Array(n).fill(0), at, ctx);
      break;
    }
    default:
      value = typeof raw.value === "string" ? raw.value : "";
      if (raw.value !== undefined && typeof raw.value !== "string") warn(ctx, `${at} should be text.`, raw.name);
  }
  for (const m of tmp) warn(ctx, m, raw.name);
  return { name: raw.name, type, value: clone(value), exposed: raw.exposed === true };
}

function parseNode(raw: unknown, index: number, ctx: Ctx, options: ParseGraphOptions): GraphNode | null {
  if (!isObj(raw) || typeof raw.type !== "string") {
    warn(ctx, `Node ${index + 1} needs a "type"; it's left out.`);
    return null;
  }
  const id = takeId(raw.id, "n", `node ${index + 1}`, ctx);
  if (options.knownNodeTypes && !options.knownNodeTypes.has(raw.type)) warn(ctx, `Unknown node type "${raw.type}"; it's kept as it is.`, id);
  const pos = Array.isArray(raw.position) && raw.position.length === 2 && raw.position.every(finite) ? ([raw.position[0], raw.position[1]] as Vec2) : null;
  if (!pos) warn(ctx, `${id}.position should be [x, y].`, `${id}.position`);
  const node: GraphNode = { id, type: raw.type, position: pos ?? [0, 0] };
  if (isObj(raw.settings)) node.settings = clone(raw.settings);
  if (isObj(raw.inputs)) node.inputs = clone(raw.inputs) as Record<string, GraphInputValue>;
  return node;
}

/** Read a particle graph document, migrating `myco.particles@1` files. Nothing here throws. */
export function parseParticleGraph(raw: unknown, where = "particle graph", options: ParseGraphOptions = {}): { graph: ParticleGraph; problems: GraphProblem[]; migrated: boolean } {
  const problems: GraphProblem[] = [];
  const bail = (message: string) => {
    problems.push({ message, severity: "error" });
    return { graph: emptyParticleGraph(), problems, migrated: false };
  };
  if (!isObj(raw)) return bail(`${where} isn't a particle graph (expected a JSON object).`);

  if (raw.format === PARTICLES_FORMAT || (raw.format === undefined && Array.isArray(raw.emitters))) {
    try {
      const { effect, problems: old } = parseParticleEffect(raw, where);
      for (const message of old) problems.push({ message, severity: "warning" });
      return { graph: migrateParticleEffect(effect), problems, migrated: true };
    } catch (e) {
      return bail((e as Error).message);
    }
  }
  if (raw.format !== undefined && raw.format !== PARTICLE_GRAPH_FORMAT) return bail(`${where} has format "${String(raw.format)}"; expected "${PARTICLE_GRAPH_FORMAT}".`);

  const reserved = reserveIds(raw);
  const ctx: Ctx = { problems, seen: new Set(), reserved, ids: new IdAllocator(new Set(reserved)) };
  const list = (key: string): unknown[] => {
    const v = raw[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      warn(ctx, `${where}: "${key}" should be a list.`);
      return [];
    }
    return v;
  };

  const graph = emptyParticleGraph();
  const names = new Set<string>();
  list("properties").forEach((p, i) => {
    const prop = parseProperty(p, i, ctx);
    if (!prop) return;
    if (names.has(prop.name)) fail(ctx, `Duplicate property "${prop.name}".`, prop.name);
    names.add(prop.name);
    graph.properties.push(prop);
  });
  list("systems").forEach((s, i) => {
    const sys = parseSystem(s, i, ctx);
    if (sys) graph.systems.push(sys);
  });
  list("nodes").forEach((n, i) => {
    const node = parseNode(n, i, ctx, options);
    if (node) graph.nodes.push(node);
  });

  const blocksOf = new Map<string, Set<string>>();
  for (const s of graph.systems) blocksOf.set(s.id, new Set([s.spawn, s.initialize, s.update, s.output, ...(s.extraOutputs ?? [])].flatMap((c) => c.blocks.map((b) => b.id))));
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  list("edges").forEach((e, i) => {
    if (!isObj(e) || typeof e.from !== "string" || typeof e.to !== "string") {
      warn(ctx, `Edge ${i + 1} needs "from" and "to"; it's left out.`);
      return;
    }
    const edge: GraphEdge = { from: e.from, to: e.to };
    const from = e.from.split(".");
    if (!nodeIds.has(from[0])) warn(ctx, `The wire from "${e.from}" starts at a node that isn't there.`, e.from);
    const to = e.to.split(".");
    if (to.length >= 3) {
      if (!blocksOf.get(to[0])?.has(to[1])) warn(ctx, `The wire to "${e.to}" ends at a block that isn't there.`, e.to);
    } else if (!nodeIds.has(to[0])) warn(ctx, `The wire to "${e.to}" ends at a node that isn't there.`, e.to);
    graph.edges.push(edge);
  });

  list("events").forEach((e, i) => {
    if (!isObj(e) || typeof e.from !== "string" || typeof e.to !== "string") {
      warn(ctx, `Event ${i + 1} needs "from" and "to"; it's left out.`);
      return;
    }
    const ev: GraphEvent = { from: e.from, to: e.to };
    const from = e.from.split(".");
    if (from.length === 1 ? !nodeIds.has(from[0]) : !blocksOf.get(from[0])?.has(from[1])) warn(ctx, `The event from "${e.from}" starts at something that isn't there.`, e.from);
    const to = e.to.split(".");
    if (!blocksOf.has(to[0]) || (to[1] !== "start" && to[1] !== "stop")) warn(ctx, `The event to "${e.to}" should end at "<system>.start" or "<system>.stop".`, e.to);
    graph.events.push(ev);
  });

  list("notes").forEach((n, i) => {
    if (!isObj(n)) {
      warn(ctx, `Note ${i + 1} should be an object; it's left out.`);
      return;
    }
    const id = takeId(n.id, "note", `note ${i + 1}`, ctx);
    const vec = (v: unknown, fb: Vec2): Vec2 => (Array.isArray(v) && v.length === 2 && v.every(finite) ? [v[0], v[1]] : fb);
    const note: GraphNote = { id, position: vec(n.position, [0, 0]), size: vec(n.size, [200, 100]), text: typeof n.text === "string" ? n.text : "" };
    graph.notes.push(note);
  });
  list("groups").forEach((g, i) => {
    if (!isObj(g)) {
      warn(ctx, `Group ${i + 1} should be an object; it's left out.`);
      return;
    }
    const id = takeId(g.id, "g", `group ${i + 1}`, ctx);
    const group: GraphGroup = { id, title: typeof g.title === "string" ? g.title : "Group", members: Array.isArray(g.members) ? g.members.filter((m): m is string => typeof m === "string") : [] };
    graph.groups.push(group);
  });
  if (isObj(raw.editor)) graph.editor = clone(raw.editor);
  return { graph, problems, migrated: false };
}

// --- writing -----------------------------------------------------------------------------------------

const blockJSON = (b: GraphBlock): Record<string, unknown> => {
  const out: Record<string, unknown> = { id: b.id, type: b.type };
  if (b.enabled === false) out.enabled = false;
  out.inputs = b.inputs;
  return out;
};

const outputJSON = (o: OutputContext): Record<string, unknown> => ({ type: o.type, settings: o.settings, blocks: o.blocks.map(blockJSON) });

function systemJSON(s: ParticleGraphSystem): Record<string, unknown> {
  const out: Record<string, unknown> = { id: s.id, name: s.name };
  if (s.enabled === false) out.enabled = false;
  out.position = s.position;
  out.settings = s.settings;
  out.spawn = { settings: (s.spawn as SpawnContext).settings, blocks: s.spawn.blocks.map(blockJSON) };
  out.initialize = { blocks: s.initialize.blocks.map(blockJSON) };
  out.update = { blocks: s.update.blocks.map(blockJSON) };
  out.output = outputJSON(s.output);
  if (s.extraOutputs?.length) out.extraOutputs = s.extraOutputs.map(outputJSON);
  return out;
}

/** The graph as JSON (the file's object, with the format tag first). */
export function particleGraphJSON(graph: ParticleGraph): Record<string, unknown> {
  const out: Record<string, unknown> = {
    format: PARTICLE_GRAPH_FORMAT,
    properties: graph.properties,
    systems: graph.systems.map(systemJSON),
    nodes: graph.nodes,
    edges: graph.edges,
    events: graph.events,
    notes: graph.notes,
    groups: graph.groups,
  };
  if (graph.editor) {
    const editor = { ...graph.editor };
    // Editor-only view state names systems; drop the ones that are gone.
    if (Array.isArray(editor.collapsed)) {
      const ids = new Set(graph.systems.map((s) => s.id));
      const kept = editor.collapsed.filter((id): id is string => typeof id === "string" && ids.has(id));
      if (kept.length) editor.collapsed = kept;
      else delete editor.collapsed;
    }
    if (Object.keys(editor).length) out.editor = editor;
  }
  return out;
}

/** The graph as file text. */
export function formatParticleGraph(graph: ParticleGraph): string {
  // Arrays of plain values (positions, vectors, curve keys) go on one line each, so files stay short and diff well.
  const text = JSON.stringify(particleGraphJSON(graph), null, 2).replace(/\[(\s*(?:-?[\d.eE+-]+|"[^"\n]*"|true|false|null)(?:,\s*(?:-?[\d.eE+-]+|"[^"\n]*"|true|false|null))*\s*)\]/g, (_, items: string) => `[${items.trim().replace(/\n\s*/g, " ")}]`); // JSON strings never hold a raw newline
  return `${text}\n`;
}
