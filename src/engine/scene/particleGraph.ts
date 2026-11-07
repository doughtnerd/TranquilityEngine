/**
 * Particle effect graphs (ADR 0060): `*.particles.json` in format `myco.particles@2`, a VFX-Graph-
 * style document of systems (Spawn, Initialize, Update and Output contexts holding blocks), value
 * and operator nodes wired into block inputs, and events between systems. It's the asset: the
 * editor edits it, and `compileParticleGraph` lowers it for the CPU simulation (`render/particles/simulation.ts`).
 * `myco.particles@1` files (ADR 0057) are read and migrated (see `particleGraphFormat.ts`).
 *
 * Block types live in `particleBlocks.ts`, node types in `particleNodes.ts`.
 */
import type { ParticleColor, ParticleNumber } from "./particles";

export const PARTICLE_GRAPH_FORMAT = "myco.particles@2";

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/**
 * A block or node input's inline value: a number or colour value in 0057's forms (constant,
 * random, curve, random curves; colour, random, gradient, random gradients), a vector, a flag, or
 * a string (enum choices, asset references).
 */
export type GraphInputValue = ParticleNumber | ParticleColor | number[] | boolean | string;

export interface GraphBlock {
  /** Unique within the document. */
  id: string;
  /** A block type from `particleBlocks.ts` (`spawn.rate`, `update.colorOverLife`…). Unknown types are kept and reported. */
  type: string;
  /** Default true. */
  enabled?: boolean;
  /** Inline values by input name; an input wired from a node ignores its inline value. Missing inputs take the block's default. */
  inputs: Record<string, GraphInputValue>;
}

export interface SpawnSettings {
  /** Seconds per cycle. */
  duration: number;
  looping: boolean;
  /** Seconds before spawning starts. */
  startDelay: number;
  /** Start as if a full cycle had already run (looping systems). */
  prewarm: boolean;
}

export type OutputType = "quad" | "stretched" | "horizontal" | "vertical" | "mesh" | "trail";
export const OUTPUT_TYPES: readonly OutputType[] = ["quad", "stretched", "horizontal", "vertical", "mesh", "trail"];

export interface OutputSettings {
  /** A material asset. Empty: an unlit material with `texture` and `blending`. */
  material: string;
  /** The particle texture (no material). Empty: a soft round dot. */
  texture: string;
  blending: "additive" | "alpha" | "premultiplied";
  /** Higher draws later. */
  renderOrder: number;
  /** Mesh: a built-in mesh (`builtin:cube`…) or a model asset. */
  mesh: string;
  /** Stretched: stretch by speed, and by size. */
  speedScale: number;
  lengthScale: number;
  /** Trail: length in points. */
  trailLength: number;
}

export interface BlockContext {
  blocks: GraphBlock[];
}
export interface SpawnContext extends BlockContext {
  settings: SpawnSettings;
}
export interface OutputContext extends BlockContext {
  type: OutputType;
  settings: OutputSettings;
}

export type ContextKind = "spawn" | "initialize" | "update" | "output";
export const CONTEXT_KINDS: readonly ContextKind[] = ["spawn", "initialize", "update", "output"];

export interface SystemSettings {
  /** World: particles stay where they were born as the node moves. Local: they move with it. */
  space: "local" | "world";
  /** The most particles alive at once. */
  capacity: number;
}

export interface ParticleGraphSystem {
  /** Unique within the document (systems, blocks and nodes share one id space). */
  id: string;
  name: string;
  /** Default true. */
  enabled?: boolean;
  /** Top-left of the system's frame on the canvas. */
  position: Vec2;
  settings: SystemSettings;
  spawn: SpawnContext;
  initialize: BlockContext;
  update: BlockContext;
  output: OutputContext;
  /** More outputs: kept in the format, flagged "needs GPU backend" by the quarks backend (one renderer per emitter). */
  extraOutputs?: OutputContext[];
}

export interface GraphNode {
  /** Unique within the document. */
  id: string;
  /** A node type from `particleNodes.ts` (`gradient`, `multiply`, `time`, `property`, `event.custom`…). Unknown types are kept and reported. */
  type: string;
  position: Vec2;
  /** The node's own settings (a curve's keys, a property's name, an event's name…). */
  settings?: Record<string, unknown>;
  /** Inline values of unwired inputs, by input name. */
  inputs?: Record<string, GraphInputValue>;
}

/**
 * A value wire: from a node's output port (`"<nodeId>.<port>"`) to a node's input
 * (`"<nodeId>.<port>"`) or a block's input (`"<systemId>.<blockId>.<input>"`). An input has at
 * most one wire.
 */
export interface GraphEdge {
  from: string;
  to: string;
}

/**
 * An event wire. `from` is an event node (`"<nodeId>"`: On Play, On Stop, Custom) or a Trigger
 * Event block (`"<systemId>.<blockId>"`); `to` is a system's spawn start or stop
 * (`"<systemId>.start"`, `"<systemId>.stop"`). A trigger block wired to a start makes that system
 * spawn from each triggering particle (a sub-emitter).
 */
export interface GraphEvent {
  from: string;
  to: string;
}

export type GraphPropertyType = "number" | "vector2" | "vector3" | "color" | "curve" | "gradient" | "texture";
export const GRAPH_PROPERTY_TYPES: readonly GraphPropertyType[] = ["number", "vector2", "vector3", "color", "curve", "gradient", "texture"];

export interface GraphProperty {
  /** Unique within the document; what `ParticleSystem.setProperty` takes. */
  name: string;
  type: GraphPropertyType;
  value: GraphInputValue;
  /** Shown on ParticleSystems as a per-instance override. */
  exposed: boolean;
}

export interface GraphNote {
  id: string;
  position: Vec2;
  size: Vec2;
  text: string;
}
export interface GraphGroup {
  id: string;
  title: string;
  /** Ids of the systems and nodes in it. */
  members: string[];
}

export interface ParticleGraph {
  properties: GraphProperty[];
  systems: ParticleGraphSystem[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  events: GraphEvent[];
  notes: GraphNote[];
  groups: GraphGroup[];
  /** Editor-only data (view position and zoom…), kept as it is and ignored by the engine. */
  editor?: Record<string, unknown>;
}

/** Something wrong in a graph: a parse issue, an unknown type, a wire the backend can't run. `at` is the id path it's about. */
export interface GraphProblem {
  message: string;
  severity: "error" | "warning";
  at?: string;
}
