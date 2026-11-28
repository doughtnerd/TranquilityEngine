# 0451. Localisation becomes a plugin that provides the engine's existing strings seam

- **Status:** Proposed (revision 2, after the RFC round)
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0133, 0135, 0144, 0275, 0354, 0356, 0357, 0391, 0423, 0452

Design folder: [`docs/design/plugin-lanes-localisation/`](../design/plugin-lanes-localisation/goal.md). RFC round:
[`docs/rfc/0451-0452/`](../rfc/0451-0452/). Spike: [`spikes/player-chunks/`](../../spikes/player-chunks/README.md).

## Glossary

- **String table:** a project file (`*.strings.json`) mapping keys to messages in one language, with translation
  files beside it (0356).
- **Message:** a string in ICU MessageFormat, which can hold plurals, numbers and dates (`{count, plural, one {# coin}
  other {# coins}}`).
- **Strings seam (`LocaleStrings`):** the interface `Locale` already reads its messages through
  (`src/engine/localisation/runtime/strings.ts:14-32`): load a language, give a key's message in a language, name the
  language a fallback message is written in, list the keys. `Locale` starts with an empty one (`noStrings`) and swaps
  it with `localeStringsChanged` (`Locale.ts:63`, `:459`).
- **Strings provider:** whatever supplies `Locale`'s `LocaleStrings`. Today the engine's boot does
  (`runtime/boot.ts`: project string tables, or a build's string files). After this record, the
  `myco.localisation` plugin does, and another plugin could instead.
- **Language state:** the current language and how it behaves (fallback chain, direction, fonts, formatting rules),
  which the UI core, asset loading and audio need with or without string tables. It stays in the engine.

## Context

Localisation is engine core (`src/engine/localisation/`, 5,646 lines, 3,878 without tests), with its editor tools in
the shell (`src/editor/ui/localisation/`, about 2,500 lines; the `strings` core asset kind). The public surface is
`Locale`, `LocalText`, `t`, `tHtml` (`src/engine/index.ts`).

**The seam already exists.** `Locale` formats messages itself (`message/`, imported at `Locale.ts:19-21`) and reads
them through `LocaleStrings`. Where they come from is decided in one place, `runtime/boot.ts`: `bootLocale` hands
`configureLocale` either the build's string files (`installBuildStrings`, called by the player at
`src/player/main.ts:62`) or project string tables read from the asset sources, and swaps them on edits.

