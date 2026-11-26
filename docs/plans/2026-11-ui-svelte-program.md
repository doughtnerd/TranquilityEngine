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
| X1 ✅ merged | 0418 wave 4: transitions, `@keyframes`, `animation`, on the tween backend; `transitionend`/`animationend` | 0420 |
| X2 ✅ merged (conformance 1077/1311, 82.2%) | Svelte hooks without UI core dependencies: legacy `on:`, `globalTarget` (`<svelte:window/document/body>`, events and size bindings), `addStyles` (`css: 'injected'`), `<svelte:head>` title; `t()`; the Element subset on renderer nodes | 0419 A |
| X3 ✅ merged (UI bundle 24.9 KB + cascade 10.7 KB gzip) | 0421: Svelte runtime and renderer bundled into each game's code at export, tree-shaken | 0419 A |
| Y1 ✅ merged | 0418 wave 5: `:not`, structural, attribute and sibling selectors, `calc()`, canvas `@media` (+ `MediaQuery`) | X1 (cascade) |
| Y2 ✅ merged | Svelte `animate`/`measure` hooks: `transition:`/`in:`/`out:`/`animate:` and `svelte/transition` built-ins on the tween backend and transformed boxes | X1, wave 3 |
| Y3 ✅ merged (conformance 1121/1311, 85.5%) | Event bubbling and capture (0422); scrolling containers (0423) | X2 |
| Z1 ✅ merged | 0419 wave B: built-in UI (`UIControlMapper`, `SubtitleDisplay`) and the samples to Svelte | X2 (`t()`), Y3 (bubbling) |
| Z2 (0424 ✅ merged, 0426 ✅ merged with Z1: conformance 1125/1311, 85.8%; 0425 ✅ merged: conformance 1130/1311, 86.2%) | Form elements (0424); inline rich text, `{@html}`, `contenteditable` (0425); filters, SVG, video/audio, matrix transforms with skew (0426) | Y-wave |
| Z3 ✅ merge-ready | Svelte's timing on the engine frame: a patch hook so the renderer drives Svelte's internal `raf` (`svelte/motion` Tween/Spring, `tick` transitions, its timers) from the UI step on unscaled time, headless included; `prefers-reduced-motion` in canvas `@media` and `prefersReducedMotion`, from an engine setting | 0425 (patch) |
| C ✅ merged | 0419 wave C: editor tooling for `.svelte` (picking by template location, literal attribute editing, Create menu, Inspector sources) | Z1 |
| D | 0419 wave D: retire UI documents (`UIDocument`, `*.ui.xml`, `*.ui.css`, markup parser, markup edits) once conformance meets the gate | C, conformance |
| End | Affected e2e specs once; per-wave captures and the frame-time check (Pirates HUD, control mapper) | all |

## Notes carried between waves

- Never commit a worktree's `node_modules` symlink (it happened once; `.gitignore` now ignores `node_modules` as a file too).
- Committed wasm embeds the building checkout's absolute path (pre-existing); remapping paths is a hygiene follow-up beside the pending `wasm-opt` note.
- The core-backed tween backend's update clears per-frame outputs for every World: UI runs it outside a game World's evaluate-to-apply span (0420 as built).
- Skew is supported since 0426 (Z2): a transform list that doesn't fold (`skew()`, `matrix()`, a rotation after an unequal scale) keeps its leading translates and becomes `transformMatrix`, drawn through the full matrix (`Drawn` in the Babylon layer); 0418 wave 3's refusal is gone. Form controls' parts are children of their `Drawn` control and an open select's list inherits the select's filter and transform, so filters and skew apply to them as to any element.
- Units ruling (coordinator): Svelte's `window.innerWidth/innerHeight` and `devicePixelRatio` move to canvas **UI pixels** (device pixels per UI pixel), matching `getBoundingClientRect` and canvas `@media`; done in wave Y1. The 0418 implementation-status row's "getBoundingClientRect on transformed boxes missing" is done (X2).
- 0421 as built: the renderer (and files beside it that it imports) may import from `src/engine/` only by name (no default or namespace import, no re-export): the player's `myco-ui-host.js` re-exports exactly those names, read from its source at player build, and a game's UI bundle imports them from there. Compiled components export `$mount`, which `UIView` calls. Rebuild the player after changing the renderer's engine imports.
- Wave 4 gaps: `UIView.ready` doesn't wait for the tween backend (a view's very first segment eases in TS, values correct); mid-transition inheritance to children, reversed-transition shortening, `transition-behavior`, `linear()`. Svelte `on*` animation event attributes mapped (coordinator).
- Both tween backends hold only 256 sequences (vs 4,096 tweens): Y2's Svelte transitions should use tweens per segment as wave 4 does.
- Size tripwire (0421's HUD UI bundle, `src/export/svelteExport.test.ts`): raised from 24.9 KB to 30.6 KB gzip measured (30,560 bytes) at the Y1+Y2+Y3 merge, past the old 29.9 KB tripwire. Why: the renderer grew by scheduled features, not by accident: canvas window units and `matchMedia` (Y1), the `animate`/`measure` hooks and Svelte's transition runtime (Y2), event propagation and the nodes' scrolling members (Y3). At the Z1+Z2 (0424, 0426) merge it measures 35.5 KB (35,530 bytes; form bindings and state, SVG documents and hit-testing, media bindings in the renderer), under the 36.7 KB tripwire, so `MEASURED_GZIP` stays 30,600 for now: the next scheduled growth (0425's inline runs) will likely cross it, and then it's raised with this reason.
- Agents' "full suite passes" claims need checking: wave 5 reported green while its own tip failed 14 animation tests (found at merge). The coordinator re-runs the full suite after every merge and reads the summary from a saved log (`Test Files|Tests  | FAIL `), never by grepping `×`, which matches benchmark output.
- e2e specs already known to be affected: `ui-navigation`, `localisation`, `arena`, `input`, `input-mapper`, `sample`, `hierarchy-create`, `selection`, `sound-lab-touch`, `inspector-fields`, `worldspanel`, `export`, `export-capture`, `animation-export`, `studio-export`, plus Code panel, Assets Create, export and player-boot specs (wave A part 2).
- 0425 (Z2) as built: HUD UI bundle measured 36.5 KB gzip (36,538 bytes, player rebuilt), 182 bytes under the 36.7 KB tripwire, so `MEASURED_GZIP` stays 30,600; the inline HTML parser isn't in it (only components using `{@html}`/`bind:innerHTML` import `myco/ui-html`). The next renderer growth crosses the tripwire: raise it then, with 0425's runs, `{@html}` hook and editable-text bindings as part of the reason. The Svelte patch gained the `html` hook (regenerated with patch-package, applies to a pristine svelte@5.59.2). `#text` pieces (text between inline children, and Svelte's button labels) now match no CSS rule, not even `*`; HTML's phrasing defaults (`b` bold, `small` 0.83 em, `a` underlined…) apply outside text elements too (no sample uses those tags). `UICore.pickAll` lists a run before its text (wave C's picking may want the run's template location). e2e specs to run for 0425: `ui-navigation`, `localisation`, `sample` and the Svelte UI specs of the samples (text runs change nothing in them unless they nest phrasing tags), plus export specs (`export`, `export-capture`) for the new `myco/ui-html` specifier.
