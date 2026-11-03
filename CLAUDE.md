# Myco Engine

A 2D & 3D TypeScript game engine: Unity-style scripting over a hidden ECS core, Godot-style node graph, three.js rendering, shipped through Tauri.

**Read [docs/README.md](docs/README.md) before making structural changes.** It indexes the architecture overview, open questions, implementation status, and the decision records (`docs/decisions/`).

- Engine code is in `src/engine/` (public API: `src/engine/index.ts`). The v1 demo, a Flappy Bird clone, is a sample project in `samples/flappy/` (ADR 0031): data plus `scripts/` that import `"myco"`. Samples ship beside the editor and are never imported from `src/` (editor tests register the sample's types through `src/editor/sampleTypes.ts`).
- [docs/architecture/implementation-status.md](docs/architecture/implementation-status.md) says what each decision record has and lacks. Update it when you implement part of a record.
- three.js, Rapier and Howler must never appear in the public API (ADR 0010).
- Significant decisions (hard to reverse, cross-module, new dependency, public API change) get a record in `docs/decisions/` using `0000-template.md`. Accepted records aren't rewritten; supersede them with a new one.
- Build tooling is Vite ([0015](docs/decisions/0015-vite-build-tooling.md)). Every Vite/Vitest config must use the `typescriptTranspile()` plugin from `vite.shared.ts` with `oxc: false`, because oxc doesn't lower standard decorators.
- The scene editor is in `src/editor/` (page: `editor.html`); the Tauri shell is in `src-tauri/` and needs a Rust toolchain.
- Editor CSS uses the theme tokens from `src/editor/theme.ts` (`var(--panel)`, `var(--text)`, `var(--accent)`, `var(--danger)`…; the full list heads `src/editor/ui/editor.css`), never hard-coded colours, so Settings > Appearance themes it.
- Commands: `npm run dev` (dev server on :3000; editor at `/editor.html`, `?sample=flappy` opens the sample), `npm run build` (typecheck, then the editor with the samples in `dist/editor/` and the engine library in `dist/engine/`), `npm test` (Vitest, headless), `npm run test:e2e` (Playwright on Chromium and WebKit; run `npm run test:e2e:install` once first), `npm run typecheck`, `npm run tauri:dev` (desktop editor window), `npm run tauri:build` (installers). There's no standalone game build yet (O14).
