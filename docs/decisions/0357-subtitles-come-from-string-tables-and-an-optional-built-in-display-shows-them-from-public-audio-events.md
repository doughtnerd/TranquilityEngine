# 0357. Subtitles come from string tables, and an optional built-in display shows them from public audio events

- **Status:** Accepted, amended by 0421 (`SubtitleDisplay` builds its canvas from its document)
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0024, 0077, 0133, 0262, 0304, 0314, 0317, 0341, 0342, 0343 (extended: a playlist `caption`), 0348, 0349, 0354 (amended: subtitle text, subtitle language, reading time), 0355, 0356

## Context

0354 keeps subtitle text in line tables (`*.lines.json`, `text: { "<code>": "…" }` per line) "because the engine has
no text localisation", leaves display to the game (`Audio.onLine` and a guide recipe), and plays a line missing in
every language as subtitle-only for `max(1.5, words / 2.5)` seconds. 0356 adds string tables, ICU messages and the
`Locale` text language. Neither 0354 nor 0355 is built yet (implementation status: "Not started").

**Owner decisions** (decision log D53, 2026-11-22): subtitles move into string tables; subtitles are **"Optional
built-in"**: text and `Audio.onLine` events stay the base, plus a drop-in subtitle component built only on those public
events, with speaker names, adjustable size, a background box and a player on/off setting, which games can replace;
all shipped languages go in the build; lip-sync stays import-only.

**How others do it.**
- **Unreal** ships basic built-in subtitles (Dialogue Waves and Sound Waves carry subtitle cues, shown by the engine,
  with a global on/off). **Unity, Godot, Wwise and FMOD** give data and callbacks only.
- **Accessibility guidance** (Game Accessibility Guidelines; Xbox Accessibility Guideline 104, "Subtitles and
  captions"; the BBC Subtitle Guidelines; Netflix Timed Text Style Guides): player-adjustable size (at least three
  sizes), a background box with adjustable opacity, speaker names (and colours), at most two lines at about 42
  characters, a reading speed of about 15–17 characters per second for adults (Netflix English 17 for adults; slower for
  Chinese, Japanese and Korean), a minimum display time, and **captions for important sounds** (`[door slams]`) as a
  separate option. Subtitles on by default, or asked at first launch, is the recommended practice.

## Decision

We will move subtitle text into 0356's string tables (line tables name keys, the line key by default) and remove 0354's
`text` field before it is built; resolve subtitles in the text language, with the voice language following it by
default; time every subtitle with one reading-speed rule; add opt-in **captions** for playlists with a new public
`Audio.onCaption` event; and ship an optional **`myco.subtitles`** plugin whose `SubtitleDisplay` component and
`Subtitles` player settings are built only on `Audio.onLine`, `Audio.onCaption`, `Locale` and a UI document.

### 1. Subtitle text moves into string tables (amends 0354 §5, §6, §9)

- **Line tables name string keys.** `myco.lines@1` loses the line's `text` field and gains:

```jsonc
{
  "format": "myco.lines@1",
  "strings": "audio/vo/ch1.strings.json",   // the string table holding this table's subtitles; default: <stem>.strings.json beside it
  "lines": [
    { "key": "intro_01", "speaker": "Ava" },                       // subtitle key: "intro_01" (the line key)
    { "key": "intro_02", "speaker": "Ava", "textKey": "ch1.ava.late" },   // another key
    { "key": "breath_03", "speaker": "Ava", "textKey": null }      // never subtitled (breaths, efforts)
  ]
}
```

- **`text` is removed, not kept as a second store.** Nothing has been built on it, and a convenience field that
  mirrors a string table would be two sources of truth with an ordering problem on every import. The convenience stays
  in the tools: the Studio's Dialogue screen keeps its Text column and inline edits (0354 §9), which write the line's
  string in its string table (the reference text, or the preview language's translation). A hand-written table that
  still has `text` parses with a lint, **Move subtitles to the string table** (one undo step over both documents);
  the runtime ignores it.
- **Ownership.** A line table's string table is a Studio file (0356 §9's rule for tables audio data names); creating
  a line table creates it. The editor's Localisation panel lists it with every other table (read-only while the Studio
  holds its lock), and translators' exchange (0356 §8) covers it like any table.
- **Resolution.** A line's subtitle is `Locale.t(textKey)` in the **subtitle language** through its chain; no key in
  the chain gives `null`. `AudioLineHandle.text` is read live (it follows a language change mid-line);
  `AudioLineEvent` gains `textKey: string | null` so a display can re-resolve on `Locale.onChange`.
