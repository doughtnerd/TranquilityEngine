// Condition rows (ADR 0373 "a condition editor: rows of parameter, operator and value, joined by all or any"; D53): a
// transition's or chooser row's structured condition (`animGraph.ts` `Condition`) seen as one join and a list of rows,
// and the edits of those rows, typed against the graph's parameters the way the parse and the compiler read them back:
// float and int parameters compare numbers (an int a whole one), bool parameters `==`/`!=` a boolean, vectors,
// quaternions and nodes don't compare; requests are live or not. Every edit is a refused-or-next result (ADR 0307).
//
// A condition nested deeper than one group keeps its nested groups as rows of their own (shown as a summary, removable),
// so editing the top level never flattens what a file wrote.
import { CMP_OPS, GRAPH_LIMITS, STATE_OPERANDS, type AnimGraph, type CmpOp, type Condition, type GraphParamType, type StateOperand } from "../../../../engine/animation/animGraph";
import { accept, refuse, type EditResult } from "../../../../editor/sdk";

/** How the rows join. */
export type ConditionJoin = "all" | "any";

/** A condition as the row editor shows it. */
export interface ConditionRows {
  readonly join: ConditionJoin;
  readonly rows: readonly Condition[];
}

/** What a row compares: a parameter, a state operand, a curve or a request. */
export type RowSubject =
  | { readonly kind: "param"; readonly name: string }
  | { readonly kind: "operand"; readonly operand: StateOperand }
  | { readonly kind: "curve"; readonly name: string }
  | { readonly kind: "request"; readonly name: string };

/** A condition (null: always) as one join and its rows. */
export function conditionRows(c: Condition | null): ConditionRows {
  if (c === null) return { join: "all", rows: [] };
  if ("all" in c) return { join: "all", rows: c.all };
  if ("any" in c) return { join: "any", rows: c.any };
  return { join: "all", rows: [c] };
}

/** Rows back as a condition: none is null (always), one row is itself, more are a group. */
export function rowsCondition(rows: ConditionRows): Condition | null {
  if (rows.rows.length === 0) return null;
  if (rows.rows.length === 1 && rows.join === "all") return rows.rows[0]!;
  return rows.join === "all" ? { all: rows.rows } : { any: rows.rows };
}

/** Whether a row is a nested group (shown as a summary). */
export const isGroup = (c: Condition): c is { all: readonly Condition[] } | { any: readonly Condition[] } => "all" in c || "any" in c;

/** A row's subject (null for a nested group). */
export function rowSubject(c: Condition): RowSubject | null {
  if ("param" in c) return { kind: "param", name: c.param };
  if ("operand" in c) return { kind: "operand", operand: c.operand };
  if ("curve" in c) return { kind: "curve", name: c.curve };
  if ("request" in c) return { kind: "request", name: c.request };
  return null;
}

const typeOf = (graph: AnimGraph, name: string): GraphParamType | undefined => graph.parameters.find((p) => p.name === name)?.type;
const comparable = (t: GraphParamType) => t === "float" || t === "int" || t === "bool";

/** The operators a row's subject takes. */
export function operatorsFor(graph: AnimGraph, subject: RowSubject): readonly CmpOp[] {
  if (subject.kind === "request") return ["==", "!="];
  if (subject.kind === "param" && typeOf(graph, subject.name) === "bool") return ["==", "!="];
  return CMP_OPS;
}

/** Whether a row's value is a boolean (bool parameters and requests). */
export function booleanValue(graph: AnimGraph, subject: RowSubject): boolean {
  return subject.kind === "request" || (subject.kind === "param" && typeOf(graph, subject.name) === "bool");
}

/** A short text of a condition, for lists and summaries ("speed > 0.1 and grounded == true"). */
export function conditionText(c: Condition | null): string {
  if (c === null) return "always";
  if ("all" in c) return c.all.map((x) => (isGroup(x) ? `(${conditionText(x)})` : conditionText(x))).join(" and ");
  if ("any" in c) return c.any.map((x) => (isGroup(x) ? `(${conditionText(x)})` : conditionText(x))).join(" or ");
  if ("request" in c) return c.op === "==" && c.value ? `request ${c.request}` : `no request ${c.request}`;
  const subject = "param" in c ? c.param : "operand" in c ? c.operand : `curve ${c.curve}`;
  return `${subject} ${c.op} ${String(c.value)}`;
}

