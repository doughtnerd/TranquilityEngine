/**
 * ADR 0080: the prefab and material files a script names in string literals, so scene loads warm
 * them up. No imports, so the exporter (Node) can use it as well as the editor.
 */

/** A string literal (quotes, or a backtick without substitutions) naming a prefab or material file. */
const LITERAL = /(["'`])((?:asset:)?[\w./ -]+\.(?:prefab|material)\.json)\1/g;

/** Asset paths (without `asset:`) the string literals of a script's source name: prefab and material files only. */
export function scriptAssetRefs(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(LITERAL)) out.add(m[2]!.replace(/^asset:/, ""));
  return [...out];
}

/** Every file `scripts` (source by path) name with `scriptAssetRefs`, kept to those `exists` says are in the project, sorted. */
export function projectScriptAssetRefs(scripts: Iterable<string>, exists: (path: string) => boolean): string[] {
  const out = new Set<string>();
  for (const source of scripts) for (const p of scriptAssetRefs(source)) if (exists(p)) out.add(p);
  return [...out].sort();
}
