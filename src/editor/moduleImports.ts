// The TypeScript compiler, loaded lazily, and finding the import specifiers in a module's text
// (ADR 0030, 0125). Shared by the script loader, the package bundler and the package types reader.

export type TS = typeof import("typescript");
let tsModule: Promise<TS> | null = null;

/** The TypeScript compiler, loaded on first use (it's large, and only scripts need it). */
export function typescript(): Promise<TS> {
  return (tsModule ??= import("typescript").then((m) => ((m as { default?: TS }).default ?? m) as TS));
}

/** An import or export-from in compiled code: its specifier and where the specifier's text is. */
export interface ImportSite {
  readonly specifier: string;
  readonly start: number;
  readonly end: number;
}

/** Imports, export-froms and dynamic imports with a literal specifier in JavaScript `code`, with their positions. */
export function importSites(ts: TS, code: string): ImportSite[] {
  const info = ts.preProcessFile(code, true, true);
  // Positions start at the literal's quote; find the specifier's own text from there.
  return info.importedFiles.map((f) => {
    const start = code.indexOf(f.fileName, f.pos);
    return { specifier: f.fileName, start, end: start + f.fileName.length };
  });
}

/** `code` with each import specifier replaced by what `urlFor` gives it (positions from `importSites`). */
export function rewriteImports(code: string, imports: readonly ImportSite[], urlFor: (specifier: string) => string): string {
  let out = "";
  let at = 0;
  for (const imp of [...imports].sort((a, b) => a.start - b.start)) {
    out += code.slice(at, imp.start) + urlFor(imp.specifier);
    at = imp.end;
  }
  return out + code.slice(at);
}
