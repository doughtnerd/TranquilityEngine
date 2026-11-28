/**
 * The graph compiler (ADR 0372, T30): an animation graph (`myco.animgraph-source@1`, `animGraph.ts`) lowered to the
 * binary `myco.animgraph@1` the core loads (`native/anim/crates/anim-format/src/graph.rs`, the contract).
 *
 * # What it writes
 *
 * - **Parameters** (`PARAMS`) in the source's order, with the replicate / predicted / computed flags and their defaults.
 * - **Nodes** (`NODES`, `NODE_INPUTS`, `PARAM_BLOCKS`) in a valid order: children first (inputs, state roots, bridge
 *   nodes, chooser results), otherwise the source's order (a stable topological sort), so a source already written
 *   children-first keeps its order. Each block is packed by the node's catalogue entry (`graphNodes/`), full length,
 *   defaults explicit, `NONE` for absent words.
 * - **State machines** (`MACHINES`, `STATES`, `TRANSITIONS`, `INTERRUPTS`): per machine its any-state transitions, then
 *   each state's, each list in priority order (highest first). `when` (now, exit, `marker:<name>`, a normalised time),
 *   `how` (crossfade, cut, inertialize, bridge with its node), the duration, the fade shape (D53's ids: 0 linear,
 *   1 smoothstep, 2 ease in, 3 ease out) and the interrupt mode (never, any, or a list of the machine's transition
 *   ids). A state with no root gets a shared empty clip player (it outputs nothing).
 * - **Condition programs** (`CONDITION_PROGRAMS`, `CONDITION_NODES`): each structured condition as one prefix-order
 *   tree (all / any groups up to 16 deep), type-checked against the parameters (float and int parameters compare
 *   numbers, bool parameters `==`/`!=` a boolean; vectors, quaternions and nodes don't compare).
 * - **Slots, linked graphs** (with the capacities their nodes declare, D56), **choosers** and **layers**: each top-level
 *   layer becomes a `mixing/layer` node stacked over the output in order (Unity's layers), with its `LAYERS` record
 *   naming its root (`anim.layerWeight` sets index i's weight; the core's input view has 4 layer weights).
 * - **Strings** (`STRINGS`): the graph's name, then parameter names, request names (the blackboard's globals), then each
 *   node's strings in node order (its debug name, parameter strings, side-table names), then layers.
 *
 * # Names and assets
 *
 * Names the core matches across tables (sync, exit and cue markers, curves, linked-graph parameters) are stored as
 * strings and hashed by the core with FNV-1a (D55); the compiler only places them. **Asset references** (clips, masks,
 * linked and source graphs, pose databases, retarget maps, plugin modules) are stored as their project path (the
 * reference without `asset:` or a leading `./`; a `#sub-asset` kept), and listed in `bindings`: the loader binds each
 * string id to the loaded asset's handle (`graph_bind`), as the core expects (`anim-wasm/src/assets.rs`: one binding
 * per string id).
 *
 * # Problems
 *
 * Never throws. Each problem names a path into the source model (`nodes[3].params.speed`,
 * `nodes[5].machine.states[1].transitions[0].if.any[1]`) and is an error or a warning. Errors: unknown kinds, wrong
 * input counts, cycles, type mismatches, references to nothing; warnings: unreachable states and nodes, clamped values,
 * unknown node parameters. The bytes are written whenever a valid file can be (a bad piece is dropped or defaulted);
 * they are null only without nodes, without an output, or with a cycle.
 *
 * Pure; no plugin, no DOM. Internal: not public API.
 */
import {
  CMP_OPS, FADE_SHAPES, GRAPH_FAMILIES, GRAPH_LIMITS, GRAPH_PARAM_TYPES, LAYER_MODES, parseAnimGraph, STATE_OPERANDS, TRANSITION_HOWS,
  type AnimGraph, type Condition, type GraphNode, type GraphParamType, type NodeParamValue, type Transition,
} from "./animGraph";
import { ByteWriter, encodeStringTable, f32Bits, writeContainer } from "./binaryWriter";
import { familyId, NONE, nodeKindSchema, type AssetRefKind, type NodeKindSchema, type NodePacker, type NodeParamSchema, type NodeResolveContext } from "./graphNodes";
import { pluginNodeModuleDescriptor } from "./graphNodes/plugin";
import type { PluginModuleDescriptor } from "./pluginDescriptor";
import { normalizeAssetPath } from "../scene/assetPath";

