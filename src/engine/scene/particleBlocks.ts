/**
 * The particle block registry (ADR 0060): every block type a system's contexts can hold, with its
 * inputs, defaults and the contexts it fits. The graph format, the editor's search and inspector
 * and the compiler all read it. Block types are versioned by name (`update.colorOverLife`).
 *
 * Together the blocks express everything `myco.particles@1` could, so migration is lossless.
 */
import type { ContextKind, GraphBlock, GraphInputValue } from "./particleGraph";
import { defaultBehavior, defaultEmitter, defaultRenderer, defaultShape, type ParticleBehaviorType } from "./particles";

export type BlockInputType = "number" | "color" | "vector2" | "vector3" | "bool" | "enum" | "asset";
export type NumberForm = "constant" | "random" | "curve" | "randomCurves";
export type ColorForm = "constant" | "random" | "gradient" | "randomGradients";

export interface BlockInputDef {
  name: string;
  label: string;
  type: BlockInputType;
  /** Number/colour inputs: which value forms the input accepts (inline and wired). */
  forms?: readonly (NumberForm | ColorForm)[];
  default: GraphInputValue;
  /** Enum choices. */
  choices?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
  /** "s", "m", "m/s", "°", "°/s"… */
  unit?: string;
}

export interface BlockDef {
  type: string;
  label: string;
  description: string;
  contexts: readonly ContextKind[];
  inputs: readonly BlockInputDef[];
  /** Trigger Event: the block has an event output. */
  event?: boolean;
}

const ALL_NUMBER: readonly NumberForm[] = ["constant", "random", "curve", "randomCurves"];
const SIMPLE_NUMBER: readonly NumberForm[] = ["constant", "random"];
const RATE_NUMBER: readonly NumberForm[] = ["constant", "random", "curve"];
const CONSTANT: readonly NumberForm[] = ["constant"];
const ALL_COLOR: readonly ColorForm[] = ["constant", "random", "gradient", "randomGradients"];

type Opts = Partial<Pick<BlockInputDef, "forms" | "min" | "max" | "step" | "unit">>;

const number = (name: string, label: string, def: GraphInputValue, o: Opts = {}): BlockInputDef => ({ name, label, type: "number", forms: ALL_NUMBER, default: def, ...o });
/** A plain number (constant only). */
const scalar = (name: string, label: string, def: number, o: Opts = {}): BlockInputDef => number(name, label, def, { forms: CONSTANT, ...o });
const color = (name: string, label: string, def: GraphInputValue): BlockInputDef => ({ name, label, type: "color", forms: ALL_COLOR, default: def });
const vector2 = (name: string, label: string, def: number[], o: Opts = {}): BlockInputDef => ({ name, label, type: "vector2", default: def, ...o });
const vector3 = (name: string, label: string, def: number[], o: Opts = {}): BlockInputDef => ({ name, label, type: "vector3", default: def, ...o });
const bool = (name: string, label: string, def: boolean): BlockInputDef => ({ name, label, type: "bool", default: def });
const enumInput = (name: string, label: string, choices: readonly string[], def: string): BlockInputDef => ({ name, label, type: "enum", choices, default: def });

const emitter = defaultEmitter();
const shape = defaultShape();
const renderer = defaultRenderer();
const bd = (type: ParticleBehaviorType, key: string): GraphInputValue => (defaultBehavior(type) as unknown as Record<string, GraphInputValue>)[key];

const MODES = ["random", "loop", "pingpong", "burst"] as const;
const mode = () => enumInput("mode", "Mode", MODES, shape.mode);
const spread = () => scalar("spread", "Spread", shape.spread, { min: 0, max: 1, step: 0.01 });
const arc = () => scalar("arc", "Arc", shape.arc, { min: 0, max: 360, unit: "°" });
const thickness = () => scalar("thickness", "Thickness", shape.thickness, { min: 0, max: 1, step: 0.01 });
const radius = () => scalar("radius", "Radius", shape.radius, { min: 0, unit: "m" });
const placement = () => [vector3("offset", "Offset", [0, 0, 0], { unit: "m" }), vector3("rotation", "Rotation", [0, 0, 0], { unit: "°" })];

const IN_SPAWN: readonly ContextKind[] = ["spawn"];
const IN_INIT: readonly ContextKind[] = ["initialize"];
const IN_UPDATE: readonly ContextKind[] = ["update"];
const IN_OUTPUT: readonly ContextKind[] = ["output"];
const IN_INIT_UPDATE: readonly ContextKind[] = ["initialize", "update"];
const ATTR_ALL: readonly ContextKind[] = ["initialize", "update", "output"];

