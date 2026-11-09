# 0159. One view allocator gives Worlds their surfaces and input, one link applier connects links, and project settings boot in one step

- **Status:** Proposed
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0024, 0032, 0034, 0050, 0055, 0062, 0068, 0080, 0128

## Context

`core/Engine.ts` (816 lines) held three jobs besides stepping Worlds, each spread over fields and methods that had
to agree:

- **Views and input.** Eight fields (`viewWorld`, `render`, `extraViews`, `handedViews`, `inputWorld`,
  `inputCanvas`, `viewWishes`, `variantReport`) and seven methods (`assignView`, `applyInput`, `_handView`,
  `unwindViews`, `_attachView`, `_focusInput`, half of `tearDown`) kept the rules of ADR 0034 and 0068: one main
  view; an editor tile gives way to the main view; hand-overs nest and unwind innermost first; input follows the
  view unless focused or set by config; a destroyed World unwinds the hand-overs it was given and disposes the
  hidden surface it left. `world === this.viewWorld ? this.render : this.extraViews.get(world)` was written out in
  `stepWorld`, `_redraw` and `applyInput`. The only tests (`handView.test.ts`) mocked `BabylonSurface` and went
  through a whole Engine.
- **Links (0062).** `Engine.create` connected the start-up links inline (its own `{ server, peer, pending }`
  record, awaited), and `applyLink` did the same bookkeeping for runtime ones with promise callbacks, plus the
  "already connected elsewhere" and retry-next-frame rules the start-up copy lacked.
- **Project boot.** `create` also added asset sources, picked storage (0024), warned about four project-settings
  sections (graphics, navigation, physics, audio), configured the mixer and FMOD, and ran quality auto-detect
  (0050, 0055), before it got to the bootstrap.

## Decision

**View allocator.** `core/viewAllocator.ts` exports `ViewAllocator`, which owns which surface and which input
target each World has. It is given `container` (null: headless), `createSurface(element, world)` and an
`input` port (`attach`, `retarget`, `detach`; the Engine passes `Input`). Interface:

- `add(world, { renders, input })` when a World is created; `retire(world)` when it's destroyed (it stops being a
  candidate for the view and input at once); `release(world)` at its tear-down (its tile and the hidden surface it
  left are disposed, hand-overs given to it unwind, the main view passes on).
- `surfaceOf(world)`: its main view or tile, or null. The Engine asks this when it steps and redraws a World.
- `handView(world)` (0068), `attachView(world, element)` (editor tiles), `focusInput(world | null)`.
- `state(world)` for `_viewStates`, `setVariantReport(on)` (0080, every surface now and later), `dispose()`.

The invariants live inside it: one main view, tiles give way to it, hand-overs nest, input follows the view, a
destroyed World unwinds its hand-overs. It sets `world.render` and `world._takesInput` as before. Its tests use
fake surfaces and a fake input port, with no DOM, Babylon or Engine.

**Link applier.** `core/linkApplier.ts` exports `LinkApplier` over `find(name)` and `alive(world)`: it holds the
bootstrap's links, the connection each made per client (`linkedServer(client)`), and the links deferred to the
next frame. `startUp()` applies every link in order, awaiting each connection (a failure fails `Engine.create`,
as before); `worldCreated(world)` and `retryDeferred()` (once per frame) apply runtime ones and log failures. One
`connect(link)` does the bookkeeping for both. So start-up links also skip a client a bootstrap script already
connected to another server (with the warning), which the start-up copy didn't check.

**Project boot.** `core/projectBoot.ts` `bootProject(engineSettings, options)` does the asset sources, storage,
the four sections' warnings, the mixer and FMOD, and the quality tier, and returns the quality monitor or null.
`Engine.create` calls it, then runs the bootstrap.

The public Engine API and `Engine.create`'s signature and behaviour are unchanged; `Engine` keeps its `@internal`
editor methods (`_handView`, `_attachView`, `_focusInput`, `_viewStates`, `_setVariantReport`) as one-line
delegations.

## Alternatives considered

- **Leave views in Engine and add the `surfaceOf` helper only** — removes the repeated lookup but leaves the
  invariants across seven methods, testable only through a whole Engine with Babylon mocked.
- **Store the surface on the World only (`world.render`) and drop the lookup** — `world.render` is also what
  components release into while a World is torn down, so it can't be the allocator's single source of truth
  without changing tear-down order.
- **Make the input port a seam with one adapter** — it has two: the real `Input` and the tests' fake.

## Consequences

**Positive**
- The view and input rules are in one module (270 lines, half of them comments) with direct tests; Engine drops
  eight fields and six methods, and goes from 816 to 542 lines.
- One link path; start-up and runtime agree on what "already connected" means.
- `Engine.create` reads as: boot project settings, run the bootstrap, apply links, wait for scenes.

**Negative / costs**
- Two calls on destroy (`retire`, then `release` at tear-down), because a World destroyed in its own frame is torn
  down at the frame's end.
- One more indirection for editor tools reading view state.

## Deprecates

`Engine`'s `assignView`, `applyInput`, `unwindViews`, `applyLink`/`applyLinks`, `newSurface`, the inline start-up
link loop and the `ViewHandOver` record: removed, moved into the modules above. `handView.test.ts` keeps its
Engine-level checks (drawing to the right surface); the hand-over, tile and input rules move to
`viewAllocator.test.ts`.

## Open questions

None.

## References

- `src/engine/core/viewAllocator.ts`, `linkApplier.ts`, `projectBoot.ts`, `Engine.ts`
- Tests: `src/engine/tests/viewAllocator.test.ts` (new), `handView.test.ts` (Engine-level checks kept),
  `spawnableLinks.test.ts` and `bootstrap.test.ts` (links through `Engine.create` and `createWorld`)
