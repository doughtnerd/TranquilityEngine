# TranquilityEngine Design Docs

Start here. These docs describe where the engine is going, why, and what is being left behind.

| Doc | What it covers |
| --- | --- |
| [Architecture overview](architecture/overview.md) | Goals, non-goals, layers, module layout, glossary |
| [Open questions](architecture/open-questions.md) | Design decisions not yet made, with leanings |
| [Implementation status](architecture/implementation-status.md) | What `src/engine/` implements today versus each decision record |
| [Legacy codebase](architecture/legacy-codebase.md) | The 2021 prototype (removed 2026-10-31), its known problems, and what replaced each part |
| [Decision records](decisions/) | Short-form RFC/ADR records, one decision per file |

## Decision records

| # | Title | Status |
| --- | --- | --- |
| [0001](decisions/0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](decisions/0002-typescript-first-esm.md) | TypeScript-first, ES modules | Accepted |
| [0003](decisions/0003-tauri-platform-browser-runtime.md) | Tauri platform, browser runtime | Accepted |
| [0004](decisions/0004-threejs-render-pipeline.md) | three.js owns the render pipeline | Accepted, amended by 0010 |
| [0005](decisions/0005-physics-backend.md) | Physics: Rapier now, PhysX for 3D later, behind an engine interface | Accepted |
| [0006](decisions/0006-audio-howler-and-three.md) | Audio: Howler + three.js positional audio | Accepted |
| [0007](decisions/0007-hidden-ecs-with-lifecycle-scripting.md) | Hidden ECS core, lifecycle-method scripting | Accepted, amended by 0017 |
| [0008](decisions/0008-gameobjects-as-node-graph.md) | GameObjects are entities arranged as a node graph | Accepted |
| [0009](decisions/0009-components-attached-or-as-child-nodes.md) | Components attach to a node or live as child nodes | Accepted |
| [0010](decisions/0010-engine-graph-authoritative-over-threejs.md) | Engine node graph is authoritative; three.js never exposed | Accepted |
| [0011](decisions/0011-frame-loop-and-system-order.md) | Frame loop and system order | Accepted |
| [0012](decisions/0012-ecs-storage-implementation.md) | ECS storage: in-house sparse sets, benchmark first | Accepted |
| [0013](decisions/0013-data-driven-scene-format.md) | Data-driven scene format with a type registry | Accepted |
| [0014](decisions/0014-unified-2d-and-3d.md) | 2D and 3D share one pipeline | Accepted |
| [0015](decisions/0015-vite-build-tooling.md) | Vite build tooling | Accepted |
| [0016](decisions/0016-world-root-and-scenes-as-nodes.md) | A World root node; scenes are nodes | Accepted |
| [0017](decisions/0017-user-systems-and-data-components.md) | User systems and data components in v1; no engine event system | Accepted |
| [0018](decisions/0018-promise-based-waits.md) | Promise-based waits for scripts | Accepted |
| [0019](decisions/0019-public-api-conventions.md) | Public API conventions: names, angles, live vectors | Accepted |
| [0020](decisions/0020-in-canvas-ui-with-uikit.md) | In-canvas UI built on pmndrs uikit | Accepted |
| [0021](decisions/0021-particles-with-three-quarks.md) | Particles with three.quarks | Accepted |
| [0022](decisions/0022-editor-is-a-v1-goal.md) | A scene editor is a v1 goal | Accepted |
| [0023](decisions/0023-testing-vitest-and-browser-smoke-tests.md) | Testing: Vitest + browser smoke tests | Accepted |
| [0024](decisions/0024-storage-via-platform-adapter.md) | Saves and settings through a platform Storage API | Accepted |
| [0025](decisions/0025-editor-ui-dom-with-preact.md) | Editor UI: DOM panels built with Preact | Accepted |
| [0026](decisions/0026-editor-scene-document-and-commands.md) | The editor edits a scene document through commands | Accepted |
| [0027](decisions/0027-persistent-undo-tree.md) | Persistent, tree-shaped edit history | Accepted |
| [0028](decisions/0028-component-enabled-overrides.md) | Prefab overrides can switch a component on or off | Accepted |
| [0029](decisions/0029-component-order-overrides.md) | Prefab overrides can reorder a node's components | Accepted |
| [0030](decisions/0030-in-editor-scripting.md) | Write and run project scripts inside the editor | Proposed |

## Working with decisions

- New decision: copy [0000-template.md](decisions/0000-template.md) to the next number, set status **Proposed**, and add it to the table above.
- A record is **Accepted** once the owner agrees to it. Accepted records are not rewritten; to change one, write a new record that **supersedes** (or **amends**) it and update the old one's status. Open questions in an accepted record may be struck through with their answer.
- When a decision retires existing code or an older approach, say so in the record's **Deprecates** section and update [legacy-codebase.md](architecture/legacy-codebase.md).

Status values: `Proposed` · `Accepted` · `Rejected` · `Deprecated` · `Superseded by NNNN`.
