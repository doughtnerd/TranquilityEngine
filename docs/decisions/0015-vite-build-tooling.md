# 0015. Vite build tooling

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0002, 0003, 0005

## Context

The intended build tool is Vite (Rollup-based), but the repository has never used it. As of commit `d4dab10` the build is **webpack 5**: `webpack/webpack-dev.config.js` and `webpack/webpack-prod.config.js`, `ts-loader` for both `.js` and `.ts`, `asset/resource` rules for images/audio, `asset/source` for GLSL, `html-webpack-plugin`, and the 2019-era `clean-webpack-plugin@1`. The October 2026 Node 26 upgrade kept webpack rather than switching.

Forces:
- Tauri v2's frontend templates and docs assume Vite (`devUrl`, `frontendDist`, `beforeDevCommand: vite`).
- The engine loads WASM (Rapier, possibly Havok, 0005) and many binary assets; Vite handles `?url`, `?raw`, WASM and static assets with little config.
- Fast dev-server startup and hot module replacement matter for the edit-run loop on game scripts.
- The engine itself should ship as a library (ESM + `.d.ts`), which Vite's library mode covers.

Vite 8 (current: 8.3.5) bundles production builds with **Rolldown**, a Rust implementation that is API- and plugin-compatible with Rollup. Rollup plugins generally work unchanged.

## Decision

- The build uses **Vite** (8.x) for the dev server, production builds of games/demos, and library builds of the engine.
- The production bundler is whatever Vite ships (Rolldown in Vite 8). The engine depends only on Vite/Rollup-compatible plugin APIs, never on Rolldown- or webpack-specific features.
- Type checking runs separately (`tsc --noEmit`), since Vite transpiles TypeScript without checking it.
- Asset conventions follow Vite: `import url from "./x.png"` for URLs, `?raw` for shader source, `public/` for files that must keep their path.
- Tauri integration uses the standard Vite setup (`beforeDevCommand` / `beforeBuildCommand`, fixed dev port).
- Build scripts: `dev` (vite), `build` (tsc --noEmit && vite build), `preview` (vite preview).

## Alternatives considered

- **Keep webpack 5.** It works today, but the configs are custom and dated, the dev loop is slower, and Tauri's tooling and examples assume Vite.
- **Plain Rollup (no Vite).** Fine for the library build, but no dev server or HMR; Vite already wraps it.
- **esbuild / tsup only.** Good for library output, but no dev-server story for games.

## Consequences

**Positive**
- Matches Tauri's defaults; less custom config.
- Faster dev server and HMR.
- Simpler WASM and asset handling for Rapier and three.js content.

**Negative / costs**
- A one-time migration of the build config and asset imports (GLSL `asset/source` imports become `?raw`; image/audio imports already return URLs in both tools).
- Dev (unbundled ESM) and production (Rolldown bundle) take different paths, so occasional prod-only issues need a `vite preview` check.

## Deprecates

- `webpack/webpack-dev.config.js`, `webpack/webpack-prod.config.js`.
- Dependencies: `webpack`, `webpack-cli`, `webpack-dev-server`, `webpack-merge`, `ts-loader`, `html-webpack-plugin`, `clean-webpack-plugin`, plus the unused `file-loader`, `source-map-loader`, `css-loader`, `css-minimizer-webpack-plugin`, `optimize-css-assets-webpack-plugin`.
- The webpack `DefinePlugin` flags `CANVAS_RENDERER` / `WEBGL_RENDERER` (unused leftovers).
- The `npm run start` script (replaced by `dev`).

## Open questions

- Monorepo layout once the engine and demo games are separate packages (e.g. `packages/engine`, `packages/demo-flappy`), and whether to use npm workspaces.

## References

- https://vite.dev/guide/
- https://v2.tauri.app/start/frontend/vite/
- https://rolldown.rs/
