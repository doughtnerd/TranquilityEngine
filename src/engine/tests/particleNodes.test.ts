import { describe, expect, it } from "vitest";
import { compileUniform, nodeDef, NODES, outputType, portRate, whyNotConnect, type EvalContext, type NodeValue } from "../scene/particleNodes";
import type { GraphEdge, GraphInputValue, GraphNode, GraphProperty, ParticleGraph } from "../scene/particleGraph";

const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, type, position: [0, 0], ...extra });
const edge = (from: string, to: string): GraphEdge => ({ from, to });
const graph = (nodes: GraphNode[], edges: GraphEdge[] = [], properties: GraphProperty[] = []): ParticleGraph => ({
  properties, systems: [], nodes, edges, events: [], notes: [], groups: [],
});
const ctx = (over: Partial<EvalContext> = {}, props: [string, GraphInputValue][] = []): EvalContext => ({
  time: 0, deltaTime: 0, playTime: 0, properties: new Map(props), random: () => 0.5, ...over,
});
const run = (g: ParticleGraph, from: string, c: EvalContext = ctx()): NodeValue => compileUniform(g, from)(c);

describe("node registry", () => {
  it("has unique types, outputs, and valid defaults", () => {
    const types = NODES.map((n) => n.type);
    expect(new Set(types).size).toBe(types.length);
    for (const n of NODES) {
      expect(n.outputs.length, n.type).toBeGreaterThan(0);
      expect(nodeDef(n.type)).toBe(n);
      expect(new Set(n.inputs.map((p) => p.name)).size).toBe(n.inputs.length);
      for (const p of n.inputs) {
        if (p.type === "number") expect(typeof p.default, `${n.type}.${p.name}`).toBe("number");
        if (p.type === "vector2") expect((p.default as number[]).length).toBe(2);
        if (p.type === "vector3") expect((p.default as number[]).length).toBe(3);
        if (p.type === "color") expect(typeof p.default).toBe("string");
        if (p.type === "curve") expect(p.default).toHaveProperty("curve");
        if (p.type === "gradient") expect(p.default).toHaveProperty("gradient");
      }
    }
    expect(nodeDef("nope")).toBeUndefined();
  });
});

