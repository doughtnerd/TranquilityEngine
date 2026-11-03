# 0034. Between frames the default World is current; the view passes between Worlds

- **Status:** Accepted
- **Date:** 2026-11-02
- **Deciders:** Chris Carlson
- **Supersedes:** parts of 0032 (the current world outside frames; rendering and input ownership)
- **Related:** 0016, 0018, 0022, 0032

## Context

Implementing 0032 (wave 1) and reviewing it turned up places where the record doesn't work as written, or doesn't say enough:

- **Outside frames.** 0032 says the static facades (`Time`, `SceneManager`, `GameObject.create`, …) throw when no World's frame is running. But the editor creates and edits nodes between frames, and so do tests, `Engine.create` callers and scene loading. Throwing would break all of them.
- **Code after an `await`.** Promise continuations run after the Engine's frame has returned, so no World's frame is running. A behavior in a server World that awaits and then calls `GameObject.instantiate` would act on whatever World is current. JavaScript has no way to carry "the current World" across an `await`.
- **Rendering and input.** 0032 says a World "renders to a surface or runs headless" and "receives local input or not", but not who decides when several Worlds want the one canvas. The first implementation gave the canvas to the first World and never gave it up. So the Host flow (a menu World creates a match World and destroys itself) left a blank, input-dead screen.
- **The Editor World and game systems.** With 0032's default `worlds` filter (`default`, `local`), game systems no longer run in the Editor World, which is tagged `editor`. They never saw the scene being edited anyway, but 0032 doesn't say so.

## Decision

1. **Between frames, the Engine's default World is current.** While a World's frame runs, that World is current, as in 0032. Outside frames, the facades act on the default World (`engine.world`) instead of throwing. They throw only when no Engine exists.
2. **Code that may run after an `await` names its World:**
   - **A given parent decides the World.** `GameObject.create(name, { parent })` and `GameObject.instantiate(path, { parent })` use the parent's World.
   - **Behaviors use their own World.** `this.instantiate(path, options)` and `this.time` always use the behavior's World. They're the recommended forms in async behavior code; `this.instantiate` refuses a parent from another World.
   - Engine-internal work done for a World uses that World directly: scene loads capture their World when called, and physics events go into their own World's buffers.
3. **One view per Engine, passed between Worlds.** An Engine has one view: its canvas and render surface when it has a container, and local input.
   - **Who gets it:** the first World that wants it. A World wants it unless its config says `renders: false`. A World tagged `server` doesn't want it unless it says `renders: true`.
   - **Input follows the view** unless a World's config sets `input` itself.
   - **Handover:** when the World with the view is destroyed, its objects are released and the view passes to the next World that wants it. The canvas and input listeners stay attached.
   - Giving several Worlds their own views at once (tiling) is the editor's job in wave 2 (T5).
4. **Game systems don't run in the Editor World** unless their `worlds` filter includes `editor`. Engine built-ins (script hooks, physics) are meant for every World (`"*"`).
5. **`Engine.createWorld` validates a config the way a declarative bootstrap does:** names, tags, rates, system names, unknown keys. It does that before changing anything, so a bad config leaves the Engine as it was. If `Engine.create` fails partway (a start-up scene doesn't load), it disposes what it made. `timeScale: 0` (start paused) is valid.

## Alternatives considered

- **Throw outside frames (0032 as written).** It would catch async mistakes loudly, but it breaks the editor and every caller that builds a scene before starting the loop.
- **Run each World's promise continuations before stepping the next World.** That would need the frame loop to be async and to drain microtasks per World. Continuations that await again would still escape, and `engine.step()` couldn't stay synchronous for tests.
- **Keep the canvas with the first World for the Engine's life.** That's the bug described above.

## Consequences

**Positive**
- The editor, tests and existing games keep working. The Host flow (a menu that creates a match World and then destroys itself) keeps a working screen and input.
- Async behavior code has a clear rule: use `this.instantiate`, `this.time` or a parent, and it stays in its World.

**Negative / costs**
- A bare `GameObject.instantiate(path)` or `Time.*` after an `await` in a non-default World still acts on the default World. The documentation and the async guidance have to say so.
- Only one World is visible at a time until the editor tiles views.

## Deprecates

- 0032's "outside any World's frame, the facades throw".
- Wave 1's first-World-keeps-the-canvas behavior.

## Open questions

- Should a development build warn when a facade is used after an `await` from a behavior whose World isn't the default one?

## References

- ADR 0032; ADR 0018 (promise-based waits).
- TC39 AsyncContext proposal, which would let the current World follow an `await`: https://github.com/tc39/proposal-async-context
