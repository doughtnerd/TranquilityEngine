/**
 * Animation graphs (ADR 0372 "The graph"): parse and write `*.animgraph.json`, format `myco.animgraph-source@1`. The
 * graph compiler (T30) lowers one to `myco.animgraph@1` (`anim-format/src/graph.rs`); the graph editor (T51) edits it.
 *
 * # Schema
 *
 * ```jsonc
 * {
 *   "format": "myco.animgraph-source@1",
 *   "name": "Locomotion",                        // default ""
 *   "skeleton": "asset:models/hero.glb#Skeleton", // default none
 *   "output": "root",                            // the node whose pose the graph outputs (default none)
 *   "parameters": [                              // the blackboard (≤ 64): PARAMS
 *     { "name": "speed", "type": "float", "default": 0, "replicate": true, "predicted": true },
 *     { "name": "canVault", "type": "bool", "computed": true }   // filled by `anim.compute` in Gather
 *   ],
 *   "nodes": [                                   // NODES: id unique; family + kind (GRAPH_NODE_KINDS); inputs by id
 *     { "id": "walk", "family": "sources", "kind": "clipPlayer", "params": { "clip": "asset:clips/walk.anim.json", "speed": 1 } },
 *     { "id": "move", "family": "sources", "kind": "blendSpace1D", "inputs": ["walk", "run"], "params": { "x": "speed", "coords": [1.5, 4], "sync": true } },
 *     { "id": "feet", "family": "sync", "kind": "syncGroup", "inputs": ["move"] },              // a sync group: members follow the leader by markers
 *     { "id": "loco", "family": "logic", "kind": "stateMachine", "name": "Base", "machine": {
 *         "entry": "Idle",
 *         "states": [
 *           { "name": "Idle", "root": "idle", "transitions": [
 *               { "id": "go", "to": "Move", "if": { "all": [{ "param": "speed", "op": ">", "value": 0.1 }] },
 *                 "when": "now", "how": "crossfade", "duration": 0.2, "shape": "smoothstep" } ] },
 *           { "name": "Move", "root": "feet", "transitions": [
 *               { "to": "Idle", "if": { "any": [{ "param": "speed", "op": "<=", "value": 0.1 }, { "request": "Stop" }] },
 *                 "when": "exit", "how": "bridge", "bridge": "stopClip", "duration": 0.1, "interrupt": ["go"] } ] },
 *           { "name": "Done", "root": null, "exit": true }
 *         ],
 *         "anyState": [{ "to": "Idle", "if": { "param": "dead", "op": "==", "value": true }, "how": "cut" }]
 *     } },
 *     { "id": "pick", "family": "logic", "kind": "chooser", "chooser": {
 *         "rows": [{ "if": { "param": "armed", "op": "==", "value": true }, "result": "armedIdle" }], "fallback": "idle" } },
 *     { "id": "upper", "family": "slots", "kind": "slot", "slot": { "name": "UpperBody", "group": "Actions" } },
 *     { "id": "weapon", "family": "slots", "kind": "linked", "linked": { "name": "Weapon", "graph": "asset:graphs/sword.animgraph.json" } }
 *   ],
 *   "layers": [                                  // LAYERS: named by `anim.layerWeight`
 *     { "name": "UpperBody", "root": "upper", "mask": "asset:masks/upper.mask.json", "mode": "override", "weight": 1, "weightParameter": "aim" }
 *   ]
 * }
 * ```
 *
 * - **Nodes.** `family` is one of `GRAPH_FAMILIES` (`anim-format`'s `family` ids) and `kind` one of that family's
 *   `GRAPH_NODE_KINDS` (index = the `u16` kind id the core dispatches on). `params` is the node's typed parameter map
 *   (numbers, booleans, strings, lists of numbers or of strings): the node catalogue (ADR 0372 "One node catalogue")
 *   gives each name its meaning, and the compiler packs them into the node's parameter block. A string starting with
 *   `asset:` is an asset reference (a clip player's clip, a pose database); other strings name parameters, bones or
 *   values. `name` is the debug name, `position` the graph editor's `[x, y]`.
 * - **State machines** (`logic`/`stateMachine`) carry `machine`: states by unique name, `entry` (default: the first
 *   state), and per state its sub-graph's root node (null until one is assigned), `exit` (an exit state) and its
 *   transitions in **priority order, highest first**. `anyState` transitions are checked before the state's own.
 * - **Transitions:** `to` (a state of the same machine); `if`, a structured condition (absent: always); `when` (D53,
 *   audio's Switch words): `"now"` (default), `"exit"`, `"marker:<name>"` or a normalised time (a number ≥ 0); `how`:
 *   `"crossfade"` (default), `"cut"`, `"inertialize"` or `"bridge"` (through `bridge`, a node, entering the target at
 *   its exit marker or end); `duration` in seconds (default 0.2; a cut has none); `shape`, the fade shape (D53:
 *   `linear`, `smoothstep`, `easeIn`, `easeOut`; default linear); `interrupt`: `"never"` (default), `"any"`, or the
 *   ids of the transitions (of this machine) that may interrupt it. `id` names a transition for interrupt lists.
 * - **Conditions** are `{ "all": [...] }`, `{ "any": [...] }` (non-empty, nested at most 16 deep, the root counting) or
 *   a comparison: `{ "param": name, "op", "value" }` (float and int parameters compare numbers, bool parameters `==`
 *   or `!=` a boolean; vectors, quaternions and nodes don't compare), `{ "operand": "stateTime" | "normalizedTime" |
 *   "syncPhase", "op", "value" }`, `{ "curve": name, "op", "value" }`, or `{ "request": name }` (live and consumed by
 *   the transition; `"op": "!="` or `"value": false` negates). `op` is one of `== != < <= > >=` (default `==`).
 * - **Choosers** (`logic`/`chooser`): rows tried in order, `{ if, result }`, then `fallback` (a node or null).
 * - **Slots** (`slots`/`slot`): `slot.name` (what `anim.play(…, { slot })` names) and an optional `group`. **Linked
 *   graphs** (`slots`/`linked`): `linked.name` (what `anim.link` names) and the default `graph`.
 * - **Layers:** `root` (a node), `mask` (an avatar mask; none: full body), `mode` (`override` default, `additive`),
 *   `weight` (0..1, default 1) and `weightParameter` (a float parameter driving it, default none).
 * - **Sync groups** are `sync`/`syncGroup` nodes over the members' sub-graph (D20), and blend spaces' `sync` param.
 * - Every reference to a node, state, transition or parameter is checked: one that names nothing is dropped with a
 *   problem. Cycles are the compiler's to refuse (it walks the DAG anyway). Limits are `GRAPH_LIMITS`, declared once.
 *
 * Pure; no plugin, no DOM. Internal: not public API.
 */