const position = (shapeName: string, description: string, fields: BlockInputDef[]): BlockDef => ({
  type: `init.position${shapeName}`,
  label: `Position: ${shapeName}`,
  description,
  contexts: IN_INIT,
  inputs: [...fields, ...placement()],
});

const burstTime = () => scalar("time", "Time", 0, { min: 0, unit: "s" });
const burstCount = () => number("count", "Count", 10, { forms: SIMPLE_NUMBER, min: 0 });
const probability = () => scalar("probability", "Probability", 1, { min: 0, max: 1, step: 0.01 });

export const BLOCKS: readonly BlockDef[] = [
  // --- spawn ---
  { type: "spawn.rate", label: "Constant rate", description: "Spawns particles steadily each second; a curve varies it over the spawn cycle.", contexts: IN_SPAWN, inputs: [number("rate", "Rate", emitter.emission.rateOverTime, { forms: RATE_NUMBER, min: 0, unit: "/s" })] },
  { type: "spawn.rateOverDistance", label: "Rate over distance", description: "Spawns particles for each metre the system moves.", contexts: IN_SPAWN, inputs: [number("rate", "Rate", 10, { forms: RATE_NUMBER, min: 0, unit: "/m" })] },
  { type: "spawn.burst", label: "Burst", description: "Spawns a number of particles at one moment of the cycle.", contexts: IN_SPAWN, inputs: [burstTime(), burstCount(), probability()] },
  {
    type: "spawn.periodicBurst",
    label: "Periodic burst",
    description: "Spawns a burst, then repeats it at an interval.",
    contexts: IN_SPAWN,
    inputs: [burstTime(), burstCount(), scalar("cycles", "Cycles", 3, { min: 1, step: 1 }), scalar("interval", "Interval", 0.1, { min: 0, unit: "s" }), probability()],
  },

  // --- initialize ---
  { type: "init.lifetime", label: "Set lifetime", description: "How long each particle lives.", contexts: IN_INIT, inputs: [number("lifetime", "Lifetime", emitter.startLife, { min: 0, unit: "s" })] },
  { type: "init.velocity", label: "Set velocity", description: "The speed particles start with, along the shape's direction.", contexts: IN_INIT, inputs: [number("speed", "Speed", emitter.startSpeed, { unit: "m/s" })] },
  { type: "init.size", label: "Set size", description: "Each particle's starting size.", contexts: IN_INIT, inputs: [number("size", "Size", emitter.startSize, { min: 0, unit: "m" })] },
  { type: "init.rotation", label: "Set rotation", description: "Each particle's starting rotation.", contexts: IN_INIT, inputs: [number("rotation", "Rotation", emitter.startRotation, { unit: "°" })] },
  { type: "init.color", label: "Set colour", description: "Each particle's starting colour; a gradient is read over the spawn cycle.", contexts: IN_INIT, inputs: [color("color", "Colour", emitter.startColor)] },
  position("Point", "Particles start at a single point.", []),
  position("Sphere", "Particles start in or on a sphere and move outwards.", [radius(), arc(), thickness(), mode(), spread()]),
  position("Hemisphere", "Particles start in or on a half sphere that opens up.", [radius(), arc(), thickness(), mode(), spread()]),
  position("Cone", "Particles start on a disc and move out along a cone.", [radius(), scalar("angle", "Angle", shape.angle, { min: 0, max: 90, unit: "°" }), arc(), thickness(), mode(), spread()]),
  position("Circle", "Particles start on a circle and move outwards.", [radius(), arc(), thickness(), mode(), spread()]),
  position("Donut", "Particles start inside a ring-shaped tube.", [radius(), scalar("donutRadius", "Tube radius", shape.donutRadius, { min: 0, unit: "m" }), arc(), thickness(), mode(), spread()]),
  position("Rectangle", "Particles start in or on a flat rectangle.", [
    scalar("width", "Width", shape.width, { min: 0, unit: "m" }),
    scalar("height", "Height", shape.height, { min: 0, unit: "m" }),
    thickness(),
    mode(),
    spread(),
  ]),
  position("Grid", "Particles start on the points of a grid.", [
    scalar("width", "Width", shape.width, { min: 0, unit: "m" }),
    scalar("height", "Height", shape.height, { min: 0, unit: "m" }),
    scalar("columns", "Columns", shape.columns, { min: 1, step: 1 }),
    scalar("rows", "Rows", shape.rows, { min: 1, step: 1 }),
  ]),

  // --- update ---
  { type: "update.gravity", label: "Gravity", description: "Pulls particles down, as a multiplier of 9.81 m/s².", contexts: IN_UPDATE, inputs: [scalar("strength", "Strength", 1)] },
  { type: "update.colorOverLife", label: "Colour over Life", description: "Colours each particle along its life.", contexts: IN_UPDATE, inputs: [color("color", "Colour", bd("colorOverLife", "color"))] },
  { type: "update.sizeOverLife", label: "Size over Life", description: "Scales each particle along its life.", contexts: IN_UPDATE, inputs: [number("size", "Size", bd("sizeOverLife", "size"), { min: 0 })] },
  { type: "update.rotationOverLife", label: "Rotation over Life", description: "Spins particles.", contexts: IN_UPDATE, inputs: [number("speed", "Speed", bd("rotationOverLife", "speed"), { unit: "°/s" })] },
  { type: "update.speedOverLife", label: "Speed over Life", description: "Multiplies each particle's speed along its life.", contexts: IN_UPDATE, inputs: [number("speed", "Multiplier", bd("speedOverLife", "speed"), { min: 0 })] },
  {
    type: "update.forceOverLife",
    label: "Force over Life",
    description: "Accelerates particles, in the system's space.",
    contexts: IN_UPDATE,
    inputs: [number("x", "X", bd("forceOverLife", "x"), { unit: "m/s²" }), number("y", "Y", bd("forceOverLife", "y"), { unit: "m/s²" }), number("z", "Z", bd("forceOverLife", "z"), { unit: "m/s²" })],
  },
  {
    type: "update.gravityPoint",
    label: "Point gravity",
    description: "Pulls particles towards a point.",
    contexts: IN_UPDATE,
    inputs: [vector3("center", "Center", bd("gravityPoint", "center") as number[], { unit: "m" }), scalar("strength", "Strength", bd("gravityPoint", "strength") as number)],
  },
  {
    type: "update.noise",
    label: "Noise",
    description: "Wobbles particles with smooth noise.",
    contexts: IN_UPDATE,
    inputs: [
      number("frequency", "Frequency", bd("noise", "frequency"), { min: 0 }),
      number("power", "Power", bd("noise", "power")),
      number("positionAmount", "Position amount", bd("noise", "positionAmount")),
      number("rotationAmount", "Rotation amount", bd("noise", "rotationAmount")),
    ],
  },
  {
    type: "update.turbulence",
    label: "Turbulence",
    description: "Pushes particles around with a turbulent velocity field.",
    contexts: IN_UPDATE,
    inputs: [
      vector3("scale", "Scale", bd("turbulence", "scale") as number[]),
      scalar("octaves", "Octaves", bd("turbulence", "octaves") as number, { min: 1, max: 4, step: 1 }),
      vector3("velocity", "Velocity", bd("turbulence", "velocity") as number[], { unit: "m/s" }),
      vector3("timeScale", "Time scale", bd("turbulence", "timeScale") as number[]),
    ],
  },
  { type: "update.orbit", label: "Orbit", description: "Turns particles around an axis.", contexts: IN_UPDATE, inputs: [number("speed", "Speed", bd("orbit", "speed"), { unit: "°/s" }), vector3("axis", "Axis", bd("orbit", "axis") as number[])] },
  { type: "update.frameOverLife", label: "Flipbook Frame over Life", description: "Steps through the flipbook tiles along the particle's life.", contexts: IN_UPDATE, inputs: [number("frame", "Frame", bd("frameOverLife", "frame"), { min: 0 })] },
  {
    type: "update.limitSpeed",
    label: "Limit speed",
    description: "Slows particles that go faster than a limit.",
    contexts: IN_UPDATE,
    inputs: [number("speed", "Speed", bd("limitSpeed", "speed"), { min: 0, unit: "m/s" }), scalar("dampen", "Dampen", bd("limitSpeed", "dampen") as number, { min: 0, max: 1, step: 0.01 })],
  },
  {
    type: "update.colorBySpeed",
    label: "Colour by Speed",
    description: "Colours particles by how fast they move.",
    contexts: IN_UPDATE,
    inputs: [color("color", "Colour", bd("colorBySpeed", "color")), scalar("min", "Min speed", bd("colorBySpeed", "min") as number, { unit: "m/s" }), scalar("max", "Max speed", bd("colorBySpeed", "max") as number, { unit: "m/s" })],
  },
  {
    type: "update.sizeBySpeed",
    label: "Size by Speed",
    description: "Scales particles by how fast they move.",
    contexts: IN_UPDATE,
    inputs: [number("size", "Size", bd("sizeBySpeed", "size"), { min: 0 }), scalar("min", "Min speed", bd("sizeBySpeed", "min") as number, { unit: "m/s" }), scalar("max", "Max speed", bd("sizeBySpeed", "max") as number, { unit: "m/s" })],
  },
  {
    type: "update.collision",
    label: "Collide with plane",
    description: "Bounces particles off a horizontal plane, or kills them there.",
    contexts: IN_UPDATE,
    inputs: [
      scalar("height", "Height", bd("collision", "height") as number, { unit: "m" }),
      scalar("bounce", "Bounce", bd("collision", "bounce") as number, { min: 0, step: 0.01 }),
      bool("kill", "Kill on hit", bd("collision", "kill") as boolean),
    ],
  },
  {
    type: "update.triggerEvent",
    label: "Trigger Event",
    description: "Sends an event from particles; wire it to a system's start to spawn from them.",
    contexts: IN_UPDATE,
    event: true,
    inputs: [enumInput("on", "On", ["birth", "death", "frame"], "death"), scalar("probability", "Probability", 1, { min: 0, max: 1, step: 0.01 }), bool("inheritVelocity", "Inherit velocity", false)],
  },

  // --- output ---
  // Set Attribute (ADR 0095): write a per-particle value into an attribute. Kernel backends only (ADR 0094).
  ...(
    [
      ["Position", "position", "vector3", "m"],
      ["Velocity", "velocity", "vector3", "m/s"],
      ["Colour", "color", "color", ""],
      ["Alpha", "alpha", "number", ""],
      ["Size", "size", "number", "m"],
      ["Rotation", "rotation", "number", "°"],
      ["Lifetime", "lifetime", "number", "s"],
    ] as const
  ).map(
    ([label, attr, kind, unit]): BlockDef => ({
      type: `attribute.${attr}`,
      label: `Set ${label}`,
      description: `Sets, adds to or multiplies each particle's ${label.toLowerCase()} with a value that can differ per particle (wire Particle nodes and operators into it). Runs on kernel (GPU) backends only.`,
      contexts: attr === "lifetime" ? IN_INIT : attr === "color" || attr === "alpha" || attr === "size" ? ATTR_ALL : IN_INIT_UPDATE,
      inputs: [
        enumInput("mode", "Mode", ["set", "add", "multiply"], "set"),
        kind === "vector3"
          ? vector3("value", "Value", [0, 0, 0], unit ? { unit } : {})
          : kind === "color"
            ? { name: "value", label: "Value", type: "color", forms: ["constant"], default: "#ffffffff" }
            : number("value", "Value", attr === "alpha" || attr === "size" ? 1 : 0, { forms: CONSTANT, ...(unit ? { unit } : {}) }),
      ],
    }),
  ),

  {
    type: "output.flipbook",
    label: "Flipbook",
    description: "Reads the texture as a grid of tiles.",
    contexts: IN_OUTPUT,
    inputs: [vector2("tiles", "Tiles", [4, 4], { min: 1, step: 1 }), number("startTile", "Start tile", renderer.startTile, { forms: SIMPLE_NUMBER, min: 0 }), bool("blendTiles", "Blend tiles", renderer.blendTiles)],
  },
  { type: "output.widthOverLength", label: "Width over Length", description: "Trail width along the trail.", contexts: IN_OUTPUT, inputs: [number("width", "Width", bd("widthOverLength", "width"), { min: 0 })] },
];

const byType = new Map(BLOCKS.map((b) => [b.type, b]));

/** The block definition for `type`, or undefined for an unknown type. */
export const blockDef = (type: string): BlockDef | undefined => byType.get(type);

/** The blocks that fit in a context, in registry order. */
export const blocksFor = (context: ContextKind): BlockDef[] => BLOCKS.filter((b) => b.contexts.includes(context));

/** A new block of `type` with every input at its default (an unknown type gets no inputs). */
export function defaultBlock(type: string, id: string): GraphBlock {
  const def = byType.get(type);
  const inputs: Record<string, GraphInputValue> = {};
  for (const i of def?.inputs ?? []) inputs[i.name] = structuredClone(i.default);
  return { id, type, inputs };
}
