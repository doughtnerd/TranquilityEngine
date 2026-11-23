/**
 * Internal (ADR 0360 §6): **Bake to sample**, what the Studio's Bake dialog runs. A generator is rendered by the offline
 * module (`generatorRender.ts`, the core's own kernels) and written as an ordinary sample beside it:
 *
 * - **`<name>.baked.wav`** (32-bit float, mono, 48 kHz: owner decision 8), `<name>.baked2.wav`, … when taken (each
 *   variation takes the next free name; `paths` overwrites chosen files instead, for Rebake);
 * - **its sidecar** (`<file>.meta.json`, `myco.import@1`) with a `sample` block (kind `oneshot` and the root note from
 *   the frequency; an endless generator baked for `seconds` is kind `loop` with one loop crossfaded over its last 50 ms)
 *   and the **`generated`** block: the generator's path, the SHA-256 of its `generatorPatchText` (so "out of date"
 *   compares patches, not file formatting), the seed rendered and the variation;
 * - **variations**: N files from seeds `seed`, `seed + 1`, …. Variation 0 is the stored patch exactly. Variation i > 0
 *   of a blip with no `vary` is the stored blip *mutated* with seed `seed + i` (sfxr's Mutate: every number nudged, the
 *   user's edits kept); any other is the patch with `vary` drawn from mulberry32(`seed + i`), as a trigger would. Each
 *   plays noise seeded `seed + i`;
 * - optionally **a Queue playlist** over the files (`<name>.baked.playlist.json`; random, avoid-repeat 1: the sfxr
 *   variety workflow);
 * - optionally **Replace uses**: every playlist entry and sequence clip that links the generator is pointed at the bake
 *   (the Queue when there is one and the place can hold a playlist: a sequence clip, or an embedded Clip whose source is
 *   the generator; else the first file) and loses its `gen:` curves, through the host's project edit (the editor's
 *   `editProjectFiles`: one undo step per file, ADR 0360 §6).
 *
 * `isBakeStale` is the Samples screen's "out of date" badge: the sidecar's hash against the generator's patch now.
 *
 * The bake reads and writes only through its `BakeHost`; no plugin, no DOM.
 */
import { sha256Hex } from "../../localisation/textHash";
import { defaultImportSettings, formatImportSettings, sidecarPath, type ImportSettings } from "../../scene/importSettings";
import { defaultEntryUse, emptyPlaylistBody, formatPlaylist } from "../playlist/format";
import type { EmbeddedEntry, SampleEntry } from "../playlist/types";
import { defaultSampleEdits } from "../sample/format";
import { midiToNoteName } from "../sample/noteNames";
import type { SampleEdits } from "../sample/types";
import { encodeWavFloat32 } from "../sample/wavEncode";
import { mutateBlip } from "./blipPresets";
import { generatorParamIndex } from "./catalogue";
import { parseGenerator } from "./format";
import { GENERATOR_RENDER_RATE, renderResolvedGenerator, type RenderedGenerator } from "./generatorRender";
import type { GeneratedProvenance } from "./provenance";
import { MAX_SEED, mulberry32 } from "./random";
import { generatorPatchText, resolveGenerator, type ResolvedGenerator } from "./resolve";
import { GENERATOR_SUFFIX, type GeneratorBody } from "./types";

/** The most variations one bake renders. */
export const MAX_BAKE_VARIATIONS = 64;

/**
 * One edit across the project's JSON files, in the shape the editor's `editProjectFiles` applies (`ProjectFileEdit`):
 * each file's owner applies it (an open asset document as an undo step of its own history).
 */
export interface BakeUsesEdit {
  /** Only files whose text this accepts are parsed. */
  mentioned(text: string): boolean;
  scene(file: unknown): null;
  settings(json: Record<string, unknown>): null;
  /** A JSON file by its project path: its new value, or null for no change. */
  json(json: unknown, path: string): unknown;
}