import { compact, IdScope, isFiniteNumber, isRecord, jsonText, LenientReader, limited, readRef, readRoot, referencePaths, withPath, type FormatParse, type JsonRecord } from "./shared";

/** @internal The format name. */
export const ANIM_GRAPH_FORMAT = "myco.animgraph-source@1";
/** @internal The file ending. */
export const ANIM_GRAPH_SUFFIX = ".animgraph.json";

/** @internal Limits of a graph, declared once (ADR 0306, 0371 "References and limits"). */
export const GRAPH_LIMITS = Object.freeze({
  nodes: 4096,
  /** Inputs of one node. */
  inputs: 64,
  /** Entries of one node's parameter map. */
  nodeParams: 64,
  /** The blackboard's parameters per row (the core's `BLACKBOARD_PARAMS`). */
  parameters: 64,
  /** States of one machine. */
  states: 256,
  /** Transitions of one state, and any-state transitions of one machine. */
  transitions: 64,
  /** Transitions allowed to interrupt one transition. */
  interrupters: 64,
  /** How deep a condition nests (`MAX_CONDITION_DEPTH`; the root counts as 1). */
  conditionDepth: 16,
  /** Comparisons and groups in one condition. */
  conditionTerms: 64,
  layers: 32,
  chooserRows: 256,
});

/** @internal Node families, in `anim-format`'s `family` id order. */
export const GRAPH_FAMILIES = ["sources", "logic", "mixing", "slots", "sync", "rig", "retarget", "matching", "physics", "plugin"] as const;
export type GraphFamily = (typeof GRAPH_FAMILIES)[number];

/** @internal Each family's node kinds; a kind's index is its `u16` id in `anim-graph` (`<family>.rs`'s `kind` module). */
export const GRAPH_NODE_KINDS = Object.freeze({
  sources: ["clipPlayer", "blendSpace1D", "blendSpace2D", "poseSnapshot", "referencePose", "bindPose"],
  logic: ["stateMachine", "random", "chooser"],
  mixing: ["blend2", "crossfade", "layer", "inertialize", "blendEnum", "blendBool", "additive", "timeScale", "mirror"],
  slots: ["slot", "linked"],
  sync: ["syncGroup", "notifyGate"],
  rig: ["twoBoneIk", "ccd", "fabrik", "fullBodyIk", "lookAt", "aim", "grounder", "springChain", "copy", "limitRotation", "limitPosition", "damp", "strideWarp", "orientationWarp", "motionWarp", "distanceMatch"],
  retarget: ["retarget"],
  matching: ["poseDatabase", "matchTags"],
  physics: ["physicalPose", "physicsBlend"],
  plugin: ["plugin"],
} as const satisfies Record<GraphFamily, readonly string[]>);