/** Why `subject` can't be compared in `graph`, or null. */
function whyNotSubject(graph: AnimGraph, subject: RowSubject): string | null {
  if (subject.kind === "param") {
    const t = typeOf(graph, subject.name);
    if (!t) return `there's no parameter named "${subject.name}"`;
    if (!comparable(t)) return `type mismatch: a ${t} parameter isn't comparable (compare float, int or bool parameters)`;
  }
  if ((subject.kind === "curve" || subject.kind === "request") && subject.name.trim() === "") return `a ${subject.kind} needs a name`;
  return null;
}

/** A comparison of `subject` with a fitting default operator and value. */
function rowFor(graph: AnimGraph, subject: RowSubject): Condition {
  switch (subject.kind) {
    case "request": return { request: subject.name.trim(), op: "==", value: true };
    case "curve": return { curve: subject.name.trim(), op: ">", value: 0 };
    case "operand": return { operand: subject.operand, op: ">=", value: subject.operand === "stateTime" ? 0 : 1 };
    case "param": {
      const p = graph.parameters.find((q) => q.name === subject.name)!;
      if (p.type === "bool") return { param: p.name, op: "==", value: true };
      return { param: p.name, op: ">", value: typeof p.default === "number" ? p.default : 0 };
    }
  }
}

/** The subject a new row starts with: the first comparable parameter, else the state time. */
export function defaultSubject(graph: AnimGraph): RowSubject {
  const p = graph.parameters.find((q) => comparable(q.type));
  return p ? { kind: "param", name: p.name } : { kind: "operand", operand: "stateTime" };
}

const countTerms = (c: Condition): number => ("all" in c ? 1 + c.all.reduce((n, x) => n + countTerms(x), 0) : "any" in c ? 1 + c.any.reduce((n, x) => n + countTerms(x), 0) : 1);

/** Rows with one more (the first comparable parameter, else the state time), within the term limit. */
export function addRow(graph: AnimGraph, rows: ConditionRows, subject: RowSubject = defaultSubject(graph)): EditResult<ConditionRows> {
  const why = whyNotSubject(graph, subject);
  if (why) return refuse(why);
  const terms = rows.rows.reduce((n, x) => n + countTerms(x), rows.rows.length > 1 ? 1 : 0);
  if (terms + 1 > GRAPH_LIMITS.conditionTerms) return refuse(`a condition has at most ${GRAPH_LIMITS.conditionTerms} terms`);
  return accept({ join: rows.join, rows: [...rows.rows, rowFor(graph, subject)] });
}

/** Rows without row `index`. */
export function removeRow(rows: ConditionRows, index: number): EditResult<ConditionRows> {
  if (!rows.rows[index]) return refuse("there's no such row");
  return accept({ join: rows.join, rows: rows.rows.filter((_, i) => i !== index) });
}

/** Rows joined by `join`. */
export const setJoin = (rows: ConditionRows, join: ConditionJoin): EditResult<ConditionRows> => accept(rows.join === join ? rows : { join, rows: rows.rows });

const replace = (rows: ConditionRows, index: number, row: Condition): ConditionRows => ({ join: rows.join, rows: rows.rows.map((r, i) => (i === index ? row : r)) });

/** Row `index` compares `subject` instead (operator and value kept where they still fit, else the subject's defaults). */
export function setRowSubject(graph: AnimGraph, rows: ConditionRows, index: number, subject: RowSubject): EditResult<ConditionRows> {
  const row = rows.rows[index];
  if (!row || isGroup(row)) return refuse("there's no such row");
  const why = whyNotSubject(graph, subject);
  if (why) return refuse(why);
  const fresh = rowFor(graph, subject);
  const before = rowSubject(row)!;
  // Keep the operator and value when both subjects take the same kind of value.
  const keep = booleanValue(graph, before) === booleanValue(graph, subject) && operatorsFor(graph, subject).includes((row as { op: CmpOp }).op);
  const next = keep ? ({ ...fresh, op: (row as { op: CmpOp }).op, value: (row as { value: number | boolean }).value } as Condition) : fresh;
  if (subject.kind === "param" && typeOf(graph, subject.name) === "int" && typeof (next as { value: unknown }).value === "number" && !Number.isInteger((next as { value: number }).value)) {
    return accept(replace(rows, index, { ...(next as { param: string; op: CmpOp }), value: Math.round((next as { value: number }).value) }));
  }
  return accept(replace(rows, index, next));
}

