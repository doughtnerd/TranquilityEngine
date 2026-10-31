# TranquilityEngine

A 2D & 3D TypeScript game engine: Unity-style scripting over a hidden ECS core, Godot-style node graph, three.js rendering, shipped through Tauri.

**Read [docs/README.md](docs/README.md) before making structural changes.** It indexes the architecture overview, open questions, and the decision records (`docs/decisions/`).

- The code in `src/` is the 2021 prototype and mostly predates the current design. [docs/architecture/legacy-codebase.md](docs/architecture/legacy-codebase.md) says what replaces each part. Don't extend legacy modules that are marked for removal.
- Significant decisions (hard to reverse, cross-module, new dependency, public API change) get a record in `docs/decisions/` using `0000-template.md`. Accepted records aren't rewritten; supersede them with a new one.
- Build tooling is meant to be Vite ([0015](docs/decisions/0015-vite-build-tooling.md)), but the repo still builds with webpack 5 until that migration lands. Current commands: `npm run start` (dev server on :3000), `npm run build` (production build to `dist/`).
