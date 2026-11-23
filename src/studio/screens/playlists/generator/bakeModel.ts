// Bake (ADR 0360 §6, §9) as the Studio calls it, and the provenance a baked sample's sidecar carries.
//
// The bake itself is G5's (`generators/bake.ts`, through the offline render). The Studio asks for one call:
// `bakeGenerator(path, options)`. Until G5 is merged `BAKE` is null and the Bake dialog and Rebake say why they are
// off (`bakeAvailability`); merging G5 sets `BAKE` to its function, nothing else changes here.
//
// Provenance: a sample baked from a generator has a sidecar `generated` block (`provenance.ts`): "Baked from
// coin.generator.json", and "out of date" when the generator's resolved patch no longer hashes to the block's `hash`
// (SHA-256 of `generatorPatchText`, so formatting and notes don't count). Pure.
import type { GeneratedProvenance } from "../../../../engine/audio/generators/provenance";
import { generatorPatchText } from "../../../../engine/audio/generators/resolve";
import type { GeneratorBody } from "../../../../engine/audio/generators/types";
import { sha256Hex } from "../../../../engine/localisation/textHash";

/** What the Bake dialog asks for (ADR 0360 §6). */
export interface BakeOptions {
  /** Seconds to render an endless generator for (it becomes a loop); ignored for one that ends. */
  readonly length?: number;
  /** How many files: seeds `seed`, `seed + 1`, … (1: one file). */
  readonly variations: number;
  /** Where the files go (project path; default beside the generator). */
  readonly folder: string;
  /** Also write a Queue playlist (random, avoid-repeat 1) over the variations. */
  readonly queue: boolean;
  /** Point the playlist entries that use the generator at the baked sample. */
  readonly replaceUses: boolean;
}

export interface BakeResult {
  /** The samples written. */
  readonly files: readonly string[];
  /** The Queue written, when asked. */
  readonly queue?: string;
}

/** G5's bake: render `path` (a `*.generator.json`) to samples with their sidecars. */
export type BakeGenerator = (path: string, options: BakeOptions) => Promise<BakeResult>;

/** The bake the Studio calls; null until G5's offline bake is merged. */
export const BAKE: BakeGenerator | null = null;

/** Why Bake is off when there is no bake yet. */
export const BAKE_PENDING = "Bake renders through the offline module, which isn't in this build yet (ADR 0360, G5).";

export interface Availability {
  readonly enabled: boolean;
  /** Why not (the button's tooltip), or null. */
  readonly reason: string | null;
}

/** Whether Bake can run for a generator at `path` (null: an embedded generator, which has no file to bake beside). */
export function bakeAvailability(bake: BakeGenerator | null, path: string | null, writable = true): Availability {
  if (!bake) return { enabled: false, reason: BAKE_PENDING };
  if (!path) return { enabled: false, reason: "An embedded generator has no file to bake beside: make it a file first." };
  if (!writable) return { enabled: false, reason: "This project is read-only." };
  return { enabled: true, reason: null };
}

/** The defaults the dialog opens with for a generator at `path`. */
export function defaultBakeOptions(path: string, endless: boolean): BakeOptions {
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return { ...(endless ? { length: 2 } : {}), variations: 1, folder, queue: false, replaceUses: false };
}

/** Options checked: variations 1..64, an endless one's length 0.05..60 s; a Queue only over several files. */
export function cleanBakeOptions(o: BakeOptions): BakeOptions {
  const variations = Math.max(1, Math.min(64, Math.round(Number.isFinite(o.variations) ? o.variations : 1)));
  const length = o.length === undefined ? undefined : Math.max(0.05, Math.min(60, Number.isFinite(o.length) ? o.length : 2));
  return { ...o, variations, ...(length === undefined ? {} : { length }), queue: o.queue && variations > 1 };
}

/** The hash a bake records: SHA-256 (hex) of the generator's resolved patch text. */
export const generatorPatchHash = (body: GeneratorBody): string => sha256Hex(new TextEncoder().encode(generatorPatchText(body)));

export interface ProvenanceView {
  readonly generator: string;
  /** "coin.generator.json". */
  readonly name: string;
  readonly state: "current" | "outOfDate" | "missing";
  /** "Baked from coin.generator.json", then " · variation 2" for one of several. */
  readonly text: string;
  /** The state as words ("out of date"), or null when current. */
  readonly note: string | null;
  readonly rebake: Availability;
}

/** What the Samples inspector says about a sample's `generated` block (`load` reads the generator now, null if gone). */
export function provenanceView(g: GeneratedProvenance | null, load: (path: string) => GeneratorBody | null, bake: BakeGenerator | null, writable = true): ProvenanceView | null {
  if (!g) return null;
  const name = g.generator.slice(g.generator.lastIndexOf("/") + 1);
  const body = load(g.generator);
  const state = !body ? "missing" : g.hash !== "" && generatorPatchHash(body) === g.hash ? "current" : "outOfDate";
  const text = `Baked from ${name}${g.variation > 0 ? ` · variation ${g.variation + 1}` : ""}`;
  const note = state === "missing" ? "the generator is gone" : state === "outOfDate" ? "out of date" : null;
  const rebake = state === "missing" ? { enabled: false, reason: `${g.generator} isn't in the project any more.` } : bakeAvailability(bake, g.generator, writable);
  return { generator: g.generator, name, state, text, note, rebake };
}
