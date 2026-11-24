// Bake (ADR 0360 §6, §9) as the Studio calls it, and the provenance a baked sample's sidecar carries.
//
// The bake itself is G5's (`generators/bake.ts`, through the offline render). The Studio asks for one call:
// `bakeGenerator(path, options)` (`BakeGenerator`; `studioBake` adapts G5's own). `BAKE` is that call over the Studio's
// open project (`projectBakeHost`); with no project open it rejects, and the Bake dialog and Rebake say why they are
// off (`bakeAvailability`).
//
// Provenance: a sample baked from a generator has a sidecar `generated` block (`provenance.ts`): "Baked from
// coin.generator.json", and "out of date" when the generator's resolved patch no longer hashes to the block's `hash`
// (SHA-256 of `generatorPatchText`, so formatting and notes don't count). Rebake renders the sample's variation again
// over its own file (`rebakeOptions`). The rules here are pure; `BAKE` is the one binding to the project.
import { audioProject } from "../../../shell/audioProject";
import { bakeGenerator, generatorPatchHash } from "../../../../engine/audio/generators/bake";
import type { GeneratedProvenance } from "../../../../engine/audio/generators/provenance";
import type { GeneratorBody } from "../../../../engine/audio/generators/types";
import { projectBakeHost } from "./projectBakeHost";

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
  /** Rebake: the first variation's index (default 0; variation i plays seed `seed + i`). */
  readonly variation?: number;
  /** Rebake: the files to overwrite, in variation order, instead of free names. */
  readonly paths?: readonly string[];
}

export interface BakeResult {
  /** The samples written. */
  readonly files: readonly string[];
  /** The Queue written, when asked. */
  readonly queue?: string;
}

/** G5's bake: render `path` (a `*.generator.json`) to samples with their sidecars. */
export type BakeGenerator = (path: string, options: BakeOptions) => Promise<BakeResult>;

/** The offline bake's own call as the Studio relies on it (G5's `bakeGenerator`, structurally). */
export type OfflineBake<H> = (
  path: string,
  options: {
    readonly host: H;
    readonly variations?: number;
    readonly variation?: number;
    readonly paths?: readonly string[];
    readonly seconds?: number;
    readonly folder?: string;
    readonly queue?: boolean;
    readonly replaceUses?: boolean;
  },
) => Promise<{ readonly files: readonly { readonly path: string }[]; readonly queue: string | null } | { readonly refused: string }>;

/**
 * The Studio's `bakeGenerator(path, options)` over the offline bake: the dialog's options as its options, its files as
 * paths, and a refusal as a rejection (the screen's toast says why). `host` gives the project to write to (null: none
 * open, which rejects).
 */
export function studioBake<H>(bake: OfflineBake<H>, host: () => H | null): BakeGenerator {
  return async (path, o) => {
    const h = host();
    if (h === null) throw new Error("no project is open");
    const c = cleanBakeOptions(o);
    const r = await bake(path, {
      host: h, variations: c.variations, ...(c.length !== undefined ? { seconds: c.length } : {}), folder: c.folder, queue: c.queue, replaceUses: c.replaceUses,
      ...(c.variation ? { variation: c.variation } : {}), ...(c.paths ? { paths: c.paths } : {}),
    });
    if ("refused" in r) throw new Error(r.refused);
    return { files: r.files.map((f) => f.path), ...(r.queue ? { queue: r.queue } : {}) };
  };
}

/** The bake the Studio calls: G5's offline bake over the open project (rejects with none open). */
export const BAKE: BakeGenerator | null = studioBake(bakeGenerator, () => {
  const p = audioProject.peek();
  return p ? projectBakeHost(p) : null;
});

/** Why Bake is off in a build without a bake. */
export const BAKE_PENDING = "Bake renders through the offline module, which isn't in this build.";
/** Why Bake is off with no project open. */
export const NO_PROJECT = "Open a project to bake into.";

export interface Availability {
  readonly enabled: boolean;
  /** Why not (the button's tooltip), or null. */
  readonly reason: string | null;
}

/**
 * Whether Bake can run for a generator at `path` (null: an embedded generator, which has no file to bake beside);
 * `writable` is whether the open project can be written, null when no project is open.
 */
export function bakeAvailability(bake: BakeGenerator | null, path: string | null, writable: boolean | null = true): Availability {
  if (!bake) return { enabled: false, reason: BAKE_PENDING };
  if (writable === null) return { enabled: false, reason: NO_PROJECT };
  if (!path) return { enabled: false, reason: "An embedded generator has no file to bake beside: make it a file first." };
  if (!writable) return { enabled: false, reason: "This project is read-only." };
  return { enabled: true, reason: null };
}

/** The defaults the dialog opens with for a generator at `path`. */
export function defaultBakeOptions(path: string, endless: boolean): BakeOptions {
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return { ...(endless ? { length: 2 } : {}), variations: 1, folder, queue: false, replaceUses: false };
}

/**
 * Rebake's options for `sample`, baked from `g`: the sample's own variation rendered again over the sample (and its
 * sidecar), from the generator as it is now. `loopSeconds` is the sample's loop length when it is a baked endless
 * generator (the loop keeps its length; default the dialog's 2 s).
 */
export function rebakeOptions(sample: string, g: GeneratedProvenance, endless: boolean, loopSeconds?: number): BakeOptions {
  const folder = sample.includes("/") ? sample.slice(0, sample.lastIndexOf("/")) : "";
  const length = endless ? (loopSeconds !== undefined && loopSeconds > 0 ? loopSeconds : 2) : undefined;
  return { ...(length !== undefined ? { length } : {}), variations: 1, folder, queue: false, replaceUses: false, ...(g.variation > 0 ? { variation: g.variation } : {}), paths: [sample] };
}

/** Options checked: variations 1..64, an endless one's length 0.05..60 s; a Queue only over several files. */
export function cleanBakeOptions(o: BakeOptions): BakeOptions {
  const variations = Math.max(1, Math.min(64, Math.round(Number.isFinite(o.variations) ? o.variations : 1)));
  const length = o.length === undefined ? undefined : Math.max(0.05, Math.min(60, Number.isFinite(o.length) ? o.length : 2));
  const variation = o.variation === undefined ? undefined : Math.max(0, Math.min(63, Math.round(Number.isFinite(o.variation) ? o.variation : 0)));
  return { ...o, variations, ...(length === undefined ? {} : { length }), ...(variation === undefined ? {} : { variation }), queue: o.queue && variations > 1 };
}

/** The hash a bake records: SHA-256 (hex) of the generator's resolved patch text. */
export { generatorPatchHash };

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
export function provenanceView(g: GeneratedProvenance | null, load: (path: string) => GeneratorBody | null, bake: BakeGenerator | null, writable: boolean | null = true): ProvenanceView | null {
  if (!g) return null;
  const name = g.generator.slice(g.generator.lastIndexOf("/") + 1);
  const body = load(g.generator);
  const state = !body ? "missing" : g.hash !== "" && generatorPatchHash(body) === g.hash ? "current" : "outOfDate";
  const text = `Baked from ${name}${g.variation > 0 ? ` · variation ${g.variation + 1}` : ""}`;
  const note = state === "missing" ? "the generator is gone" : state === "outOfDate" ? "out of date" : null;
  const rebake = state === "missing" ? { enabled: false, reason: `${g.generator} isn't in the project any more.` } : bakeAvailability(bake, g.generator, writable);
  return { generator: g.generator, name, state, text, note, rebake };
}
