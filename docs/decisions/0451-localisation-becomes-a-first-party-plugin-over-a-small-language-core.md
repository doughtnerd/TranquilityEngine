# 0451. Localisation becomes a first-party plugin over a small language core in the engine

- **Status:** Proposed
- **Date:** 2026-11-27
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0133, 0135, 0144, 0275, 0354, 0355, 0356, 0357, 0391, 0423, 0447, 0452

## Context

Localisation is engine core today. `src/engine/localisation/` is 5,646 lines (3,878 without tests):

- **Root:** `Locale.ts` (the `Locale` runtime, `LocalText`), `t.ts` (reactive `t()`/`tHtml()` for Svelte),
  `languages.ts` (`project.json` `languages`, fallback chains, BCP 47, default direction, the voice-language rule),
  `variants.ts` (per-language asset folders), `pseudo.ts`, `textHash.ts` (synchronous SHA-256), `lenient.ts`,
  `subtitles.ts` and `subtitleSettings.ts`.
- **`strings/`** (string table and translation file formats, validation), **`message/`** (ICU MessageFormat 1 on
  `Intl`), **`runtime/`** (`bootLocale`, build string files, the string registry, language-switch participants,
  localised textures and fonts), **`exchange/`** (CSV, XLIFF, PO, gathering, `maxLength`).

Its editor tools are in the editor shell, not a plugin: the Localisation panel (`src/editor/ui/localisation/`, about
2,500 lines: strings editor, reports, exchange, the text fit check, the Inspector's Localise and Extract to string
table), the `strings` core asset kind, and the Languages and Subtitles settings sections. The exporter writes
`strings/<code>.json` and `game.json`'s `localisation` (`export/strings.ts`, `webBuild.ts`); the player installs them
(`installBuildStrings`); every other host boots `Locale` from `projectBoot.ts`.

Who depends on what (non-test imports):

| Area | Needs |
|---|---|
| Engine core | `bootLocale` (`projectBoot.ts`), `parseLanguages`/`parseSubtitleSettings` (`settings.ts`), `variantPath`/`localisedParts` (`Assets.ts`), `sha256Hex` (`tauriRecords.ts`) |
| UI core | `Locale.language`/`epoch` for `:lang()` (`styledTree.ts`), `Locale.direction` (`elementKinds.ts`), per-language fonts and a language-switch participant (`fonts.ts`). Line breaking uses `Intl.Segmenter` directly; plurals live only in `message/` |
| Audio (engine formats and plugin) | languages and fallback chains, `variantPath` (0354 folders), `formatMessage`/`parseMessage`, `localeStrings`, `readingRule`, participants (`languageState.ts` behind `Audio.language`), `sha256Hex` (generator bake) |
| Subtitles plugin | `Locale` (`has`, `t`, `language`, `epoch`), `readingRule`, the subtitle model and settings |
| Svelte renderer | `onLocaleEpoch`, `setLocaleTracker` (makes `t()` reactive) |
| Studio | Dialogue and caption screens: string formats, languages, subtitles, `textHash`, CSV |
| Export, player | `export/strings.ts`, `audio.ts`, `lines.ts`; the player's `installBuildStrings` |

The owner wants most of this to be a plugin (2026-11-27): a project that ships in one language shouldn't carry string
tables, ICU formatting and exchange tooling in its engine, and localisation should be enabled, disabled and extended
like any other feature. 0447 also deferred per-feature export and launch steps partly because localisation was an
engine module while capture and takes belonged to the audio plugin; making localisation a plugin removes that split.

## Decision

We will split localisation into a **language core** that stays in the engine and a first-party plugin,
**`myco.localisation`**, that holds strings, messages and the tools.

**The language core stays in the engine** (`src/engine/localisation/` shrinks to it). It answers "which language is
it, and how does that language behave", which the UI core, `Assets` and audio need with or without string tables:

- `languages.ts`: the project's languages, fallback chains, BCP 47 tags, default direction and the voice-language
  rule, parsed from `project.json` as today.
- `variants.ts`: per-language asset folders, used by `Assets` and audio (0354).
- **Language state** on `Locale`: `language`, `pendingLanguage`, `languages`, `direction`, `epoch`, `setLanguage`,
  `onChange`, language-switch participants, and the `Intl` formatters that need only a language (`formatNumber`,
  `formatDate`, `formatList`, `formatRelativeTime`). Per-language fonts stay here because the UI core needs them to
  lay out any text.
- `bootLocale` keeps choosing the starting language for every host; it no longer loads strings.

