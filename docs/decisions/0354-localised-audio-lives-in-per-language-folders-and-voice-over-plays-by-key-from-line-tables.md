# 0354. Localised audio lives in per-language folders, and voice-over plays by key from line tables

- **Status:** Accepted, amended by 0357 (subtitle text moves to 0356's string tables and line tables lose `text`; subtitles follow the text language; one reading-speed rule; captions; an optional built-in subtitle display)
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0040, 0077 (its open question on localised strings stays open), 0254, 0262, 0293, 0314, 0317, 0341, 0342 (extended: the sidecar's `sample` block gains `lipsync` and `vo`), 0343 (extended: a `line` entry kind), 0344, 0348 (extended: `line` and `language` request records), 0349, 0351 (extended: packages split per language), 0355

## Context

The owner's follow-on scope (plan "Follow-on scope", 2026-11-22) asks for localisation and voice-over (feature 1),
built in W13 with dynamic dialogue (0355), following Wwise and FMOD norms.

**What exists today.**
- **No localisation of any kind.** Nothing in `src/` knows a language or locale (the only hits are Monaco language
  ids, `Intl.Collator` for sorting and the WAV `ltxt` chunk's language field). No record covers text localisation;
  0077 leaves "whether `{name}` bindings or a `t:` key form carry translated strings" open. There are no subtitles.
- **Audio** plays samples and playlists by project path (`Audio.play`, `Audio.playOneShot`, `AudioSource.clip`), each
  resolved by the clip resolver (0293, `runtime/clipResolver.ts`). A sample's sidecar holds its markers, trim and
  loudness normalisation (0342); Cue markers reach the game through `AudioPlaylistHandle.onMarker` and the component
  hook `onAudioMarker` (`engine/audio/markerTypes.ts`).
- **The mix** (`audio.json`, 0344) has a default `Voice` bus beside Music, SFX and UI, and presence ducking rules
  (`{ target, trigger, mode: "presence", amountDb, attackMs, releaseMs }`).
- **Packages** (0351, accepted, builds in W12): `audio.json` `packages` with dependency closure, `.mycopak` files,
  a `game.json` `audio.media` table keyed by project path, and `Audio.package(name).load()/unload()`. 0351 leaves
  "localised packages (one per language)" to this record.
- **Takes** (0348) record `play`, `param`, `trigger` and other requests and replay them against the current project
  with the recorded pick-generator state.

**How the reference tools do it.**
- **Wwise:** a Sound Voice object has one source per language, kept in `Originals/Voices/<language>/` under the same
  name; the project's language list has a reference language; a missing language plays nothing (or the reference
  through "use reference language as standin"); localised SoundBanks are built per language into
  `<platform>/<language>/` and the game switches language by unloading and reloading them; the Voice Profiler lists
  missing sources per language.
- **FMOD Studio:** *audio tables* map a key to a file in a folder (`key` = file name by default) with one table per
  locale, and a *programmer instrument* inside an event asks the game for the sound by key at play time; localised
  audio tables are built into one bank per locale.
- **Unity Localization:** locales with fallbacks, a startup selector chain (command line, player prefs, system
  language, default), string tables and asset tables (per-entry maps from locale to asset).
- **Unreal:** Dialogue Waves (a line with its spoken text and subtitle, one sound per context), culture folders
  (`L10N/<culture>/`) for localised assets, subtitles shown by the engine.

## Decision

We will keep each language's recordings in a language folder under a declared **localised root**, with every
reference naming the reference language's file and the resolver swapping the language at play time; keep voice-over
lines as keyed rows in **line tables** (`*.lines.json`) that hold speaker, subtitle text and notes; play a line by key
or through a playlist `line` entry; switch language at runtime with per-language package parts; and give the Studio a
**Dialogue** screen for the tables, recordings, reports and batch import.

### 1. Languages

**Where the list lives.** Languages are game-wide (text localisation, when it comes, uses the same list), so they live
in `project.json` as a `languages` section, parsed by `src/engine/localisation/languages.ts` (pure, engine-level, no
audio import):

```jsonc
"languages": {
  "list": [
    { "code": "en", "name": "English" },
    { "code": "fr", "name": "Français" },
    { "code": "fr-CA", "name": "Français (Canada)", "fallback": ["fr"] },
    { "code": "de", "name": "Deutsch", "ship": false }        // work in progress: not exported
  ],
  "reference": "en",        // the language references are authored in; must be in the list
  "default": "en",          // the start language when nothing else picks one (§4)
  "fallback": ["en"],       // the chain every language ends with (default: [reference])
  "useSystemLanguage": true,
  "remember": true
}
```

- **Codes** are BCP 47 tags written in canonical case (`en`, `en-GB`, `pt-BR`, `zh-Hans`); the parse refuses
  duplicates and tags that differ only in case (CLAUDE.md's case rule: they become folder names). At most 64 languages.
- **Fallback chain** of language L (`fallbackChain(L)`): L, then its own `fallback` list in order, then the project's
  `fallback` list, duplicates removed. Adding `fr-CA` in a UI pre-fills `fallback: ["fr"]` when `fr` is listed.
- A project without `languages` has one implicit language, `en`, and no localised roots: nothing changes.
- **Ownership** (0341): the editor's Project Settings gains **Languages**. The Studio's Dialogue screen edits the same
  section through the same module when no editor holds the project lock (`.myco/locks/editor.json`); while one does,
  the Studio shows it read-only with "Edit in the editor" (0341's precedent for scene references).
- **Preview language** is a per-user preference, not project data: a language chip in the Studio header and a
  Language menu in the editor's Play toolbar (`myco.audio.previewLanguage`, local storage). The Studio's auditions and
  the editor's Play start in it; remembered and system languages are ignored there.

### 2. Localised audio: per-language folders under localised roots

`audio.json` (0344) gains a `localisation` section (`src/engine/audio/localisation/types.ts`):

```jsonc
"localisation": {
  "roots": ["audio/vo"],                         // under each root, the first folder is a language code
  "loudness": { "mode": "loudness", "target": -23 },   // batch import and "Normalise language" write this (§9)
  "durationTolerance": 0.25,                     // §8: warn when a language is >25% (and >0.5 s) off the reference
  "missing": "subtitleOnly"                      // subtitleOnly | silent (§3)
}
```

- **Layout.** `audio/vo/en/ch1/intro_01.wav`, `audio/vo/fr/ch1/intro_01.wav`, … Every file under
  `<root>/<code>/` is that language's variant of `<root>/<any code>/<same rest>`. Files in a root's folder whose first
  segment isn't a listed language are linted ("audio/vo/es/ isn't a project language").
- **References name the reference language's file.** A playlist entry, `AudioSource.clip`, an `Audio.play` path or a
  derived sample's `source` names `audio/vo/en/grunt_03.wav`: a real file, so asset references, renames (0314), the
  Samples tree and playback in every tool keep working unchanged. A reference into another language's folder is
  treated the same (its rest is what's swapped).
- **Resolution** (`variantPath(path, language, roots, exists)` in `src/engine/audio/localisation/variants.ts`, pure):
  for a path under a root, try `<root>/<c>/<rest>` for each `c` in `fallbackChain(language)` and return the first that
  exists, with the language it found; a path outside every root is returned unchanged. The clip resolver (0293) calls
  it first, before `resolveSample`, so derived samples (`*.sample.json`) under a root localise too, and each variant
  plays with its **own sidecar** (its own trim, markers, normalisation and lip-sync).
- **Moves.** Moving or renaming a localised file in the Studio moves its variants in every language folder with it
  (one undo step); the asset references to the reference file are rewritten as today.

### 3. Missing languages

When no language in the chain has a file:
- a plain sample or playlist entry plays nothing; the voice's handle reason is `missingLanguage` (new `AudioReason`),
  with one warning per path and language;
- a **line** (§5) with `missing: "subtitleOnly"` (default) still fires its start and end events with its subtitle and a
  reading-time duration (`max(1.5, words / 2.5)` seconds; characters / 12 for languages written without spaces:
  `ja`, `zh*`, `th`), so subtitled games keep flowing; with `"silent"` it is refused like a sample.

### 4. Runtime language

```ts
Audio.language: string                         // the current audio language (get; set = void Audio.setLanguage(x))
Audio.setLanguage(code: string, options?: { playing?: "finish" | "stop" }): Promise<void>
Audio.pendingLanguage: string | null            // a switch in progress
Audio.subtitleLanguage: string | null           // null (default): follows Audio.language
Audio.languages: readonly AudioLanguage[]       // { code, name, fallback: readonly string[] } of the shipped languages
```

- **Start language** (Unity's selector chain), decided once before preload packages load: the remembered language
  (player storage, 0317, key `myco.audio.language`, when `remember`), else the best system match (when
  `useSystemLanguage`: `navigator.languages` matched by BCP 47 lookup: exact tag, then the tag with its last subtag
  dropped, repeatedly), else `default`. Only shipped languages count. In the editor's Play and the Studio it is the
  preview language.
- **A switch is atomic.** `setLanguage` loads the new language's parts of every loaded package (§6), then changes
  `Audio.language` in one step, then remembers it (when `remember`). With no packages it completes synchronously (the
  promise is already resolved). An unknown or unshipped code rejects with one warning and changes nothing; a second
  switch while one is pending supersedes it.
- **Playing voice-over on a switch.** `playing: "finish"` (default) lets voices that resolved a localised file finish in
  the old language, then unloads the old parts; `"stop"` stops them with a 50 ms fade first. Playlists started after
  the switch resolve in the new language; a playing playlist's later picks (a Queue's next entry) resolve in the
  language current when they are made.
- `Audio.debug()` gains `language: { current, subtitles, pending, missing: [{ path, language }] }` (the last 32).
- No Babylon, Web Audio or codec type appears (0010).

### 5. Line tables (FMOD audio tables, Unreal dialogue waves)

A line table is an asset, `*.lines.json` (`myco.lines@1`), parsed by `src/engine/audio/localisation/lines/format.ts`.
A project has any number (one per chapter, character or system).

```jsonc
{
  "format": "myco.lines@1",
  "root": "audio/vo",              // a localised root; default the first
  "folder": "ch1",                 // under each language folder: audio/vo/<lang>/ch1/
  "output": "Voice",               // bus; default Voice when it exists, else Master
  "template": null,                // a playlist path with a programmer `line` entry (§5 "Playlists"); null: a plain Clip
  "priority": 50,                  // 0..100, used by 0355's speaker channels
  "speakers": ["Ava", "Guard"],    // names offered in the Speaker column (free text allowed)
  "lines": [
    { "key": "intro_01", "speaker": "Ava",
      "text": { "en": "We're late.", "fr": "On est en retard." },
      "notes": "Whispered, out of breath",          // direction for actors; never shipped
      "file": null,                                 // file name stem; null: the key
      "files": { "de": "audio/vo/de/ch1/intro_01_alt.wav" },   // explicit per-language override (rare)
      "tags": ["main"] }
  ]
}
```

- **Keys** match `[A-Za-z0-9_.-]{1,64}` and are **unique across the project** (`Audio.line(key)` names no table). The
  Studio refuses a duplicate on edit; the runtime takes the first table in path order and warns once. A key rename
  rewrites every reference in playlists' `line` entries and dialogue events (0355) through the named-list module
  (0262); string literals in scripts are linted, not rewritten.
- **The file for language L** (`lineFile(table, line, L, exists)` in `lines/resolve.ts`, pure): `files[c]` if given,
  else `<root>/<c>/<folder>/<file ?? key>.<ext>` with `ext` the first of `wav, flac, ogg, mp3, m4a, sample.json` that
  exists, for each `c` in `fallbackChain(L)`. A line is **recorded** in a language when its own file exists (not by
  fallback).
- **Subtitle text lives in the line table**, one string per language, because the engine has no text localisation.
  Text resolves through the subtitle language's chain; no text gives `null`. The line key is the string's id, so a
  later text-localisation record can move the strings into string tables keyed by line key mechanically.
- **Limits** (declared once in the parse, 0306): 20,000 lines per table, 2,000 characters per text, 64 tags per line.

**Playing a line.**

```ts
Audio.line(key: string, options?: LineOptions): AudioLineHandle
interface LineOptions extends EventOptions {   // position, volume, bus (overrides the table's output), parameters…
  node?: GameObject;    // plays from and follows this node's world position (a flat template ignores it)
}
interface AudioLineHandle extends AudioPlaylistHandle {
  readonly key: string;
  readonly speaker: string | null;
  readonly language: string | null;   // the language actually heard (after fallback); null when nothing plays
  readonly text: string | null;       // in the subtitle language
  readonly duration: number;          // seconds of the heard file, or the reading time (§3)
  readonly finished: Promise<"ended" | "stopped" | "interrupted" | "refused">;
  viseme(): AudioViseme | null;       // §7
}
Audio.onLine(fn: (e: AudioLineEvent) => void): () => void
interface AudioLineEvent {
  phase: "start" | "end" | "marker";
  key: string; speaker: string | null; language: string | null; text: string | null;
  duration: number; time: number;          // heard time, Audio.time's base
  marker?: AudioMarkerEvent;               // phase "marker": a Cue marker in the line's file
  reason?: "ended" | "stopped" | "interrupted";
}
```

`Audio.line` plays immediately (no queueing; 0355's `Audio.say` adds speaker channels). An unknown key returns an
inert handle with reason `unknownLine` and one warning. Subtitle display is the game's: `Audio.onLine` gives start,
end and marker events with the text; the guide shows a UI-document subtitle panel built on it.

**Playlists (FMOD's programmer instrument).** A Clip playlist may hold a **`line` entry** beside `sample` entries:

```jsonc
{ "line": "intro_01" }        // a fixed line
{ "line": null }              // programmer: the key comes from the play's `line` option
```

`LineEntry extends EntryUse { kind: "line"; line: string | null }` in `playlist/types.ts`; the parse, writer,
references and lint (`line: null` in a playlist nobody plays with a `line` option is fine; an unknown key is a lint)
follow. `EventOptions` gains `line?: string`. A table's `template` is such a playlist (say, a radio voice with a band
pass and a static layer): every line in the table plays through it, with the key filled in. Without a template a line
plays as an implicit Clip playlist on the table's `output` with `playback: oneShot`. A `line` entry resolves its file
by §5 at the moment the entry is picked.

### 6. Packages per language (0351)

- **Split automatically.** A package whose dependency closure reaches files under a localised root builds a **base**
  part, `audio/packages/<name>.mycopak` (everything not localised), and one **language part** per shipped language,
  `audio/packages/<name>.<code>.mycopak`, holding that language's variants of the localised files in the closure (the
  file the chain resolves to, so `fr-CA`'s part may hold `fr` files; a file shared that way is duplicated per part, as
  0351 duplicates across packages). A line table in `include` brings every line's files.
- **`game.json`** `audio.packages[]` entries gain `languages: { "<code>": { url, bytes } }`; `audio.media` keys stay
  real project paths (`audio/vo/fr/ch1/intro_01.wav`), each with its package and `language`.
- **Runtime.** `Audio.package(name).load()` loads the base and the current language's part; `AudioPackage` gains
  `languages: readonly string[]` (the parts it has) and `bytes`/`memoryBytes` count the current language. A switch
  (§4) loads every loaded package's new part, then unloads the old part (after voices finish, or at once with
  `"stop"`). Strict packaging (0351) applies per part: a localised file whose part isn't loaded is refused with
  `notLoaded`.
- **Export.** Languages with `ship: false` are left out; `npm run export -- <dir> --languages en,fr` narrows further.
  Loose localised files (in no package) ship under their own paths, per language. `audio-report.json` gains a
  per-language total per package.
- **Line index.** The export writes `audio/lines/index.json` (key → table, speaker, priority, output, template, and per
  shipped language the resolved file path and duration in seconds) and `audio/lines/text.<code>.json` (key → subtitle)
  per shipped language; notes never ship. The runtime loads the index at start and a language's text with its switch.
  In the editor and the Studio the runtime reads the tables directly (`runtime/localisation/lineRegistry.ts` builds the
  same index in memory).

### 7. Markers and lip-sync

- **Markers.** A line's file's Cue markers (0342) fire `AudioLineEvent` phase `marker` as well as the handle's
  `onMarker`; markers are per language because each variant has its own sidecar.
- **Lip-sync data (optional).** The sidecar's `sample` block gains `lipsync`:

```jsonc
"lipsync": { "set": "rhubarb", "keys": [[0.00, "X"], [0.12, "B"], [0.31, "E"]] }   // seconds, viseme
```

  `set` names the viseme alphabet: `rhubarb` (A–H, X: the Preston Blair set Rhubarb Lip Sync writes) or `custom`
  (any short names). The Studio imports Rhubarb Lip Sync's TSV or JSON output for one file or a batch (matched by file
  name); it does not run Rhubarb. `AudioLineHandle.viseme()` returns `{ viseme, next, blend }` for the heard time
  (`blend` 0..1 toward `next` over the last 60 ms before it), read by the game's animation each frame; null without
  data. Limits: 20,000 keys per file.

### 8. Loudness and ducking

- **Per-language loudness** uses 0342's normalisation unchanged: batch import (§9) and the Dialogue screen's
  **Normalise language** write `normalize: { mode, target, gainDb }` from `localisation.loudness` into each file's
  sidecar (gain measured as today). The Dialogue screen flags files whose own `normalize` target differs from the
  setting. A language recorded hot or quiet is corrected by its normalisation, not by a per-language fader.
- **Ducking** reuses 0344's rules: lines play on `Voice` by default, and when the project has a line table but no rule
  triggered by its output bus, the Dialogue screen offers "Duck Music under Voice" which adds
  `{ target: "Music", trigger: "Voice", mode: "presence", amountDb: -6, attackMs: 80, releaseMs: 400 }` through
  `projectOps.ts` (one undo step). Nothing new in the mixer.
- **Duration mismatch.** A language's file is flagged when `|d − dRef| > max(0.5, durationTolerance × dRef)` seconds
  (Wwise and localisation vendors check this to catch wrong takes and truncations).

### 9. The Studio: Dialogue screen

A new screen, `src/studio/screens/dialogue/`, in the **Author** group after Playlists (the next free Ctrl/⌘ digit),
built from the kit (0349). Panels:

- **Lines** (the fixed panel): a table over every line table (table filter, search by key, speaker, text, tag), with
  columns Key, Speaker, Text (preview language), and one **status cell per language**: recorded, fallback (heard from
  another language, named), missing, duration mismatch (⚠ with both durations), script changed (the reference text
  changed after this language's file was imported: batch import writes `"vo": { "key": "intro_01", "textHash":
  "<SHA-256 of the reference text, first 16 hex>" }` into the file's sidecar `sample` block, and the cell compares).
  Column filters "missing in fr", "mismatch". Add, delete and duplicate rows; inline edit of key, speaker and text
  (refused-or-next edits, 0313).
- **Line inspector:** every language's text, notes, tags, file per language with its waveform strip, duration,
  loudness and markers; **audition** per language (plays through the table's template on the Studio runtime) and in
  the preview language with Space; "Open in Samples" for a variant.
- **Languages tab:** the `project.json` list (§1 ownership), reference, default, fallbacks, ship flags, and
  `localisation` settings (roots, loudness, tolerance, missing).
- **Report:** per language: recorded / fallback / missing counts and the missing keys, mismatches, script changes,
  shipped size per language (from 0351's estimates); **Export CSV** of the report.
- **Script CSV** import and export (keys, speaker, notes, one text column per language; UTF-8 with BOM, RFC 4180), the
  format translators and recording studios exchange; import shows a diff (added, changed, removed keys) before
  applying as one undo step.
- **Batch import** (`batchImport.ts` + dialog): pick files or a folder; a naming pattern with tokens `{lang}`, `{key}`,
  `{table}` and `{ignore}` (presets: `{lang}/{key}`, `{key}_{lang}`, `{lang}_{key}`; Wwise and FMOD deliveries use the
  first two) matches files to keys; the preview lists matched, unknown key (create rows or skip), unknown language
  (skip) and replace-existing (old audio kept as a source version, 0342); applying copies to
  `<root>/<lang>/<folder>/<key>.<ext>`, writes each sidecar's `normalize` and `vo.textHash`, and is one undo step per
  affected document. Rhubarb output (§7) imports through the same dialog.
- The header's language chip sets the preview language for every screen.

The editor keeps no dialogue UI besides Project Settings > Languages and the Play toolbar's Language menu.

### 10. Takes (0348)

New request records: `line` (`{ t, instance, key, language, options }`) and `language` (`{ t, audio, subtitles }`).
Replay plays lines by key against the current tables in the recorded language (a Take toolbar toggle replays in the
preview language instead). Capture EVENT records for lines carry the key and language, so the Profiler's "Why it
played" names them. The take format's minor version rises.

## Alternatives considered

- **A "localised" flag on a folder or sample, with sources per language stored elsewhere** (Wwise's model inside its
  own object database) — needs a place for the per-language sources that the asset tree, renames and sidecars don't
  know; folders give each variant a real path and sidecar with no new store, and a `roots` list is the flag.
- **Per-asset variant maps** (Unity's asset tables: a map from language to file per entry) — explicit, but every new
  recording means editing a map, thousands of lines mean thousands of edits, and a vendor's per-language folder
  delivery can't simply be dropped in. Kept only as the line table's rare `files` override.
- **A language placeholder in references** (`audio/vo/{lang}/x.wav`) — no real file at the path, so asset references,
  the Samples tree and every tool's playback need special cases; naming the reference file avoids them.
- **Per-table keys (`table:key`)** — collisions never happen, but every call site carries the table; project-unique keys
  match FMOD's single key lookup and Unreal's dialogue wave names, and the Studio enforces uniqueness.
- **Subtitles in a separate string table now** — the right home once text localisation exists, but inventing string
  tables for subtitles alone would pre-empt that record; keys line up so the move is mechanical.
- **Languages in `audio.json`** — the Studio would own it, but the language list is game-wide and text localisation
  will need it; `project.json` with the lock rule keeps one list.
- **Switching language immediately and refusing lines until their part loads** — exposes a window of `notLoaded`
  refusals to every game; the atomic switch hides it behind one promise.
- **Stopping voice-over on a switch by default** — cuts a sentence in half; finishing it is what players expect when
  they change language in a pause menu, and `"stop"` remains.

## Consequences

**Positive**
- Recordings drop into language folders as vendors deliver them; every existing reference, tool and playback path
  keeps working, and each variant has its own markers and lip-sync.
- Lines play by key with subtitles, fall back through a chain, and switch at runtime with per-language package parts.
- The Dialogue screen shows what is recorded, missing or wrong per language, and imports a delivery in one step.

**Negative / costs**
- Public API growth: `Audio.language`, `setLanguage`, `pendingLanguage`, `subtitleLanguage`, `languages`, `line`,
  `onLine`, `AudioLineHandle`, `AudioLineEvent`, `AudioViseme`, `AudioLanguage`, `LineOptions`, reasons
  `missingLanguage` and `unknownLine`, `EventOptions.line`, `AudioPackage.languages`.
- Subtitle text sits in audio assets until text localisation exists, and will move then.
- The clip resolver gains a lookup per play under a localised root (a map lookup per chain step).
- Files a chain shares across languages are duplicated in each language part.
- Lip-sync is import-only; a game wanting visemes must run Rhubarb (or another tool) itself.

## Deprecates

Nothing.

## Open questions

- Text localisation for UI documents (0077's open question) and whether subtitles move into its string tables.
- Downloading a language part on demand instead of shipping every language in the build.
- Running a lip-sync generator in the Studio.

## References

- Wwise: Languages and the reference language, localised SoundBanks, Voice Profiler. FMOD Studio: audio tables,
  programmer instruments, localised banks. Unity Localization: locales, fallbacks, startup selectors, string and asset
  tables. Unreal: Dialogue Waves, culture folders, subtitles. Rhubarb Lip Sync (MIT) output formats. BCP 47 / RFC 4647
  lookup.
- `src/plugins/audio/runtime/clipResolver.ts`, `Audio.ts`, `playlists/`; `src/engine/audio/playlist/types.ts`,
  `sample/`, `project/types.ts`, `markerTypes.ts`, `take/types.ts`; `src/engine/core/settings.ts`;
  `src/studio/shell/screens.ts`; ADR 0351 §7 and §9.

## Build plan

| # | Milestone | Contents | Files (owner) |
|---|---|---|---|
| L1 | Formats | `project.json` `languages` (parse, write, `fallbackChain`, BCP 47 lookup); `audio.json` `localisation`; `variantPath`; `*.lines.json` parse/write, limits, `lineFile`, reading-time rule; built line index and text formats; script CSV read/write; playlist `line` entry (types, parse, writer, references, lint); sidecar `lipsync` and `vo`; unit tests (chain table, lookup, variant resolution with fallback, key uniqueness, CSV round trip with quotes and BOM, line entry round trip) | `src/engine/localisation/**`, `src/engine/audio/localisation/**`, `src/engine/core/settings.ts`, `src/engine/audio/project/format.ts` + `types.ts`, `src/engine/audio/playlist/types.ts` + `format.ts` + `references.ts` + `lint.ts`, `src/engine/audio/sample/types.ts` + `format.ts` |
| L2 | Runtime | language state, start selector, atomic switch (without packages), subtitle language; clip resolver hook; line registry (tables or built index); `Audio.line`, `onLine`, `AudioLineHandle`, `missingLanguage`/`unknownLine`, subtitle-only lines; playlist `line` entries and `EventOptions.line`; take `line`/`language` records and replay; `Audio.debug().language`; `src/myco.ts` exports; tests on the fake backend (fallback, switch finish/stop, subtitle-only timing, template playlist, replay language) | `src/plugins/audio/runtime/localisation/**`, `clipResolver.ts`, `Audio.ts`, `backend.ts` (types), `playlists/nodes.ts` + `options.ts`, `capture/takeTap.ts`, `src/engine/audio/take/**`, `src/myco.ts` |
| L3 | Packages and export | language parts in the closure and `.mycopak` naming; `game.json` `languages`; `processAudio` per-language placement, `--languages`, `ship: false`, report totals; line index and text writer; runtime parts load/unload on switch, `AudioPackage.languages`; tests in `buildWriter.test.ts` and on the fake backend | `src/engine/audio/packaging/**`, `src/export/audio.ts` + new `lines.ts`, `src/export/main.ts`, `src/plugins/audio/runtime/media/packages.ts` |
| L4 | Markers and lip-sync | line marker events; `viseme()`; Rhubarb TSV/JSON import (pure); tests | `src/engine/audio/localisation/lipsync.ts`, `src/plugins/audio/runtime/localisation/viseme.ts` |
| L5 | Studio Dialogue screen | screen registration and digit; Lines table with status cells, filters, inline edits; Line inspector with audition per language; Report and CSV; header language chip and Studio runtime preview language; stories with `play` tests | `src/studio/screens/dialogue/**`, `src/studio/shell/screens.ts`, `src/studio/screens/index.tsx`, `src/studio/shell/StudioHeader.tsx`, `src/studio/runtime/**` |
| L6 | Batch import, loudness, ducking | naming patterns and preview, copy with source versions, sidecar `normalize` and `vo.textHash`, Normalise language, "Duck Music under Voice"; Languages tab with the lock rule; tests | `src/studio/screens/dialogue/batchImport.ts` + dialog, `languagesTab.tsx`, `src/engine/audio/projectOps.ts` |
| L7 | Editor | Project Settings > Languages; Play toolbar Language menu (preview language into Play) | `src/editor/ui/settings/**` (Languages section), the Play toolbar file |
| L8 | Docs and e2e | `docs/wiki/guide/localised-audio.md` (folders, line tables, subtitles recipe, switching, packages); e2e: Studio Dialogue shows a missing French line and plays the English fallback; `@slow` export with two languages boots, `Audio.setLanguage("fr")` then plays a line from the French part | `docs/wiki/guide/**`, `tests/e2e/studio-dialogue.spec.ts`, `tests/e2e/export-languages.spec.ts` |

L1 first. L2, L4, L5 and L7 run beside each other after it; L3 needs 0351's A1, A3 and A5 merged; L6 after L5.
Single-writer files shared with 0355 in W13: `Audio.ts`, `src/myco.ts`, `playlist/types.ts` and `format.ts`,
`take/types.ts`, `src/studio/shell/screens.ts`, `src/studio/screens/dialogue/` (0355 adds an Events tab to this
screen); the coordinator names one task per wave for each.
