# 0332. Script compiler settings are written once, in one plain-JS module every host derives from

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0015, 0030, 0041, 0125

## Context

TypeScript is compiled or checked by five hosts, and each wrote its own compiler settings with a comment saying they
matched the others. Nothing checked it:

- `typescriptTranspile()` in `vite.shared.ts` (dev server, every build, Vitest): ES2022, ESNext modules,
  define-semantics fields (plus JSX and source maps).
- `src/server/tsLoader.mjs` (the dedicated server's and `npm run export`'s Node hooks): the same emit settings, and a
  resolve hook trying a relative import as written, with `.ts`, `.js` → `.ts` and `/index.ts`.
- `compileScript` and `resolveScript` in `src/editor/scriptLoader.ts` (project scripts in the editor and game builds):
  the same emit settings and the same four candidates, written again.
- The Code panel's checker (`src/editor/code/monaco.ts`): `moduleResolution: NodeJs`, `lib`, `strict`, JSON imports,
  and `target: 9` with a comment, as Monaco's enum stops at ES2020.
- The `tsconfig.json` a project gets for external editors (`src/editor/scriptingSetup.ts`): the same settings in
  tsconfig spelling, but `moduleResolution: "Bundler"`.

So the copies had already drifted: the Code panel checked scripts with Node10 resolution, which ignores a package's
`exports` map, while VS Code (through the generated tsconfig), the engine's own `tsconfig.json`, Vite and the package
bundler (ADR 0125) all resolve as a bundler does. A script importing a package subpath could type-check in one and fail
in the other.

## Decision

We will write the settings once, in `src/scriptCompiler.mjs` (types in `scriptCompiler.d.mts`):

- **Plain JavaScript, no imports.** A Node hook, a Vite config and the editor's browser bundle all load it unchanged;
  it needs no `allowJs`, as TypeScript reads the `.d.mts` beside it (the precedent is `tools/hrir/convert.mjs`).
- **`SCRIPT_EMIT`**: what every host emits (`target: "ES2022"`, `module: "ESNext"`, `useDefineForClassFields`),
  in tsconfig spelling. **`SCRIPT_CHECK`**: what checkers type-check scripts with, the emit settings plus
  `moduleResolution: "Bundler"`, `lib: ["ES2022", "DOM"]`, `strict` and `resolveJsonModule`.
- **`compilerOptions(settings)`** turns tsconfig spelling into the compiler API's form (enums as TypeScript's
  numbers, libs as file names) without the `typescript` package, so Monaco (whose checker runs in a worker and whose
  enums lack ES2022 and Bundler) takes it too. A unit test holds it equal to `ts.convertCompilerOptionsFromJson`; a
  name it has no number for throws.
- **`relativeImportCandidates(base)`**: the relative import rule (as written, `.ts`, `.js` → `.ts`, `/index.ts`).
  `resolveScript` and the Node resolve hook take it; Vite's own resolver is the third follower and isn't ours.
- **Hosts derive and add only what is theirs**: `typescriptTranspile()` adds JSX and source maps; the Node hooks and
  `compileScript` add inline source maps; Monaco adds `noEmit` and `allowNonTsExtensions`; the project tsconfig adds
  `noEmit`, `skipLibCheck`, `paths` and `include`.
- **Bundler resolution is the right one**, so the Code panel moves to it: every host that runs scripts resolves as a
  bundler (extensionless relative imports, `package.json` `exports`), and so do the engine's tsconfig and the tsconfig
  an external editor uses. Monaco's bundled TypeScript (5.9) supports it although its typings stop at `NodeJs`.

## Alternatives considered

- **A test comparing the five copies** — keeps five places to edit and only reports drift after the fact.
- **A TypeScript module** — the Node hooks are what make TypeScript loadable, so they cannot import one.
- **Numbers in the module directly** — unreadable (`target: 9`), and the project tsconfig needs the names anyway; one
  spelling and a tested converter keeps a single source.
- **Keep `NodeJs` in Monaco** — it disagrees with every host that runs the scripts and with the external editors.

## Consequences

**Positive**
- One edit changes what the build, the server, the editor's loader, the Code panel and external editors use.
- The Code panel and VS Code now report the same errors for a script.

**Negative / costs**
- One more small module at `src/` root, shallow by nature (settings, little behaviour).
- The on-disk transpile caches (`myco-tsc`, `myco-server-ts`) are keyed by the options' JSON, so they recompile once.

## Deprecates

The inline option objects in `vite.shared.ts`, `tsLoader.mjs`, `scriptLoader.ts`, `monaco.ts` and `scriptingSetup.ts`,
and the two inline candidate lists: removed, each host now imports the module.

## Open questions

None.

## References

`src/scriptCompiler.mjs`, `src/scriptCompiler.d.mts`, `src/scriptCompiler.test.ts`; architecture review 2026-11-22,
card 6.