describe("arithmetic", () => {
  it("evaluates numbers, vectors and broadcasts", () => {
    const g = graph([
      node("a", "constant.number", { settings: { value: 3 } }),
      node("v", "constant.vector3", { settings: { value: [1, 2, 3] } }),
      node("m", "multiply"),
      node("s", "subtract", { inputs: { a: 10, b: 4 } }),
      node("d", "divide", { inputs: { a: 1, b: 0 } }),
      node("n", "negate", { inputs: { x: 2 } }),
      node("ab", "abs", { inputs: { x: -2 } }),
      node("mn", "min", { inputs: { a: 2, b: 5 } }),
      node("mx", "max", { inputs: { a: 2, b: 5 } }),
    ], [edge("a.out", "m.a"), edge("v.out", "m.b")]);
    expect(run(g, "m.out")).toEqual([3, 6, 9]);
    expect(outputType(g, g.nodes[2], "out")).toBe("vector3");
    expect(run(g, "s.out")).toBe(6);
    expect(run(g, "d.out")).toBe(0);
    expect(run(g, "n.out")).toBe(-2);
    expect(run(g, "ab.out")).toBe(2);
    expect(run(g, "mn.out")).toBe(2);
    expect(run(g, "mx.out")).toBe(5);
  });

  it("clamp, lerp, remap, step, smoothstep", () => {
    const g = graph([
      node("c", "clamp", { inputs: { x: 5, min: 0, max: 1 } }),
      node("l", "lerp", { inputs: { a: 10, b: 20, t: 0.25 } }),
      node("r", "remap", { inputs: { x: 5, inMin: 0, inMax: 10, outMin: 100, outMax: 200 } }),
      node("st", "step", { inputs: { edge: 0.5, x: 0.5 } }),
      node("st2", "step", { inputs: { edge: 0.5, x: 0.4 } }),
      node("ss", "smoothstep", { inputs: { edge0: 0, edge1: 1, x: 0.5 } }),
      node("ss2", "smoothstep", { inputs: { edge0: 0, edge1: 1, x: 2 } }),
    ]);
    expect(run(g, "c.out")).toBe(1);
    expect(run(g, "l.out")).toBe(12.5);
    expect(run(g, "r.out")).toBe(150);
    expect(run(g, "st.out")).toBe(1);
    expect(run(g, "st2.out")).toBe(0);
    expect(run(g, "ss.out")).toBeCloseTo(0.5);
    expect(run(g, "ss2.out")).toBe(1);
  });

  it("vector nodes", () => {
    const g = graph([
      node("c", "compose2", { inputs: { x: 3, y: 4 } }),
      node("len", "length"),
      node("nrm", "normalize"),
      node("sp", "split2"),
      node("c3", "compose3", { inputs: { x: 1, y: 2, z: 3 } }),
      node("sp3", "split3"),
    ], [edge("c.out", "len.v"), edge("c.out", "nrm.v"), edge("c.out", "sp.v"), edge("c3.out", "sp3.v")]);
    expect(run(g, "len.out")).toBe(5);
    expect(run(g, "nrm.out")).toEqual([0.6, 0.8]);
    expect(outputType(g, g.nodes[2], "out")).toBe("vector2");
    expect(run(g, "sp.y")).toBe(4);
    expect(run(g, "sp3.z")).toBe(3);
  });

  it("colour nodes", () => {
    const g = graph([
      node("h", "colorFromHSV", { inputs: { h: 0, s: 1, v: 1, a: 0.5 } }),
      node("h2", "colorFromHSV", { inputs: { h: 1 / 3, s: 1, v: 1, a: 1 } }),
      node("mc", "multiplyColor", { inputs: { a: "#ff8000", b: "#808080" } }),
    ]);
    expect(run(g, "h.out")).toEqual([1, 0, 0, 0.5]);
    const green = run(g, "h2.out") as number[];
    expect(green[0]).toBeCloseTo(0);
    expect(green[1]).toBeCloseTo(1);
    const m = run(g, "mc.out") as number[];
    expect(m[0]).toBeCloseTo(128 / 255);
    expect(m[3]).toBe(1);
  });
});

describe("time and properties", () => {
  it("time nodes read the context", () => {
    const g = graph([node("t", "time"), node("d", "deltaTime"), node("p", "playTime")]);
    const c = ctx({ time: 4, deltaTime: 0.016, playTime: 1.5 });
    expect(run(g, "t.out", c)).toBe(4);
    expect(run(g, "d.out", c)).toBe(0.016);
    expect(run(g, "p.out", c)).toBe(1.5);
  });

  it("property reads the override, then the graph's value", () => {
    const props: GraphProperty[] = [
      { name: "Speed", type: "number", value: 2, exposed: true },
      { name: "Tint", type: "color", value: "#ff0000", exposed: true },
      { name: "Dir", type: "vector2", value: [1, 0], exposed: false },
      { name: "Tex", type: "texture", value: "", exposed: false },
    ];
    const g = graph([
      node("s", "property", { settings: { name: "Speed" } }),
      node("t", "property", { settings: { name: "Tint" } }),
      node("d", "property", { settings: { name: "Dir" } }),
      node("x", "property", { settings: { name: "Tex" } }),
      node("bad", "property", { settings: { name: "Nope" } }),
    ], [], props);
    expect(run(g, "s.out")).toBe(2);
    expect(run(g, "s.out", ctx({}, [["Speed", 7]]))).toBe(7);
    expect(run(g, "t.out")).toEqual([1, 0, 0, 1]);
    expect(run(g, "d.out")).toEqual([1, 0]);
    expect(outputType(g, g.nodes[0], "out")).toBe("number");
    expect(outputType(g, g.nodes[1], "out")).toBe("color");
    expect(outputType(g, g.nodes[3], "out")).toBeNull();
    expect(() => run(g, "x.out")).toThrow(/texture/);
    expect(() => run(g, "bad.out")).toThrow(/unknown property/);
  });
});

