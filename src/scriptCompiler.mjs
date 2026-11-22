// How TypeScript is compiled and type-checked, written once (ADR 0332). Every host that compiles or
// checks the engine's or a project's TypeScript derives its settings from here: the build and Vitest
// (`typescriptTranspile()` in vite.shared.ts), the server's Node hooks (server/tsLoader.mjs), the
// editor's script loader (editor/scriptLoader.ts), the Code panel's checker (editor/code/monaco.ts)
// and the `tsconfig.json` a project gets for external editors (editor/scriptingSetup.ts).
//
// Plain JavaScript with no imports, so a Node hook, a Vite config and the editor's browser bundle can
// all load it; types are in scriptCompiler.d.mts. Settings are written in tsconfig spelling (what a
// project's tsconfig.json holds); `compilerOptions` turns them into the numeric form the compiler API
// takes, without needing the `typescript` package (Monaco's checker runs it in a worker).

/** What every host emits: ES2022 modules with define-semantics class fields and standard decorators lowered. */
export const SCRIPT_EMIT = Object.freeze({
  target: "ES2022",
  module: "ESNext",
  useDefineForClassFields: true,
});

/**
 * What checkers type-check scripts with: the emit settings, and resolution as the hosts resolve
 * ("Bundler": extensionless relative imports, `package.json` "exports"), strict, JSON imports.
 */
export const SCRIPT_CHECK = Object.freeze({
  ...SCRIPT_EMIT,
  moduleResolution: "Bundler",
  lib: Object.freeze(["ES2022", "DOM"]),
  strict: true,
  resolveJsonModule: true,
});

// TypeScript's enum values (its public API numbers) for the names the settings use. Monaco's own
// enums stop at ES2020 and NodeJs resolution, though the checker it bundles knows these.
const ENUMS = {
  target: { ES2022: 9, ESNext: 99 },
  module: { ESNext: 99 },
  moduleResolution: { Bundler: 100 },
};

/** `settings` (tsconfig spelling) as the compiler API takes them, as `ts.convertCompilerOptionsFromJson` gives. */
export function compilerOptions(settings) {
  const out = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key in ENUMS) {
      const n = ENUMS[key][value];
      if (n === undefined) throw new Error(`scriptCompiler: no enum value for ${key} "${value}"; add it to ENUMS.`);
      out[key] = n;
    } else if (key === "lib") out[key] = value.map((name) => `lib.${name.toLowerCase()}.d.ts`);
    else out[key] = value;
  }
  return out;
}

/**
 * The files a relative import may name, best first, given its target `base` (the specifier joined to
 * the importing file's folder): as written, with `.ts` added, `.js` swapped for `.ts` (the TypeScript
 * convention), or `/index.ts`. The rule "Bundler" resolution and Vite apply to TypeScript sources.
 */
export function relativeImportCandidates(base) {
  return [base, `${base}.ts`, base.replace(/\.js$/, ".ts"), `${base}/index.ts`];
}
