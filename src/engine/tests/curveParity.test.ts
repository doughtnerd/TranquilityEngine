// The engine curve's parity fixture (ADR 0370 "Crates", audio ADR 0346): `evalCurve`'s values on a fixed set of curves
// and inputs, written to native/common/curve/tests/parity.txt, which the shared Rust evaluator (`myco-curve`,
// tests/parity.rs) reads and must reproduce: exactly in f64, within a stated tolerance in f32. This test fails when
// curve.ts's numbers drift from the file; rewrite it with MYCO_CURVE_PARITY_WRITE=1 and then run `cargo test` in
// native/common/curve. Skipped when native/ is absent (an exported project, a package).
//
// Inputs are f32 values (Math.fround), so both forms read the same keys and the f32 form's error is its arithmetic only.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { curveKeyHandles, curveKeyInterpCode, evalCurve, type Curve, type CurveInterp, type CurveKey } from "../core/curve";

const fixture = fileURLToPath(new URL("../../../native/common/curve/tests/parity.txt", import.meta.url));
const f = Math.fround;

/** A deterministic generator (an LCG), so the file is the same on every machine. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const SHAPES: readonly CurveInterp[] = ["linear", "step", "smooth", "easeIn", "easeOut"];

/** The hand-written cases (curve.test.ts's), then seeded random curves of every key form. */
function cases(): [string, Curve][] {
  const bez = (x: number, y: number, inH: [number, number], outH: [number, number]): CurveKey => [x, y, "bezier", { in: inH, out: outH }];
  const out: [string, Curve][] = [
    ["empty", []],
    ["one_key", [[2, 3]]],
    ["linear", [[0, 0], [10, 1], [12, -4]]],
    ["step", [[0, 1, "step"], [1, 5], [2, 0, "step"], [3, 2]]],
    ["smooth", [[0, 0, "smooth"], [1, 1]]],
    ["ease_in", [[0, 0, "easeIn"], [1, 1]]],
    ["ease_out", [[0, 0, "easeOut"], [2, 3]]],
    ["jump_at_same_x", [[0, 0], [1, 1], [1, 4], [2, 4]]],
    ["bezier_on_the_line", [bez(0, 0, [0, 0], [1, 1]), bez(3, 3, [-1, -1], [0, 0])]],
    ["bezier_before_plain", [bez(0, 0, [0, 0], [f(1 / 3), 0]), [1, 1]]],
    ["bezier_clamped_overshoot", [bez(0, 0, [0, 0], [9, 2]), bez(1, 1, [-9, 2], [0, 0])]],
    ["bezier_chain", [bez(-1, 2, [0, 0], [0.5, 3]), bez(0.5, -1, [-0.25, 1], [0.375, -2]), bez(2, 0, [-1.5, 0.5], [0.75, 0.5]), [3, 1, "easeIn"], [4, -2]]],
    ["long_linear", Array.from({ length: 64 }, (_, i): CurveKey => [i, i * 2])],
  ];
  const rand = lcg(0x70a);
  const value = (lo: number, hi: number) => f(lo + (hi - lo) * rand());
  for (let c = 0; c < 48; c++) {
    const n = 2 + Math.floor(rand() * 11);
    const keys: CurveKey[] = [];
    let x = value(-5, 5);
    for (let k = 0; k < n; k++) {
      if (k > 0 && rand() > 0.1) x = f(x + value(0.05, 3));
      const y = value(-10, 10);
      const r = rand();
      if (r < 0.45) keys.push(bez(x, y, [value(-3, 1), value(-5, 5)], [value(-1, 3), value(-5, 5)]));
      else if (r < 0.6) keys.push([x, y]);
      else keys.push([x, y, SHAPES[Math.floor(rand() * SHAPES.length)]!]);
    }
    out.push([`random_${c}`, keys]);
  }
  return out;
}

/** The inputs a curve is read at: a sweep past both ends, every key's x and the f32 just after it, NaN and ±∞. */
function inputs(curve: Curve): number[] {
  const lo = (curve[0]?.[0] ?? 0) - 1;
  const hi = (curve[curve.length - 1]?.[0] ?? 1) + 1;
  const xs = Array.from({ length: 97 }, (_, i) => f(lo + ((hi - lo) * i) / 96));
  for (const k of curve) {
    xs.push(k[0]);
    const bits = new Float32Array([k[0]]);
    const word = new Uint32Array(bits.buffer);
    word[0] = word[0]! + (k[0] >= 0 ? 1 : -1);
    xs.push(bits[0]!);
  }
  xs.push(NaN, Infinity, -Infinity);
  return xs;
}

/** The fixture's text: `curve <name>`, then `key x y interp inDx inDy outDx outDy` and `at x y` lines. */
function render(): string {
  const lines = [
    "# The engine curve's parity fixture: written by src/engine/tests/curveParity.test.ts from src/engine/core/curve.ts",
    "# (MYCO_CURVE_PARITY_WRITE=1), read by tests/parity.rs. Do not edit by hand.",
    "# key: x y interp(0 linear, 1 step, 2 smooth, 3 easeIn, 4 easeOut, 5 bezier) inDx inDy outDx outDy",
    "# at: x evalCurve(x), in f64 (JavaScript's shortest round-trip form)",
  ];
  for (const [name, curve] of cases()) {
    lines.push(`curve ${name}`);
    for (const k of curve) {
      const h = curveKeyHandles(k);
      const hs = h ? [h.in[0], h.in[1], h.out[0], h.out[1]] : [0, 0, 0, 0];
      lines.push(`key ${k[0]} ${k[1]} ${curveKeyInterpCode(k)} ${hs.join(" ")}`);
    }
    for (const x of inputs(curve)) lines.push(`at ${x} ${evalCurve(curve, x)}`);
  }
  return lines.join("\n") + "\n";
}

describe.skipIf(!existsSync(fixture.replace(/tests[\\/]parity\.txt$/, "")))("curve parity fixture", () => {
  it("matches evalCurve (else: MYCO_CURVE_PARITY_WRITE=1, then cargo test in native/common/curve)", () => {
    const text = render();
    if (process.env.MYCO_CURVE_PARITY_WRITE === "1") writeFileSync(fixture, text);
    expect(existsSync(fixture), "native/common/curve/tests/parity.txt is missing").toBe(true);
    expect(readFileSync(fixture, "utf8").replace(/\r\n/g, "\n") === text, "parity.txt differs from evalCurve's numbers").toBe(true);
  });
});