**What can't move without breaking layering.** No engine file imports a plugin today. Code that stays in the engine
imports `message/` (`Locale.ts`, `pseudo.ts`), and `strings/format`/`strings/translation` (the four `exchange/` files,
audio's `playlist/format.ts` and `lines/format.ts` use `isStringKey` and `STRINGS_SUFFIX`). `t.ts` is imported by the
UI plugin's Svelte renderer (`setLocaleTracker`); moving it would make `myco.ui` depend on localisation.

**Size isn't the reason:** localisation is about 14 kB compressed in the player, about 2% of what loads up front
([`spikes/player-chunks/`](../../spikes/player-chunks/README.md)).

**Owner's direction (2026-11-27/28):** a plugin because it's a feature like any other and others should be able to
replace or extend it; smaller games a bonus; the smallest move, no rewrite.

## Decision

We will make **`myco.localisation`** a first-party plugin that **provides `Locale`'s strings seam**, and give it the
code that decides where strings come from and the tools that edit them. Formatting and the formats stay in the engine.

**The plugin** (`src/plugins/localisation/`, in the first-party catalogue, enabled by default):

- **Runtime half:** on activation, provides the `LocaleStrings` that `bootLocale` picks today: the build's string
  files in a player with them, otherwise the project's string tables from the asset sources, swapped when a table
  changes. It owns, moved from the engine: `runtime/strings.ts` (`ProjectStrings`, `BuildStrings`),
  `runtime/buildFile.ts`, and the string half of `runtime/boot.ts` (`installBuildStrings`, `assetStrings` and its
  `Assets.onChanged` listener).
- **Editor half:** registers the Localisation panel (the `src/editor/ui/localisation/` folder moves into it) and the
  `strings` asset kind (no longer a core asset kind).

**The engine keeps:** `Locale` with its formatting and language state, the `LocaleStrings` interface and `noStrings`,
`message/`, `strings/` (the file formats), `t.ts`, `languages.ts`, `variants.ts`, fonts, `pseudo.ts`, `exchange/`,
`textHash.ts`, `lenient.ts`, the subtitle model and settings, `Locale.debug()` (missing keys for the profiler), and the
Languages and Subtitles settings sections. `bootLocale` keeps choosing the start language; it takes its strings from
the provider instead of building them.

**Providing the seam:** the runtime context gets one setter for the strings provider (`ctx.locale.strings(provider)`),
undone on deactivation. One provider at a time; a later one replaces the earlier one with a warning. The plugin must
be active before `bootLocale` runs, which the technical design checks against the engine's start order.

**Callers outside the engine** that read string tables (the exporter's `src/export/strings.ts`, the player's
`installBuildStrings`, the Studio's Dialogue screens) import the plugin's modules directly, as first-party code may.
The player keeps its static call, so a game build still carries the plugin's string loading even when disabled; that
size win is deferred (the owner calls it a bonus).

**With the plugin disabled:** `Locale` keeps `noStrings`, so `t(key)` and `Locale.t` show the key and warn once, as a
missing key does today, `Locale.has` is false, and `Locale.debug()` lists the missing keys. Language state, `:lang()`,
direction, fonts, localised asset folders, `Audio.language` and message formatting (audio captions, subtitles) keep
working. The editor warns once in the status bar when a project has `*.strings.json` files and the plugin is off.
`myco.subtitles` gains a dependency on `myco.localisation`.

## Alternatives considered

- **A new strings interface with lookup and format** (revision 1). It duplicated `LocaleStrings`, and moving
  `message/` and `strings/` into the plugin would have made engine code import a plugin (RFC: senior engineer,
  challenger).
- **Move all of localisation and split `Locale`** (the first draft). About 5,500 lines moved; the owner asked for the
  smallest move.
- **A setter only, no file moves** (challenger). Cheapest (2–4 table-days), but the engine would still own where
  strings come from, so the plugin would be a shell around engine code.
- **Keep localisation in the engine.** Can't be disabled or replaced.

## Consequences

**Positive**
- Localisation is enabled, disabled and replaced like other features, through a seam that already exists and is
  already tested.
- No layering break: nothing in the engine imports the plugin.
- Small: about 600 runtime lines and the panel folder move; formatting and formats don't.

**Negative / costs**
- A disabled plugin still ships its string loading in game builds (the player's static import).
- `bootLocale`'s start-order dependency on the plugin needs a check and a test.
- **Provisional estimate:** about 10 table-days plus a third in reserve, 12–16 table-days (the relative unit of
  earlier task tables, calibrated against their estimates, not actuals). The technical design's task table replaces
  it.

## Deprecates

- The `strings` core asset kind (becomes the plugin's).
- Engine ownership of `runtime/strings.ts`, `runtime/buildFile.ts`, the string half of `runtime/boot.ts`, and the
  Localisation panel folder (moved to `myco.localisation`).

## RFC round (2026-11-28)

Reviews: [`docs/rfc/0451-0452/`](../rfc/0451-0452/) (architect, senior engineer, mid-level engineer, user,
challenger). Every code claim below was checked.

| Point | Reviewer | Outcome |
|---|---|---|
| The proposed interface duplicates `LocaleStrings` (`runtime/strings.ts:14-32`, `localeStringsChanged` `Locale.ts:459`) | senior, challenger | **Taken:** the plugin provides `LocaleStrings`. |
| `format`/ICU doesn't belong in the provider; captions and subtitles format with the plugin off | senior, challenger | **Taken:** `message/` stays. |
| "Stays" code imports "moving" code (`Locale.ts:19-21`, `pseudo.ts`, `exchange/`, audio formats); no engine file imports a plugin today | senior | **Taken:** `strings/` and `message/` stay; only the provider code and the panel move. Checked: engine files mention `src/plugins` only in comments. |
| Moving `t.ts` makes `myco.ui` depend on the plugin | senior | **Taken, owner to confirm:** `t.ts` stays (the owner's earlier summary moved it). |
| The player installs build strings before plugins activate (`main.ts:62` vs `:99`) | architect | **Taken:** the player keeps its direct call into the plugin's module; start order checked in the technical design. |
| A disabled plugin still ships (static import) | senior, mid-level | **Taken as a cost:** size is a bonus goal; deferred. |
| "Localisation off" means language switches change no text | mid-level | **Taken:** stated under "With the plugin disabled". |
| `Locale.debug()` should survive; warn when string tables exist but the plugin is off | user | **Taken.** |
| Cost list undercounted (31 non-engine, 5 engine files) | senior | **Taken:** the smaller move cuts it; estimate revised to 12–16. |
| A setter only, no moves | challenger | **Not taken:** the plugin would own nothing; listed under Alternatives. |

## Open questions

- Whether the strings provider is set through `ctx.locale.strings` or a contribution point another plugin could also
  extend (technical design).

## References

- `src/engine/localisation/` (`Locale.ts`, `runtime/strings.ts`, `runtime/boot.ts`, `runtime/buildFile.ts`),
  `src/editor/ui/localisation/`, `src/player/main.ts`, `src/export/strings.ts`, `src/plugins/subtitles/`.
- ADR 0356 (string tables and ICU), 0391 (fallback messages), 0357 (subtitles), 0452 (diagnostics, same design).
