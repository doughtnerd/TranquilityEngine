import { describe, expect, it } from "vitest";
import { BOOL_LABELS, parameterKind, parameterKindText, parseParameters } from "./parameters";

describe("parameter types (true / false and text read as labels)", () => {
  it("parses a true / false parameter as the labels false, true", () => {
    const problems: string[] = [];
    const [a, b] = parseParameters([{ name: "inCombat", type: "bool", default: true }, { name: "swimming", type: "bool" }], "p", problems);
    expect(problems).toEqual([]);
    expect(a).toEqual({ name: "inCombat", labels: [...BOOL_LABELS], default: "true", type: "bool" });
    expect(b).toEqual({ name: "swimming", labels: ["false", "true"], default: "false", type: "bool" });
    expect(parameterKind(a!)).toBe("bool");
    expect(parameterKindText(a!)).toBe("true / false");
  });
  it("parses a text parameter with the values known so far (an empty text is allowed)", () => {
    const problems: string[] = [];
    const [t, e] = parseParameters([{ name: "surface", type: "text", labels: ["Dirt", "Wood"], default: "Wood" }, { name: "area", type: "text" }], "p", problems);
    expect(problems).toEqual([]);
    expect(t).toEqual({ name: "surface", labels: ["Dirt", "Wood"], default: "Wood", type: "text" });
    expect(e).toEqual({ name: "area", labels: [""], default: "", type: "text" });
    expect(parameterKind(t!)).toBe("text");
    expect(parameterKind({ name: "s", labels: ["A"], default: "A" })).toBe("state");
    expect(parameterKind({ name: "n", min: 0, max: 1, default: 0, seekSpeed: 0 })).toBe("number");
  });
  it("ignores an unknown type with one problem line", () => {
    const problems: string[] = [];
    const [x] = parseParameters([{ name: "x", type: "colour", min: 0, max: 2 }], "p", problems);
    expect(x).toMatchObject({ name: "x", min: 0, max: 2 });
    expect(problems).toEqual(['p[0].type: must be "bool" or "text"; ignored.']);
  });
});