describe("sampling", () => {
  it("samples curves and gradients (wired or inline)", () => {
    const g = graph([
      node("c", "curve", { settings: { keys: [[0, 0], [1, 10]] } }),
      node("sc", "sampleCurve", { inputs: { t: 0.5 } }),
      node("sc2", "sampleCurve", { inputs: { t: 0.5, curve: { curve: [[0, 2], [1, 4]] } } }),
      node("g", "gradient", { settings: { gradient: { colors: [[0, "#000000"], [1, "#ffffff"]], alphas: [[0, 0], [1, 1]] } } }),
      node("sg", "sampleGradient", { inputs: { t: 0.5 } }),
    ], [edge("c.out", "sc.curve"), edge("g.out", "sg.gradient")]);
    expect(run(g, "sc.out")).toBe(5);
    expect(run(g, "sc2.out")).toBe(3);
    const col = run(g, "sg.out") as number[];
    expect(col[0]).toBeCloseTo(0.5);
    expect(col[3]).toBeCloseTo(0.5);
    // A Curve node is a per-particle source itself, but uniform as an operator's input.
    expect(portRate(g, "c.out")).toBe("particle");
    expect(portRate(g, "sc.out")).toBe("uniform");
    expect(run(g, "c.out")).toEqual({ curve: [[0, 0], [1, 10]] });
  });

  it("noise is deterministic, smooth and bounded", () => {
    const g = graph([node("n", "noise", { settings: { seed: 3 } }), node("n2", "noise", { settings: { seed: 4 } }), node("t", "time")], [edge("t.out", "n.x"), edge("t.out", "n2.x")]);
    const f = compileUniform(g, "n.out");
    const f2 = compileUniform(g, "n2.out");
    let prev = f(ctx({ time: 0 })) as number;
    let differs = false;
    for (let i = 1; i <= 2000; i++) {
      const t = i * 0.005;
      const v = f(ctx({ time: t })) as number;
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      expect(Math.abs(v - prev)).toBeLessThan(0.02);
      expect(f(ctx({ time: t }))).toBe(v);
      if (f2(ctx({ time: t })) !== v) differs = true;
      prev = v;
    }
    expect(differs).toBe(true);
  });
});

describe("rates", () => {
  it("propagates per-particle through operators only", () => {
    const g = graph([
      node("r", "randomRange"),
      node("t", "time"),
      node("m1", "multiply"),
      node("m2", "multiply"),
      node("inl", "multiply", { inputs: { a: { random: [0, 1] } } }),
    ], [edge("r.out", "m1.a"), edge("t.out", "m2.a")]);
    expect(portRate(g, "r.out")).toBe("particle");
    expect(portRate(g, "m1.out")).toBe("particle");
    expect(portRate(g, "m2.out")).toBe("uniform");
    expect(portRate(g, "t.out")).toBe("uniform");
    expect(portRate(g, "inl.out")).toBe("particle");
    expect(portRate(g, "missing.out")).toBe("uniform");
  });

  it("is safe on cycles", () => {
    const g = graph([node("a", "add"), node("b", "add")], [edge("a.out", "b.a"), edge("b.out", "a.a")]);
    expect(portRate(g, "a.out")).toBe("uniform");
  });
});

