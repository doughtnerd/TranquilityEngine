# 0438. A styled-tree module styles the UI host's elements

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0423 (refines), 0422, 0432, 0436, 0437, 0340, 0077

## Context

ADR 0423 made the UI tree host (`src/engine/ui/host/UIHost.ts`) the only maker of UI elements. By 0437 the host was about 1,850 lines. It mixed DOM-like tree mutation, events, geometry and animation hooks with a whole style engine:

- Module-level flags (`sheetsUsePseudo`, `sheetsUseLang`, `sheetsUseStructure`, `sheetsUseMedia`, `sheetsUseViewport`, `sheetsHas`, `sheetsPseudoElements`) shared by every tree, recomputed by whichever tree read the sheets next.
- `_lateSync` re-checked the stylesheets, locale, UI preferences, canvas size, viewport and every element's pseudo-state each frame. `resolveDirty`, `hasChanged` and the `:has()` anchors decided what restyled. Inheritance through animations (`_animatedWrite`) and `resolve`, `apply`, `pseudoFields` and `generate` (`::before`/`::after`) did the restyle. `apply` also wrote `UIPanel._styledStates` (0437).
- The host used about 30 exports of `document/cascade.ts` plus its key constants (`UNITS_KEY`, `TRANSITION_KEY`, `CONTENT_KEY`…), through `host/hostSupport.ts`, a re-export that was also the lazily loaded chunk. From the host's side, cascade's interface was nearly as wide as its implementation. To learn when something restyles, you had to read both files.

## Decision

We will move style invalidation, resolving and applying styles, and pseudo-element generation into one deep module, the **styled tree** (`src/engine/ui/document/styledTree.ts`, `UIStyledTree`). The host keeps the DOM-like tree operations, events and geometry.

- **Calls in** (what the host tells it): `attach` (a new element and its first attributes), `inserted` (made or moved into its parent), `detached` (taken out of a parent to move), `removed`, `attributesChanged`, `emptinessChanged` (a text became empty or stopped being), `restyle` (a subtree, now), `restylePending` (before geometry is read), `sync` (the frame's late sync: stylesheets, locale, preferences, canvas size, viewport, pseudo-states), `query` (selector queries in the tree), `play` (a renderer's keyframes, converted as a stylesheet's are), `takeEvents` and `dispose`.
- **Out**: field writes on the components, made directly or handed to the UI animator (the styled tree is the animator's owner, so `_animatedWrite` and animation events are its). Also node references by element id (ADR 0340), part styles, `UIPanel._styledStates` (0437), and generated `::before`/`::after` elements and their labels, which it asks its host to make and destroy (`UIStyledTreeHost`). The host still makes every UI element (0423).
- **Each element's style state** (`UIElementStyle`: its selector target, markup, resolved style, applied fields, generated elements, part styles) is kept on the element as `_style`, set by the styled tree. The host reads `target` (id, classes), `before` for node order, and the editor reads `resolved` (field sources).
- **What the sheets use is a property of a sheet set.** `UISheetSet` is made once per version of the registered sheets: cascade order across files, the usage flags, the pseudo-elements styled. Each tree picks up the current set where it used to call `hostSheets()` (making a tree, `restyle`, a pending restyle, the late sync), so a tree's invalidation always matches the sheets it styled with. There are no module-level style flags.
- **The registry stays in the host.** `setUIHostStyles` still works before the cascade loads, and hands each styled tree a live `UISheetSource`.
- **The lazy chunk is the styled tree.** `loadUIHostSupport` imports `document/styledTree.ts`, which brings the cascade with it. `host/hostSupport.ts` is deleted. The host's run-time use of the chunk is `UIStyledTree`, `matchesSelector` (the renderer's `matches`/`closest`) and `defaultFieldValue` (a content attribute that went, ADR 0428). It imports no cascade constants.

## Alternatives considered

- **Keep the style code in the host and only narrow the cascade import.** This doesn't separate "when does X restyle" from tree mutation and events, and the module-level flags would stay.
- **The styled tree keeps its own mirror of the element tree.** That frees it from the host's element type, but the structure would be duplicated and kept in step on every create, move and remove. The structural interface (`UIStyledNode`: tag, component, parent, children, alive) is enough.
- **Per-tree flags recomputed per tree.** This is equivalent to sharing one immutable sheet set per version, but costs more.
- **Move node references and content attributes out too.** References moved: they read attributes into fields as markup does, and need the element ids the styled tree keeps. Content attributes stay with the host: they are form-control state (0436), not style.

## Consequences

**Positive**
- The host is about 1,040 lines and has no style engine. Everything that decides a restyle is in one file behind about a dozen calls.
- The styled tree is tested through its own interface with a plain host (`engine/tests/uiStyledTree.test.ts`): attributes, pseudo-states, sheet changes, structural selectors, `:has()`, references and generated elements. The view-level tests stay as integration tests.
- Usage flags can no longer go stale when another tree refreshes them.

**Negative / costs**
- A behaviour change in one edge case. When the sheets change, a tree that hasn't yet picked up the new set (before its next `restyle`, pending restyle or late sync) uses the previous set's flags for structural and `:has()` tracking. Before, it used whatever another tree last computed. The full restyle that follows a sheet change makes the outcome the same.
- `UIHost.ts` keeps a side-effect import of the UI animator so the animator's frame system registers with the host's systems, before any World is made, as it did when the host called the animator itself.

## Deprecates

The host's style code (`hostSheets`, the `sheetsUse*` flags, `resolveDirty`, `hasChanged`, `resolve`, `apply`, `pseudoFields`, `generate`, `partStyleOf`, `splitDeclarations`, `resolveReferences`, `_animatedWrite`) and its element fields (`_target`, `_markup`, `_resolved`, `_applied`, `_styled`, `_written`, `_before`, `_after`, `_parts`, `_pseudo`): moved to the styled tree. `host/hostSupport.ts`: removed.

## Open questions

None.

## References

- Architecture review 2026-11-27, candidate "a styled-tree module behind the UI tree host".
- `src/engine/ui/document/styledTree.ts`, `src/engine/ui/host/UIHost.ts`; tests `engine/tests/uiStyledTree.test.ts`, and through views `uiSelectors`, `uiHasAndUnits`, `uiPseudoElements`, `uiAnimation`, `uiResolvedPaint`, `uiNavigation`.

## As built (2026-11-27)

- Built as decided. A pure refactor, apart from the edge case under Consequences. The Svelte conformance check stays at 1278 of 1278 in scope. The HUD bundle tripwire (`MEASURED_GZIP`) is unchanged and passes.
- Outside the UI module, `editor/uiViews.ts` reads `el._style.target`/`el._style.resolved`, the Svelte renderer reads `hosted._style.target.state`, and `editor/prefetch.ts` prefetches `document/styledTree`.
