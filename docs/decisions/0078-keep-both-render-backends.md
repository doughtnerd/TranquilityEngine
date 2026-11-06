# 0078. Keep both render backends: Babylon.js by default, three.js as a toggle

- **Status:** Superseded by 0081
- **Date:** 2026-11-06
- **Deciders:** Chris Carlson
- **Supersedes:** 0075 (in part: its stage 10 and its Deprecates list)
- **Related:** 0010, 0044, 0069, 0075, 0076

## Context

0075 moved rendering to Babylon.js in ten stages, with both backends side by side behind a dev flag, and planned to delete the three.js backend and its dependencies in stage 10 once Babylon reached parity. Stages 1–8 and part of stage 9 are built. Two things changed the plan:

- Comparing the two backends on the same project is useful for testing, and that need doesn't end at parity.
- Babylon has no FBX loader. Model import (0044) parses FBX and OBJ with three.js loaders into renderer-neutral data (0075 stage 7), so three.js is needed for import anyway.

## Decision

- **No stage 10.** The three.js backend and its dependencies (`three`, `postprocessing`, `n8ao`, `three.quarks`, `@pmndrs/uikit`) stay.
- **Babylon.js is the default renderer** for the editor, the player and exported games.
- **three.js is a feature toggle**, read by `rendererChoice()`:
  - `?renderer=three` (or `babylon`) in the address, which wins;
  - otherwise `localStorage["myco.renderer"]`, which the editor's Settings > General > Renderer writes. The change applies on the next load.
- **Model import keeps three.js's FBX and OBJ loaders**, converting to the neutral model data whichever backend draws.
- **Lazy loading stays both ways:** a page downloads only the backend it runs (0075), so keeping three.js costs games on Babylon nothing at start.
- **New rendering features are built for Babylon first.** three.js keeps what it has. A feature it lacks is listed in the implementation status, not treated as a bug, unless it breaks a project that works on Babylon.
- 0010's boundary holds for both: neither library appears in the public API.

## Alternatives considered

- **Delete three.js at parity (0075's plan).** Smaller dependency tree and one code path, but no way to compare backends, and FBX import would need a converter or our own parser.
- **Keep three.js only as an editor-side import converter.** Keeps FBX, but loses the side-by-side comparison.

## Consequences

**Positive**
- Any project can be compared on both renderers by flipping a setting.
- FBX import keeps working with no new converter.

**Negative / costs**
- Two backends to keep compiling and tested. Engine changes that touch rendering go through `RenderSurface` and need both implementations, or a recorded gap on three.js.
- The repository keeps three.js's dependencies, and the editor's build includes both backends' lazy chunks.

## Deprecates

- 0075's stage 10 and its Deprecates list. The rest of 0075 stands: Babylon is the main backend, imported module by module.

## Open questions

- Whether exported games should be able to pin a renderer in project settings, rather than only through the address or storage.
