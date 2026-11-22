/**
 * What a sample path plays (ADR 0328): an audio file plays itself with its sidecar's `sample` block; a derived sample
 * (`*.sample.json`, `myco.sample@1`) plays the audio file its `source` names with its resolved edits.
 *
 * - **Source.** A `source` that is itself a derived sample is followed to the audio file at the end of the chain.
 * - **Edits.** A following fork reads each field it didn't change live from its parent's resolved block
 *   (`resolveSampleEdits`); the parent is an audio file (its sidecar's edits, `sampleEditsFromSidecar`, as the Studio
 *   reads them) or another derived sample (resolved the same way, recursively). A pinned fork, a snippet and a duplicate
 *   play their own block.
 * - **Range.** A snippet's `range` (seconds in the source) is the region it plays: the block's `trim` narrowed to the
 *   range (their overlap; the range alone when the block has no trim or they don't overlap). Loops and markers keep
 *   their source times.
 * - **Render.** Edits with a `source` (a flattened render, "Flatten" in ADR 0328: `brake_skid.flat1.wav`) play that file
 *   in place of the source (`render`). The render is the source with the baked chain, its automation and the
 *   normalisation gain rendered in, on the source's own timeline: trim, loops and markers keep their source times and
 *   still apply; only what it bakes is not applied again. Its path is a project path, or a bare name beside the source.
 *   A render that isn't in the project (or names a derived sample) is reported and the source plays with every edit.
 *
 * Cycles (a source chain or a lineage chain that comes back to itself) are cut where they close, with a problem line:
 * a source cycle plays nothing, a lineage cycle plays the derived sample's own block. Nothing throws.
 *
 * Pure: the caller says how to read files (`SampleReader`) and decides what to do with the problems (the runtime warns
 * once per line). No plugin, no DOM.
 */
import { isDerivedSamplePath, parseDerivedSample, resolveSampleEdits, sampleEditsFromSidecar } from "./format";
import type { DerivedSampleAsset, SampleEdits } from "./types";

/** How the resolver reads the project. Each read answers the same until the file changes. */
export interface SampleReader {
  /** Whether a file exists at `path`. */
  has(path: string): boolean;
  /** A derived sample's raw JSON value (parsed with `parseDerivedSample`); only called when `has(path)`. */
  json(path: string): unknown;
  /** An audio file's sidecar fields that hold sample edits (the defaults when it has no sidecar). */
  sidecar(path: string): { sample: SampleEdits | null; loopStart: number | null; loopEnd: number | null };
}

export interface ResolvedSample {
  /** The path asked for. */
  readonly path: string;
  /** The audio file that plays; "" when there is none (a missing or broken derived sample, a source cycle). */
  readonly source: string;
  /**
   * The edits it plays with: an audio file's sidecar block (null without one: the file as it is); a derived sample's
   * resolved block, a snippet's range applied as its trim.
   */
  readonly edits: SampleEdits | null;
  /**
   * The flattened render that plays in place of `source` (the edits' `source`, found in the project; ADR 0328 "Flatten"),
   * null when there is none. It bakes the effects, their automation and the normalisation gain; it keeps the source's
   * timeline, so `edits`' trim, loops and markers apply to it as they are.
   */
  readonly render: string | null;
  /** True for a `*.sample.json`. */
  readonly derived: boolean;
  /** One line per problem found on the way, each naming its file. */
  readonly problems: readonly string[];
}

/** A snippet's region: the block's trim narrowed to `range`; the range alone without a trim or an overlap. */
function snippetTrim(trim: [number, number] | null, range: [number, number]): [number, number] {
  if (!trim) return [range[0], range[1]];
  const start = Math.max(trim[0], range[0]);
  const end = Math.min(trim[1], range[1]);
  return end > start ? [start, end] : [range[0], range[1]];
}

/** The render `edits` name for `source` (a project path, else a bare name beside the source), or null with a problem line. */
function renderOf(source: string, edits: SampleEdits | null, read: SampleReader, problems: string[], where: string): string | null {
  const name = edits?.source;
  if (!name || source === "") return null;
  if (isDerivedSamplePath(name)) {
    problems.push(`${where}: its render "${name}" is a derived sample, not an audio file; it plays its source.`);
    return null;
  }
  const slash = source.lastIndexOf("/");
  const beside = slash >= 0 && !name.includes("/") ? source.slice(0, slash + 1) + name : null;
  if (read.has(name)) return name;
  if (beside !== null && read.has(beside)) return beside;
  problems.push(`${where}: its render "${name}" isn't in the project; it plays its source with every edit.`);
  return null;
}

/** What `path` plays, read through `read`. */
export function resolveSample(path: string, read: SampleReader): ResolvedSample {
  if (!isDerivedSamplePath(path)) {
    const problems: string[] = [];
    const edits = read.has(path) ? read.sidecar(path).sample : null;
    return { path, source: path, edits, render: renderOf(path, edits, read, problems, path), derived: false, problems };
  }
  const problems: string[] = [];
  const parsed = new Map<string, DerivedSampleAsset | null>();
  /** A derived sample's parsed file (its problems reported once), or null when it is missing. */
  const load = (p: string): DerivedSampleAsset | null => {
    if (parsed.has(p)) return parsed.get(p)!;
    let asset: DerivedSampleAsset | null = null;
    if (!read.has(p)) problems.push(`${p}: the derived sample isn't in the project; it plays nothing.`);
    else {
      const out = parseDerivedSample(read.json(p), p);
      for (const line of out.problems) problems.push(line);
      asset = out.sample;
    }
    parsed.set(p, asset);
    return asset;
  };

  // The source chain, to the audio file at its end.
  let source = "";
  const chain = [path];
  for (let at = path; ;) {
    const asset = load(at);
    if (!asset || asset.source === "") break;
    const next = asset.source;
    if (chain.includes(next)) {
      problems.push(`${path}: its source chain ${[...chain, next].join(" → ")} comes back to itself; it plays nothing.`);
      break;
    }
    if (!isDerivedSamplePath(next)) {
      if (read.has(next)) source = next;
      else problems.push(`${at}: its source "${next}" isn't in the project; it plays nothing.`);
      break;
    }
    chain.push(next);
    at = next;
  }

  const own = load(path);
  if (!own) return { path, source: "", edits: null, render: null, derived: true, problems };

  // The lineage: a following fork's parent edits, resolved recursively.
  const block = (p: string, seen: readonly string[]): SampleEdits => {
    const asset = load(p)!;
    const { lineage } = asset;
    if (lineage.kind !== "fork" || lineage.mode !== "follow" || !lineage.baseline) return asset.sample;
    const parent = lineage.parent;
    if (parent === "" || parent === p) return asset.sample;
    if (seen.includes(parent)) {
      problems.push(`${path}: its lineage ${[...seen, parent].join(" → ")} comes back to itself; ${p} plays its own edits.`);
      return asset.sample;
    }
    let parentEdits: SampleEdits;
    if (isDerivedSamplePath(parent)) {
      if (!load(parent)) return asset.sample;
      parentEdits = block(parent, [...seen, parent]);
    } else {
      if (!read.has(parent)) {
        problems.push(`${p}: the parent it follows, "${parent}", isn't in the project; it plays its own edits.`);
        return asset.sample;
      }
      parentEdits = sampleEditsFromSidecar(read.sidecar(parent));
    }
    return resolveSampleEdits(asset, parentEdits);
  };
  let edits = block(path, [path]);
  if (own.range) edits = { ...edits, trim: snippetTrim(edits.trim, own.range) };
  return { path, source, edits, render: renderOf(source, edits, read, problems, path), derived: true, problems };
}
