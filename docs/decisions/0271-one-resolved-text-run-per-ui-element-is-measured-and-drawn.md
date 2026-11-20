# 0271. One resolved text run per UI element is what layout measures and what the drawing layer draws

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0076, 0077, 0069, 0010

## Context

The UI core (0076) lays text out with Yoga and a measure function; Babylon GUI draws it (`render/babylon/ui.ts`). What a text element shows (its text, size, CSS weight, family, line height and wrapping) was assembled separately in each:

- `UICore.measure` built a `TextMeasureRequest` from `UIText` and, for input fields, from `value || placeholder` with weight `"400"`; `UICore.applyProperties` built a second string of the same fields as the measure's dirty signature.
- `BabylonUI.syncUIText` and `syncInput` read the same component fields again (weight `"400"` twice, `fontSize * UI_LINE_HEIGHT` for the caret).
- Two weight mappings disagreed: `layout.ts` `cssFontWeight` accepted `/^[1-9]00$/`, Babylon's private `cssWeight` accepted `/^\d+$/`. A `fontWeight` of `"350"` was laid out at 400 and drawn at 350, so the box did not fit the text.
- Wrapping disagreed too: `wordBreak: "keep-all"` was measured wrapped at spaces and drawn on one clipped line, and `break-all` was measured at spaces and drawn breaking anywhere.

The closed list of element kinds was also switched on in six places: `UICore.ts` (`kindOf`, `LEAF_KINDS`, interactive kinds), `UIDocument.ts` (`TAG_TYPES`, `pseudoState`), the markup and stylesheet parsers (`UI_TAGS` twice), `babylon/ui.ts` and the editor's `uiPicking.ts` (`isPaintedUI`).

## Decision

We will put the element kinds and the text run in one engine module, `src/engine/ui/elementKinds.ts`, renderer-neutral and not public API (0010).

- **The kind table.** One row per closed kind (`canvas`, `panel`, `text`, `image`, `button`, `input`): its component type, markup tag, whether it is a leaf, whether it takes the pointer, its Yoga flex shrink, the pseudo-classes it sets, and whether it paints anything. Its interface: `uiKindOf`, `uiTypeOfTag`, `UI_TAGS`, `UI_KIND_TYPES`, `isLeafKind`, `isInteractiveKind`, `flexShrinkOf`, `uiPseudoState`, `isPaintedUI`. The UI core, UI documents, both parsers and the editor's UI picking read it.
- **The text run.** `textRunOf(component)` returns the resolved `UITextRun` (`text`, `fontSize`, `fontWeight` as CSS, `fontFamily`, `lineHeight`, `wrap: "word" | "anywhere" | "none"`) or null for kinds without text. An input field's run is its value (its placeholder while empty) on one line (`wrap: "none"`, a line break shown as a space so caret indices still match) at weight 400.
- **The core measures the run and publishes it.** `UICore` keeps each text entry's run, re-measures when the run or the font epoch changes (the run is the dirty signature), measures with `maxWidth: Infinity` for `wrap: "none"`, and reports the run on each laid-out element (`UILaidOutElement.text`). A changed run alone bumps `layoutVersion`. `TextMeasureRequest` is the run plus `maxWidth`, and both measurers (`estimateText` in Node, Babylon's `measureText`) wrap as the run says.
- **Babylon draws exactly that run.** `syncUIText` and `syncInput` take the text, font and wrapping from `el.text`; only colour and alignment, which don't change the size, come from the component. Babylon's `cssWeight` is deleted.
- **One weight rule.** A `fontWeight` is one of the names `light` (300), `normal` (400), `medium` (500), `semi-bold` (600), `bold` (700), or a whole number from 1 to 1000 (CSS Fonts 4). The bundled Inter is a variable font (100 to 900), so an in-between weight draws as written. Anything else is 400. This keeps what Babylon drew and makes layout agree with it.

## Alternatives considered

- **Babylon calls `textRunOf` itself** instead of reading `el.text`: the two would agree only while both call the same function at the same moment; publishing the run makes "measured equals drawn" a property of the core's output that a test can read.
- **Multiples of 100 only** (layout's old rule): it would change what existing projects with `"350"` or `"650"` draw, and the variable font supports every weight.
- **Keep the kind switches where they are** and only share the text run: a new kind would still touch six modules.

## Consequences

**Positive**
- Measured text is drawn text: weight, family, size, line height and wrapping can't drift. `keep-all` text no longer measures two lines and draws one.
- A new element kind is one row in one module.
- "Measured equals drawn" is tested through `UICore.elements()` and the host's measure requests; the run and the table have their own unit tests.

**Negative / costs**
- `textRunOf` and the font family lookup run for every text element each sync (a few field reads and a map lookup, as the old signature string did).
- The markup and stylesheet parsers (a lazy chunk) now import the kind table, and through it the UI components, which the main bundle already holds.

## Deprecates

`layout.ts` `cssFontWeight` and `UI_LINE_HEIGHT` (moved to `elementKinds.ts`), Babylon's `cssWeight` and its `UI_FONT_FAMILY`/`UI_LINE_HEIGHT` re-exports, `UICore`'s `kindOf`, `LEAF_KINDS` and signature string, `UIDocument`'s `TAG_TYPES` and `pseudoState`, the parsers' own `UI_TAGS` lists, and the editor's private `isPaintedUI`. All removed; callers use the module.

## Open questions

None.

## References

- Architecture review 2026-11-20, candidate 4 and small fix 1.
- `src/engine/ui/elementKinds.ts`, `src/engine/ui/UICore.ts`, `src/engine/render/babylon/ui.ts`; tests `engine/tests/elementKinds.test.ts`, `engine/tests/uiCore.test.ts` ("reports the text run it measured…"), `engine/tests/babylonUI.test.ts`.
