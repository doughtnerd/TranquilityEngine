/**
 * What a generator plays when it is triggered (ADR 0346 §5, §7), pure given a draw function (the runtime passes the
 * World's seeded generator, so a take replays the same noise, variations and silences):
 *
 * - `varyGeneratorParams`: `vary` (0..1) moves each numeric parameter by up to `vary` × 5 % of its range, uniformly
 *   either way (a log parameter in log space, so a frequency moves by the same ratio anywhere). Choices, `length` and
 *   `lengthRandom` don't vary (they decide whether and when the voice ends). Locked parameters keep their values but
 *   their draws are still taken, so a lock changes no other parameter.
 * - `resolveGenerator`: the values a PLAY + GEN carries, in wire order: draws, in this order, the noise seed when
 *   `seed` is null, then `vary` (no draws when it is 0), then a silence's `length` ± `lengthRandom` (its resolved
 *   length replaces `length`, and `lengthRandom` is sent as 0).
 * - `generatorPatchText`: the resolved patch as canonical text (kind, wire-order values, seed), what the bake's
 *   `generated.hash` hashes (ADR 0346 §6) so "out of date" compares patches, not file formatting.
 *
 * Pure; no plugin, no DOM.
 */
import { clampGeneratorParam, generatorParamIndex, generatorSpec, generatorWireValues } from "./catalogue";
import { seedFrom, type Draw } from "./random";
import type { GeneratorBody, GeneratorKind } from "./types";

/** How far `vary` 1 moves a parameter: 5 % of its range. */
export const VARY_SPAN = 0.05;

/** Parameters `vary` never moves. */
const NOT_VARIED = new Set(["length", "lengthRandom"]);

/** `params` with `vary` applied (a new object; `params` unchanged). No draws when `vary` is 0. */
export function varyGeneratorParams(kind: GeneratorKind, params: Readonly<Record<string, number>>, vary: number, draw: Draw, locks: readonly string[] = []): Record<string, number> {
  const out: Record<string, number> = { ...params };
  if (!(vary > 0)) return out;
  const amount = Math.min(1, vary) * VARY_SPAN;
  for (const q of generatorSpec(kind).params) {
    if (q.choices || NOT_VARIED.has(q.name)) continue;
    const u = draw() * 2 - 1;
    if (locks.includes(q.name)) continue;
    const v = params[q.name] ?? q.default;
    if (q.scale === "log" && q.min > 0) {
      const span = Math.log(q.max / q.min);
      out[q.name] = clampGeneratorParam(q, Math.exp(Math.log(Math.max(q.min, v)) + u * amount * span));
    } else out[q.name] = clampGeneratorParam(q, v + u * amount * (q.max - q.min));
  }
  return out;
}

/** What one trigger of a generator plays. */
export interface ResolvedGenerator {
  kind: GeneratorKind;
  /** Every parameter in wire order (the catalogue's), fitted to its spec. */
  values: number[];
  /** The noise seed: the generator's, or drawn when it has none. */
  seed: number;
}

/** The values one trigger of `body` plays, drawing from `draw` (see the module note for the order). */
export function resolveGenerator(body: GeneratorBody, draw: Draw): ResolvedGenerator {
  const seed = body.seed ?? seedFrom(draw);
  const params = varyGeneratorParams(body.kind, body.params, body.vary, draw);
  const values = generatorWireValues(body.kind, params);
  if (body.kind === "silence") {
    const li = generatorParamIndex("silence", "length"), ri = generatorParamIndex("silence", "lengthRandom");
    const spread = values[ri];
    if (spread > 0) values[li] = clampGeneratorParam(generatorSpec("silence").params[li], values[li] + (draw() * 2 - 1) * spread);
    values[ri] = 0;
  }
  return { kind: body.kind, values, seed };
}

/** The resolved patch of `body` as canonical text (its stored values, not a trigger's draws). */
export function generatorPatchText(body: GeneratorBody): string {
  return JSON.stringify({ kind: body.kind, values: generatorWireValues(body.kind, body.params), seed: body.seed });
}
