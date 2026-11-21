# 0310. Input devices are one snapshot module: device events in, a typed UI routing step, the DOM listener as an adapter

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0011 (step 2, the input snapshot), 0032 / 0034 (shared devices, Worlds that take input), 0069 (UI-first routing), 0076 (the UI core), 0309 (the UI interaction log the routing feeds)

## Context

`src/engine/input/Input.ts` held module state (held keys, this frame's downs and ups, a queue, pointer, movement,
scroll), the DOM listener, the snapshot, UI-first routing and the public getters in one class, plus:

- four internal statics the UI core reached into, relying on their order: `_addFrameHook`, `_claimPointer`,
  `_claimKeyboard` (only valid while a hook runs) and `_raw`;
- `simulate`, `simulatePointer`, `simulateMouseMove` and `simulateScroll`, documented "(tests)"; `simulate` claimed
  "editor play mode" but only tests and the audio soak (`realScenes.soak.ts`) called it. CLAUDE.md forbids test-only
  members;
- a leak: the `contextmenu` listener was added on every `attach` / `retarget` and never removed.

## Decision

We will split input into one device-snapshot module and adapters.

- **`src/engine/input/devices.ts`: the device snapshot** (`devices`, the Engine's one set of devices).
  - **Input end** (`DeviceEventSink`): `keyDown(key)`, `keyUp(key)`, `buttonDown(button)`, `buttonUp(button)`,
    `pointerAt(x, y)` (canvas pixels, at once), `move(dx, dy)`, `scroll(dx, dy)`, `releaseAll()` (focus lost). Keys,
    buttons, movement and scroll queue until the next snapshot.
  - **Snapshot** (`beginFrame`, run once per Engine frame): applies the queue, then the **routing step**.
  - **Routing step**: each router (`addRouter(router)`, returning its removal) is handed what the pointer did this frame
    (`PointerFrame`: position, and per button down / held / up, before routing) and returns what it claims
    (`InputClaim`: `{ pointer?, keyboard? }`). Then this frame's mouse presses over claimed UI go to the UI until
    released (ADR 0069, unchanged). The UI core is the router; nothing else reaches into the snapshot.
  - **Reading end**: what the game sees after routing (held / down / up for a key, any key down, pointer, movement,
    scroll, pointer and keyboard over UI), read by the `Input` getters.
- **`src/engine/input/domDevices.ts`: the DOM adapter.** `listenToDom(canvas, sink)` turns keyboard events on the
  window and pointer, wheel and context-menu events on the canvas into device events, and returns one function that
  removes *every* listener it added (the `contextmenu` leak is fixed).
- **`Input`** keeps its public getters unchanged and its engine-facing `@internal` lifecycle (`attach`, `retarget`,
  `detach`, `beginFrame`, `reset`), each a call into the snapshot or the adapter. `_addFrameHook`, `_claimPointer`,
  `_claimKeyboard`, `_raw` and the four `simulate*` statics are deleted.
- **Tests drive the DOM adapter**: a test helper (`src/engine/tests/domInput.ts`) attaches `Input` to a stand-in canvas
  and window built on Node's `EventTarget`, and dispatches `keydown`, `pointerdown`, `pointermove`, `wheel`… events, as
  one existing UI core test already did. No DOM test environment is added (none is in devDependencies). Every former
  `simulate*` caller (engine and editor tests, the server test, the audio soak) moves onto it.

## Alternatives considered

- **Keep `simulate*` but call it the play view's adapter.** Nothing in production feeds input but the DOM listener; the
  members would stay test-only by another name.
- **Add happy-dom or jsdom as a test environment.** A new dependency for what `EventTarget` and `Event` already give in
  Node; recorded here as not needed.
- **Make the device snapshot a seam with a pluggable source** (touch feed, play view). Only one real adapter exists;
  the input end is the place a second one would plug in when it does.

## Consequences

**Positive**
- UI-first routing (ADR 0069) lives in one module, with a typed hand-over instead of ordered statics.
- No test-only members on `Input`; tests exercise the same DOM listener the player's browser does.
- The `contextmenu` listener no longer accumulates on re-attach.

**Negative / costs**
- Tests that injected key names now dispatch DOM events; a key passes through the same normalisation as a browser's
  (`" "` and `"space"` both mean Space).

## Deprecates

`Input._addFrameHook`, `_claimPointer`, `_claimKeyboard`, `_raw`, `simulate`, `simulatePointer`, `simulateMouseMove`,
`simulateScroll` (removed; callers moved).

## Open questions

None.

## References

`src/engine/input/devices.ts`, `domDevices.ts`, `Input.ts`, `src/engine/ui/UICore.ts`; tests
`src/engine/tests/input.test.ts`, `src/engine/tests/domInput.ts`.
