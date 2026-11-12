// ADR 0166 M4b, task T2 (api-and-models §10 row T2; waves plan, Wave 8 exit "every seam nulls to 1e-5"): the seam
// goldens, wasm half. Each `golden/seams/seam-<case>.json` is a music seam as the whole runtime played it on the real core
// (`music/seam.test.ts` writes it with `UPDATE_GOLDENS=1`): the messages the core received, each at its frame. Replayed
// here on the committed wasm, the output must give the fixture's digest (the native half,
// `native/audio/crates/audio-core/tests/seam_goldens.rs`, must give the same: native equals wasm) and null to 1e-5
// against the fixture's offline reference of the intended mix (`seamReference.ts`: clip levels times Z3's same-knot
// control-rate fade laws).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fadeAt, fnv1a64, lawValue, replaySeam, seamNull, type SeamFixture } from "./seamReference";

/** A folder of their own: `audioGolden.test.ts` holds `golden/`'s top level to its own scenes plus the known prefixes. */
const SEAMS_DIR = fileURLToPath(new URL("./seams/", import.meta.url));

/** The row's seams: the cut, the three crossfade laws, a bridge (both legs), a loop exit with its tail, a stinger, a switch change. */
export const SEAM_CASES = [
  "seam-cut",
  "seam-crossfade-linear",
  "seam-crossfade-s-curve",
  "seam-crossfade-equal-power",
  "seam-bridge",
  "seam-loop-exit-tail",
  "seam-stinger",
  "seam-switch-default",
] as const;

function readSeam(name: string): SeamFixture {
  const path = `${SEAMS_DIR}${name}.json`;
  if (!existsSync(path)) throw new Error(`no golden/seams/${name}.json: run UPDATE_GOLDENS=1 npx vitest run src/plugins/audio/runtime/music/seam.test.ts`);
  return JSON.parse(readFileSync(path, "utf8")) as SeamFixture;
}

describe("seam goldens: the wasm replay gives the digest and nulls against the reference (T2)", () => {
  it("the reference: a fade holds a before F, takes the law's value at each knot, is linear between, and is b from F + N - 1", () => {
    const fade = { law: "equalPowerOut" as const, a: 1, b: 0, f: 1000, n: 2400 };
    const u = (x: number): number => 1 - (fade.f + fade.n - x) / fade.n;
    expect(fadeAt(fade, fade.f - 1)).toBe(1);
    // Knots at F, 1024 (the next quantum boundary) and 1152; frame t reads the curve at x = t + 1.
    expect(fadeAt(fade, 1023)).toBeCloseTo(Math.cos((u(1024) * Math.PI) / 2), 12);
    expect(fadeAt(fade, 1087)).toBeCloseTo((Math.cos((u(1024) * Math.PI) / 2) + Math.cos((u(1152) * Math.PI) / 2)) / 2, 12);
    expect(fadeAt(fade, fade.f + fade.n - 1)).toBe(0);
    // An equal-power pair keeps its power at a knot.
    const into = { ...fade, law: "equalPowerIn" as const, a: 0, b: 1 };
    expect(fadeAt(fade, 1151) ** 2 + fadeAt(into, 1151) ** 2).toBeCloseTo(1, 12);
    expect(lawValue("sCurve", 0, 1, 0.5)).toBe(0.5);
  });

  it.for(SEAM_CASES)("%s: the wasm digest is the fixture's, and both channels null to 1e-5", async (name) => {
    const fixture = readSeam(name);
    const { left, right } = await replaySeam(fixture);
    expect(left.length, `${name}: frames`).toBe(fixture.frames);
    expect(left.every(Number.isFinite) && right.every(Number.isFinite), `${name}: finite samples`).toBe(true);
    expect(fnv1a64(left, right), `${name}: digest`).toBe(fixture.fnv1a64);
    const { reference } = fixture;
    expect(reference.tolerance).toBe(1e-5);
    for (const [side, out] of [["left", left], ["right", right]] as const) {
      const { maxError, at } = seamNull(out, reference);
      expect(maxError, `${name}: ${side} null at frame ${at}`).toBeLessThanOrEqual(reference.tolerance);
    }
    // The seam is audible: not a null of silence against silence.
    let peak = 0;
    for (let t = reference.from; t < reference.to; t++) peak = Math.max(peak, Math.abs(left[t]!));
    expect(peak).toBeGreaterThan(0.1);
  });

  it("golden/seams/ holds no seam-*.json outside the cases", () => {
    const names = readdirSync(SEAMS_DIR)
      .filter((f) => /^seam-.*\.json$/.test(f))
      .map((f) => f.slice(0, -".json".length));
    for (const name of names) expect(SEAM_CASES, `${name}.json has no case`).toContain(name);
  });
});