/** @internal One problem: where in the source model, what, and how bad. */
export interface CompileProblem {
  readonly path: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

/** @internal A string id the loader binds to an asset handle. */
export interface GraphBinding {
  readonly stringId: number;
  /** The reference as written (`asset:clips/walk.anim.json`). */
  readonly ref: string;
  readonly asset: AssetRefKind;
}

/** @internal What a compile produced. */
export interface CompiledAnimGraph {
  /** The `myco.animgraph@1` bytes, or null when no valid file could be written. */
  readonly bytes: Uint8Array | null;
  /** Bytes and no errors. */
  readonly ok: boolean;
  readonly problems: readonly CompileProblem[];
  readonly strings: readonly string[];
  readonly bindings: readonly GraphBinding[];
  /** Node index → the source node's id ("" for a node the compiler added). */
  readonly nodes: readonly string[];
  /** Parameter index → name. */
  readonly parameters: readonly string[];
  /** Machine index → its node's id and its state names (local index order). */
  readonly machines: readonly { readonly node: string; readonly states: readonly string[] }[];
  /** Slot, linked-graph and layer index → name. */
  readonly slots: readonly string[];
  readonly linked: readonly string[];
  readonly layers: readonly string[];
  /** IK target slot index → name (`anim.ik(name)`; at most 16). */
  readonly ikTargets: readonly string[];
  /** Ray rows the grounders use. */
  readonly rays: number;
  /**
   * Transition index (the `TRANSITIONS` table, over every machine) → its source path
   * (`nodes[3].machine.states[1].transitions[0]`, `nodes[3].machine.anyState[0]`): what the debugger's records name (T52).
   */
  readonly transitions: readonly string[];
  /** Condition term index (the `CONDITIONS` table) → its source path (`….transitions[0].if.all[1]`): a debug blocker's failing term (T52). */
  readonly conditions: readonly string[];
}

/** @internal What the compiler may know beyond the graph. */
export interface GraphCompileOptions {
  /** The skeleton's bone names (bone references by name; Humanoid role names work without it). */
  readonly bones?: readonly string[];
  /** A pose database's tag names, for tag lists given by name (`database` null: a `matchTags` node's). */
  readonly poseDatabaseTags?: (database: string | null) => readonly string[] | undefined;
  /**
   * A third-party node module's descriptor by project path, so plugin nodes that name a module node pack named
   * parameters (T45t). Absent: the catalogue's registry (`graphNodes/plugin.ts`, filled by the loaders).
   */
  readonly pluginDescriptors?: (module: string) => PluginModuleDescriptor | undefined;
}

const MAGIC = "MYCOAGPH";

/** Parameter flags (`PARAM_REPLICATE`, `PARAM_PREDICTED`, `PARAM_COMPUTED`). */
const PARAM_REPLICATE = 1, PARAM_PREDICTED = 2, PARAM_COMPUTED = 4;
const STATE_EXIT = 1;
/** IK target slots per instance (`rig::view::MAX_TARGETS`) and ray rows (`MAX_RAYS`). */
const MAX_TARGETS = 16, MAX_RAYS = 8;
/** Layer weights the input view carries (`anim-wire`'s `MAX_LAYERS`). */
const INPUT_LAYERS = 4;
/** `rig::ROLE`. */
const ROLE = 0x80000000;

/**
 * @internal Audio's fade shape (ADR 0350, `src/engine/audio/playlist/fadeShapes.ts`) with the same curve as each of the
 * core's transition shapes (D53): the ids differ (the core's 0–3 are fixed in `logic.rs`), the curves agree, so a graph
 * editor can preview a transition with audio's `shapeLevel`.
 */
export const AUDIO_FADE_SHAPE = Object.freeze({ linear: "linear", smoothstep: "sCurve", easeIn: "exp2", easeOut: "log2" } as const);

/** The Humanoid profile's roles in index order (`anim-retarget/src/profile.rs`, `humanoid`). */
const HUMANOID_ROLES: readonly string[] = (() => {
  const hand = (s: string) => [
    "Shoulder", "UpperArm", "LowerArm", "Hand", "ThumbMetacarpal", "ThumbProximal", "ThumbDistal",
    ...["Index", "Middle", "Ring", "Little"].flatMap((f) => [`${f}Proximal`, `${f}Intermediate`, `${f}Distal`]),
  ].map((r) => s + r);
  const leg = (s: string) => ["UpperLeg", "LowerLeg", "Foot", "Toes"].map((r) => s + r);
  return [
    "Root", "Hips", "Spine", "Chest", "UpperChest", "Neck", "Head", "LeftEye", "RightEye", "Jaw",
    ...hand("Left"), ...hand("Right"), ...leg("Left"), ...leg("Right"),
    "LeftUpperArmTwist", "LeftLowerArmTwist", "RightUpperArmTwist", "RightLowerArmTwist",
    "LeftUpperLegTwist", "LeftLowerLegTwist", "RightUpperLegTwist", "RightLowerLegTwist",
  ];
})();

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const finiteF32 = (v: number): boolean => Number.isFinite(Math.fround(v));

interface CondRecord { code: number; op: number; src: number; operand: number; value: number; path: string }
interface TransitionRecord { target: number; condition: number; when: number; whenValue: number; how: number; duration: number; shape: number; bridge: number; mode: number; first: number; count: number }
interface NodeRecord { family: number; kind: number; inputs: number[]; words: number[]; name: number }

/** @internal Parses a `*.animgraph.json` value and compiles it; parse problems come first (as errors of the parse). */
export function compileAnimGraphSource(raw: unknown, options: GraphCompileOptions = {}): CompiledAnimGraph {
  const parsed = parseAnimGraph(raw);
  const out = compileAnimGraph(parsed.value, options);
  const parseProblems: CompileProblem[] = parsed.problems.map((p) => {
    const i = p.indexOf(": ");
    return { path: i < 0 ? "" : p.slice(0, i), message: i < 0 ? p : p.slice(i + 2), severity: "error" };
  });
  const problems = [...parseProblems, ...out.problems];
  return { ...out, problems, ok: out.ok && parseProblems.length === 0 };
}

/** @internal Compiles a graph to `myco.animgraph@1` (never throws; see the module docs). */
export function compileAnimGraph(graph: AnimGraph, options: GraphCompileOptions = {}): CompiledAnimGraph {
  return new Compiler(graph, options).run();
}

class Compiler {
  readonly problems: CompileProblem[] = [];
  readonly strings: string[] = [];
  readonly stringIds = new Map<string, number>();
  readonly bindings = new Map<number, GraphBinding>();
  readonly paramIndex = new Map<string, number>();
  readonly paramTypes: GraphParamType[] = [];
  readonly ikTargets: string[] = [];
  rays = 0;
  readonly conds: CondRecord[] = [];
  /** Each `TRANSITIONS` record's source path, in table order. */
  readonly transitionPaths: string[] = [];
  readonly programs: [number, number][] = [];

  constructor(readonly g: AnimGraph, readonly options: GraphCompileOptions) {}

  readonly resolveContext: NodeResolveContext = {
    pluginDescriptor: (module) => (this.options.pluginDescriptors ?? pluginNodeModuleDescriptor)(module),
  };

  error(path: string, message: string): void {
    this.problems.push({ path, message, severity: "error" });
  }
  warn(path: string, message: string): void {
    this.problems.push({ path, message, severity: "warning" });
  }

  intern(s: string): number {
    let id = this.stringIds.get(s);
    if (id === undefined) {
      id = this.strings.length;
      this.strings.push(s);
      this.stringIds.set(s, id);
    }
    return id;
  }
  optName(s: string | null | undefined): number {
    return s ? this.intern(s) : NONE;
  }
  assetRef(ref: string, asset: AssetRefKind, path: string): number {
    const key = normalizeAssetPath(ref);
    if (key === "") return NONE;
    const id = this.intern(key);
    const had = this.bindings.get(id);
    if (had && had.asset !== asset) this.error(path, `${JSON.stringify(ref)} is bound as a ${had.asset} elsewhere in this graph; one string can't name two kinds of asset.`);
    else if (!had) this.bindings.set(id, { stringId: id, ref, asset });
    return id;
  }

  fail(): CompiledAnimGraph {
    return { bytes: null, ok: false, problems: this.problems, strings: this.strings, bindings: [], nodes: [], parameters: [], machines: [], slots: [], linked: [], layers: [], ikTargets: [], rays: 0, transitions: [], conditions: [] };
  }