/** @internal Parameter types, in `ParamType` id order. */
export const GRAPH_PARAM_TYPES = ["float", "int", "bool", "vec2", "vec3", "quat", "node"] as const;
export type GraphParamType = (typeof GRAPH_PARAM_TYPES)[number];
/** @internal Comparison operators, in `CmpOp` id order. */
export const CMP_OPS = ["==", "!=", "<", "<=", ">", ">="] as const;
export type CmpOp = (typeof CMP_OPS)[number];
/** @internal The operands that aren't parameters, curves or requests (`OperandSource` 1..3). */
export const STATE_OPERANDS = ["stateTime", "normalizedTime", "syncPhase"] as const;
export type StateOperand = (typeof STATE_OPERANDS)[number];
/** @internal How a transition blends, in `HowKind` id order. */
export const TRANSITION_HOWS = ["crossfade", "cut", "inertialize", "bridge"] as const;
export type TransitionHow = (typeof TRANSITION_HOWS)[number];
/** @internal Fade shapes, ids 0..3 (D53). */
export const FADE_SHAPES = ["linear", "smoothstep", "easeIn", "easeOut"] as const;
export type FadeShape = (typeof FADE_SHAPES)[number];
/** @internal Layer modes, in `LayerMode` id order. */
export const LAYER_MODES = ["override", "additive"] as const;
export type LayerMode = (typeof LAYER_MODES)[number];

/** @internal The default crossfade, inertialize and bridge duration, seconds. */
export const DEFAULT_TRANSITION_DURATION = 0.2;

/** @internal A parameter's default value: float/int a number, bool a boolean, vec2/vec3/quat numbers, node a node path or null. */
export type GraphParamValue = number | boolean | readonly number[] | string | null;
export interface GraphParameter {
  readonly name: string;
  readonly type: GraphParamType;
  readonly default: GraphParamValue;
  readonly replicate: boolean;
  readonly predicted: boolean;
  readonly computed: boolean;
}

/** @internal A value in a node's parameter map. */
export type NodeParamValue = number | boolean | string | readonly number[] | readonly string[];

/** @internal A comparison or a group. */
export type Condition =
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly param: string; readonly op: CmpOp; readonly value: number | boolean }
  | { readonly operand: StateOperand; readonly op: CmpOp; readonly value: number }
  | { readonly curve: string; readonly op: CmpOp; readonly value: number }
  | { readonly request: string; readonly op: "==" | "!="; readonly value: boolean };

/** @internal When a transition may fire: `"now"`, `"exit"`, `"marker:<name>"` or a normalised time. */
export type TransitionWhen = "now" | "exit" | `marker:${string}` | number;

export interface Transition {
  /** Names it for interrupt lists ("" for none). */
  readonly id: string;
  readonly to: string;
  readonly if: Condition | null;
  readonly when: TransitionWhen;
  readonly how: TransitionHow;
  /** Seconds (0 for a cut). */
  readonly duration: number;
  readonly shape: FadeShape;
  /** The bridge node (`how: "bridge"`), else null. */
  readonly bridge: string | null;
  readonly interrupt: "never" | "any" | readonly string[];
}
export interface MachineState {
  readonly name: string;
  readonly root: string | null;
  readonly exit: boolean;
  readonly transitions: readonly Transition[];
  readonly position?: readonly [number, number];
}
export interface StateMachine {
  readonly entry: string | null;
  readonly states: readonly MachineState[];
  readonly anyState: readonly Transition[];
}
export interface ChooserTable {
  readonly rows: readonly { readonly if: Condition; readonly result: string }[];
  readonly fallback: string | null;
}

/** @internal One node. The side-table members appear on their kinds only. */
export interface GraphNode {
  readonly id: string;
  readonly family: GraphFamily;
  readonly kind: string;
  readonly name: string;
  readonly position?: readonly [number, number];
  readonly inputs: readonly string[];
  readonly params: Readonly<Record<string, NodeParamValue>>;
  readonly machine?: StateMachine;
  readonly chooser?: ChooserTable;
  readonly slot?: { readonly name: string; readonly group: string | null };
  readonly linked?: { readonly name: string; readonly graph: string | null };
}
export interface GraphLayer {
  readonly name: string;
  readonly root: string;
  readonly mask: string | null;
  readonly mode: LayerMode;
  readonly weight: number;
  readonly weightParameter: string | null;
}
/** @internal An animation graph. */
export interface AnimGraph {
  readonly format: typeof ANIM_GRAPH_FORMAT;
  readonly name: string;
  readonly skeleton: string | null;
  readonly output: string | null;
  readonly parameters: readonly GraphParameter[];
  readonly nodes: readonly GraphNode[];
  readonly layers: readonly GraphLayer[];
}

/** @internal A new graph: no parameters, no nodes. */
export const emptyAnimGraph = (): AnimGraph => ({ format: ANIM_GRAPH_FORMAT, name: "", skeleton: null, output: null, parameters: [], nodes: [], layers: [] });

/** @internal The family a kind belongs to, or undefined. */
export function familyOfKind(kind: string): GraphFamily | undefined {
  return GRAPH_FAMILIES.find((f) => (GRAPH_NODE_KINDS[f] as readonly string[]).includes(kind));
}

