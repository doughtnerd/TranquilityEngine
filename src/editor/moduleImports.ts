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
  // A full parse, not `ts.preProcessFile`: that scanner loses its place in minified code (a bundle's chunks) and
  // finds none of the imports after it, which were then left unrewritten.
  const file = ts.createSourceFile("module.js", code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const sites: ImportSite[] = [];
  const add = (literal: import("typescript").Node | undefined): void => {
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    // The specifier's text sits between the literal's quotes.
    sites.push({ specifier: literal.text, start: literal.getStart(file) + 1, end: literal.end - 1 });
  };
  const visit = (node: import("typescript").Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require" && node.arguments.length === 1)) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
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