  run(): CompiledAnimGraph {
    const g = this.g;
    const info = { name: this.optName(g.name), skeleton: g.skeleton ? this.intern(normalizeAssetPath(g.skeleton)) : NONE };

    // Parameters.
    const params = new ByteWriter();
    const paramNames: string[] = [];
    g.parameters.forEach((p, i) => {
      const at = `parameters[${i}]`;
      if (paramNames.length >= GRAPH_LIMITS.parameters) return this.error(at, `a graph has at most ${GRAPH_LIMITS.parameters} parameters; dropped.`);
      if (!p.name || this.paramIndex.has(p.name)) return this.error(`${at}.name`, p.name ? `parameter "${p.name}" is defined twice; dropped.` : "a parameter needs a name; dropped.");
      const type = (GRAPH_PARAM_TYPES as readonly string[]).includes(p.type) ? p.type : (this.error(`${at}.type`, `${JSON.stringify(p.type)} isn't a parameter type; using "float".`), "float");
      const name = this.intern(p.name);
      const words = this.paramDefault(type, p.default, `${at}.default`);
      this.paramIndex.set(p.name, paramNames.length);
      this.paramTypes.push(type);
      paramNames.push(p.name);
      params.u32(name).u8(GRAPH_PARAM_TYPES.indexOf(type)).u8((p.replicate ? PARAM_REPLICATE : 0) | (p.predicted ? PARAM_PREDICTED : 0) | (p.computed ? PARAM_COMPUTED : 0)).u16(0).u32s(words);
    });

    // Request names, the blackboard's other globals.
    for (const n of g.nodes) {
      const visit = (c: Condition | null) => {
        if (!c) return;
        if ("all" in c) c.all.forEach(visit);
        else if ("any" in c) c.any.forEach(visit);
        else if ("request" in c && c.request) this.intern(c.request);
      };
      if (n.kind === "stateMachine" && n.machine) {
        for (const s of n.machine.states) s.transitions.forEach((t) => visit(t.if));
        n.machine.anyState.forEach((t) => visit(t.if));
      }
      if (n.kind === "chooser" && n.chooser) n.chooser.rows.forEach((r) => visit(r.if));
    }

    if (g.nodes.length === 0) {
      this.error("nodes", "a graph needs at least one node.");
      return this.fail();
    }
    const srcIndex = new Map<string, number>();
    g.nodes.forEach((n, i) => {
      if (srcIndex.has(n.id)) this.error(`nodes[${i}].id`, `node id "${n.id}" is used twice; references go to the first.`);
      else srcIndex.set(n.id, i);
    });
    const ref = (id: string | null, path: string): number | null => {
      if (id === null) return null;
      const i = srcIndex.get(id);
      if (i === undefined) this.error(path, `${JSON.stringify(id)} isn't a node of this graph; dropped.`);
      return i ?? null;
    };

    // Children per node (inputs, state roots, bridges, chooser results), checked against the catalogue.
    const schemas = g.nodes.map((n, i) => this.schemaOf(n, `nodes[${i}]`));
    const inputs: number[][] = g.nodes.map((n, i) => {
      const list = n.inputs.map((x, k) => ref(x, `nodes[${i}].inputs[${k}]`)).filter((x): x is number => x !== null);
      const s = schemas[i];
      if (!s) return list;
      if (list.length < s.inputs.min) this.error(`nodes[${i}].inputs`, `a ${n.kind} node needs ${s.inputs.min === s.inputs.max ? "" : "at least "}${s.inputs.min} input${s.inputs.min === 1 ? "" : "s"}${s.inputs.names.length ? ` (${s.inputs.names.join(", ")})` : ""}, has ${list.length}.`);
      if (list.length > s.inputs.max) {
        this.error(`nodes[${i}].inputs`, s.inputs.max === 0 ? `a ${n.kind} node takes no inputs; dropped.` : `a ${n.kind} node takes at most ${s.inputs.max} inputs; the rest are dropped.`);
        return list.slice(0, s.inputs.max);
      }
      return list;
    });
    const extra: number[][] = g.nodes.map((n, i) => {
      const out: number[] = [];
      if (n.kind === "stateMachine" && n.machine) {
        n.machine.states.forEach((s, k) => {
          const r = ref(s.root, `nodes[${i}].machine.states[${k}].root`);
          if (r !== null) out.push(r);
          s.transitions.forEach((t, j) => {
            const b = t.how === "bridge" ? ref(t.bridge, `nodes[${i}].machine.states[${k}].transitions[${j}].bridge`) : null;
            if (b !== null) out.push(b);
          });
        });
        n.machine.anyState.forEach((t, j) => {
          const b = t.how === "bridge" ? ref(t.bridge, `nodes[${i}].machine.anyState[${j}].bridge`) : null;
          if (b !== null) out.push(b);
        });
      }
      if (n.kind === "chooser" && n.chooser) {
        n.chooser.rows.forEach((r, k) => {
          const x = ref(r.result, `nodes[${i}].chooser.rows[${k}].result`);
          if (x !== null) out.push(x);
        });
        const f = ref(n.chooser.fallback, `nodes[${i}].chooser.fallback`);
        if (f !== null) out.push(f);
      }
      return out;
    });
    const children = g.nodes.map((_, i) => [...inputs[i], ...extra[i]]);

    const order = this.topoOrder(children);
    if (!order) return this.fail();

    const outputSrc = g.output === null ? null : srcIndex.get(g.output) ?? null;
    if (outputSrc === null) {
      this.error("output", g.output === null ? "a graph needs an output node." : `${JSON.stringify(g.output)} isn't a node of this graph.`);
      return this.fail();
    }

    // Reachability from the output and the layers' roots.
    const reached = new Set<number>();
    const stack = [outputSrc, ...g.layers.map((l) => srcIndex.get(l.root)).filter((x): x is number => x !== undefined)];
    while (stack.length) {
      const v = stack.pop()!;
      if (reached.has(v)) continue;
      reached.add(v);
      stack.push(...children[v]);
    }
    g.nodes.forEach((n, i) => {
      if (!reached.has(i)) this.warn(`nodes[${i}]`, `node "${n.id}" doesn't feed the output or a layer; it never runs.`);
    });

    // Final indices: an empty player first when a state has no root, then the source nodes children-first.
    const needsEmpty = g.nodes.some((n) => n.kind === "stateMachine" && n.machine?.states.some((s) => s.root === null || !srcIndex.has(s.root)));
    const finalIndex = new Map<number, number>();
    const shift = needsEmpty ? 1 : 0;
    order.forEach((src, k) => finalIndex.set(src, k + shift));
    const records: NodeRecord[] = [];
    const nodeIds: string[] = [];
    const EMPTY = 0;
    if (needsEmpty) {
      records.push({ family: 0, kind: 0, inputs: [], words: [NONE, f32Bits(1), 0, 0, NONE], name: NONE });
      nodeIds.push("");
    }
    const fi = (src: number) => finalIndex.get(src)!;

    // Side tables, built as their nodes are written.
    const machines: number[][] = [];
    const machineInfo: { node: string; states: string[] }[] = [];
    const states: number[][] = [];
    const transitions: TransitionRecord[] = [];
    const interrupts: number[] = [];
    const slots: number[][] = [];
    const slotNames: string[] = [];
    const linked: number[][] = [];
    const linkedNames: string[] = [];
    const choosers: number[][] = [];
    const chooserRows: number[][] = [];

    for (const src of order) {
      const n = g.nodes[src];
      const at = `nodes[${src}]`;
      const schema = schemas[src];
      const name = this.optName(n.name);
      const ins = inputs[src].map(fi);
      if (!schema) {
        records.push({ family: 0, kind: 0, inputs: [], words: [NONE, f32Bits(1), 0, 0, NONE], name });
        nodeIds.push(n.id);
        continue;
      }
      const words = this.pack(n, schema, at, ins.length);
      let record: NodeRecord = { family: familyId(schema.family), kind: schema.id, inputs: ins, words, name };
      if (schema.side === "machine") {
        const m = this.machine(n, at, fi, needsEmpty ? EMPTY : NONE, srcIndex, states, transitions, interrupts);
        if (m) {
          machines.push([fi(src), name, ...m.record]);
          machineInfo.push({ node: n.id, states: m.names });
        } else record = { family: 0, kind: 0, inputs: [], words: [NONE, f32Bits(1), 0, 0, NONE], name };
      } else if (schema.side === "chooser") {
        const first = chooserRows.length;
        (n.chooser?.rows ?? []).forEach((r, k) => {
          const result = srcIndex.get(r.result);
          if (result === undefined) return;
          const prog = this.program(r.if, `${at}.chooser.rows[${k}].if`);
          if (prog === null) return this.error(`${at}.chooser.rows[${k}]`, "the row's condition is invalid; the row is dropped.");
          chooserRows.push([prog, fi(result)]);
        });
        const fb = n.chooser?.fallback ? srcIndex.get(n.chooser.fallback) : undefined;
        choosers.push([fi(src), first, chooserRows.length - first, fb === undefined ? NONE : fi(fb)]);
      } else if (schema.side === "slot") {
        let slotName = n.slot?.name ?? "";
        if (!slotName) {
          slotName = n.id;
          this.warn(`${at}.slot.name`, `a slot needs a name; using "${n.id}".`);
        }
        if (slotNames.includes(slotName)) this.error(`${at}.slot.name`, `slot "${slotName}" is defined twice; \`play\` reaches the first.`);
        slots.push([this.intern(slotName), fi(src), this.optName(n.slot?.group), 0]);
        slotNames.push(slotName);
      } else if (schema.side === "linked") {
        let linkedName = n.linked?.name ?? "";
        if (!linkedName) {
          linkedName = n.id;
          this.warn(`${at}.linked.name`, `a linked graph needs a name; using "${n.id}".`);
        }
        if (linkedNames.includes(linkedName)) this.error(`${at}.linked.name`, `linked graph "${linkedName}" is defined twice; \`link\` reaches the first.`);
        const def = n.linked?.graph ? this.assetRef(n.linked.graph, "graph", `${at}.linked.graph`) : NONE;
        linked.push([this.intern(linkedName), fi(src), def, 0]);
        linkedNames.push(linkedName);
      }
      records.push(record);
      nodeIds.push(n.id);
    }

    // Layers: a `mixing/layer` node per layer, stacked over the output.
    let output = fi(outputSrc);
    const layers = new ByteWriter();
    const layerNames: string[] = [];
    g.layers.forEach((l, i) => {
      const at = `layers[${i}]`;
      const root = srcIndex.get(l.root);
      if (root === undefined) return this.error(`${at}.root`, `${JSON.stringify(l.root)} isn't a node of this graph; the layer is dropped.`);
      if (layerNames.includes(l.name)) return this.error(`${at}.name`, `layer "${l.name}" is defined twice; dropped.`);
      const index = layerNames.length;
      if (index === INPUT_LAYERS) this.warn(at, `the core takes runtime weights for the first ${INPUT_LAYERS} layers; this one and later ones keep their default weight.`);
      const mode = Math.max(0, LAYER_MODES.indexOf(l.mode));
      const mask = l.mask ? this.assetRef(l.mask, "mask", `${at}.mask`) : NONE;
      let weight = isNum(l.weight) ? l.weight : 1;
      if (weight < 0 || weight > 1) {
        this.warn(`${at}.weight`, `${weight} is outside 0..1; clamped.`);
        weight = Math.min(1, Math.max(0, weight));
      }
      let wp = NONE;
      if (l.weightParameter) {
        const p = this.paramIndex.get(l.weightParameter);
        if (p === undefined || this.paramTypes[p] !== "float") this.error(`${at}.weightParameter`, `${JSON.stringify(l.weightParameter)} isn't a float parameter; none.`);
        else wp = p;
      }
      const nameId = this.intern(l.name);
      records.push({ family: familyId("mixing"), kind: 2, inputs: [output, fi(root)], words: [index, mode, mask, f32Bits(weight), wp], name: nameId });
      nodeIds.push("");
      output = records.length - 1;
      layers.u32(nameId).u32(fi(root)).u32(mask).u32(mode).f32(weight).u32(wp);
      layerNames.push(l.name);
    });

    // Write.
    const nodes = new ByteWriter(), nodeInputs = new ByteWriter(), blocks = new ByteWriter();
    let inputCount = 0, wordCount = 0;
    for (const r of records) {
      nodes.u8(r.family).u8(0).u16(r.kind).u32s([inputCount, r.inputs.length, wordCount, r.words.length, r.name]);
      nodeInputs.u32s(r.inputs);
      blocks.u32s(r.words);
      inputCount += r.inputs.length;
      wordCount += r.words.length;
    }
    const rows = (list: number[][]) => {
      const w = new ByteWriter();
      for (const r of list) w.u32s(r);
      return w.finish();
    };
    const tw = new ByteWriter();
    for (const t of transitions) tw.u32(t.target).u32(t.condition).u8(t.when).u8(t.how).u8(t.mode).u8(0).u32(t.whenValue).f32(t.duration).u32(t.shape).u32(t.bridge).u32(t.first).u32(t.count).u32(0);
    const cw = new ByteWriter();
    for (const c of this.conds) cw.u8(c.code).u8(c.op).u8(c.src).u8(0).u32(c.operand).u32(c.value).u32(0);
    const bytes = writeContainer(MAGIC, 1, 0, [
      { kind: 1, count: this.strings.length, data: encodeStringTable(this.strings) },
      { kind: 2, count: 1, data: rows([[info.name, output, info.skeleton, 0]]) },
      { kind: 3, count: paramNames.length, data: params.finish() },
      { kind: 4, count: records.length, data: nodes.finish() },
      { kind: 5, count: inputCount, data: nodeInputs.finish() },
      { kind: 6, count: wordCount, data: blocks.finish() },
      { kind: 7, count: machines.length, data: rows(machines.map((m) => [...m, 0])) },
      { kind: 8, count: states.length, data: rows(states.map((s) => [...s, 0])) },
      { kind: 9, count: transitions.length, data: tw.finish() },
      { kind: 10, count: interrupts.length, data: rows([interrupts]) },
      { kind: 11, count: this.programs.length, data: rows(this.programs) },
      { kind: 12, count: this.conds.length, data: cw.finish() },
      { kind: 13, count: slots.length, data: rows(slots) },
      { kind: 14, count: linked.length, data: rows(linked) },
      { kind: 15, count: layerNames.length, data: layers.finish() },
      { kind: 16, count: choosers.length, data: rows(choosers) },
      { kind: 17, count: chooserRows.length, data: rows(chooserRows) },
    ]);
    return {
      bytes, ok: !this.problems.some((p) => p.severity === "error"), problems: this.problems, strings: this.strings, bindings: [...this.bindings.values()],
      nodes: nodeIds, parameters: paramNames, machines: machineInfo, slots: slotNames, linked: linkedNames, layers: layerNames, ikTargets: this.ikTargets, rays: this.rays,
      transitions: this.transitionPaths, conditions: this.conds.map((c) => c.path),
    };
  }