/** @internal A parameter type's default value. */
export function defaultParamValue(type: GraphParamType): GraphParamValue {
  switch (type) {
    case "float": case "int": return 0;
    case "bool": return false;
    case "vec2": return [0, 0];
    case "vec3": return [0, 0, 0];
    case "quat": return [0, 0, 0, 1];
    case "node": return null;
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const L = GRAPH_LIMITS;

class GraphReader {
  readonly r: LenientReader;
  /** Node ids the file defines, collected before any node is read so references can go forward. */
  nodeIds = new Set<string>();
  paramTypes = new Map<string, GraphParamType>();
  constructor(problems: string[]) {
    this.r = new LenientReader(problems);
  }

  parameter(raw: unknown, at: string): GraphParameter | null {
    const r = this.r;
    if (!isRecord(raw)) return r.problem(at, "a parameter must be an object; dropped."), null;
    if (typeof raw.name !== "string" || !NAME.test(raw.name)) return r.problem(`${at}.name`, "a parameter needs a name (letters, digits, _ and ., not starting with a digit); dropped."), null;
    if (this.paramTypes.has(raw.name)) return r.problem(`${at}.name`, `parameter "${raw.name}" is already defined; dropped.`), null;
    if (raw.type === undefined) r.problem(`${at}.type`, `missing; using "float".`);
    const type = r.pick(raw.type, `${at}.type`, GRAPH_PARAM_TYPES, "float");
    const def = defaultParamValue(type);
    let value: GraphParamValue = def;
    const d = raw.default;
    if (d !== undefined) {
      const width = type === "vec2" ? 2 : type === "vec3" ? 3 : type === "quat" ? 4 : 0;
      const ok = type === "float" ? isFiniteNumber(d)
        : type === "int" ? Number.isInteger(d) && Math.abs(d as number) <= 0x7fffffff
        : type === "bool" ? typeof d === "boolean"
        : type === "node" ? d === null || typeof d === "string"
        : Array.isArray(d) && d.length === width && d.every(isFiniteNumber);
      if (ok) value = Array.isArray(d) ? d.map((v: number) => v + 0) : typeof d === "number" ? d + 0 : d === "" ? null : (d as GraphParamValue);
      else r.problem(`${at}.default`, `isn't a ${type} value; using ${JSON.stringify(def)}.`);
    }
    this.paramTypes.set(raw.name, type);
    return { name: raw.name, type, default: value, replicate: r.bool(raw.replicate, `${at}.replicate`, false), predicted: r.bool(raw.predicted, `${at}.predicted`, false), computed: r.bool(raw.computed, `${at}.computed`, false) };
  }

  /** A node id reference: one the file defines, or null with a problem (absent/null: null, silently). */
  nodeRef(raw: unknown, at: string): string | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string" || !this.nodeIds.has(raw)) {
      this.r.problem(at, `${JSON.stringify(raw)} isn't a node of this graph; none.`);
      return null;
    }
    return raw;
  }

  position(raw: unknown, at: string): readonly [number, number] | undefined {
    if (raw === undefined) return undefined;
    if (Array.isArray(raw) && raw.length === 2 && raw.every(isFiniteNumber)) return [raw[0] + 0, raw[1] + 0];
    this.r.problem(at, "must be [x, y]; dropped.");
    return undefined;
  }

  /** A condition; null when nothing usable is left (with the problems that dropped it). `terms` counts across one condition. */
  condition(raw: unknown, at: string, depth: number, terms: { n: number }): Condition | null {
    const r = this.r;
    if (!isRecord(raw)) return r.problem(at, "a condition must be an object; dropped."), null;
    if (++terms.n > L.conditionTerms) return r.problem(at, `a condition has at most ${L.conditionTerms} terms; dropped.`), null;
    const group = raw.all !== undefined ? "all" : raw.any !== undefined ? "any" : null;
    if (group) {
      if (depth >= L.conditionDepth) return r.problem(at, `conditions nest at most ${L.conditionDepth} deep; dropped.`), null;
      const items = r.list(raw[group], `${at}.${group}`).map((c, i) => this.condition(c, `${at}.${group}[${i}]`, depth + 1, terms)).filter((c): c is Condition => c !== null);
      if (items.length === 0) return r.problem(at, `an "${group}" group needs at least one condition; dropped.`), null;
      return group === "all" ? { all: items } : { any: items };
    }
    const op = (fallback: CmpOp = "==") => r.pick(raw.op, `${at}.op`, CMP_OPS, fallback);
    const num = (): number | null => (isFiniteNumber(raw.value) ? raw.value + 0 : (r.problem(`${at}.value`, "must be a number; the comparison is dropped."), null));
    if (typeof raw.request === "string" && raw.request !== "") {
      const o = op();
      if (o !== "==" && o !== "!=") return r.problem(`${at}.op`, "a request compares with == or != only; dropped."), null;
      if (raw.value !== undefined && typeof raw.value !== "boolean") return r.problem(`${at}.value`, "a request's value is true or false; dropped."), null;
      return { request: raw.request, op: o, value: raw.value === undefined ? true : raw.value };
    }
    if (typeof raw.param === "string") {
      const type = this.paramTypes.get(raw.param);
      if (!type) return r.problem(`${at}.param`, `"${raw.param}" isn't a parameter of this graph; the comparison is dropped.`), null;
      if (type === "bool") {
        const o = op();
        if (o !== "==" && o !== "!=") return r.problem(`${at}.op`, "a bool parameter compares with == or != only; dropped."), null;
        if (typeof raw.value !== "boolean") return r.problem(`${at}.value`, "must be true or false for a bool parameter; dropped."), null;
        return { param: raw.param, op: o, value: raw.value };
      }
      if (type !== "float" && type !== "int") return r.problem(`${at}.param`, `a ${type} parameter isn't comparable; dropped.`), null;
      const o = op();
      const v = num();
      if (v === null) return null;
      if (type === "int" && !Number.isInteger(v)) return r.problem(`${at}.value`, "must be a whole number for an int parameter; dropped."), null;
      return { param: raw.param, op: o, value: v };
    }
    if (raw.operand !== undefined) {
      if (typeof raw.operand !== "string" || !(STATE_OPERANDS as readonly string[]).includes(raw.operand)) return r.problem(`${at}.operand`, `must be one of ${STATE_OPERANDS.join(", ")}; dropped.`), null;
      const o = op();
      const v = num();
      return v === null ? null : { operand: raw.operand as StateOperand, op: o, value: v };
    }
    if (typeof raw.curve === "string" && raw.curve !== "") {
      const o = op();
      const v = num();
      return v === null ? null : { curve: raw.curve, op: o, value: v };
    }
    r.problem(at, "a condition is all, any, or a comparison of a param, operand, curve or request; dropped.");
    return null;
  }

  optCondition(raw: unknown, at: string): Condition | null {
    return raw === undefined || raw === null ? null : this.condition(raw, at, 1, { n: 0 });
  }

  transition(raw: unknown, at: string, states: ReadonlySet<string>): (Transition & { interruptRaw?: unknown }) | null {
    const r = this.r;
    if (!isRecord(raw)) return r.problem(at, "a transition must be an object; dropped."), null;
    if (typeof raw.to !== "string" || !states.has(raw.to)) return r.problem(`${at}.to`, `${JSON.stringify(raw.to)} isn't a state of this machine; the transition is dropped.`), null;
    let when: TransitionWhen = "now";
    const w = raw.when;
    if (w !== undefined) {
      if (w === "now" || w === "exit") when = w;
      else if (typeof w === "string" && w.startsWith("marker:") && w.length > 7) when = w as `marker:${string}`;
      else if (isFiniteNumber(w) && w >= 0) when = w + 0;
      else r.problem(`${at}.when`, 'must be "now", "exit", "marker:<name>" or a normalised time ≥ 0; using "now".');
    }
    let how = r.pick(raw.how, `${at}.how`, TRANSITION_HOWS, "crossfade");
    let bridge: string | null = null;
    if (how === "bridge") {
      bridge = this.nodeRef(raw.bridge, `${at}.bridge`);
      if (bridge === null) {
        r.problem(`${at}.bridge`, 'a bridge transition must name its bridge node; using "crossfade".');
        how = "crossfade";
      }
    } else if (raw.bridge !== undefined) r.problem(`${at}.bridge`, `only a bridge transition has a bridge node; dropped.`);
    let duration = 0;
    if (how === "cut") {
      if (raw.duration !== undefined && raw.duration !== 0) r.problem(`${at}.duration`, "a cut has no duration; dropped.");
    } else duration = r.num(raw.duration, `${at}.duration`, DEFAULT_TRANSITION_DURATION, 0, 60);
    const shape = r.pick(raw.shape, `${at}.shape`, FADE_SHAPES, "linear");
    const id = typeof raw.id === "string" ? raw.id : "";
    if (raw.id !== undefined && typeof raw.id !== "string") r.problem(`${at}.id`, "must be a string; dropped.");
    return { id, to: raw.to, if: this.optCondition(raw.if, `${at}.if`), when, how, duration, shape, bridge, interrupt: "never", interruptRaw: raw.interrupt };
  }

  machine(raw: unknown, at: string): StateMachine {
    const r = this.r;
    const o = r.record(raw, at) ?? {};
    const names = new Set<string>();
    const stateRaws: [JsonRecord, string][] = [];
    limited(r, o.states, `${at}.states`, L.states, "states").forEach((s, i) => {
      const sa = `${at}.states[${i}]`;
      if (!isRecord(s)) return r.problem(sa, "a state must be an object; dropped.");
      if (typeof s.name !== "string" || s.name === "") return r.problem(`${sa}.name`, "a state needs a name; dropped.");
      if (names.has(s.name)) return r.problem(`${sa}.name`, `state "${s.name}" is already defined; dropped.`);
      names.add(s.name);
      stateRaws.push([s, sa]);
    });
    // Transitions and their ids first (interrupt lists name any transition of the machine), then the lists.
    const ids = new Set<string>();
    const readList = (list: unknown, la: string): (Transition & { interruptRaw?: unknown; at: string })[] =>
      limited(r, list, la, L.transitions, "transitions").map((t, k) => {
        const ta = `${la}[${k}]`;
        const tr = this.transition(t, ta, names);
        if (!tr) return null;
        let id = tr.id;
        if (id !== "" && ids.has(id)) {
          r.problem(`${ta}.id`, `transition id "${id}" is used twice; dropped.`);
          id = "";
        }
        if (id !== "") ids.add(id);
        return { ...tr, id, at: ta };
      }).filter((t): t is Transition & { interruptRaw?: unknown; at: string } => t !== null);
    const anyRaw = readList(o.anyState, `${at}.anyState`);
    const stateLists = stateRaws.map(([s, sa]) => readList(s.transitions, `${sa}.transitions`));
    const finish = (t: Transition & { interruptRaw?: unknown; at: string }): Transition => {
      const { interruptRaw: ir, at: ta, ...rest } = t;
      let interrupt: Transition["interrupt"] = "never";
      if (ir === "any" || ir === "never") interrupt = ir;
      else if (Array.isArray(ir)) {
        const list = ir.slice(0, L.interrupters).filter((x, k) => {
          const ok = typeof x === "string" && ids.has(x) && x !== rest.id;
          if (!ok) r.problem(`${ta}.interrupt[${k}]`, `${JSON.stringify(x)} isn't another transition of this machine; dropped.`);
          return ok;
        }) as string[];
        if (ir.length > L.interrupters) r.problem(`${ta}.interrupt`, `at most ${L.interrupters} transitions; the rest are dropped.`);
        interrupt = [...new Set(list)];
      } else if (ir !== undefined) r.problem(`${ta}.interrupt`, 'must be "never", "any" or a list of transition ids; using "never".');
      return { ...rest, interrupt };
    };
    const states: MachineState[] = stateRaws.map(([s, sa], i) => {
      const position = this.position(s.position, `${sa}.position`);
      return { name: s.name as string, root: this.nodeRef(s.root, `${sa}.root`), exit: r.bool(s.exit, `${sa}.exit`, false), transitions: stateLists[i].map(finish), ...(position ? { position } : {}) };
    });
    let entry: string | null = states[0]?.name ?? null;
    if (o.entry !== undefined) {
      if (typeof o.entry === "string" && names.has(o.entry)) entry = o.entry;
      else r.problem(`${at}.entry`, `${JSON.stringify(o.entry)} isn't a state of this machine; using ${JSON.stringify(entry)}.`);
    }
    return { entry, states, anyState: anyRaw.map(finish) };
  }

  chooser(raw: unknown, at: string): ChooserTable {
    const r = this.r;
    const o = r.record(raw, at) ?? {};
    const rows: { if: Condition; result: string }[] = [];
    limited(r, o.rows, `${at}.rows`, L.chooserRows, "rows").forEach((row, i) => {
      const ra = `${at}.rows[${i}]`;
      if (!isRecord(row)) return r.problem(ra, "a row must be an object; dropped.");
      const result = this.nodeRef(row.result, `${ra}.result`);
      if (result === null) return r.problem(`${ra}.result`, "a row must name its result node; dropped.");
      const cond = this.condition(row.if, `${ra}.if`, 1, { n: 0 });
      if (cond === null) return r.problem(ra, "a row needs a condition; dropped.");
      rows.push({ if: cond, result });
    });
    return { rows, fallback: this.nodeRef(o.fallback, `${at}.fallback`) };
  }

  nodeParams(raw: unknown, at: string): Record<string, NodeParamValue> {
    const r = this.r;
    const o = r.record(raw, at);
    const out: Record<string, NodeParamValue> = {};
    if (!o) return out;
    const keys = Object.keys(o);
    if (keys.length > L.nodeParams) r.problem(at, `at most ${L.nodeParams} parameters; the rest are dropped.`);
    for (const k of keys.slice(0, L.nodeParams)) {
      const v = o[k];
      if (isFiniteNumber(v)) out[k] = v + 0;
      else if (typeof v === "boolean" || typeof v === "string") out[k] = v;
      else if (Array.isArray(v) && (v.every(isFiniteNumber) || v.every((x) => typeof x === "string"))) out[k] = v.map((x: number | string) => (typeof x === "number" ? x + 0 : x)) as NodeParamValue;
      else r.problem(`${at}.${k}`, "a node parameter is a number, true/false, a string, or a list of numbers or of strings; dropped.");
    }
    return out;
  }

  node(raw: JsonRecord, at: string, id: string): GraphNode | null {
    const r = this.r;
    const family = familyOfKind(typeof raw.kind === "string" ? raw.kind : "");
    if (!family) return r.problem(`${at}.kind`, `${JSON.stringify(raw.kind)} isn't a node kind; the node is dropped.`), null;
    if (raw.family !== family) r.problem(`${at}.family`, `${JSON.stringify(raw.kind)} is a "${family}" node${raw.family === undefined ? "" : `, not ${JSON.stringify(raw.family)}`}; using "${family}".`);
    const kind = raw.kind as string;
    const inputs: string[] = [];
    limited(r, raw.inputs, `${at}.inputs`, L.inputs, "inputs").forEach((x, i) => {
      const ref = this.nodeRef(x, `${at}.inputs[${i}]`);
      if (ref === id) r.problem(`${at}.inputs[${i}]`, "a node can't be its own input; dropped.");
      else if (ref !== null) inputs.push(ref);
    });
    const position = this.position(raw.position, `${at}.position`);
    const node: GraphNode = { id, family, kind, name: r.str(raw.name, `${at}.name`, ""), ...(position ? { position } : {}), inputs, params: this.nodeParams(raw.params, `${at}.params`) };
    if (kind === "stateMachine") return { ...node, machine: this.machine(raw.machine, `${at}.machine`) };
    if (kind === "chooser") return { ...node, chooser: this.chooser(raw.chooser, `${at}.chooser`) };
    if (kind === "slot" || kind === "linked") {
      const o = r.record(raw[kind], `${at}.${kind}`) ?? {};
      let name = r.str(o.name, `${at}.${kind}.name`, "");
      if (name === "") {
        name = id;
        r.problem(`${at}.${kind}.name`, `a ${kind === "slot" ? "slot" : "linked graph"} needs a name; using "${id}".`);
      }
      return kind === "slot"
        ? { ...node, slot: { name, group: r.strOrNull(o.group, `${at}.slot.group`, null) || null } }
        : { ...node, linked: { name, graph: readRef(r, o.graph, `${at}.linked.graph`) } };
    }
    return node;
  }

  layer(raw: unknown, at: string, names: Set<string>): GraphLayer | null {
    const r = this.r;
    if (!isRecord(raw)) return r.problem(at, "a layer must be an object; dropped."), null;
    if (typeof raw.name !== "string" || raw.name === "") return r.problem(`${at}.name`, "a layer needs a name; dropped."), null;
    if (names.has(raw.name)) return r.problem(`${at}.name`, `layer "${raw.name}" is already defined; dropped.`), null;
    const root = this.nodeRef(raw.root, `${at}.root`);
    if (root === null) return r.problem(`${at}.root`, "a layer must name its root node; dropped."), null;
    names.add(raw.name);
    let weightParameter: string | null = null;
    if (raw.weightParameter !== undefined && raw.weightParameter !== null) {
      if (typeof raw.weightParameter === "string" && this.paramTypes.get(raw.weightParameter) === "float") weightParameter = raw.weightParameter;
      else r.problem(`${at}.weightParameter`, `${JSON.stringify(raw.weightParameter)} isn't a float parameter; none.`);
    }
    return { name: raw.name, root, mask: readRef(r, raw.mask, `${at}.mask`), mode: r.pick(raw.mode, `${at}.mode`, LAYER_MODES, "override"), weight: r.num(raw.weight, `${at}.weight`, 1, 0, 1), weightParameter };
  }
}

