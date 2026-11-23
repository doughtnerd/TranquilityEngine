// Condition rows (T51) through their interface: rows joined by all or any, typed against the graph's parameters the way
// the parse reads them back (a bool compares == or != a boolean, an int a whole number, vectors don't compare), with a
// refused-or-next result for each mistake; the conditions they make round-trip and compile.
import { describe, expect, it } from "vitest";
import { emptyAnimGraph, formatAnimGraph, parseAnimGraph, type AnimGraph, type Condition } from "../../../../engine/animation/animGraph";
import { refusalOf, type EditResult } from "../../../../editor/sdk";
import { addNode } from "./graphEditLogic";
import { addState, addTransition, setTransitionCondition, transitionsOf } from "./machineLogic";
import {
  addRow, conditionRows, conditionText, operatorsFor, removeRow, rowsCondition, setJoin, setRequestLive, setRowOp, setRowSubject, setRowValue, type ConditionRows,
} from "./conditionLogic";

const ok = <T>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const param = (name: string, type: AnimGraph["parameters"][number]["type"]) => ({ name, type, default: type === "bool" ? false : type === "vec2" ? [0, 0] : 0, replicate: false, predicted: false, computed: false });
const graph: AnimGraph = { ...emptyAnimGraph(), parameters: [param("speed", "float"), param("grounded", "bool"), param("weapon", "int"), param("aim", "vec2")] };
const none: ConditionRows = conditionRows(null);

describe("condition rows (T51)", () => {
  it("adds rows starting from the first comparable parameter; one row is the condition itself, more are a group", () => {
    const one = ok(addRow(graph, none));
    expect(rowsCondition(one)).toEqual({ param: "speed", op: ">", value: 0 });
    const two = ok(addRow(graph, one, { kind: "param", name: "grounded" }));
    expect(rowsCondition(two)).toEqual({ all: [{ param: "speed", op: ">", value: 0 }, { param: "grounded", op: "==", value: true }] });
    expect(rowsCondition(ok(setJoin(two, "any")))).toEqual({ any: [{ param: "speed", op: ">", value: 0 }, { param: "grounded", op: "==", value: true }] });
    expect(rowsCondition(ok(removeRow(two, 0)))).toEqual({ param: "grounded", op: "==", value: true });
    expect(rowsCondition(ok(removeRow(one, 0)))).toBeNull();
    expect(conditionText(rowsCondition(two))).toBe("speed > 0 and grounded == true");
  });

  it("types operators and values by the subject", () => {
    let rows = ok(addRow(graph, none, { kind: "param", name: "grounded" }));
    expect(operatorsFor(graph, { kind: "param", name: "grounded" })).toEqual(["==", "!="]);
    expect(refusalOf(setRowOp(graph, rows, 0, ">"))).toMatch(/type mismatch/);
    expect(refusalOf(setRowValue(graph, rows, 0, 3))).toMatch(/type mismatch: this compares true or false/);
    rows = ok(setRowValue(graph, rows, 0, false));
    rows = ok(setRowSubject(graph, rows, 0, { kind: "param", name: "weapon" }));
    expect(rows.rows[0]).toEqual({ param: "weapon", op: ">", value: 0 });
    expect(refusalOf(setRowValue(graph, rows, 0, 1.5))).toBe("type mismatch: weapon is an int parameter; compare a whole number");
    rows = ok(setRowValue(graph, rows, 0, 2));
    rows = ok(setRowOp(graph, rows, 0, "<="));
    expect(refusalOf(setRowSubject(graph, rows, 0, { kind: "param", name: "aim" }))).toMatch(/a vec2 parameter isn't comparable/);
    expect(refusalOf(setRowSubject(graph, rows, 0, { kind: "param", name: "ghost" }))).toMatch(/no parameter named "ghost"/);
    expect(refusalOf(setRowSubject(graph, rows, 0, { kind: "request", name: " " }))).toBe("a request needs a name");
  });

  it("compares state operands, curves and requests (a request live or not)", () => {
    let rows = ok(addRow(graph, none, { kind: "operand", operand: "normalizedTime" }));
    rows = ok(addRow(graph, rows, { kind: "curve", name: "footL" }));
    rows = ok(addRow(graph, rows, { kind: "request", name: "Jump" }));
    rows = ok(setRequestLive(rows, 2, false));
    const c = rowsCondition(rows)!;
    expect(c).toEqual({ all: [{ operand: "normalizedTime", op: ">=", value: 1 }, { curve: "footL", op: ">", value: 0 }, { request: "Jump", op: "==", value: false }] });
    expect(conditionText(c)).toBe("normalizedTime >= 1 and curve footL > 0 and no request Jump");
  });

  it("keeps nested groups as rows of their own", () => {
    const nested: Condition = { any: [{ all: [{ param: "speed", op: ">", value: 1 }, { param: "grounded", op: "==", value: true }] }, { request: "Stop", op: "==", value: true }] };
    const rows = conditionRows(nested);
    expect(rows.join).toBe("any");
    const more = ok(addRow(graph, rows, { kind: "param", name: "speed" }));
    expect(rowsCondition(more)).toEqual({ any: [...(nested as { any: Condition[] }).any, { param: "speed", op: ">", value: 0 }] });
  });

  it("writes conditions on transitions the format reads back", () => {
    let g = ok(addNode(graph, "logic", "stateMachine", [0, 0])).graph;
    g = ok(addState(g, "stateMachine", [0, 0], "Idle")).graph;
    g = ok(addState(g, "stateMachine", [0, 0], "Move")).graph;
    g = ok(addTransition(g, "stateMachine", "Idle", "Move"));
    let rows = ok(addRow(g, none));
    rows = ok(addRow(g, rows, { kind: "param", name: "grounded" }));
    g = ok(setTransitionCondition(g, "stateMachine", { from: "Idle", index: 0 }, rowsCondition(rows)));
    const read = parseAnimGraph(JSON.parse(formatAnimGraph(g)));
    expect(read.problems).toEqual([]);
    expect(transitionsOf(read.value.nodes[0]!.machine!, "Idle")[0]!.if).toEqual(rowsCondition(rows));
  });
});