  /** The catalogue entry of a node's kind, or undefined with an error. */
  schemaOf(n: GraphNode, at: string): NodeKindSchema | undefined {
    if (!(GRAPH_FAMILIES as readonly string[]).includes(n.family)) {
      this.error(`${at}.family`, `${JSON.stringify(n.family)} isn't a node family; the node outputs nothing.`);
      return undefined;
    }
    const s = nodeKindSchema(n.family, n.kind);
    if (!s) this.error(`${at}.kind`, `${JSON.stringify(n.kind)} isn't a "${n.family}" node kind; the node outputs nothing.`);
    // A kind may answer a more specific schema for this node (a plugin node's descriptor-generated kind, T45t).
    return s?.resolve?.(n.params, this.resolveContext) ?? s;
  }

  /** Stable topological order, children first; null (with an error naming a cycle) when there is one. */
  topoOrder(children: number[][]): number[] | null {
    const n = children.length;
    const parents: number[][] = Array.from({ length: n }, () => []);
    const pending = children.map((c) => new Set(c).size);
    children.forEach((c, i) => new Set(c).forEach((x) => parents[x].push(i)));
    const ready: number[] = [];
    for (let i = 0; i < n; i++) if (pending[i] === 0) ready.push(i);
    const order: number[] = [];
    while (ready.length) {
      // The lowest source index first (a sorted ready list).
      const v = ready.shift()!;
      order.push(v);
      for (const p of parents[v]) {
        if (--pending[p] === 0) {
          let lo = 0, hi = ready.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (ready[mid] < p) lo = mid + 1;
            else hi = mid;
          }
          ready.splice(lo, 0, p);
        }
      }
    }
    if (order.length === n) return order;
    // Report one cycle among what's left.
    const left = new Set<number>();
    for (let i = 0; i < n; i++) if (pending[i] > 0) left.add(i);
    const start = Math.min(...left);
    const path: number[] = [];
    const seen = new Map<number, number>();
    let v = start;
    while (!seen.has(v)) {
      seen.set(v, path.length);
      path.push(v);
      v = children[v].find((c) => left.has(c))!;
    }
    const cycle = [...path.slice(seen.get(v)!), v].map((i) => `"${this.g.nodes[i].id}"`);
    this.error(`nodes[${start}]`, `the nodes ${cycle.join(" → ")} form a cycle (through inputs, state roots, bridges or chooser results); a graph must be acyclic.`);
    return null;
  }