**The plugin `myco.localisation`** (`src/plugins/localisation/`, in the first-party catalogue, enabled by default):

- **Runtime half:** string tables and translation files, ICU MessageFormat (`message/`), the string registry and
  build string files, pseudo-localisation, `LocalText`, and the string members of `Locale` (`t`, `text`, `has`,
  `format`) and `t()`/`tHtml()`. They keep their names in `myco`, so scripts and Svelte components don't change; the
  plugin provides them when it activates.
- **Editor half:** the Localisation panel, the `strings` asset kind (no longer a core asset kind), the Inspector's
  Localise and Extract to string table, the text fit check, gathering and the CSV/XLIFF/PO exchange.
- **Export and launch:** writing `strings/<code>.json` and `game.json`'s `localisation` becomes the plugin's export
  step, and `installBuildStrings` its player boot step, through the contributions ADR 0452 defines.

**With the plugin disabled:** `t(key)`, `Locale.t` and `Locale.text` return what a missing key returns today, and
warn once per session that localisation is off. `:lang()`, direction, fonts, localised asset folders and
`Audio.language` keep working from the language core. Exports write no string files.

**Other moves:**

- **Subtitles:** `subtitles.ts` and `subtitleSettings.ts` move into `myco.subtitles`, which gains a dependency on
  `myco.localisation`. The Subtitles settings section moves into that plugin's editor half.
- **Audio:** `myco.audio` takes an optional dependency on `myco.localisation` for captions and line text (message
  formatting, reading rules). Voice-over by key, localised folders and the voice-language rule need only the
  language core and keep working without it.
- **Not localisation:** `textHash.ts` (SHA-256) and `lenient.ts` move to a shared engine utility folder; audio and
  the Tauri records use them for reasons unrelated to text.
- **The Studio** keeps using the plugin's formats (Dialogue, captions) through the internal tier, as first-party
  code does today (0147).
- **The Languages settings section** stays in the editor shell: languages are part of the language core.

## Alternatives considered

- **Keep localisation in the core.** No work, but every project carries string tables, ICU and exchange code, the
  feature can't be disabled, and export steps stay split between core and plugins (0447).
- **Move all of it into the plugin, language state included.** The UI core's `:lang()`, direction and fonts,
  `Assets`' localised folders and `Audio.language` would then depend on a plugin, or each grow its own idea of the
  current language.
- **Two plugins: strings and tools.** The runtime half and the editor half already separate what ships from what
  only the editor loads; a second plugin adds a manifest and a dependency without a reason to disable one alone.

## Consequences

**Positive**
- A project without localisation ships no string tables, message formatter or exchange code, and can turn it off.
- Localisation's export and launch steps become a plugin's, like audio's, so ADR 0452's contributions cover every
  build option.
- The core keeps one answer to the current language for the UI core, `Assets` and audio.
- The editor shell loses about 2,500 lines of panel code to a plugin editor half.

**Negative / costs**
- A large move: about 3,000 lines of runtime code, the editor tools, imports in audio, subtitles, the Studio, the
  export and the renderer, and their tests.
- `t()` and `Locale.t` become members whose implementation a plugin installs. Scripts must not cache them before
  plugins activate, and the warning path needs a test.
- `myco.subtitles` and the optional link from `myco.audio` add plugin dependencies to keep in step.

## Deprecates

- The `strings` core asset kind (it becomes the plugin's asset kind).
- Engine ownership of `strings/`, `message/`, `exchange/`, `pseudo.ts`, `t.ts` and the string half of `runtime/`
  (moved to the plugin); `subtitles.ts` and `subtitleSettings.ts` (moved to `myco.subtitles`).
- The exporter's and player's built-in localisation steps (replaced by the plugin's contributions, ADR 0452).

## Open questions

- Whether `Locale.t` should keep its place on `Locale` or move to a plugin-owned object (`Strings.t`), with `Locale`
  left as language state only. Keeping it avoids changing every script.
- Whether the warning when the plugin is off belongs in the console only, or also in the editor's status bar.
- Whether the dedicated server should load the plugin at all (`server` in its manifest). Server-side code formats
  messages today only through scripts that call `Locale.t`.

## References

- `src/engine/localisation/`, `src/editor/ui/localisation/`, `src/plugins/subtitles/`,
  `src/plugins/audio/runtime/localisation/languageState.ts`, `src/export/strings.ts`, `src/player/main.ts`.
- ADR 0356 (string tables and ICU), 0354 (localised audio folders and line tables), 0357 (subtitles), 0391
  (fallback messages), 0447 (launch settings and the deferred per-feature slice), 0452 (plugin contributions).
