/**
 * Contract (ADR 0346 §1): the generator asset, `*.generator.json` (`myco.generator@1`). One generator per file; an
 * embedded generator (a playlist's generator entry, a sequence clip's generator source) is the same object without
 * `format`. These are the parsed (canonical) shapes the parse (`format.ts`) produces and the writer writes.
 *
 * ```jsonc
 * {
 *   "format": "myco.generator@1",
 *   "kind": "blip",                 // oscillator | synth | blip | silence
 *   "params": { "waveform": "square", "baseFrequency": 0.42, "slide": 0.18, "decay": 0.31 },
 *   "seed": 1734,                   // the randomiser's and the noise's seed; null (absent): drawn per trigger
 *   "preset": "coin",               // blip and synth: the preset it was made from (display only)
 *   "vary": 0,                      // 0..1: per-trigger variation drawn from the World's generator
 *   "note": "Shop purchase"
 * }
 * ```
 *
 * `params` holds every parameter of the kind (the parse fills missing ones with the catalogue's defaults), by name;
 * a choice parameter (`waveform`) is its option's index in memory and its option's name in the file.
 *
 * Pure; no plugin, no DOM.
 */

export const GENERATOR_FORMAT = "myco.generator@1";
export const GENERATOR_SUFFIX = ".generator.json";

/** The generator kinds, in the order of their reserved clip ids (ADR 0346 §3: `GEN_CLIP_ID_FIRST` + 1, + 2, …). */
export const GENERATOR_KINDS = ["oscillator", "synth", "blip", "silence"] as const;
export type GeneratorKind = (typeof GENERATOR_KINDS)[number];

/** A generator without its `format` line: what an embedded generator holds. */
export interface GeneratorBody {
  kind: GeneratorKind;
  /** Every parameter of the kind, by name (a choice is its option's index). */
  params: Record<string, number>;
  /** 0..2³²−1: the blip randomiser's seed and the noise seed; null: the noise seed is drawn per trigger. */
  seed: number | null;
  /** Blip and synth: the preset it was made from (display only). */
  preset?: string;
  /** 0..1: per trigger, each numeric parameter moves by up to `vary` × 5 % of its range (`vary.ts`). */
  vary: number;
  /** A help note. */
  note?: string;
}

/** The asset file. */
export interface GeneratorAsset extends GeneratorBody {
  format: typeof GENERATOR_FORMAT;
}

/** What the parse returns (lenient: never throws). */
export interface GeneratorParse {
  generator: GeneratorAsset;
  problems: string[];
}