  paramDefault(type: GraphParamType, v: unknown, at: string): number[] {
    const width = type === "vec2" ? 2 : type === "vec3" ? 3 : type === "quat" ? 4 : 1;
    const zero = type === "quat" ? [0, 0, 0, 1] : [0, 0, 0, 0].slice(0, width);
    const pad = (w: number[]) => [...w, 0, 0, 0, 0].slice(0, 4);
    switch (type) {
      case "float":
        if (v === undefined || v === null) return pad([0]);
        if (isNum(v) && finiteF32(v)) return pad([f32Bits(v)]);
        this.error(at, "must be a finite float; using 0.");
        return pad([0]);
      case "int":
        if (v === undefined || v === null) return pad([0]);
        if (Number.isInteger(v) && Math.abs(v as number) <= 0x7fffffff) return pad([(v as number) >>> 0]);
        this.error(at, "must be a whole number in the i32 range; using 0.");
        return pad([0]);
      case "bool":
        if (v === undefined || v === null || typeof v === "boolean") return pad([v ? 1 : 0]);
        this.error(at, "must be true or false; using false.");
        return pad([0]);
      case "node":
        if (v === undefined || v === null || v === "") return pad([NONE]);
        if (typeof v === "string") return pad([this.intern(v)]);
        this.error(at, "must be a node path or null; using none.");
        return pad([NONE]);
      default:
        if (v === undefined || v === null) return pad(zero.map(f32Bits));
        if (Array.isArray(v) && v.length === width && v.every((x) => isNum(x) && finiteF32(x))) return pad(v.map(f32Bits));
        this.error(at, `must be ${width} finite numbers; using ${JSON.stringify(zero)}.`);
        return pad(zero.map(f32Bits));
    }
  }

  /** A node's parameter block, packed by its catalogue entry. */
  pack(n: GraphNode, schema: NodeKindSchema, at: string, inputCount: number): number[] {
    const known = new Set(schema.params.map((p) => p.name));
    for (const k of Object.keys(n.params)) if (!known.has(k)) this.warn(`${at}.params.${k}`, `a ${n.kind} node has no parameter "${k}"; ignored.`);
    const packer = new Packer(this, n, schema, at, inputCount);
    try {
      schema.pack(packer);
    } catch (e) {
      this.error(at, `the ${n.kind} node couldn't be packed (${e instanceof Error ? e.message : String(e)}); its block is empty.`);
      return [];
    }
    return packer.words;
  }