/** Where a bake reads and writes (the Studio's project). */
export interface BakeHost {
  /** The project's files (project paths), to find free names. */
  readonly files: readonly string[];
  /** A text file's contents, or null when it can't be read. */
  readText(path: string): Promise<string | null>;
  writeBinary(path: string, bytes: Uint8Array): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  /**
   * Applies `edit` to the project's JSON files as an undoable edit labelled `label` (the editor's `editProjectFiles`);
   * resolves to the files changed. Needed only for `replaceUses`.
   */
  editProjectFiles?(edit: BakeUsesEdit, label: string): Promise<readonly string[]>;
}

export interface BakeOptions {
  readonly host: BakeHost;
  /** The generator's patch; default: read from `path` through the host. */
  readonly body?: GeneratorBody;
  /** 1..`MAX_BAKE_VARIATIONS`; default 1. */
  readonly variations?: number;
  /** The first variation's seed; default the generator's, else drawn. */
  readonly seed?: number;
  /** An endless generator's length (default 2 s, then a loop); a cap on a finite one. */
  readonly seconds?: number;
  /** The folder the files go in (a project path); default the generator's. */
  readonly folder?: string;
  /** The files to write, in variation order, instead of free names (Rebake overwrites its file). */
  readonly paths?: readonly string[];
  /** Also write a Queue playlist (random, avoid-repeat 1) over the files. Default false. */
  readonly queue?: boolean;
  /** Point the generator's uses at the bake (needs `host.editProjectFiles`). Default false. */
  readonly replaceUses?: boolean;
  /** Hz; default 48,000 (owner decision 8). */
  readonly rate?: number;
}

export interface BakedFile {
  readonly path: string;
  readonly sidecar: string;
  readonly seed: number;
  readonly variation: number;
  readonly frames: number;
}

export type BakeResult =
  | {
      readonly files: readonly BakedFile[];
      /** The Queue playlist written, else null. */
      readonly queue: string | null;
      /** The files Replace uses changed (empty when it didn't run or found none). */
      readonly replaced: readonly string[];
      /** The patch hash every sidecar carries. */
      readonly hash: string;
      readonly warnings: readonly string[];
    }
  | { readonly refused: string };

/** The SHA-256 (hex) of `body`'s `generatorPatchText`: what `generated.hash` holds. */
export const generatorPatchHash = (body: GeneratorBody): string => sha256Hex(new TextEncoder().encode(generatorPatchText(body)));

/**
 * True when a baked sample's sidecar says it came from a patch other than `generator` (the "out of date" badge). A
 * sidecar without a `generated` block is never stale.
 */
export function isBakeStale(sidecar: Pick<ImportSettings, "generated"> | { generated?: GeneratedProvenance | null }, generator: GeneratorBody): boolean {
  const g = sidecar.generated;
  return !!g && g.hash !== generatorPatchHash(generator);
}

const folderOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash + 1) : "";
};

/** The generator's name: its file name without `.generator.json`. */
function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.toLowerCase().endsWith(GENERATOR_SUFFIX) ? name.slice(0, -GENERATOR_SUFFIX.length) : name.replace(/\.[^.]+$/, "");
}

/** The first free `<folder><stem>.baked<n><ext>` (n omitted for 1) not in `taken` (lower-cased). */
function freePath(folder: string, stem: string, ext: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const path = `${folder}${stem}.baked${n === 1 ? "" : n}${ext}`;
    if (!taken.has(path.toLowerCase())) {
      taken.add(path.toLowerCase());
      return path;
    }
  }
}

/** The pitch a render sounds at, Hz (an oscillator's or synth's `frequency`, a blip's sfxr base frequency), or null. */
function fundamental(r: ResolvedGenerator): number | null {
  const at = (name: string): number | null => {
    const i = generatorParamIndex(r.kind, name);
    return i >= 0 ? (r.values[i] ?? null) : null;
  };
  if (r.kind === "oscillator" || r.kind === "synth") {
    // Noise has no pitch.
    if (r.kind === "oscillator" && at("waveform") === 4) return null;
    return at("frequency");
  }
  if (r.kind === "blip") {
    const b = at("baseFrequency");
    if (b === null || at("waveform") === 3) return null;
    // sfxr: a period of 100 / (f² + 0.001) supersampled steps (an integer, at least 8); frequency = 8 × 44,100 / period.
    const period = Math.max(8, Math.floor(100 / (b * b + 0.001)));
    return (8 * 44_100) / period;
  }
  return null;
}

