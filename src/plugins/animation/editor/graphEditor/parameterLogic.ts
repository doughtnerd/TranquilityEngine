// The graph's parameters (its blackboard, ≤ 64) through the one parameter list module (ADR 0304, `editor/sdk`
// `parameterList`): add, remove and rename go through the list (unique names, the limit), with this holder carrying a
// rename or a remove through the graph (conditions, node parameter bindings, layer weights). What is the graph's own —
// seven types instead of numeric/labelled, a typed default, the replicate/predicted/computed flags — is edited here,
// typed against what binds the parameter. Every edit is refused-or-next (ADR 0307).
//
// The list sees each parameter as a numeric `ParameterDef` (its range unused); a parameter it adds ("Parameter",
// "Parameter 2"…) becomes a float parameter with a valid graph name ("Parameter", "Parameter2"…).
import {
  GRAPH_LIMITS, GRAPH_PARAM_TYPES, defaultParamValue,
  type AnimGraph, type GraphNode, type GraphParamType, type GraphParamValue, type GraphParameter, type Transition,
} from "../../../../engine/animation/animGraph";
import type { ParameterDef } from "../../../../engine/audio/parameters";
import { accept, parameterList, refuse, type EditResult, type ParameterHolder, type ParameterList } from "../../../../editor/sdk";
import { uniqueName } from "../../../../engine/core/uniqueName";
import { conditionParams, renameConditionParam } from "./conditionLogic";
import { JOINED, kindLabel, schemaOf } from "./graphEditLogic";

const NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** Where node `n` binds parameters: (param name in its schema, the graph parameter names it binds, the types it takes). */
function bindings(n: GraphNode): { field: string; names: string[]; types: readonly GraphParamType[] | undefined }[] {
  const schema = schemaOf(n);
  if (!schema) return [];
  const out: { field: string; names: string[]; types: readonly GraphParamType[] | undefined }[] = [];
  for (const s of schema.params) {
    const v = n.params[s.name];
    if (s.kind === "parameter" && typeof v === "string") out.push({ field: s.name, names: [v], types: s.parameterTypes });
    else if (s.kind === "float" && s.animatable && typeof v === "string") out.push({ field: s.name, names: [v], types: s.parameterTypes });
    else if (s.kind === "parameterList" && Array.isArray(v)) out.push({ field: s.name, names: (v as unknown[]).filter((x): x is string => typeof x === "string"), types: s.parameterTypes });
  }
  return out;
}

/** Every condition of the graph (transitions and chooser rows). */
function conditions(graph: AnimGraph) {
  return graph.nodes.flatMap((n) => [
    ...(n.machine ? [...n.machine.anyState, ...n.machine.states.flatMap((s) => s.transitions)].map((t) => t.if) : []),
    ...(n.chooser ? n.chooser.rows.map((r) => r.if) : []),
  ]);
}

/** Where parameter `name` is used, as short texts ("move.x", "a condition"…). */
export function parameterUses(graph: AnimGraph, name: string): { conditions: number; bindings: string[]; layers: string[] } {
  return {
    conditions: conditions(graph).filter((c) => conditionParams(c).includes(name)).length,
    bindings: graph.nodes.flatMap((n) => bindings(n).filter((b) => b.names.includes(name)).map((b) => `${n.id}.${b.field}`)),
    layers: graph.layers.filter((l) => l.weightParameter === name).map((l) => l.name),
  };
}