  /** A machine's states and transitions; null (with an error) when it has no states. */
  machine(n: GraphNode, at: string, fi: (src: number) => number, empty: number, srcIndex: Map<string, number>, states: number[][], transitions: TransitionRecord[], interrupts: number[]): { record: number[]; names: string[] } | null {
    const m = n.machine;
    if (!m || m.states.length === 0) {
      this.error(`${at}.machine`, "a state machine needs at least one state; the node outputs nothing.");
      return null;
    }
    const local = new Map<string, number>();
    m.states.forEach((s, i) => {
      if (local.has(s.name)) this.error(`${at}.machine.states[${i}].name`, `state "${s.name}" is defined twice; transitions go to the first.`);
      else local.set(s.name, i);
    });
    // Conditions (programs) in state order then any-state, so each transition's problems come in source order.
    type Built = { t: Transition; path: string; condition: number; ok: boolean };
    const build = (t: Transition, path: string): Built => {
      let ok = true;
      if (!local.has(t.to)) {
        this.error(`${path}.to`, `${JSON.stringify(t.to)} isn't a state of this machine; the transition is dropped.`);
        ok = false;
      }
      let condition = NONE;
      if (ok && t.if) {
        const p = this.program(t.if, `${path}.if`);
        if (p === null) {
          this.error(path, "the transition's condition is invalid; the transition is dropped.");
          ok = false;
        } else condition = p;
      }
      return { t, path, condition, ok };
    };
    const stateLists = m.states.map((s, i) => s.transitions.map((t, k) => build(t, `${at}.machine.states[${i}].transitions[${k}]`)));
    const anyList = m.anyState.map((t, k) => build(t, `${at}.machine.anyState[${k}]`));

    // Global indices: any-state first, then each state's list.
    const ids = new Map<string, number>();
    let next = transitions.length;
    const assign = (list: Built[]) => list.filter((b) => b.ok).forEach((b) => {
      if (b.t.id) ids.set(b.t.id, next);
      next++;
    });
    assign(anyList);
    stateLists.forEach(assign);

    const write = (b: Built) => {
      const t = b.t;
      const rec: TransitionRecord = { target: local.get(t.to)!, condition: b.condition, when: 0, whenValue: 0, how: 0, duration: 0, shape: 0, bridge: NONE, mode: 0, first: 0, count: 0 };
      if (t.when === "exit") rec.when = 1;
      else if (typeof t.when === "string" && t.when.startsWith("marker:") && t.when.length > 7) {
        rec.when = 2;
        rec.whenValue = this.intern(t.when.slice(7));
      } else if (typeof t.when === "number") {
        if (isNum(t.when) && t.when >= 0 && finiteF32(t.when)) {
          rec.when = 3;
          rec.whenValue = f32Bits(t.when);
        } else this.error(`${b.path}.when`, "a normalised time must be a finite number ≥ 0; using \"now\".");
      } else if (t.when !== "now") this.error(`${b.path}.when`, `${JSON.stringify(t.when)} isn't "now", "exit", "marker:<name>" or a normalised time; using "now".`);
      let how = TRANSITION_HOWS.indexOf(t.how);
      if (how < 0) {
        this.error(`${b.path}.how`, `${JSON.stringify(t.how)} isn't a transition kind; using "crossfade".`);
        how = 0;
      }
      if (how === 3) {
        const br = t.bridge === null ? undefined : srcIndex.get(t.bridge);
        if (br === undefined) {
          // An unknown bridge was reported with the node's children.
          if (t.bridge === null) this.error(`${b.path}.bridge`, "a bridge transition needs its bridge node; using a crossfade.");
          how = 0;
        } else rec.bridge = fi(br);
      }
      rec.how = how;
      if (how !== 1) {
        let d = t.duration;
        if (!isNum(d) || d < 0 || !finiteF32(d)) {
          this.error(`${b.path}.duration`, "must be a finite number of seconds ≥ 0; using 0.2.");
          d = 0.2;
        }
        rec.duration = d;
        if (how === 0 || how === 3) {
          const shape = FADE_SHAPES.indexOf(t.shape);
          if (shape < 0) this.error(`${b.path}.shape`, `${JSON.stringify(t.shape)} isn't a fade shape (${FADE_SHAPES.join(", ")}); using linear.`);
          rec.shape = Math.max(0, shape);
        }
      }
      if (t.interrupt === "any") rec.mode = 1;
      else if (Array.isArray(t.interrupt)) {
        const list = (t.interrupt as readonly string[]).flatMap((id, k) => {
          const g = ids.get(id);
          if (g === undefined) this.error(`${b.path}.interrupt[${k}]`, `${JSON.stringify(id)} isn't a transition of this machine; dropped.`);
          return g === undefined ? [] : [g];
        });
        if (list.length) {
          rec.mode = 2;
          rec.first = interrupts.length;
          rec.count = list.length;
          interrupts.push(...list);
        }
      } else if (t.interrupt !== "never") this.error(`${b.path}.interrupt`, 'must be "never", "any" or a list of transition ids; using "never".');
      transitions.push(rec);
      this.transitionPaths.push(b.path);
    };
    const anyFirst = transitions.length;
    anyList.filter((b) => b.ok).forEach(write);
    const anyCount = transitions.length - anyFirst;
    const statesFirst = states.length;
    m.states.forEach((s, i) => {
      const first = transitions.length;
      stateLists[i].filter((b) => b.ok).forEach(write);
      const root = s.root === null ? undefined : srcIndex.get(s.root);
      states.push([this.intern(s.name), root === undefined ? empty : fi(root), first, transitions.length - first, s.exit ? STATE_EXIT : 0]);
    });
    let entry = 0;
    if (m.entry !== null) {
      const e = local.get(m.entry);
      if (e === undefined) this.error(`${at}.machine.entry`, `${JSON.stringify(m.entry)} isn't a state of this machine; using the first.`);
      else entry = e;
    }

    // Reachability from the entry (any-state transitions reach their targets from anywhere).
    const reach = new Set<number>([entry]);
    for (const b of anyList) if (b.ok) reach.add(local.get(b.t.to)!);
    for (let grew = true; grew; ) {
      grew = false;
      stateLists.forEach((list, i) => {
        if (!reach.has(i)) return;
        for (const b of list) if (b.ok && !reach.has(local.get(b.t.to)!)) (reach.add(local.get(b.t.to)!), (grew = true));
      });
    }
    m.states.forEach((s, i) => {
      if (!reach.has(i)) this.warn(`${at}.machine.states[${i}]`, `state "${s.name}" can't be reached from the entry state by any transition (only \`jump\` enters it).`);
    });
    return { record: [statesFirst, m.states.length, entry, anyFirst, anyCount], names: m.states.map((s) => s.name) };
  }

  /** A condition program's index, or null (with problems) when the condition is invalid. */
  program(c: Condition, at: string): number | null {
    const nodes: CondRecord[] = [];
    const ok = this.cond(c, at, 1, nodes);
    if (!ok) return null;
    if (nodes.length > GRAPH_LIMITS.conditionTerms) {
      this.error(at, `a condition has at most ${GRAPH_LIMITS.conditionTerms} terms.`);
      return null;
    }
    this.programs.push([this.conds.length, nodes.length]);
    this.conds.push(...nodes);
    return this.programs.length - 1;
  }

