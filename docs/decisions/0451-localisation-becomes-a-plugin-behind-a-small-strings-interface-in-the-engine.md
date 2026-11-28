# 0451. Localisation becomes a plugin behind a small strings interface in the engine

- **Status:** Proposed
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0133, 0135, 0144, 0275, 0354, 0356, 0357, 0391, 0423, 0452

Design folder: [`docs/design/plugin-lanes-localisation/`](../design/plugin-lanes-localisation/goal.md). Spike:
[`spikes/player-chunks/`](../../spikes/player-chunks/README.md).

## Glossary

- **String table:** a project file (`*.strings.json`) mapping keys to messages in one language, with translation
  files beside it (0356).
- **Message:** a string in ICU MessageFormat, which can hold plurals, numbers and dates (`{count, plural, one {# coin}
  other {# coins}}`).
- **Strings interface:** what the engine asks of whoever provides localised text: look up a key, format a message,
  and say when strings change. New in this record.
- **Strings provider:** the plugin that implements the strings interface. `myco.localisation` is the default; another
  plugin could replace it.
- **Language state:** the current language and how it behaves (fallback chain, text direction, fonts), which the UI
  core, asset loading and audio need with or without string tables. It stays in the engine.

## Context

Localisation is engine core: `src/engine/localisation/` (5,646 lines, 3,878 without tests), its editor tools in the
shell (`src/editor/ui/localisation/`, about 2,500 lines; the `strings` core asset kind), exported as `Locale`,
`LocalText`, `t` and `tHtml` (`src/engine/index.ts`).

What reads it:
- **Language state:** the UI core (`:lang()`, direction, fonts: `styledTree.ts`, `elementKinds.ts`, `fonts.ts`),
  asset loading (`Assets.ts`: localised folders), audio (`Audio.language`, line tables, fallback chains), the engine's
  settings and boot (`settings.ts`, `projectBoot.ts`).
- **Strings and messages:** scripts and Svelte components (`Locale.t`, `t()`, made reactive by the Svelte renderer's
  `setLocaleTracker`), `LocalText`, `myco.subtitles` (`Locale.has`/`t`), audio captions (`formatMessage`,
  `parseMessage`, `localeStrings` in `plugins/audio/runtime/localisation/languageState.ts`), the Studio's Dialogue
  screens (string formats), the exporter (`src/export/strings.ts`) and the player (`installBuildStrings`).

Today a missing key shows the key and warns once (`Locale.ts`, `t`).

Size isn't the reason to move it: localisation is about 14 kB compressed in the player, about 2% of what loads up
front, and the exchange formats aren't in the player at all
([`spikes/player-chunks/`](../../spikes/player-chunks/README.md)).

**Owner's direction (2026-11-27/28):** localisation should be a plugin because it's a feature like any other, so it is
packaged like one, and because others should be able to replace or extend it; games that don't localise carrying less
is a bonus. Move the smallest amount without a rewrite.

## Decision

We will put a small **strings interface** in the engine, make **`myco.localisation`** a first-party plugin that
provides it, and move only the files the plugin needs to own.

**The strings interface** (`src/engine/localisation/strings.ts`, internal to the engine, used by `Locale`):

- `lookup(key, language)`: the message for a key in a language, or none.
- `format(message, args, language)`: the formatted text.
- `changed`: a signal when strings change (a table edited, a build file installed).

`Locale.t`, `Locale.has` and `LocalText` keep their names and signatures and go through it. A
plugin provides it when it activates (`ctx.contribute` on a new core point, or a single setter on the runtime
context; the technical design picks one).

**The plugin `myco.localisation`** (`src/plugins/localisation/`, in the first-party catalogue, enabled by default):

- **Runtime half:** provides the strings interface from string tables and ICU messages. It owns, moved mechanically
  from the engine with imports updated and no behaviour change:
  - `strings/` (string table and translation formats, validation);
  - `message/` (ICU MessageFormat);
  - the runtime string registry and build string files (`runtime/strings.ts`, `runtime/buildFile.ts`), and
    `installBuildStrings`;
  - `t()` and `tHtml()` (`t.ts`, the reactive helpers Svelte components call). `myco` re-exports them from the plugin,
    as it re-exports other plugins' APIs, so components' imports don't change.
- **Editor half:** registers the Localisation panel (the `src/editor/ui/localisation/` folder moves into it) and the
  `strings` asset kind (no longer a core asset kind).
- **Callers outside the engine** (the exporter's `src/export/strings.ts`, the player's `installBuildStrings`, the
  Studio's Dialogue screens, audio captions) import the plugin's modules directly, as first-party code may.

**Everything else stays where it is:** `Locale`'s language state and its `Intl` formatters, `languages.ts`,
`variants.ts`, fonts, `pseudo.ts`, `exchange/`, `textHash.ts`, `lenient.ts`, the subtitle model and settings, and
the Languages and Subtitles settings sections. They can move later if a reason appears.

**With the plugin disabled:** no strings provider, so `t(key)` and `Locale.t` show the key and warn once, as a missing
key does today, and `Locale.has` is false. Language state, `:lang()`, direction, fonts, localised asset folders and
`Audio.language` keep working. `myco.subtitles` gains a dependency on `myco.localisation`; audio takes an optional
one for captions.

## Alternatives considered

- **Move all of localisation into the plugin and split `Locale`** (this record's first draft). About 3,000 runtime and
  2,500 editor lines move, and `Locale` splits in two. The owner asked for the smallest move.
- **Keep localisation in the engine.** No work, but it can't be disabled or replaced, and it isn't packaged like
  other features.
- **A thin plugin over engine code, moving nothing.** The plugin would only register the panel; the engine would
  still own string tables and messages, so a replacement plugin couldn't take their place.

## Consequences

**Positive**
- Localisation is enabled, disabled and packaged like other features, and a different strings provider can replace
  it.
- The move is mechanical: the same code, behind one new interface.

**Negative / costs**
- A seam to keep: `Locale` must reach strings only through the interface, and its tests change to provide one.
- Engine code that imports `strings/` or `message/` directly today (`runtime/boot.ts`, audio's `languageState.ts`)
  changes its imports, and boot loads project string tables through the provider instead of directly.
- **Provisional estimate:** about 13 table-days plus a third in reserve, 14–20 table-days in all (the relative unit of
  earlier task tables, calibrated against their estimates, not actuals). The real figure comes from the technical
  design.

## Deprecates

- The `strings` core asset kind (becomes the plugin's asset kind).
- Engine ownership of `strings/`, `message/`, `runtime/strings.ts`, `runtime/buildFile.ts`, `t.ts` and the
  Localisation panel folder (moved to `myco.localisation`); `t` and `tHtml` leave `src/engine/index.ts` for a
  re-export in `src/myco.ts`.

## Open questions

- Whether the strings interface is registered through `ctx.contribute` on a core contribution point or a dedicated
  setter (technical design).
- Whether `t()`'s Svelte reactivity (`setLocaleTracker` in the Svelte renderer) follows the interface's `changed`
  signal directly (technical design).

## References

- `src/engine/localisation/` (`Locale.ts`, `t.ts`, `strings/`, `message/`, `runtime/`), `src/editor/ui/localisation/`,
  `src/plugins/subtitles/`, `src/plugins/audio/runtime/localisation/languageState.ts`, `src/export/strings.ts`,
  `src/player/main.ts`.
- ADR 0356 (string tables and ICU), 0391 (fallback messages), 0357 (subtitles), 0452 (diagnostics, same design).