- **0354's script CSV** becomes 0356's CSV with the line columns (`table`, `speaker`, `notes`) added for keys that are
  line subtitles; batch import's `vo.textHash` hashes the reference text from the string table.
- **Build.** 0354 §6's `audio/lines/text.<code>.json` files are dropped: subtitle strings ship in 0356's
  `strings/<code>.json`. The line index keeps `textKey` per line when it differs from the key (or is `null`).

### 2. Text language and voice language (amends 0354 §4)

- `Audio.subtitleLanguage` keeps its shape; `null` (default) now follows **`Locale.language`** instead of
  `Audio.language`. Subtitles are text: they are in the language the player reads.
- `project.json` `languages.voice`: `"followText"` (default) or `"separate"`. With `followText`,
  `Locale.setLanguage(code)` also switches `Audio.language` in the **same atomic switch**: both load (strings and fonts,
  audio package parts), then both change in one frame, through 0356's internal language-participant seam (not public
  API). With `"separate"` the two start and switch independently (a game with Voice and Text menus); 0354's start
  selector and `myco.audio.language` apply to voice, 0356's and `myco.locale.language` to text.
- A language row may set `"voice": false` (translated but not recorded): it isn't offered in `Audio.languages`, and
  following it switches voice to the first language of its chain that is a voice language.
- `Audio.setLanguage` stays: in `followText` mode it sets voice until the next text switch (documented).

### 3. One reading-speed rule (amends 0354 §3)

- `readingSpeed(language)` in characters per second (graphemes including spaces, speaker name excluded): the
  language's `readingSpeed` in `project.json`, else built-in defaults from the Netflix timed-text guides (`ja` 4,
  `zh*` 9, `ko` 12), else `subtitles.readingSpeed` (default 15). `subtitles.minDisplay` (default 1.5 s).
- **Reading time** of a text: `max(minDisplay, characters / readingSpeed)`. It replaces 0354 §3's
  `max(1.5, words / 2.5)` (and its characters / 12 special case) for subtitle-only lines, and is the minimum display
  time of every subtitle page (§5).
- Pure, in `src/engine/localisation/subtitles.ts` with the paging and stacking model (§5), shared by the runtime, the
  Studio and the editor.

### 4. Captions for sound effects (v1, opt-in per playlist; extends 0343)

- A playlist may have `"caption": { "key": "cc.door_slams", "minGap": 2 }`: a string key and the seconds within which
  the same caption isn't repeated (footsteps, gunfire). Only playlists with a caption produce captions; most have none.
- **Public event:**

```ts
Audio.onCaption(fn: (e: AudioCaptionEvent) => void): () => void
interface AudioCaptionEvent {
  phase: "start" | "end";
  playlist: string;              // project path
  key: string; text: string | null;   // text in the subtitle language
  time: number;                  // heard time
  duration: number | null;       // seconds; null for a looping or open-ended instance
  pan: number | null;            // -1..1 relative to the listener for a positioned instance, else null
}
```

  `start` fires when an instance starts sounding (not when it is refused, virtual or culled by voice limits, 0343),
  `end` when it stops. Caption text lives in a captions string table, `audio.json` `localisation.captions` (default
  `strings/captions.strings.json`, a Studio file). Bracket style (`[door slams]`) is part of the string, so each
  language writes its own convention.
- **Why v1.** Accessibility guidance asks for captions of important sounds; the cost is one optional field, one event
  and one row style in the display. Opt-in per playlist keeps them to sounds a designer chose.

### 5. The built-in display: the `myco.subtitles` plugin

A first-party plugin (0133), `src/plugins/subtitles/` (`dependencies`: `myco.audio`, `myco.ui`), enabled by default in
new projects and toggled in Project Settings > Plugins. It uses only public API: `Audio.onLine`, `Audio.onCaption`,
`Locale`, `Storage`, and a UI document. A game that wants its own display disables the plugin (or leaves the component
out) and builds on the same events.

**`SubtitleDisplay`** (`engine.SubtitleDisplay`), added to any node; it builds its document under its own `UICanvas`
child (screen mode, `sortOrder` 1000) unless the node already has one. Fields:

