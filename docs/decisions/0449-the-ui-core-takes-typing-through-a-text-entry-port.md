# 0449. The UI core takes typing through a text entry port, and drops its test-only `hitTest`

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson (directed after the 2026-11-28 architecture review)
- **Supersedes:** —
- **Related:** 0069, 0076, 0434 (the UI core); 0309, 0340 (typing's events and navigation); 0356 (IMEs); 0385
  (raycast targets); 0428 (text areas); 0429 (editable text)

## Context

`src/engine/ui/UICore.ts` (2407 lines) has a small interface (`UICoreLike` in `uiCoreTypes.ts`) but mixes four
concerns: layout mirroring, pointer routing, hit-testing and the typing bridge. The typing bridge (`ensureDom`, `syncDom`,
`syncEditDom`, `editInput`, `unfocusDom`, about 250 lines) made hidden DOM `<input>`/`<textarea>` elements and called
`document` directly, so it couldn't run in Node. Its tests had to stub the global `document` with a fake element
(`stubDocument`/`FakeInput` in `src/engine/tests/uiPointer.ts`). Commit 5daa0487 had to rework a test that read a
private field.

`UICoreLike.hitTest` was documented as being "for tests". Its only non-test caller was the test helper
`UIPointer.centreOf`, with about 80 assertions in UI tests beside it. CLAUDE.md doesn't allow test-only members.

## Decision

**Text entry is a port the core is given.** `src/engine/ui/textEntry.ts` defines:

- `UITextEntry`: `open(multiline, events)` makes a `UITextBox`, or returns null when the platform has none.
- `UITextBox`: a value, a selection with direction, `dir`, `limit(maxLength)`, focus and blur, and `remove`. It reports
  `input`, `key` (`UITextKey`: key, Shift, IME composing, `preventDefault`) and `blur`.

`UICoreOptions.textEntry` takes the adapter, beside `host`, following the core's existing options pattern. When it's
left out, the core uses the browser adapter, so `BabylonUIFeature` and every other caller keep working unchanged.

**The bridge is separate from the adapters.** `UITextEntryBridge`, in the same module, holds the half of typing that
doesn't depend on the platform, moved out of `UICore.ts` with the same behaviour:

- one box per kind, shared by whichever field is focused;
- mirroring value, `maxLength` and direction into the box;
- trimming to `maxLength` and recording `change`;
- Enter submits, Escape cancels, Tab and Shift+Tab move through navigation, and those keys are claimed from the game;
- IME composing is left alone;
- a blur from the player unfocuses the field;
- the editable text's selection is synced both ways, and its edits go into its runs.

The core keeps the editing state, because pointer routing changes it, and hands it to the bridge.

**Adapters:**

- `src/engine/ui/domTextEntry.ts` is the browser's adapter and the default: hidden off-screen DOM elements, made
  exactly as before. Without a `document` it makes nothing, so typing in Node still does nothing by default.
- `src/engine/tests/memoryTextEntry.ts` (`MemoryTextEntry`) keeps boxes in memory and edits them as a browser's text
  controls do for what the bridge relies on: typing at the caret within `maxLength`, Backspace and Delete, the caret
  keys with Shift, Enter in a multi-line box, Tab's focus change unless prevented, and focus moving between boxes.
  It lives in tests, not production: no production caller types without a DOM today. A headless or dedicated server
  routes no player typing, and `Input.inject` has no text input. When a production consumer appears (an automation
  or replay path that types in Node), the adapter moves into `src/engine/ui/` beside the DOM one. Nothing about the
  port changes.

**`hitTest` is removed** from `UICore` and `UICoreLike`. Tests ask what the pointer goes to with
`pointerTargetAt(core, x, y)` in `src/engine/tests/uiPointer.ts`. It is built from what the core reports to real
callers: the topmost raycast target (`isRaycastTarget`) among the elements the editor's `pickAll` lists at the point,
or the interactive element it's in. Every former `hitTest` assertion passes unchanged through it. `UIPointer.centreOf`
uses it too, and `UIPointer.create` takes `{ textEntry }`.

Route and hit-testing stay in `UICore.ts` for now: splitting them wouldn't shrink the interface. The file goes from
2407 to 2211 lines.

## Alternatives considered

- **Move all of the typing logic into the DOM adapter.** An in-memory adapter would then have to repeat the field
  rules (`maxLength`, submit, navigation keys), and Node tests would check the copy instead of the code that runs.
- **A production in-memory adapter now.** Nothing would use it outside tests yet. It moves when something real does.
- **Keep stubbing `document`.** This leaves the bridge tied to DOM globals and its tests tied to a fake element's
  shape. The existing DOM-stub tests do stay, as tests of the DOM adapter.
- **Keep `hitTest` for the editor.** The editor picks with `pickAll`/`pickCanvases`, and no runtime caller needs the
  routed target outside routing.
- **Port hit tests to stepped pointer events.** About 80 assertions across non-interactive cores would each have
  needed frames, a World loop and observable side effects. The cost is too high for the same coverage.

## Consequences

**Positive**
- Typing (fields, text areas, editable text: caret, selection, Enter, Escape, Tab, IME, blur) is tested in Node through
  the real bridge (`src/engine/tests/uiTextEntry.test.ts`).
- The DOM-specific code is in one 100-line module, and `UICore.ts` holds no `document` reference.
- `UICoreLike` loses a test-only member.

**Negative / costs**
- `pointerTargetAt` composes `pickAll` with the raycast-target rule. If routing's hit order ever diverges from
  `pickAll`'s (for example, scrollbars, which `pickAll` doesn't list), the helper won't see it. Routing tests that click
  and scroll still cover routing itself.
- One small behaviour change in Node without a stubbed `document`: an editable text being edited now stops being edited
  when it becomes hidden or non-editable, as it already did in the browser. Before, the whole sync step was skipped
  when there was no `document`.

## Deprecates

`UICoreLike.hitTest` and `UICore.hitTest` are removed. The private DOM fields (`dom`, `doms`, `active`, `editActive`,
`programmatic`, `detachDom`, `swallowed`) leave `UICore`.

## Open questions

- Whether `BabylonUIFeature` should pass `domTextEntry()` explicitly rather than rely on the default. The behaviour is
  the same either way.

## References

- `src/engine/ui/textEntry.ts`, `src/engine/ui/domTextEntry.ts`, `src/engine/tests/memoryTextEntry.ts`,
  `src/engine/tests/uiTextEntry.test.ts`, `src/engine/tests/uiPointer.ts`.