/** @internal A `*.animgraph.json` value, leniently: never throws; problem lines start with `path` when given. */
export function parseAnimGraph(raw: unknown, path?: string): FormatParse<AnimGraph> {
  const problems: string[] = [];
  const o = readRoot(raw, ANIM_GRAPH_FORMAT, "an animation graph", problems);
  const g = new GraphReader(problems);
  const r = g.r;
  const parameters = limited(r, o.parameters, "parameters", L.parameters, "parameters").map((p, i) => g.parameter(p, `parameters[${i}]`)).filter((p): p is GraphParameter => p !== null);
  // Ids first, so inputs, state roots, bridges and chooser rows can name nodes later in the list.
  const ids = new IdScope(r);
  const nodeRaws: [JsonRecord, string, string][] = [];
  limited(r, o.nodes, "nodes", L.nodes, "nodes").forEach((n, i) => {
    const at = `nodes[${i}]`;
    if (!isRecord(n)) return r.problem(at, "a node must be an object; dropped.");
    if (familyOfKind(typeof n.kind === "string" ? n.kind : "") === undefined) return r.problem(`${at}.kind`, `${JSON.stringify(n.kind)} isn't a node kind; the node is dropped.`);
    nodeRaws.push([n, at, ids.take(n.id, `${at}.id`, "node")]);
  });
  g.nodeIds = new Set(nodeRaws.map(([, , id]) => id));
  const nodes = nodeRaws.map(([n, at, id]) => g.node(n, at, id)).filter((n): n is GraphNode => n !== null);
  const layerNames = new Set<string>();
  const layers = limited(r, o.layers, "layers", L.layers, "layers").map((l, i) => g.layer(l, `layers[${i}]`, layerNames)).filter((l): l is GraphLayer => l !== null);
  const value: AnimGraph = { format: ANIM_GRAPH_FORMAT, name: r.str(o.name, "name", ""), skeleton: readRef(r, o.skeleton, "skeleton"), output: g.nodeRef(o.output, "output"), parameters, nodes, layers };
  return { value, problems: withPath(problems, path) };
}