function renameEverywhere(graph: AnimGraph, from: string, to: string): AnimGraph {
  const r = (x: string) => (x === from ? to : x);
  const nodes = graph.nodes.map((n): GraphNode => {
    let out = n;
    const bs = bindings(n);
    if (bs.some((b) => b.names.includes(from))) {
      const params = { ...n.params };
      for (const b of bs) {
        const v = params[b.field];
        params[b.field] = Array.isArray(v) ? (v as unknown[]).map((x) => (x === from ? to : x)) as string[] : r(v as string);
      }
      out = { ...out, params };
    }
    if (n.machine) {
      const fix = (t: Transition): Transition => ({ ...t, if: t.if ? renameConditionParam(t.if, from, to) : null });
      out = { ...out, machine: { ...n.machine, anyState: n.machine.anyState.map(fix), states: n.machine.states.map((s) => ({ ...s, transitions: s.transitions.map(fix) })) } };
    }
    if (n.chooser) out = { ...out, chooser: { ...n.chooser, rows: n.chooser.rows.map((row) => ({ ...row, if: renameConditionParam(row.if, from, to) })) } };
    return out;
  });
  return {
    ...graph,
    nodes,
    parameters: graph.parameters.map((p) => (p.name === from ? { ...p, name: to } : p)),
    layers: graph.layers.map((l) => (l.weightParameter === from ? { ...l, weightParameter: to } : l)),
  };
}

/** `graph` without parameter `name` and its bindings (node fields back to their defaults, layer weights unbound). Conditions on it must be gone already. */
function removeEverywhere(graph: AnimGraph, name: string): AnimGraph {
  const nodes = graph.nodes.map((n): GraphNode => {
    const bs = bindings(n).filter((b) => b.names.includes(name));
    if (!bs.length) return n;
    const params = { ...n.params };
    for (const b of bs) {
      const v = params[b.field];
      if (Array.isArray(v)) params[b.field] = (v as string[]).filter((x) => x !== name);
      else delete params[b.field];
    }
    return { ...n, params };
  });
  return { ...graph, nodes, parameters: graph.parameters.filter((p) => p.name !== name), layers: graph.layers.map((l) => (l.weightParameter === name ? { ...l, weightParameter: null } : l)) };
}

/** The list's view of a graph parameter (its range unused). */
const asDef = (p: GraphParameter): ParameterDef => ({ name: p.name, min: 0, max: 1, default: 0, seekSpeed: 0 });

const holder: ParameterHolder<AnimGraph> = {
  read: (g) => g.parameters.map(asDef),
  limit: GRAPH_LIMITS.parameters,
  write: (g, defs) => {
    const names = g.parameters.map((p) => p.name);
    const parameters = defs.map((d) => {
      const had = g.parameters.find((p) => p.name === d.name);
      if (had) return had;
      // A parameter the list added: a float with a graph name (no spaces), free among the others.
      const base = d.name.replace(/[^A-Za-z0-9_.]/g, "").replace(/^[^A-Za-z_]+/, "") || "Parameter";
      const name = uniqueName(base, names, JOINED);
      names.push(name);
      return { name, type: "float", default: 0, replicate: false, predicted: false, computed: false } satisfies GraphParameter;
    });
    return { ...g, parameters };
  },
  rename: renameEverywhere,
  remove: removeEverywhere,
};

const base = parameterList(holder);

/**
 * The graph's parameter list: the SDK list's edits with the graph's own rules in front (names are letters, digits, _
 * and ., not starting with a digit; a parameter a condition compares can't be removed until the condition is).
 */
export const graphParameters: ParameterList<AnimGraph> = {
  ...base,
  rename(g, from, to) {
    const name = to.trim();
    if (name !== from && name !== "" && !NAME.test(name)) return refuse("a parameter's name is letters, digits, _ and ., not starting with a digit");
    return base.rename(g, from, to);
  },
  remove(g, name) {
    const uses = parameterUses(g, name);
    if (uses.conditions) return refuse(`${uses.conditions} condition${uses.conditions === 1 ? " compares" : "s compare"} it; remove ${uses.conditions === 1 ? "that row" : "those rows"} first`);
    return base.remove(g, name);
  },
};

export const parameterOf = (g: AnimGraph, name: string): GraphParameter | undefined => g.parameters.find((p) => p.name === name);

const mapParam = (g: AnimGraph, name: string, f: (p: GraphParameter) => GraphParameter): AnimGraph => ({ ...g, parameters: g.parameters.map((p) => (p.name === name ? f(p) : p)) });

