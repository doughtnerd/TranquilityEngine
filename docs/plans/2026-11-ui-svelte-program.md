# UI program: web CSS on the UI core and Svelte as the UI format (ADRs 0417–0426)

The coordinator's plan for building ADRs 0418 (the UI core grows toward web CSS), 0419 (UI authored in Svelte, full compatibility), 0420 (shared tween crate) and 0421 (Svelte runtime bundled per game), in waves of parallel worktree agents. The owner approved running it to completion (2026-11-26). Agents run typecheck and Vitest only; the coordinator merges each wave and runs only the **affected** e2e specs, **once, at the end** (owner's rule).

## Done

| Item | Merged |
|---|---|
| 0417: game UI only from documents; `Text`/`LocalizedText` removed; samples migrated | yes |
| Input fix: queued pointer presses read where they happened | yes |
| 0418 wave 1 (layout), wave 2 (paint), wave 3 (transforms) | yes |
| 0419 wave A part 1 (patch with `bind`, renderer, host, `UIView`, `:is`/`:where`, conformance harness: 964/1311 pass) | yes |
| 0419 wave A part 2 (compiling in the editor and at export, styles as rule data) | yes |
| 0420: `myco-tween`/`myco-wire`, standalone tween module with sequence player, TS tween backend | yes |

## Waves to go

| Wave | Contents | Depends on |
|---|---|---|
| X1 | 0418 wave 4: transitions, `@keyframes`, `animation`, on the tween backend; `transitionend`/`animationend` | 0420 |
| X2 ✅ merged (conformance 1077/1311, 82.2%) | Svelte hooks without UI core dependencies: legacy `on:`, `globalTarget` (`<svelte:window/document/body>`, events and size bindings), `addStyles` (`css: 'injected'`), `<svelte:head>` title; `t()`; the Element subset on renderer nodes | 0419 A |
| X3 | 0421: Svelte runtime and renderer bundled into each game's code at export, tree-shaken | 0419 A |
| Y1 | 0418 wave 5: `:not`, structural, attribute and sibling selectors, `calc()`, canvas `@media` (+ `MediaQuery`) | X1 (cascade) |
| Y2 | Svelte `animate`/`measure` hooks: `transition:`/`in:`/`out:`/`animate:` and `svelte/transition` built-ins on the tween backend and transformed boxes | X1, wave 3 |
| Y3 | Event bubbling and capture (0422); scrolling containers (0423) | X2 |
| Z1 | 0419 wave B: built-in UI (`UIControlMapper`, `SubtitleDisplay`) and the samples to Svelte | X2 (`t()`), Y3 (bubbling) |
| Z2 | Form elements (0424); inline rich text, `{@html}`, `contenteditable` (0425); filters, SVG, video/audio, matrix transforms with skew (0426) | Y-wave |
| C | 0419 wave C: editor tooling for `.svelte` (picking by template location, literal attribute editing, Create menu, Inspector sources) | Z1 |
| D | 0419 wave D: retire UI documents (`UIDocument`, `*.ui.xml`, `*.ui.css`, markup parser, markup edits) once conformance meets the gate | C, conformance |
| End | Affected e2e specs once; per-wave captures and the frame-time check (Pirates HUD, control mapper) | all |

## Notes carried between waves

- Never commit a worktree's `node_modules` symlink (it happened once; `.gitignore` now ignores `node_modules` as a file too).
- Committed wasm embeds the building checkout's absolute path (pre-existing); remapping paths is a hygiene follow-up beside the pending `wasm-opt` note.
- The core-backed tween backend's update clears per-frame outputs for every World: UI runs it outside a game World's evaluate-to-apply span (0420 as built).
- Transform lists that would skew are refused, and skew isn't drawn (0418 wave 3 as built); Z2's matrix transforms lift both.
- Units ruling (coordinator): Svelte's `window.innerWidth/innerHeight` and `devicePixelRatio` move to canvas **UI pixels** (device pixels per UI pixel), matching `getBoundingClientRect` and canvas `@media`; done in wave Y1. The 0418 implementation-status row's "getBoundingClientRect on transformed boxes missing" is done (X2).
- e2e specs already known to be affected: `ui-navigation`, `localisation`, `arena`, `input`, `input-mapper`, `sample`, `hierarchy-create`, `selection`, `sound-lab-touch`, plus Code panel, Assets Create, export and player-boot specs (wave A part 2).