  cond(c: Condition, at: string, depth: number, out: CondRecord[]): boolean {
    if (typeof c !== "object" || c === null) return this.error(at, "a condition must be an object."), false;
    if ("all" in c || "any" in c) {
      const group = "all" in c ? "all" : "any";
      const items = (c as Record<string, readonly Condition[]>)[group];
      if (depth > GRAPH_LIMITS.conditionDepth) return this.error(at, `conditions nest at most ${GRAPH_LIMITS.conditionDepth} deep.`), false;
      if (!Array.isArray(items) || items.length === 0) return this.error(`${at}.${group}`, `an "${group}" group needs at least one condition.`), false;
      out.push({ code: group === "all" ? 0 : 1, op: 0, src: 0, operand: items.length, value: 0, path: at });
      return items.every((x, i) => this.cond(x, `${at}.${group}[${i}]`, depth + 1, out));
    }
    if (depth > GRAPH_LIMITS.conditionDepth) return this.error(at, `conditions nest at most ${GRAPH_LIMITS.conditionDepth} deep.`), false;
    const op = CMP_OPS.indexOf((c as { op: (typeof CMP_OPS)[number] }).op);
    if (op < 0) return this.error(`${at}.op`, `${JSON.stringify((c as { op: unknown }).op)} isn't one of ${CMP_OPS.join(" ")}.`), false;
    const floatValue = (v: unknown): number | null => (isNum(v) && finiteF32(v) ? f32Bits(v) : (this.error(`${at}.value`, "must be a finite number."), null));
    if ("request" in c) {
      if (!c.request) return this.error(`${at}.request`, "a request needs a name."), false;
      if (op > 1) return this.error(`${at}.op`, "a request compares with == or != only."), false;
      if (typeof c.value !== "boolean") return this.error(`${at}.value`, "a request's value is true or false."), false;
      out.push({ code: 2, op, src: 5, operand: this.intern(c.request), value: c.value ? 1 : 0, path: at });
      return true;
    }
    if ("param" in c) {
      const p = this.paramIndex.get(c.param);
      if (p === undefined) return this.error(`${at}.param`, `"${c.param}" isn't a parameter of this graph.`), false;
      const type = this.paramTypes[p];
      if (type === "bool") {
        if (op > 1) return this.error(`${at}.op`, "a bool parameter compares with == or != only."), false;
        if (typeof c.value !== "boolean") return this.error(`${at}.value`, `"${c.param}" is a bool parameter; compare it with true or false.`), false;
        out.push({ code: 2, op, src: 0, operand: p, value: c.value ? 1 : 0, path: at });
        return true;
      }
      if (type === "int") {
        if (!Number.isInteger(c.value) || Math.abs(c.value as number) > 0x7fffffff) return this.error(`${at}.value`, `"${c.param}" is an int parameter; compare it with a whole number.`), false;
        out.push({ code: 2, op, src: 0, operand: p, value: (c.value as number) >>> 0, path: at });
        return true;
      }
      if (type !== "float") return this.error(`${at}.param`, `"${c.param}" is a ${type} parameter, which isn't comparable.`), false;
      if (typeof c.value !== "number") return this.error(`${at}.value`, `"${c.param}" is a float parameter; compare it with a number.`), false;
      const v = floatValue(c.value);
      if (v === null) return false;
      out.push({ code: 2, op, src: 0, operand: p, value: v, path: at });
      return true;
    }
    if ("operand" in c) {
      const src = STATE_OPERANDS.indexOf(c.operand);
      if (src < 0) return this.error(`${at}.operand`, `must be one of ${STATE_OPERANDS.join(", ")}.`), false;
      const v = floatValue(c.value);
      if (v === null) return false;
      out.push({ code: 2, op, src: src + 1, operand: 0, value: v, path: at });
      return true;
    }
    if ("curve" in c) {
      if (!c.curve) return this.error(`${at}.curve`, "a curve needs a name."), false;
      const v = floatValue(c.value);
      if (v === null) return false;
      out.push({ code: 2, op, src: 4, operand: this.intern(c.curve), value: v, path: at });
      return true;
    }
    this.error(at, "a condition is all, any, or a comparison of a param, operand, curve or request.");
    return false;
  }
}

/** Packs one node's parameters (the catalogue's `NodePacker`). */
class Packer implements NodePacker {
  readonly words: number[] = [];
  constructor(private readonly c: Compiler, private readonly n: GraphNode, private readonly schema: NodeKindSchema, private readonly at: string, readonly inputCount: number) {}

  private s(name: string): NodeParamSchema {
    const s = this.schema.params.find((p) => p.name === name);
    if (!s) throw new Error(`the catalogue reads undeclared parameter "${name}"`);
    return s;
  }
  private raw(name: string): NodeParamValue | undefined {
    this.s(name);
    return this.n.params[name];
  }
  private path(name?: string): string {
    return name ? `${this.at}.params.${name}` : this.at;
  }
  problem(message: string, param?: string, warning = false): void {
    (warning ? this.c.warn : this.c.error).call(this.c, this.path(param), message);
  }

  push(...words: number[]): void {
    for (const w of words) this.words.push(w >>> 0);
  }
  f32(v: number): void {
    this.words.push(f32Bits(v));
  }
  has(name: string): boolean {
    return this.raw(name) !== undefined;
  }
  value(name: string): NodeParamValue | undefined {
    return this.raw(name);
  }

  private clamp(s: NodeParamSchema, v: number, what = "value"): number {
    const lo = s.min ?? -Infinity, hi = s.max ?? Infinity;
    if (v < lo || v > hi) {
      const c = Math.min(hi, Math.max(lo, v));
      this.problem(`${what} ${v} is outside ${s.min ?? "-∞"}..${s.max ?? "∞"}; using ${c}.`, s.name, true);
      return c;
    }
    return v;
  }