/** The root note of `hz` (nearest note and cents), or null. */
function rootOf(hz: number | null): SampleEdits["root"] {
  if (hz === null || !(hz > 0)) return null;
  const midi = 69 + 12 * Math.log2(hz / 440);
  const note = Math.round(midi);
  const name = midiToNoteName(note);
  return name ? { note: name, cents: Math.round((midi - note) * 100), source: "set" } : null;
}

/** The sidecar text of one baked file. */
function sidecarText(r: RenderedGenerator, resolved: ResolvedGenerator, generated: GeneratedProvenance): string {
  const settings = defaultImportSettings();
  const sample = defaultSampleEdits(r.loop ? "loop" : "oneshot");
  sample.root = rootOf(fundamental(resolved));
  if (r.loop) {
    sample.loops.push({
      id: "l1", start: r.loop.start / r.rate, end: r.loop.end / r.rate, direction: "forward", crossfadeMs: 0, count: 0,
      active: "always", exit: "finish", exitFadeMs: 40, reentry: "ignore", file: null,
    });
  }
  settings.sample = sample;
  settings.generated = generated;
  return formatImportSettings(settings);
}

/** The patch variation `i` of a bake plays (see the file note). */
function variationOf(body: GeneratorBody, seed: number, i: number): ResolvedGenerator {
  const s = (seed + i) >>> 0;
  if (i === 0) return resolveGenerator({ ...body, seed: s, vary: 0 }, mulberry32(s));
  if (body.kind === "blip" && !(body.vary > 0)) return resolveGenerator({ ...mutateBlip({ ...body, seed: s }), seed: s, vary: 0 }, mulberry32(s));
  return resolveGenerator({ ...body, seed: s }, mulberry32(s));
}

/** `value` with every `gen:` curve dropped from `curves` (an entry) and `gen:` lanes from `automation` (a clip). */
function withoutGenCurves(o: Record<string, unknown>): Record<string, unknown> {
  const out = { ...o };
  if (out.curves && typeof out.curves === "object" && !Array.isArray(out.curves)) {
    const curves = Object.fromEntries(Object.entries(out.curves as Record<string, unknown>).filter(([k]) => !k.startsWith("gen:")));
    if (Object.keys(curves).length > 0) out.curves = curves;
    else delete out.curves;
  }
  if (Array.isArray(out.automation)) {
    out.automation = (out.automation as unknown[]).filter((a) => !(a && typeof a === "object" && typeof (a as { target?: unknown }).target === "string" && (a as { target: string }).target.startsWith("gen:")));
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** True for a playlist body (JSON) that is a Clip whose entries link `generator`. */
const clipOf = (body: unknown, generator: string): boolean =>
  isObject(body) && body.type === "clip" && Array.isArray(body.entries) && body.entries.some((e) => isObject(e) && e.generator === generator);

/**
 * `json` (a playlist file) with every link to `generator` pointed at `sample`, or at `queue` where a playlist may stand
 * (see the file note); null when nothing links it.
 */
export function replaceGeneratorUsesInJson(json: unknown, generator: string, sample: string, queue: string | null): unknown {
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      let any = false;
      const out = v.map((x) => {
        const y = walk(x);
        if (y !== x) any = true;
        return y;
      });
      return any ? out : v;
    }
    if (!isObject(v)) return v;
    // An embedded Clip whose source is the generator: the entry links the Queue instead (its use kept).
    if (queue && clipOf(v.embedded, generator)) {
      changed = true;
      const { embedded: _embedded, ...use } = v;
      return { playlist: queue, ...withoutGenCurves(use) };
    }
    if (v.generator === generator) {
      changed = true;
      const { generator: _generator, ...rest } = withoutGenCurves(v);
      // A sequence clip (it has `at`) may play a playlist; an entry in a Clip plays a sample.
      return queue && "at" in v ? { playlist: queue, ...rest } : { sample, ...rest };
    }
    let any = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const y = walk(x);
      if (y !== x) any = true;
      out[k] = y;
    }
    return any ? out : v;
  };
  const next = walk(json);
  return changed ? next : null;
}

