/**
 * ADR 0346 §6 (amending 0328 and 0040): the sidecar's optional `generated` block, written beside a sample baked from a
 * generator, so the Samples screen can say "Baked from coin.generator.json" and "out of date" when the patch changed.
 *
 * ```jsonc
 * "generated": { "generator": "audio/ui/coin.generator.json", "hash": "<sha256 of the resolved patch>", "seed": 1734, "variation": 0 }
 * ```
 *
 * - `generator`: the generator's project path (a reference string, so a move rewrites it like any sidecar path);
 * - `hash`: the hash of `generatorPatchText` at bake time (hex);
 * - `seed`: the seed the bake rendered (u32);
 * - `variation`: which of a "Bake variations" run this file is (0, 1, …; its seed is the generator's seed + variation).
 *
 * The parse is lenient: a block without a generator path is dropped with a problem; other bad values take their
 * defaults with a problem. Pure; no plugin, no DOM.
 */
import { isFiniteNumber, isRecord, LenientReader, type JsonRecord } from "../lenientRead";
import { MAX_SEED } from "./random";

export interface GeneratedProvenance {
  generator: string;
  hash: string;
  seed: number;
  variation: number;
}

/** The block from JSON, or null (absent, or dropped with a problem). Problem lines start with `where`. */
export function parseGeneratedProvenance(raw: unknown, where: string, problems: string[]): GeneratedProvenance | null {
  if (raw === undefined || raw === null) return null;
  const r = new LenientReader(problems);
  if (!isRecord(raw) || typeof raw.generator !== "string" || raw.generator === "") {
    r.problem(where, 'needs a "generator" path; dropped.');
    return null;
  }
  let seed = 0;
  if (raw.seed !== undefined) {
    if (isFiniteNumber(raw.seed) && Number.isInteger(raw.seed) && raw.seed >= 0 && raw.seed <= MAX_SEED) seed = raw.seed;
    else r.problem(`${where}.seed`, `must be a whole number 0..${MAX_SEED}; using 0.`);
  }
  return {
    generator: raw.generator,
    hash: r.str(raw.hash, `${where}.hash`, ""),
    seed,
    variation: r.int(raw.variation, `${where}.variation`, 0, 0, 9999),
  };
}

/** The block as JSON (every key: the block is small and always written whole). */
export const generatedProvenanceToJson = (g: GeneratedProvenance): JsonRecord => ({ generator: g.generator, hash: g.hash, seed: g.seed, variation: g.variation });