// --- write -------------------------------------------------------------------------------------------------------------

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function conditionToJson(c: Condition): JsonRecord {
  if ("all" in c) return { all: c.all.map(conditionToJson) };
  if ("any" in c) return { any: c.any.map(conditionToJson) };
  if ("request" in c) return compact({ request: c.request, op: c.op === "==" ? undefined : c.op, value: c.value ? undefined : false });
  return { ...c };
}

function transitionToJson(t: Transition): JsonRecord {
  return compact({
    id: t.id || undefined,
    to: t.to,
    if: t.if ? conditionToJson(t.if) : undefined,
    when: t.when === "now" ? undefined : t.when,
    how: t.how === "crossfade" ? undefined : t.how,
    bridge: t.bridge ?? undefined,
    duration: t.how === "cut" || t.duration === DEFAULT_TRANSITION_DURATION ? undefined : t.duration,
    shape: t.shape === "linear" ? undefined : t.shape,
    interrupt: t.interrupt === "never" ? undefined : t.interrupt === "any" ? "any" : [...t.interrupt],
  });
}

function nodeToJson(n: GraphNode): JsonRecord {
  const out = compact({
    id: n.id, family: n.family, kind: n.kind, name: n.name || undefined, position: n.position ? [...n.position] : undefined,
    inputs: n.inputs.length ? [...n.inputs] : undefined,
    params: Object.keys(n.params).length ? Object.fromEntries(Object.entries(n.params).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])) : undefined,
  });
  if (n.machine) {
    const m = n.machine;
    out.machine = compact({
      entry: m.entry !== null && m.entry !== m.states[0]?.name ? m.entry : undefined,
      states: m.states.map((s) => compact({ name: s.name, root: s.root, exit: s.exit || undefined, position: s.position ? [...s.position] : undefined, transitions: s.transitions.length ? s.transitions.map(transitionToJson) : undefined })),
      anyState: m.anyState.length ? m.anyState.map(transitionToJson) : undefined,
    });
  }
  if (n.chooser) out.chooser = compact({ rows: n.chooser.rows.map((row) => ({ if: conditionToJson(row.if), result: row.result })), fallback: n.chooser.fallback ?? undefined });
  if (n.slot) out.slot = compact({ name: n.slot.name, group: n.slot.group ?? undefined });
  if (n.linked) out.linked = compact({ name: n.linked.name, graph: n.linked.graph ?? undefined });
  return out;
}

