# 0425. A text element holds styled inline runs, which `{@html}` and `contenteditable` read and write

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0271, 0356, 0419, 0422, 0424

## Context

A UI text element draws one text run with one style (0271). Three needs depend on mixed styles inside one text: localised messages with emphasis ("You have **3** coins"), Svelte's `{@html}`, and `contenteditable` (`bind:textContent`, `bind:innerHTML`). The last two are in 0419's full-compatibility target.

## Decision

**A text element's content may be a sequence of inline runs, each with its own style, laid out and drawn together.**

- **Inline elements:**
  - inside a text element, `span`, `b`/`strong`, `i`/`em`, `u`, `s`, `a`, `code`, `small`, `sub`/`sup`, `mark`, `br` and inline images (`img`);
  - each run takes cascade properties: `color`, `font-*`, `text-decoration`, `background-color`, `vertical-align`;
  - in markup and Svelte they're ordinary child elements of a text element.
- **Measuring and drawing:** one text layout measures the runs together (wrapping across run boundaries, 0356's line breaking and RTL). `textRunOf` (0271) becomes a list of runs with one measuring and dirty signature, and drawing draws the runs in order.
- **Links and hit-testing:** an `a` run takes clicks (0422 events with the run as target), and hit-testing resolves to the run under the pointer.
- **`{@html}`:** the renderer's `html(anchor, string)` hook (0419) parses an inline HTML subset into these runs.
  - Block elements in the string become panels, as the renderer maps tags.
  - Scripts, styles and event attributes are dropped.
  - The parser loads only in games that use `{@html}`. It's a small inline tokenizer, not `htmlparser2`.
- **`contenteditable`** on a text element:
  - it edits the runs (caret, selection, typing, IME through the hidden input);
  - `input` events fire;
  - `bind:textContent` and `bind:innerHTML` read and write the runs as text or the inline HTML subset;
  - rich formatting commands are out of scope.
- **Localisation:** ICU messages may carry the inline subset (`<b>{count}</b>`), rendered as runs (0356). Translators keep the tags.

**As built (2026-11-26):**

- **Runs are elements, laid out by their text.** A text element's inline children (texts and images, nested too) are hosted UI elements as before, so the cascade styles them, selectors match them, the editor can pick them and events target them; but the UI core gives them no Yoga node (a text stays a leaf) and lists them in no draw order. `textRunOf` walks them into `UITextRun.runs` (`UIInlineRun`: text, size, CSS weight, style, family, colour, decorations, background, `vertical-align`, baseline shift, image, the element events go to, the component holding the text), with whitespace collapsed across runs as HTML does. Plain text keeps `runs` absent and every path of 0271. The run list is the dirty signature; a change of colour, decoration or background alone redraws without measuring again.
- **Text between inline children** becomes text pieces: hosted elements tagged `#text` (Svelte's text nodes; a document's text between tags) that no rule matches, not even `*` (a DOM text node's style is its parent's), and whose events go to their parent. A text with only text keeps its own `text`.
- **One layout module**, `ui/text/inlineLayout.ts` (pure): it joins the runs' text and breaks it with 0356's `lineSegments` (an image a break on both sides, a `<br>` run a forced break; a trailing one makes no line unless the text is editable), fills lines greedily, builds line boxes from each run's font size × line height with the paragraph's font as a strut (plain text keeps its height), aligns runs on a common baseline (`sub`/`super` as shifts; `middle`, `top`, `bottom`, `text-top`, `text-bottom` as in CSS), aligns lines, and places a right-to-left line's runs from the right in logical order (the browser orders mixed text inside each run: bidi across runs is simplified, as 0356 records for input fields). It also gives the caret position, the offset under a point and the selection's rectangles. The UI core measures with it (a host's new `measureRunWidth`, Babylon's canvas measure, else an estimate), lays the text out again at its content width, publishes the lines (`UILaidOutElement.inline`), gives each run the bounds of its fragments, and resolves a hit on the text to the run under the point (`pickAll` lists the run before its text).
- **Babylon draws runs itself** in the existing `TextBlock` subclass (`LocalisedTextBlock`), chosen over a composite of one block per fragment: one control per text keeps 0426's full-matrix transforms and filters, the redraw region and the outline and shadow working unchanged, and draws each fragment where the core laid it out (font, colour, background, decorations, an inline image, an editable text's selection and caret). A text's own `background-color` paints its box.
- **Styles.** `UIText` gains `fontStyle` (inherited), `textDecoration` (a run's reach its inline children when its runs are built), `backgroundColor`, `verticalAlign` and `contentEditable`; `font-family` names a font file or a CSS generic family (`monospace`). HTML's phrasing defaults (`b` bold, `i`/`em` italic, `u`/`a` underlined, `s`/`del` struck, `code`/`kbd` monospace, `small`/`sub`/`sup` 0.83 em, `mark` black on yellow) are in the cascade, below every declaration and above inheritance, as the user-agent origin is (no rule sheet: games ship no CSS parser). A link keeps the text's colour rather than browsers' blue.
- **Svelte.** Every element inside a text element is a run (a non-phrasing one warns and is drawn as text); `br` is a line break run, `img` an inline image sized by its `width`/`height`. `{@html}` is the patch's new `html(anchor, value)` hook (svelte-patch.md): the renderer builds nodes with a small inline tokenizer, `htmlInline.ts` (imported as `myco/ui-html`), which `compileSvelteUI` imports, with a call registering it with the renderer, only into components that use `{@html}` or `bind:innerHTML`; a static import rather than a dynamic one keeps `{@html}` synchronous, as in the DOM, and still out of every other game's bundle. A node's `innerHTML` is writable through the same parser.
- **`contenteditable`** (text elements only) is the UI core's: a press puts the caret (Shift extends, a drag selects), the hidden `<textarea>` takes typing and the IME, Escape/Tab or a press elsewhere ends it, `focus`/`blur` and `input` events follow. An edit (the span the text area's old and new text don't share) is written into the components holding the runs' text, typing at a run boundary going into the run before it; images can't be deleted. The renderer brings its nodes up to date before `input` listeners run (`onUIHostEdit`), and binds `textContent`, `innerText` and `innerHTML`. An editable text keeps its whitespace as typed.
- **Localisation: `tHtml(key, args)`** from "myco", for `{@html tHtml("hud.coins", { count })}`: the message with its tags, every string argument HTML-escaped (a `LocalText` argument is another message, kept). Chosen over `t()` returning markup (every existing `{t(…)}` would show tags) and over a `<T key>` component (a built-in component in every game's bundle for one feature). A UI document's `t:text` shows the message's text without its tags; documents retire in wave D.
- **UI documents** take phrasing child markup inside a `Text` (`MarkupElement.inlineTag`), written as XML.
- **Not built:** `:hover`/`:pressed` on runs, padding, margins and borders on runs, inline blocks, `white-space` other than collapsing (and `pre-wrap` for editable text), undo beyond the text area's, a blinking caret.

## Alternatives considered

- **One element per styled piece, laid out as a flex row.** Wrapping across pieces and per-line alignment break, so mixed text can't flow like a paragraph.

## Consequences

**Positive:** rich text in messages, `{@html}` and editable text, all on one text model.

**Negative / costs:** the text layout grows from one run to many, and the biggest change is in measuring; editing adds caret and selection handling.

## Deprecates

Nothing. A text with plain text content is one run, as today.

## References

0271, 0356, 0419; HTML Standard (phrasing content, `contenteditable`).
