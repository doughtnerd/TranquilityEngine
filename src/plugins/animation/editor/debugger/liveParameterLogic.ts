// The live parameter panel's rows (ADR 0373 "the parameter panel is live and editable"; T52): each graph parameter with
// the value the game holds now (the value code last set, else the graph's default), and what an edit sends back. Pure.
import type { AnimGraph, GraphParamType } from "../../../../engine/animation/animGraph";
import type { CompiledAnimGraph } from "../../../../engine/animation/graphCompile";
import type { AnimatorDebugFrame, DebugParamValue } from "../../runtime/features/debug/frame";

/** One parameter row. */
export interface LiveParameterRow {
  readonly name: string;
  readonly type: GraphParamType;
  /** The value now (null: a `node` parameter, which isn't shown or edited). */
  readonly value: DebugParamValue | null;
  /** Whether code has set it (else it holds the graph's default). */
  readonly set: boolean;
  /** Filled by `anim.compute` each frame: an edit lasts one frame. */
  readonly computed: boolean;
}

/** The rows of `graph`'s parameters with `frame`'s values (the game's parameter indices, from `tables`). */
export function liveParameterRows(graph: AnimGraph, tables: CompiledAnimGraph, frame: AnimatorDebugFrame | null): LiveParameterRow[] {
  return graph.parameters.map((p) => {
    const i = tables.parameters.indexOf(p.name);
    const live = i >= 0 ? (frame?.parameters[i] ?? null) : null;
    const fallback: DebugParamValue | null = p.type === "node" ? null : (p.default as DebugParamValue);
    return { name: p.name, type: p.type, value: p.type === "node" ? null : (live ?? fallback), set: live !== null, computed: p.computed };
  });
}

/** A value as text ("0.25", "true", "(0.10, 1.00)"). */
export function valueText(v: DebugParamValue | null): string {
  if (v === null) return "—";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return `(${v.map((x) => x.toFixed(2)).join(", ")})`;
}

/**
 * What an edit of a `type` row to `input` sends (`Animator.set`), or why it can't: ints must be whole, numbers finite,
 * vectors their width.
 */
export function editValue(type: GraphParamType, input: string | boolean | readonly number[]): { value: DebugParamValue } | { refused: string } {
  if (type === "bool") return typeof input === "boolean" ? { value: input } : { refused: "a bool parameter takes true or false" };
  if (type === "node") return { refused: "node parameters are set from code" };
  if (type === "float" || type === "int") {
    const n = typeof input === "string" ? Number(input.trim()) : NaN;
    if (typeof input !== "string" || input.trim() === "" || !Number.isFinite(n)) return { refused: "type a number" };
    if (type === "int" && !Number.isInteger(n)) return { refused: "an int parameter takes a whole number" };
    return { value: n };
  }
  const width = type === "vec2" ? 2 : type === "vec3" ? 3 : 4;
  if (!Array.isArray(input) || input.length !== width || !input.every((x) => typeof x === "number" && Number.isFinite(x))) return { refused: `a ${type} parameter takes ${width} numbers` };
  return { value: [...(input as readonly number[])] };
}
