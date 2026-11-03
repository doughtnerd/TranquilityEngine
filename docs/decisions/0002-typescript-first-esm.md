# 0002. TypeScript-first, ES modules

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0007, 0013

## Context

The legacy code is a mix: most engine files are JavaScript, and a few are TypeScript (`Transform.ts`, `Vector3.ts`, `SceneManager.ts`). Since the October 2026 Node 26 upgrade, webpack compiles both with `ts-loader` (`allowJs: true`, `strict: false`). `.babelrc` and the Babel packages are still in the repo but no webpack rule uses them. Scene files and behaviors are untyped, so mistakes in scene data (wrong attribute names, missing `type`) only show up at runtime.

The engine's public API is a large surface (lifecycle hooks, `getBehavior<T>()`, component attributes in scene data) that benefits a lot from types and editor autocomplete. Game developers may still prefer plain JavaScript.

## Decision

- The engine is written in **TypeScript** with `strict` enabled. Engine source is `.ts` only.
- The engine ships **ES modules** and type declarations.
- Game code may be **TypeScript or JavaScript**. The public API is designed so JavaScript users get good autocomplete from the shipped `.d.ts` files.
- Babel is removed (it's already unused by the build); TypeScript (or the bundler's TS support) does the transpiling. `allowJs` is turned off once the engine's JavaScript files are gone.
- Target: ES2022 or newer. All Tauri webviews (see 0003) support it.

## Alternatives considered

- **Stay with mixed JS/TS.** Lowest effort now, but the core rewrite touches almost every file anyway, and untyped engine code with `strict: false` gives little safety.
- **JavaScript with JSDoc types.** Works for game code, but too weak for an engine with generic component lookups and data-driven scenes.

## Consequences

**Positive**
- Scene data and component attributes can be type-checked (see 0013).
- One compiler, simpler build.

**Negative / costs**
- Every legacy `.js` engine file must be rewritten or converted. In practice most are being replaced anyway (see [legacy-codebase.md](../architecture/legacy-codebase.md)).

## Deprecates

- `.babelrc` and the Babel packages (`@babel/cli`, `@babel/core`, `@babel/preset-env`, `@babel/plugin-proposal-class-properties`), which are unused already.
- `tsconfig.json` settings `allowJs: true` and `strict: false`.
- Untyped engine modules in `src/engine/*.js`.

## Open questions

- ~~Bundler: stay on webpack 5 or move to Vite.~~ Resolved by [0015](0015-vite-build-tooling.md): Vite.

## References

- [tsconfig.json](../../tsconfig.json), [webpack/](../../webpack/)