/** @internal A graph as canonical JSON (defaults left out). */
export function animGraphToJson(g: AnimGraph): JsonRecord {
  return compact({
    format: ANIM_GRAPH_FORMAT,
    name: g.name || undefined,
    skeleton: g.skeleton ?? undefined,
    output: g.output ?? undefined,
    parameters: g.parameters.map((p) => compact({
      name: p.name, type: p.type, default: sameJson(p.default, defaultParamValue(p.type)) ? undefined : Array.isArray(p.default) ? [...p.default] : p.default,
      replicate: p.replicate || undefined, predicted: p.predicted || undefined, computed: p.computed || undefined,
    })),
    nodes: g.nodes.map(nodeToJson),
    layers: g.layers.length ? g.layers.map((l) => compact({ name: l.name, root: l.root, mask: l.mask ?? undefined, mode: l.mode === "override" ? undefined : l.mode, weight: l.weight === 1 ? undefined : l.weight, weightParameter: l.weightParameter ?? undefined })) : undefined,
  });
}

/** @internal A graph's file text. */
export const formatAnimGraph = (g: AnimGraph): string => jsonText(animGraphToJson(g));

/** @internal The asset references a graph holds, as written: its skeleton, node parameters starting with `asset:`, linked graphs' defaults and layers' masks. */
export function animGraphReferenceStrings(g: AnimGraph): string[] {
  const out: (string | null)[] = [g.skeleton];
  for (const n of g.nodes) {
    for (const v of Object.values(n.params)) {
      if (typeof v === "string" && v.startsWith("asset:")) out.push(v);
      else if (Array.isArray(v)) for (const x of v) if (typeof x === "string" && x.startsWith("asset:")) out.push(x);
    }
    if (n.linked) out.push(n.linked.graph);
  }
  for (const l of g.layers) out.push(l.mask);
  return out.filter((x): x is string => x !== null);
}

/** @internal The project files a graph names, once each. */
export const animGraphReferences = (g: AnimGraph): string[] => referencePaths(animGraphReferenceStrings(g));