/** The project edit Replace uses applies: playlist files that link `generator` (see `replaceGeneratorUsesInJson`). */
export function replaceGeneratorUses(generator: string, sample: string, queue: string | null = null): BakeUsesEdit {
  const quoted = JSON.stringify(generator);
  return {
    mentioned: (text) => text.includes(quoted),
    scene: () => null,
    settings: () => null,
    json: (json, path) => (path.toLowerCase().endsWith(".playlist.json") ? replaceGeneratorUsesInJson(json, generator, sample, queue) : null),
  };
}

/** The file name of `path`. */
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Bakes the generator at `path` (see the file note). */
export async function bakeGenerator(path: string, options: BakeOptions): Promise<BakeResult> {
  const host = options.host;
  const warnings: string[] = [];
  let body = options.body;
  if (!body) {
    const text = await host.readText(path);
    if (text === null) return { refused: `${path} can't be read` };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { refused: `${path} isn't valid JSON` };
    }
    const parsed = parseGenerator(raw, path);
    warnings.push(...parsed.problems);
    body = parsed.generator;
  }
  if (body.kind === "silence") return { refused: "a silence has nothing to bake" };
  if (options.replaceUses && !host.editProjectFiles) return { refused: "Replace uses needs a project to edit" };
  const count = Math.max(1, Math.min(MAX_BAKE_VARIATIONS, Math.floor(options.variations ?? 1)));
  const seed = (options.seed ?? body.seed ?? Math.floor(Math.random() * (MAX_SEED + 1))) >>> 0;
  const rate = options.rate && options.rate > 0 ? options.rate : GENERATOR_RENDER_RATE;
  const hash = generatorPatchHash(body);
  const folder = options.folder !== undefined ? (options.folder === "" || options.folder.endsWith("/") ? options.folder : `${options.folder}/`) : folderOf(path);
  const stem = stemOf(path);
  const taken = new Set(host.files.map((f) => f.toLowerCase()));
  const files: BakedFile[] = [];
  for (let i = 0; i < count; i++) {
    const resolved = variationOf(body, seed, i);
    const render = await renderResolvedGenerator(resolved, { rate, seconds: options.seconds, loop: "region" });
    warnings.push(...render.warnings);
    const out = options.paths?.[i] ?? freePath(folder, stem, ".wav", taken);
    const generated: GeneratedProvenance = { generator: path, hash, seed: resolved.seed, variation: i };
    await host.writeBinary(out, encodeWavFloat32(render.pcm, 1, rate));
    const sidecar = sidecarPath(out);
    await host.writeText(sidecar, sidecarText(render, resolved, generated));
    files.push({ path: out, sidecar, seed: resolved.seed, variation: i, frames: render.frames });
  }
  let queue: string | null = null;
  if (options.queue) {
    queue = freePath(folder, stem, ".playlist.json", taken);
    const playlist = emptyPlaylistBody("queue");
    playlist.entries = files.map((f): EmbeddedEntry => {
      const sample: SampleEntry = { kind: "sample", sample: f.path, trim: null, loop: "inherit", ...defaultEntryUse() };
      return { kind: "embedded", embedded: { ...emptyPlaylistBody("clip"), entries: [sample] }, ...defaultEntryUse() };
    });
    await host.writeText(queue, formatPlaylist(playlist));
  }
  let replaced: readonly string[] = [];
  if (options.replaceUses && host.editProjectFiles) {
    const label = `Replace uses of ${nameOf(path)} · ${nameOf(queue ?? files[0]!.path)}`;
    replaced = await host.editProjectFiles(replaceGeneratorUses(path, files[0]!.path, queue), label);
  }
  return { files, queue, replaced, hash, warnings };
}