  num(name: string): number {
    const s = this.s(name);
    const v = this.n.params[name];
    const def = typeof s.default === "number" ? s.default : 0;
    if (v === undefined) return def;
    if (!isNum(v) || !finiteF32(v)) return this.problem(`must be a finite number; using ${def}.`, name), def;
    return this.clamp(s, v);
  }
  int(name: string): number | null {
    const s = this.s(name);
    const v = this.n.params[name];
    const def = typeof s.default === "number" ? s.default : null;
    if (v === undefined) return def;
    if (!Number.isInteger(v)) return this.problem(`must be a whole number; using ${def ?? "none"}.`, name), def;
    return this.clamp(s, v as number);
  }
  bool(name: string): boolean {
    const s = this.s(name);
    const v = this.n.params[name];
    const def = s.default === true;
    if (v === undefined) return def;
    if (typeof v !== "boolean") return this.problem(`must be true or false; using ${def}.`, name), def;
    return v;
  }
  choice(name: string): number {
    const s = this.s(name);
    const choices = s.choices ?? [];
    let v = this.n.params[name];
    if (v === undefined) return Math.max(0, choices.indexOf(String(s.default)));
    // A boolean for a loop-style choice: true → "loop", false → "once".
    if (typeof v === "boolean" && choices.includes("loop") && choices.includes("once")) v = v ? "loop" : "once";
    const i = typeof v === "string" ? choices.indexOf(v) : -1;
    if (i < 0) {
      const def = Math.max(0, choices.indexOf(String(s.default)));
      this.problem(`${JSON.stringify(v)} isn't one of ${choices.join(", ")}; using "${choices[def]}".`, name);
      return def;
    }
    return i;
  }
  vec(name: string): number[] {
    const s = this.s(name);
    const width = s.kind === "vec2" ? 2 : s.kind === "vec3" ? 3 : 4;
    const def = Array.isArray(s.default) ? (s.default as number[]) : new Array<number>(width).fill(0);
    const v = this.n.params[name];
    if (v === undefined) return def;
    if (!Array.isArray(v) || v.length !== width || !v.every((x) => isNum(x) && finiteF32(x))) return this.problem(`must be ${width} finite numbers; using ${JSON.stringify(def)}.`, name), def;
    return v as number[];
  }
  animated(name: string): [number, number] {
    const s = this.s(name);
    const v = this.n.params[name];
    if (typeof v === "string") return [typeof s.default === "number" ? s.default : 0, this.paramRef(s, v)];
    return [this.num(name), NONE];
  }
  private paramRef(s: NodeParamSchema, v: string, what = ""): number {
    if (v === "") return NONE;
    const i = this.c.paramIndex.get(v);
    if (i === undefined) return this.problem(`${what}"${v}" isn't a parameter of this graph; none.`, s.name), NONE;
    const types = s.parameterTypes ?? [];
    if (types.length && !types.includes(this.c.paramTypes[i])) return this.problem(`${what}"${v}" is a ${this.c.paramTypes[i]} parameter; this takes ${types.join(" or ")}. None.`, s.name), NONE;
    return i;
  }
  parameter(name: string): number {
    const s = this.s(name);
    const v = this.n.params[name];
    if (v === undefined) return NONE;
    if (typeof v !== "string") return this.problem("must name a graph parameter; none.", name), NONE;
    return this.paramRef(s, v);
  }
  asset(name: string): number {
    const s = this.s(name);
    const v = this.n.params[name];
    if (v === undefined || v === "") return NONE;
    if (typeof v !== "string") return this.problem("must be an asset reference; none.", name), NONE;
    return this.c.assetRef(v, s.asset!, this.path(name));
  }
  name(name: string): number {
    const v = this.raw(name);
    if (v === undefined || v === "") return NONE;
    if (typeof v !== "string") return this.problem("must be a name; none.", name), NONE;
    return this.c.intern(v);
  }
  texts(name: string): string[] {
    const v = this.raw(name);
    return Array.isArray(v) ? v.map(String) : [];
  }
  layerIndex(name: string): number {
    const v = this.raw(name);
    if (v === undefined || v === "") return NONE;
    const i = typeof v === "string" ? this.c.g.layers.findIndex((l) => l.name === v) : -1;
    if (i < 0) return this.problem(`${JSON.stringify(v)} isn't a layer of this graph; none.`, name), NONE;
    return i;
  }
  boneByName(name: string, param?: string): number {
    const role = HUMANOID_ROLES.indexOf(name);
    if (role >= 0) return (ROLE | role) >>> 0;
    const bone = this.c.options.bones?.indexOf(name) ?? -1;
    if (bone >= 0) return bone;
    this.problem(`"${name}" isn't a Humanoid role${this.c.options.bones ? " or a bone of the skeleton" : " (bone names need the skeleton)"}; none.`, param);
    return NONE;
  }
  private boneValue(v: unknown, param: string): number {
    if (typeof v === "number") {
      if (Number.isInteger(v) && v >= 0 && v < 0xffff) return v;
      return this.problem(`${v} isn't a bone index; none.`, param), NONE;
    }
    if (typeof v === "string" && v !== "") return this.boneByName(v, param);
    return NONE;
  }
  bone(name: string): number {
    const v = this.raw(name);
    if (v === undefined) return NONE;
    if (typeof v !== "number" && typeof v !== "string") return this.problem("must be a bone index or name; none.", name), NONE;
    return this.boneValue(v, name);
  }
  private targetValue(v: string, param: string): number {
    if (v === "") return NONE;
    let i = this.c.ikTargets.indexOf(v);
    if (i < 0) {
      if (this.c.ikTargets.length >= MAX_TARGETS) return this.problem(`an instance has ${MAX_TARGETS} IK target slots; "${v}" gets none.`, param), NONE;
      i = this.c.ikTargets.push(v) - 1;
    }
    return i;
  }
  target(name: string): number {
    const v = this.raw(name);
    if (v === undefined) return NONE;
    if (typeof v !== "string") return this.problem("must name an IK target; none.", name), NONE;
    return this.targetValue(v, name);
  }
  rays(n: number): number {
    const first = this.c.rays;
    if (first + n > MAX_RAYS) {
      this.problem(`the grounders need ${first + n} ray rows; an instance has ${MAX_RAYS}.`);
      return Math.max(0, MAX_RAYS - n);
    }
    this.c.rays += n;
    return first;
  }
  list(name: string): number[] {
    const s = this.s(name);
    let v = this.n.params[name];
    if (v === undefined) return [];
    if (!Array.isArray(v)) return this.problem("must be a list; none.", name), [];
    if (s.maxItems !== undefined && v.length > s.maxItems) {
      this.problem(`has ${v.length} entries, at most ${s.maxItems}; the rest are dropped.`, name);
      v = v.slice(0, s.maxItems) as typeof v;
    }
    const items = v as readonly (number | string)[];
    switch (s.kind) {
      case "floatList":
        return items.map((x, i) => (isNum(x) && finiteF32(x) ? f32Bits(this.clamp(s, x, `entry ${i}`)) : (this.problem(`entry ${i} must be a finite number; using 0.`, name), 0)));
      case "intList":
        return items.map((x, i) => {
          if (typeof x === "string" && name.endsWith("Tags")) return this.tag(x, i, name);
          if (!Number.isInteger(x)) return this.problem(`entry ${i} must be a whole number; using 0.`, name), 0;
          return this.clamp(s, x as number, `entry ${i}`) >>> 0;
        });
      case "boneList":
        return items.map((x) => this.boneValue(x, name));
      case "targetList":
        return items.map((x) => this.targetValue(String(x), name));
      case "parameterList":
        return items.map((x, i) => (typeof x === "string" ? this.paramRef(s, x, `entry ${i}: `) : (this.problem(`entry ${i} must name a parameter; none.`, name), NONE)));
      case "nameList":
        return items.map((x) => (x === "" ? NONE : this.c.intern(String(x))));
      default:
        throw new Error(`"${name}" isn't a list parameter`);
    }
  }
  private tag(t: string, i: number, param: string): number {
    const db = this.schema.params.some((p) => p.name === "database") && typeof this.n.params.database === "string" ? (this.n.params.database as string) : null;
    const tags = this.c.options.poseDatabaseTags?.(db);
    const k = tags?.indexOf(t) ?? -1;
    if (k < 0) return this.problem(`entry ${i}: tag "${t}" ${tags ? "isn't one of the database's tags" : "needs the database's tag names"}; dropped.`, param), NONE;
    return k;
  }
}
