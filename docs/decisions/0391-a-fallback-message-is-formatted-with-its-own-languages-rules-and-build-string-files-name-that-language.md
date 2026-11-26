# 0391. A fallback message is formatted with its own language's rules, and build string files name that language

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0356 §11)
- **Related:** 0354, 0356

## Context

When a key has no message in the current language, `Locale` resolves it through the language's fallback chain (0354
§1, 0356 §6). In the editor's Play and the Studio, `Locale` reads the project's tables and knows which language the
message it found is written in, so it formats it with that language's `Intl` tag: an English message shown while the
game is in French uses English plural rules (`{n, plural, one {# item} other {# items}}` gives "0 items").

A build reads `strings/<code>.json` (`myco.strings.build@1`, 0356 §11). The export resolves every key through the
language's chain and copies the message found into the file, so each file is complete on its own, but the file did not
say which language a copied message was written in. The player therefore formatted it as the file's language: the same
English message in `strings/fr.json` was formatted with French rules, where 0 is `one`, and showed "0 item". The editor
and the build disagreed (review item Q12).

The owner's decision (Q12, option a): a fallback message is formatted with its source language's plural and number
rules, in builds as well as the editor, as react-intl and other ICU MessageFormat libraries do (a message's rules are
those of the language it is written in; its plural categories only exist in that language).

## Decision

We will record, in each build string file, the language of every message that isn't written in the file's own language,
and the player will format each message with its recorded language.

- **Format.** `myco.strings.build@1` gains an optional `sources` object: language code → the keys whose message is
  written in that language, `{ "en": ["hud.items", "menu.quit"] }`. Grouped by language so a file that falls back a lot
  repeats each code once. Left out when every message is in the file's language (the common case: no size cost). The
  format name doesn't change: the field is additive.
- **Old files.** A file without `sources` reads as before: every message in the file's language. Builds made before
  this keep their old behaviour until they are exported again.
- **Reading** is lenient, like the rest of the file: a code that isn't a language code, the file's own language, a
  value that isn't a list, and a key the file has no message for are each dropped with a problem.
- **Runtime.** The `LocaleStrings` seam (not public API) gains an optional `sourceOf(key, code)`; `BuildStrings`
  answers it from `sources`. `Locale` formats a resolved message with `sourceOf(key, code) ?? code`, which is what it
  already did for project tables. The same language also decides whether the key counts as having fallen back in
  `Locale.debug().missing`, so a build reports the same fallbacks as the editor.

## Alternatives considered

- **Format with the current language everywhere (Q12 option b)** — rejected by the owner: a message's plural
  categories are its own language's (English has no `few`, Polish has no use for English `one`), so other rules can
  pick a branch that doesn't exist or reads wrong.
- **A per-key object (`strings: { key: { text, from } }`)** — larger for every key, and not backward compatible with
  readers that expect strings.
- **A parallel `key → code` map** — repeats the code for every fallback key; grouping by language is smaller for the
  same information.
- **Loading the fallback languages' files at runtime** — makes each file depend on others and adds requests on a
  switch; 0356 chose complete files on purpose.

## Consequences

**Positive**
- The editor and builds show the same text for a fallback message.
- No cost for files that don't fall back; old builds and files still load.

**Negative / costs**
- A few bytes per fallback key in the build file.
- Builds exported before this keep formatting fallbacks with the file's language until re-exported.

## Deprecates

Nothing.

## Open questions

None.

## References

- `src/engine/localisation/runtime/buildFile.ts` (writer and reader), `runtime/strings.ts` (`BuildStrings.sourceOf`),
  `Locale.ts` (`resolve`).
- Tests: `src/engine/localisation/runtime/buildFile.test.ts` (the editor and a build give the same text for n = 0, 1, 2
  of an English message shown in French; `sources` written, round-tripped, absent when nothing fell back; old files).
