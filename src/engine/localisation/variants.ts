/**
 * Localised files by folder (ADR 0354 §2, made generic by 0356 §10): under a localised root (an `audio.json`
 * `localisation.roots` folder or a `languages.assetRoots` folder) the first folder is a language code, and every file
 * under `<root>/<code>/` is that language's variant of `<root>/<any code>/<same rest>`. References name the reference
 * language's file; `variantPath` swaps the language at load or play time through a fallback chain.
 *
 * Pure; no plugin, no DOM. `exists` is the caller's (a project file index, a build's media table).
 */

/** Where a path sits under a localised root. */
export interface LocalisedParts {
  root: string;
  /** The first folder under the root: the language code it was written with. */
  code: string;
  /** The rest of the path after `<root>/<code>/`. */
  rest: string;
}

const trimSlashes = (s: string): string => s.replace(/^\/+|\/+$/g, "");

/**
 * The root, language folder and rest of `path` under the longest of `roots` it sits in (matched by whole path segments),
 * or null when it is under none, or sits directly in a root (no language folder and file after it).
 */
export function localisedParts(path: string, roots: readonly string[]): LocalisedParts | null {
  const p = trimSlashes(path);
  let best: string | null = null;
  for (const raw of roots) {
    const root = trimSlashes(raw);
    if (root === "" || !p.startsWith(`${root}/`)) continue;
    if (best === null || root.length > best.length) best = root;
  }
  if (best === null) return null;
  const after = p.slice(best.length + 1);
  const slash = after.indexOf("/");
  if (slash <= 0 || slash === after.length - 1) return null;
  return { root: best, code: after.slice(0, slash), rest: after.slice(slash + 1) };
}

/** The path of `parts`' file in language `code`. */
export const variantOf = (parts: LocalisedParts, code: string): string => `${parts.root}/${code}/${parts.rest}`;

/**
 * What `variantPath` found: the path to load and the language it is in (null for a path outside every root, returned
 * unchanged), or null when the path is localised but no language of the chain has the file (ADR 0354 §3: missing).
 */
export interface VariantMatch {
  path: string;
  language: string | null;
}

/**
 * The file to load for `path` in a language whose fallback chain is `chain` (`fallbackChain(languages, code)`): for a
 * path under a root, `<root>/<c>/<rest>` for each `c` of the chain, the first that `exists`; a path outside every root
 * comes back unchanged with language null; null when the chain has no variant.
 */
export function variantPath(path: string, chain: readonly string[], roots: readonly string[], exists: (path: string) => boolean): VariantMatch | null {
  const parts = localisedParts(path, roots);
  if (parts === null) return { path, language: null };
  for (const c of chain) {
    const candidate = variantOf(parts, c);
    if (exists(candidate)) return { path: candidate, language: c };
  }
  return null;
}