describe("whyNotConnect", () => {
  const g = graph([
    node("n", "constant.number"),
    node("v2", "constant.vector2"),
    node("v3", "constant.vector3"),
    node("c", "constant.color"),
    node("cv", "curve"),
    node("gr", "gradient"),
    node("ev", "event.play"),
    node("m", "multiply"),
    node("m2", "add"),
    node("len", "length"),
    node("sp", "split3"),
  ], [edge("m.out", "m2.a")]);

  it("requires matching types", () => {
    expect(whyNotConnect(g, "n.out", "m.a", "number")).toBeNull();
    expect(whyNotConnect(g, "c.out", "m.a", "number")).toMatch(/color/);
    expect(whyNotConnect(g, "n.out", "s1.b1.color", "color")).toMatch(/number/);
    expect(whyNotConnect(g, "c.out", "s1.b1.color", "color")).toBeNull();
    expect(whyNotConnect(g, "zz.out", "m.a", "number")).toMatch(/no node/);
    expect(whyNotConnect(g, "n.nope", "m.a", "number")).toMatch(/no output/);
    expect(whyNotConnect(g, "n.out", "m.zz", "number")).toMatch(/no input/);
  });

  it("broadcasts numbers into vectors, and vectors into math", () => {
    expect(whyNotConnect(g, "n.out", "s1.b1.velocity", "vector3")).toBeNull();
    expect(whyNotConnect(g, "n.out", "s1.b1.offset", "vector2")).toBeNull();
    expect(whyNotConnect(g, "v3.out", "s1.b1.size", "number")).toMatch(/vector3/);
    expect(whyNotConnect(g, "v3.out", "m.a", "number")).toBeNull();
    expect(whyNotConnect(g, "v2.out", "len.v", "vector3")).toBeNull();
    expect(whyNotConnect(g, "v2.out", "sp.v", "vector3")).toMatch(/vector2/);
  });

  it("only sends curves and gradients to curve and gradient inputs", () => {
    expect(whyNotConnect(g, "cv.out", "s1.b1.size", "curve")).toBeNull();
    expect(whyNotConnect(g, "gr.out", "s1.b1.color", "gradient")).toBeNull();
    expect(whyNotConnect(g, "cv.out", "m.a", "number")).toMatch(/curve or gradient/);
    expect(whyNotConnect(g, "gr.out", "s1.b1.color", "color")).toMatch(/curve or gradient/);
  });

  it("refuses cycles", () => {
    expect(whyNotConnect(g, "m2.out", "m.a", "number")).toMatch(/loop/);
    expect(whyNotConnect(g, "m.out", "m.b", "number")).toMatch(/loop/);
    expect(whyNotConnect(g, "m.out", "m2.b", "number")).toBeNull();
  });

  it("keeps events and values apart", () => {
    expect(whyNotConnect(g, "ev.out", "m.a", "number")).toMatch(/Events/);
    expect(whyNotConnect(g, "n.out", "s1.b1.trigger", "event")).toMatch(/Events/);
    expect(whyNotConnect(g, "ev.out", "s1.b1.trigger", "event")).toBeNull();
  });
});

describe("compileUniform", () => {
  it("matches a hand computation: sine(time x 2) x property", () => {
    const g = graph([
      node("t", "time"),
      node("m", "multiply", { inputs: { b: 2 } }),
      node("s", "sine"),
      node("p", "property", { settings: { name: "Amp" } }),
      node("o", "multiply"),
    ], [edge("t.out", "m.a"), edge("m.out", "s.x"), edge("s.out", "o.a"), edge("p.out", "o.b")], [{ name: "Amp", type: "number", value: 3, exposed: true }]);
    const f = compileUniform(g, "o.out");
    for (const time of [0, 0.3, 1.7]) {
      expect(f(ctx({ time }))).toBeCloseTo(Math.sin(time * 2) * 3);
    }
    expect(f(ctx({ time: 0.3 }, [["Amp", -1]]))).toBeCloseTo(-Math.sin(0.6));
    expect(outputType(g, g.nodes[4], "out")).toBe("number");
  });

  it("returns per-particle sources as values", () => {
    const g = graph([node("r", "randomRange", { inputs: { min: 1, max: 2 } })]);
    expect(run(g, "r.out")).toEqual({ random: [1, 2] });
  });

  it("throws on per-particle chains, cycles, unknown types, and events", () => {
    const g = graph([
      node("r", "randomRange"),
      node("m", "multiply"),
      node("a", "add"),
      node("b", "add"),
      node("u", "wat"),
      node("e", "event.play"),
    ], [edge("r.out", "m.a"), edge("a.out", "b.a"), edge("b.out", "a.a")]);
    expect(() => compileUniform(g, "m.out")).toThrow(/per-particle/);
    expect(() => compileUniform(g, "a.out")).toThrow(/loop/);
    expect(() => compileUniform(g, "u.out")).toThrow(/unknown type/);
    expect(() => compileUniform(g, "e.out")).toThrow(/event/);
    expect(() => compileUniform(g, "zz.out")).toThrow(/no node/);
  });
});
