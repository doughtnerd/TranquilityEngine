# TranquilityEngine

A 2D & 3D TypeScript game engine: Unity-style scripting over a hidden ECS core, Godot-style node graph, three.js rendering, shipped through Tauri.

**Read [docs/README.md](docs/README.md) before making structural changes.** It indexes the architecture overview, open questions, implementation status, and the decision records (`docs/decisions/`).

- Engine code is in `src/engine/` (public API: `src/engine/index.ts`). The v1 demo, a Flappy Bird clone, is in `src/demo/flappy/` and is mostly data: `project.json`, `scenes/`, `prefabs/`.
- [docs/architecture/implementation-status.md](docs/architecture/implementation-status.md) says what each decision record has and lacks. Update it when you implement part of a record.
- three.js, Rapier and Howler must never appear in the public API (ADR 0010).
- Significant decisions (hard to reverse, cross-module, new dependency, public API change) get a record in `docs/decisions/` using `0000-template.md`. Accepted records aren't rewritten; supersede them with a new one.
- Build tooling is meant to be Vite ([0015](docs/decisions/0015-vite-build-tooling.md)) but is still webpack 5 until that migration lands.
- Commands: `npm run start` (dev server on :3000), `npm run build` (production build to `dist/`), `npm test` (Vitest, headless), `npm run typecheck`.