| Field | Default | Meaning |
|---|---|---|
| `document` | `""` | a `*.ui.xml` replacing the built-in one; it must have an element `#subtitles` with a `<Template>` holding `.speaker` and `.line` texts |
| `stylesheet` | `""` | a `*.ui.css` applied after the built-in one (themes: override its variables) |
| `position` | `bottom` | `bottom` or `top` |
| `margin` | `8` | % of the canvas height from the edge (title-safe) |
| `maxWidth` | `70` | % of the canvas width |
| `maxLines` | `2` | lines per page before paging |
| `maxStack` | `3` | rows on screen at once (0355's default `maxVoices`) |
| `sizeScale` | `1` | multiplies the size presets |
| `speakerNames` | `always` | `always`, `whenSeveral` (only while two or more speakers are shown) or `never` |
| `fadeIn` / `fadeOut` | `0.12` / `0.2` | seconds |
| `captions` | `true` | shows captions when the player's setting allows |

**Look.** The built-in `subtitles.ui.xml` and `subtitles.ui.css` ship with the plugin. Text uses the current
language's font stack and direction (0356 §5). Variables: `--subtitle-font`, `--subtitle-color`,
`--subtitle-background` (colour; its opacity comes from the player setting), `--subtitle-speaker-color`,
`--subtitle-caption-color`, `--subtitle-padding`, `--subtitle-radius`. **Size presets** in % of the canvas reference
height: small 3.2, medium 4, large 5, extra large 6.4 (35, 43, 54 and 69 px at 1080p; medium near the commonly
recommended 46 px), times `sizeScale`.

**Speakers.** `project.json` `subtitles.speakers` maps a speaker id (0354's `speaker`) to `{ name?: <string key>,
color?: "#RRGGBB" }`; the shown name is that string (else the id as written), formatted with the string
`subtitles.speaker` when a project defines it (default `"{name}:"`; French writes `"{name} :"`), in the speaker's colour
or `--subtitle-speaker-color`. `Subtitles.speaker(id)` exposes the same lookup to replacement displays.

**Behaviour** (the pure model in `src/engine/localisation/subtitles.ts`, driven by the component):
- **Rows.** Each line (`Audio.onLine` `start`) or caption (`Audio.onCaption` `start`) with text gets a row; a new line
  from a speaker replaces that speaker's row. Rows stack oldest first away from the edge, newest nearest it, at most
  `maxStack`; when full, a caption is dropped before speech, then the oldest row.
- **Paging.** Text that needs more than `maxLines` at `maxWidth` (measured by the UI core, so wrapping and fonts are the
  real ones) is split into pages at sentence ends, then clause punctuation (`, ; : 、 ，`), then words, balancing page
  lengths. A blank line in the message forces a page break. Cue markers named `sub` in the line's file (0354 §7, per
  language) time the page changes; without them pages share the line's duration in proportion to their characters.
- **Timing.** A row shows from `start` until the later of the audio's `end` and `start` + the reading time (§3),
  each page at least its reading time (the last page lingers after the audio when the text is long). An `interrupted`
  or `stopped` end fades out at once. Captions with `duration: null` show until `end`, at least their reading time.
- **Language change** re-resolves visible rows through `textKey` (or the caption's key) on `Locale.onChange`.
- Fades are opacity animated by the component (stylesheets have no transitions yet, 0077).

**Player settings** (the hook a game's options menu uses):

```ts
interface SubtitleSettings {
  enabled: boolean;                                    // speech subtitles
  size: "small" | "medium" | "large" | "extraLarge";
  background: number;                                  // box opacity 0..1
  speakerNames: boolean;
  captions: boolean;                                   // sound captions
}
declare const Subtitles: {
  readonly settings: Readonly<SubtitleSettings>;
  set(patch: Partial<SubtitleSettings>): void;         // applies at once and persists
  reset(): void;                                       // back to the project's defaults
  onChange(fn: (s: Readonly<SubtitleSettings>) => void): () => void;
  speaker(id: string): { name: string; color: Color | null };
};
```

- Persisted in player storage (0317), namespace `settings`, key `myco.subtitles`, loaded before the first scene.
  First-run values come from `project.json` `subtitles.defaults` (default `{ enabled: true, size: "medium",
  background: 0.6, speakerNames: true, captions: false }`).
- `SubtitleDisplay` obeys the settings; replacement displays read them too, so one options menu serves both.

**`project.json` `subtitles` section** (editor-owned, Project Settings > Subtitles; parsed in
`src/engine/localisation/subtitleSettings.ts`): `defaults`, `readingSpeed`, `minDisplay`, `speakers`.

### 6. Studio and editor previews

- **Studio, Dialogue screen** (0354 §9): the Line inspector gains a **Subtitle** strip under each language's waveform:
  the pages over time with speaker name and colour, characters per second per page, and warnings (reading speed over
  the language's limit, more than `maxLines`, more than 42 characters on a line at the built-in medium size at
  1920×1080). Auditions show the subtitle in sync in the player bar. The Lines table gains a **reading speed** flag per
  language cell ("21 cps, max 15") and a filter. The Studio has no renderer, so the strip draws the pure model's pages
  with the kit and canvas text measuring in the built-in style; it is a timing and length preview, and the editor's
  Play is the exact one. The Events tab's test bench (0355) shows the picked line's subtitle.
- **Studio, Playlists screen:** a **Caption** field in the playlist inspector (key picker into string tables, create a
  key in the captions table, `minGap`); auditions show the caption.
- **Editor's Play view** runs the real `SubtitleDisplay` in the preview language. The Play toolbar gains a
  **Subtitles** toggle that overlays a `SubtitleDisplay` (editor-only, never saved) when the scene has none, so lines
  can be checked before a game adds one. Project Settings > Subtitles edits defaults, reading speed and speakers (name
  key picker, colour); the `SubtitleDisplay` Inspector shows its fields with a sample row.

## Alternatives considered

- **Keep `text` in line tables as an authoring convenience that writes through to the string table** — two copies of
  every subtitle that imports and hand edits must keep in step; the Studio's Text column gives the same convenience
  without a second store.
- **Leave subtitles in line tables and only UI text in string tables** — translators would receive two systems and
  two exchange formats; one table kind serves both.
- **Subtitle language follows the voice language (0354 as written)** — wrong for "Japanese voice, English
  subtitles"; subtitles are text, so they follow the text language.
- **Text and voice always switched separately** — two menus for every game; most games tie them, and `"separate"`
  covers the rest.
- **No built-in display (0354's default)** — the owner chose "Optional built-in"; every game would rebuild the same
  accessibility features.
- **A built-in display inside the audio plugin, reading internals** — couldn't be replaced on equal terms; a separate
  plugin on public events proves the events are enough.
- **A global engine overlay instead of a component** — no placement or theming per game; a component in a persistent
  scene or HUD prefab does both.
- **Captions later** — accessibility guidance lists them with subtitles, and the opt-in field costs little.
- **Words per minute for reading time** — doesn't work for languages without spaces; characters per second with
  per-language defaults is what subtitle guides use.

## Consequences

**Positive**
- One table kind and one translator workflow for UI text, subtitles and captions; subtitles follow language changes
  live.
- Games get accessible subtitles by adding one component: sizes, background, speaker names and colours, paging,
  reading-speed timing, stacking, captions and persisted player settings; games that want their own keep the events.
- The Studio flags subtitles that can't be read in time before anyone plays the game.

**Negative / costs**
- Public API growth: `Audio.onCaption`, `AudioCaptionEvent`, `AudioLineEvent.textKey`, `Subtitles`,
  `SubtitleSettings`, `SubtitleDisplay`; `project.json` `subtitles` and `languages.voice`; playlist `caption`.
- A new first-party plugin to maintain, and a built-in document and stylesheet whose element ids and variables become a
  contract for themes.
- The Studio's subtitle preview is approximate (no renderer); exact checks need the editor's Play.
- Two files per line table (lines and strings), and a cross-document undo step when moving old `text`.

## Deprecates

- 0354's line-table `text` field (removed before it is built; a lint migrates hand-written ones).
- 0354 §3's reading-time rule (replaced by §3 here).
- 0354 §6's `audio/lines/text.<code>.json` build files (subtitles ship in 0356's `strings/<code>.json`).
- 0354's "subtitle display is the game's" (the built-in display is optional; the events stay public).

## Open questions

- Directional captions (an arrow from `pan`) in the built-in display.
- Per-speaker subtitle placement near the speaker on screen (bubble subtitles).
- Karaoke-style word highlighting from markers.

## References

- Game Accessibility Guidelines (subtitles, captions); Xbox Accessibility Guideline 104; BBC Subtitle Guidelines;
  Netflix Timed Text Style Guides (English, Japanese, Chinese, Korean: line length, reading speed, minimum duration);
  Unreal subtitles (Dialogue Waves, subtitle cues).
- ADR 0354 §3–§7 and §9, ADR 0355 §4–§5, ADR 0356 §1, §4, §6, §9.
- `src/engine/ui/UIDocument.ts`, `components.ts`; `src/engine/audio/markerTypes.ts`; `src/engine/platform/Storage.ts`;
  `src/plugins/manifest.ts`.

## Build plan

| # | Milestone | Contents | Files (owner) |
|---|---|---|---|
| S1 | Formats and model | `project.json` `subtitles` section and `languages.voice` / per-language `voice` and `readingSpeed`; playlist `caption` (types, parse, writer, references to string keys, lint); `audio.json` `localisation.captions`; `subtitles.ts` (reading time, paging, stacking, page timing with `sub` markers); unit tests (reading-time table per language, paging at sentence and clause marks, forced breaks, stack overflow order, page timing with and without markers) | `src/engine/localisation/subtitles.ts`, `subtitleSettings.ts`, `src/engine/localisation/languages.ts` (single writer), `src/engine/audio/playlist/types.ts` + `format.ts` + `references.ts` + `lint.ts` (single writer), `src/engine/audio/project/format.ts` + `types.ts` |
| S2 | Audio runtime | line text from `Locale` in the subtitle language (live `handle.text`, `textKey` on events); subtitle language follows `Locale.language`; voice follows text through 0356's participant seam; subtitle-only duration by the reading rule; `Audio.onCaption` with `minGap` and `pan`; exports; tests on the fake backend (switch follows text, separate mode, caption gap, caption skipped for virtual voices, live text after a switch) | `src/plugins/audio/runtime/localisation/**`, `Audio.ts`, `playlists/nodes.ts`, `src/myco.ts` |
| S3 | Subtitles plugin | manifest and registration; `SubtitleDisplay`, built-in document and stylesheet, `Subtitles` settings with storage and defaults, speaker lookup; tests through the UI core headless with scripted `onLine`/`onCaption` events (rows, replace per speaker, paging, fades, settings off, size presets, language change) | `src/plugins/subtitles/**`, `src/plugins/catalogue.ts` (registration), `src/myco.ts` |
| S4 | Studio | Dialogue Text column writes the string table; Subtitle strip and reading-speed flags; caption field and audition in Playlists; test-bench subtitle; "Move subtitles to the string table" fix; stories with `play` tests | `src/studio/screens/dialogue/**` (single writer with 0354 L5 and 0355 D4), `src/studio/screens/playlists/**` (inspector) |
| S5 | Editor | Project Settings > Subtitles; Play toolbar Subtitles overlay toggle; `SubtitleDisplay` Inspector sample row | `src/editor/ui/settings/**` (Subtitles section), the Play toolbar file (single writer with 0354 L7 and 0356 T7), `src/plugins/subtitles/editor/**` |
| S6 | Docs and e2e | `docs/wiki/guide/subtitles.md` (built-in display, theming, player settings, replacing it, captions); 0354's guide's subtitle recipe points to it; e2e: editor Play with the overlay shows a French subtitle with the speaker name, and turning `Subtitles.set({ enabled: false })` hides it | `docs/wiki/guide/**`, `tests/e2e/subtitles.spec.ts` |

**Changes to 0354's plan (L1–L8).**
- **L1** builds `myco.lines@1` without `text`, with `strings` and `textKey` (§1); drops the reading-time rule (S1's
  `subtitles.ts` provides it); writes `variantPath` in `src/engine/localisation/variants.ts` (0356 §10); the script
  CSV is 0356 T6's CSV with line columns, so L1 drops its own CSV reader and writer.
- **L2** builds the line runtime with `text` `null` until S2 lands (S2 adds the string lookup); subtitle-only timing
  comes from S1.
- **L3** writes no `audio/lines/text.<code>.json`; the line index gains `textKey`.
- **L5**'s Text column, Report text status and script CSV go through string tables (finished in S4).
- **L6**'s `vo.textHash` hashes the string table's reference text.
- **L7**'s Languages section gains 0356's text fields (T7) and `voice` (S5).
- **L8**'s subtitle recipe becomes a pointer to `docs/wiki/guide/subtitles.md` (S6).

**Changes to 0355's plan (D1–D5).** D1 reads the line-table format without `text`; D4's test bench shows the
subtitle through S4. D2, D3 and D5 are unchanged; said lines reach the built-in display through `Audio.onLine` as
0355 §5 already specifies.

**Order.** S1 after 0354 L1 and 0356 T1; S2 after 0354 L2 and 0356 T2; S3 after S1, S2 and 0356 T3/T4; S4 after 0354
L5 and S1; S5 after S3 and 0356 T7; S6 last.