/** Row `index`'s operator, if its subject takes it. */
export function setRowOp(graph: AnimGraph, rows: ConditionRows, index: number, op: CmpOp): EditResult<ConditionRows> {
  const row = rows.rows[index];
  if (!row || isGroup(row)) return refuse("there's no such row");
  const subject = rowSubject(row)!;
  if (!operatorsFor(graph, subject).includes(op)) return refuse(`type mismatch: ${booleanValue(graph, subject) ? "a true/false value compares with == or != only" : `${op} isn't an operator`}`);
  return accept(replace(rows, index, { ...row, op } as Condition));
}

/** Row `index`'s value, typed by its subject: a boolean for bool parameters and requests, a (whole, for int) number otherwise. */
export function setRowValue(graph: AnimGraph, rows: ConditionRows, index: number, value: number | boolean): EditResult<ConditionRows> {
  const row = rows.rows[index];
  if (!row || isGroup(row)) return refuse("there's no such row");
  const subject = rowSubject(row)!;
  if (booleanValue(graph, subject)) {
    if (typeof value !== "boolean") return refuse("type mismatch: this compares true or false");
  } else {
    if (typeof value !== "number" || !Number.isFinite(value)) return refuse("type mismatch: this compares a number");
    if (subject.kind === "param" && typeOf(graph, subject.name) === "int" && !Number.isInteger(value)) return refuse(`type mismatch: ${subject.name} is an int parameter; compare a whole number`);
  }
  return accept(replace(rows, index, { ...row, value } as Condition));
}

/** A request row: true while the request is live, or while it isn't. */
export function setRequestLive(rows: ConditionRows, index: number, live: boolean): EditResult<ConditionRows> {
  const row = rows.rows[index];
  if (!row || !("request" in row)) return refuse("that row isn't a request");
  return accept(replace(rows, index, { request: row.request, op: "==", value: live }));
}

/** Whether a request row asks for a live request. */
export const requestLive = (c: Condition): boolean => "request" in c && (c.op === "==") === c.value;

/** The subjects a row can compare in `graph`: its comparable parameters, the state operands, and curve and request (named in the row). */
export function subjectChoices(graph: AnimGraph): { value: string; label: string; subject: RowSubject }[] {
  return [
    ...graph.parameters.filter((p) => comparable(p.type)).map((p) => ({ value: `param:${p.name}`, label: `${p.name} (${p.type})`, subject: { kind: "param", name: p.name } as RowSubject })),
    ...STATE_OPERANDS.map((o) => ({ value: `operand:${o}`, label: OPERAND_LABELS[o], subject: { kind: "operand", operand: o } as RowSubject })),
  ];
}

export const OPERAND_LABELS: Readonly<Record<StateOperand, string>> = { stateTime: "State time", normalizedTime: "Normalized time", syncPhase: "Sync phase" };

/** Every parameter name a condition compares. */
export function conditionParams(c: Condition | null): string[] {
  if (c === null) return [];
  if ("all" in c) return c.all.flatMap(conditionParams);
  if ("any" in c) return c.any.flatMap(conditionParams);
  return "param" in c ? [c.param] : [];
}

/** `c` with every comparison of parameter `from` comparing `to` instead. */
export function renameConditionParam(c: Condition, from: string, to: string): Condition {
  if ("all" in c) return { all: c.all.map((x) => renameConditionParam(x, from, to)) };
  if ("any" in c) return { any: c.any.map((x) => renameConditionParam(x, from, to)) };
  return "param" in c && c.param === from ? { ...c, param: to } : c;
}