/**
 * Parameter `name`'s type (its default reset to the type's). Refused when something binding it takes another type
 * (a node field, a layer's weight) or a condition compares it and the new type doesn't compare that way.
 */
export function setParameterType(g: AnimGraph, name: string, type: GraphParamType): EditResult<AnimGraph> {
  const p = parameterOf(g, name);
  if (!p) return refuse(`there's no parameter named "${name}"`);
  if (!GRAPH_PARAM_TYPES.includes(type)) return refuse(`a parameter is ${GRAPH_PARAM_TYPES.join(", ")}`);
  if (p.type === type) return accept(g);
  for (const n of g.nodes) {
    for (const b of bindings(n)) {
      if (b.names.includes(name) && b.types && !b.types.includes(type)) return refuse(`type mismatch: ${n.id}.${b.field} (${kindLabel(n.kind)}) takes a ${b.types.join(" or ")} parameter`);
    }
  }
  if (type !== "float" && g.layers.some((l) => l.weightParameter === name)) return refuse("type mismatch: a layer's weight takes a float parameter");
  const compared = conditions(g).filter((c) => conditionParams(c).includes(name)).length;
  if (compared) {
    const numeric = (t: GraphParamType) => t === "float" || t === "int";
    if (!(numeric(p.type) && numeric(type))) return refuse(`type mismatch: ${compared} condition${compared === 1 ? " compares" : "s compare"} it as a ${p.type}`);
    if (type === "int" && !intOnly(g, name)) return refuse("type mismatch: a condition compares it with a fraction; an int compares whole numbers");
  }
  return accept(mapParam(g, name, (q) => ({ ...q, type, default: defaultParamValue(type) })));
}

/** Whether every comparison of `name` uses a whole number. */
function intOnly(g: AnimGraph, name: string): boolean {
  const walk = (c: unknown): boolean => {
    if (!c || typeof c !== "object") return true;
    const o = c as Record<string, unknown>;
    if (Array.isArray(o.all)) return o.all.every(walk);
    if (Array.isArray(o.any)) return o.any.every(walk);
    return o.param !== name || Number.isInteger(o.value);
  };
  return conditions(g).every(walk);
}

/** Parameter `name`'s default, typed by the parameter (a whole number for int, true/false for bool, n numbers for vectors, a node path or null for node). */
export function setParameterDefault(g: AnimGraph, name: string, value: GraphParamValue): EditResult<AnimGraph> {
  const p = parameterOf(g, name);
  if (!p) return refuse(`there's no parameter named "${name}"`);
  const n = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const len = p.type === "vec2" ? 2 : p.type === "vec3" ? 3 : p.type === "quat" ? 4 : 0;
  const ok =
    p.type === "float" ? n(value)
    : p.type === "int" ? n(value) && Number.isInteger(value)
    : p.type === "bool" ? typeof value === "boolean"
    : p.type === "node" ? value === null || typeof value === "string"
    : Array.isArray(value) && value.length === len && value.every(n);
  if (!ok) return refuse(`type mismatch: ${name} is ${p.type === "int" ? "an int (a whole number)" : `a ${p.type}`}`);
  if (JSON.stringify(p.default) === JSON.stringify(value)) return accept(g);
  return accept(mapParam(g, name, (q) => ({ ...q, default: value })));
}

/** A parameter flag: replicated to clients, predicted, or computed (filled by `anim.compute`). */
export function setParameterFlag(g: AnimGraph, name: string, flag: "replicate" | "predicted" | "computed", on: boolean): EditResult<AnimGraph> {
  const p = parameterOf(g, name);
  if (!p) return refuse(`there's no parameter named "${name}"`);
  if (flag === "predicted" && on && !p.replicate) return refuse("only a replicated parameter is predicted; replicate it first");
  if (p[flag] === on) return accept(g);
  return accept(mapParam(g, name, (q) => ({ ...q, [flag]: on, ...(flag === "replicate" && !on ? { predicted: false } : {}) })));
}
