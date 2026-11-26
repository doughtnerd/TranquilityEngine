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

## Alternatives considered

- **One element per styled piece, laid out as a flex row.** Wrapping across pieces and per-line alignment break, so mixed text can't flow like a paragraph.

## Consequences

**Positive:** rich text in messages, `{@html}` and editable text, all on one text model.

**Negative / costs:** the text layout grows from one run to many, and the biggest change is in measuring; editing adds caret and selection handling.

## Deprecates

Nothing. A text with plain text content is one run, as today.

## References

0271, 0356, 0419; HTML Standard (phrasing content, `contenteditable`).
