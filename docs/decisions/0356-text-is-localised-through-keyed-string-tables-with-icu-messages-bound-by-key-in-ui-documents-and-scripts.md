# 0356. Text is localised through keyed string tables with ICU messages, bound by key in UI documents and scripts

- **Status:** Accepted, amended by 0391 (a fallback message is formatted with its source language's rules; build string files name that language in `sources`), partly superseded by 0417 (`LocalizedText` removed)
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0024, 0069, 0076, 0077 (resolves its open question on localisation; extended: `t:` attributes, `translate="no"`, the `:lang()` pseudo-class), 0133, 0141, 0262, 0306, 0313, 0314, 0317, 0341, 0351, 0354 (extended: the shared `languages` section gains text fields), 0355, 0357

## Context

The owner answered "Yes, add it" to text and UI localisation (decision log D53, 2026-11-22), after 0354 left it out
and kept subtitle text in line tables "keyed so a later text record can move it". 0357 moves it, on top of this record.

**What exists today.**
- **Text components.** `UIText` (`text`, `font`, `fontSize`, `fontWeight`, `textAlign`, `wordBreak`), `UIInputField`
  (`value`, `placeholder`) and the screen-space `Text` component (`engine.Text`, `text`, `fontFamily`), in
  `src/engine/ui/components.ts` and `src/engine/render/components.ts`. Hand-built UI nodes (0069) set them in scenes.
- **UI documents** (0077, `src/engine/ui/UIDocument.ts`): `*.ui.xml` markup and `*.ui.css` stylesheets. The only
  binding is `{name}` in text or an attribute value, filled from `ui.data` or a `list()` row's item and compared each
  frame (`updateBindings`, `bindingValue`). 0077 leaves open "whether `{name}` bindings or a separate `t:` key form carry
  translated strings".
- **Fonts** (`src/engine/ui/fonts.ts`, 0076): the bundled Inter, subset to Latin and Latin-1 (48 KB), then
  `system-ui, sans-serif` glyph by glyph; a `font` field names a project font file, loaded with `FontFace` under a
  generated family name with Inter after it. CJK, Arabic or Devanagari text draws in whatever system font the OS has.
- **Wrapping** (`src/engine/render/babylon/ui.ts` `textSize`, Babylon GUI `TextBlock` with `wordSplittingFunction`):
  `break-word` splits on spaces, so Chinese or Japanese text, which has none, never wraps; `break-all` splits anywhere.
  Text is drawn with the 2D canvas, so the browser shapes Arabic and applies the bidi algorithm within a line, but the
  base direction is always left-to-right and alignment is `left | center | right | justify`.
- **Languages** (0354 §1, accepted, not built): `project.json` `languages` with `list`, `reference`, `default`,
  `fallback`, `useSystemLanguage`, `remember`, BCP 47 codes and `fallbackChain(L)`, parsed by
  `src/engine/localisation/languages.ts`; a per-user preview language; `Audio.language` and an atomic `setLanguage`.
- **Name collision.** `Text` is already a component, so the script API can't be `Text.t(...)`.

**How the reference tools do it.**
- **Unity Localization:** locales with fallback; *string table collections* (shared keys and metadata, one table per
  locale); *Smart Strings* (SmartFormat: placeholders, plural and choose formatters); asset tables; `LocalizedString`
  bound to UI Toolkit attributes or through `LocalizeStringEvent`; pseudo-locales; CSV, XLIFF 1.2/2.0 and Google
  Sheets exchange.
- **Unreal:** `FText` with namespace and key; string tables (`.csv`) referenced by id and key; *text gathering*
  collects source text from code and assets into a manifest; per-culture `.po` export and import and compiled
  `.locres` per culture; culture fallback; `FText::Format` with ICU-backed plural and gender arguments; composite fonts
  with per-culture sub-fonts; Slate flow direction for RTL.
- **Godot:** CSV or gettext `.po` translations, `tr()` and automatic translation of Control text by matching keys,
  pseudolocalisation settings, per-node layout direction for RTL.
- **Message formats.** ICU MessageFormat 1 (`{n, plural, one {# item} other {# items}}`, `select`, `selectordinal`,
  number and date arguments) is what CAT tools and translation platforms (Crowdin, Lokalise, Phrase, Smartling, memoQ,
  Trados) recognise inside a segment. Fluent (Mozilla) is more expressive (terms, attributes, asymmetric variants) but
  is a file format first and has thinner tool support. Unicode MessageFormat 2 became stable in CLDR 47 (2025); tool
  support is still early.
- **Libraries measured** (esbuild, minified, bundled with one call, gzip -9): `intl-messageformat` 12.2.0
  (BSD-3-Clause) 33.8 KB / 9.8 KB gzip, and it throws on a malformed message; `@messageformat/core` 3.4.1 (MIT)
  71.4 KB / 20.1 KB; `@fluent/bundle` 0.19.1 (Apache-2.0) 11.1 KB / 4.0 KB.

## Decision

We will keep text in **string tables**: a table file of keys with reference-language text and notes, and one
translation file per language beside it; format messages with **ICU MessageFormat 1** through a small engine module
built on `Intl`; resolve each key through 0354's fallback chains; bind keys in UI documents with **`t:` attributes**,
in scenes with a **`LocalizedText`** component and in scripts with **`Locale.t`**; pick fonts, line breaking and text
direction per language; give the editor a **Localisation panel** with reports, pseudo-localisation and CSV, XLIFF and
PO exchange; and ship every shipped language's strings as one file per language in the build.

### 1. String tables

**The table** is an asset, `*.strings.json` (`myco.strings@1`), parsed leniently by
`src/engine/localisation/strings/format.ts` (never throws; problems with paths). A project has any number; tables are
files for organising work (per screen, system or chapter), not namespaces.

```jsonc
// strings/menu.strings.json
{
  "format": "myco.strings@1",
  "language": "en",                        // the reference language its text is written in (checked against project.json)
  "strings": [
    { "key": "menu.start", "text": "Start game",
      "notes": "Main menu button. Verb.",  // for translators; never shipped
      "maxLength": 18,                      // characters (graphemes); optional, §8
      "tags": ["menu"],
      "examples": { } },                    // sample arguments for previews and fit checks, §8
    { "key": "hud.coins", "text": "{count, plural, =0 {No coins} one {# coin} other {# coins}}",
      "examples": { "count": 12 } }
  ]
}
```

**Translations** sit beside the table, one file per language: `strings/menu.fr.strings.json`
(`myco.translation@1`, `src/engine/localisation/strings/translation.ts`).

```jsonc
{
  "format": "myco.translation@1",
  "language": "fr",
  "strings": {
    "menu.start": { "text": "Commencer", "status": "translated", "source": "3fa1c29e0b7d44a1" },
    "hud.coins":  { "text": "{count, plural, =0 {Aucune pièce} one {# pièce} other {# pièces}}", "status": "needsReview" }
  }
}
```

- **Naming.** A table's stem matches `[A-Za-z0-9_-]{1,64}` (no dots), so `<stem>.<code>.strings.json` is
  unambiguously its translation into `<code>`; a translation file whose code isn't a project language, or whose table
  doesn't exist, is linted. Tables usually live in `strings/`, but any folder works.
- **Keys** match `[A-Za-z0-9_.-]{1,128}` and are **unique across the project** (0354's rule for line keys, so a line key
  is a valid string key, 0357). Dotted prefixes (`menu.`, `hud.`) are the convention. The editor refuses a duplicate on
  edit; the runtime takes the first table in path order and warns once.
- **Reference text in the table, translations per language.** Authors add a key and its English text in one place;
  translators and vendors receive and return one file per language, which diffs and merges cleanly. Changing
  `languages.reference` is an editor command that swaps each table's text with the new reference language's
  translation (one undo step per document) and is refused while any key lacks the new language.
- **Status** per translated key: `translated`, `needsReview` (imported as fuzzy or needing review, or set by hand) or
  **missing** (no entry). `source` is the SHA-256 of the reference text when it was translated (first 16 hex, 0354's
  `textHash` rule); when the reference text changes, the entry's effective status becomes `needsReview` without a write.
  A `needsReview` translation is still used at runtime (better than a fallback language); the reports list it.
- **Limits** (declared once in the parse, 0306): 20,000 keys per table, 4,000 characters per message, 64 tags, 32
  example arguments, 64 placeholders and nesting depth 8 per message.
- **Renames** of a key rewrite every reference (UI document `t:` attributes, `LocalizedText.key` in scenes and prefabs,
  line tables' text keys and playlist captions under 0357) through the asset kinds' reference rewriting (0314) and the
  named-list module (0262); script string literals are linted, not rewritten (0354's rule).

### 2. Messages: ICU MessageFormat 1, implemented in the engine

**Syntax** (the ICU MessageFormat 1 subset CAT tools understand), parsed by `src/engine/localisation/message/parse.ts`
into an AST with source positions and formatted by `message/format.ts`:

- `{name}`: an argument. Strings as given; numbers through `Intl.NumberFormat`; `Date` through `Intl.DateTimeFormat`
  (`dateStyle: "medium"`); a `LocalText` (§6) as its current string. A missing argument stays `{name}` with one warning
  per key and name (0077's binding rule).
- `{n, number}`, `{n, number, integer | percent}`, and skeletons `{n, number, ::…}` with the tokens `integer`,
  `percent`, `compact-short`, `compact-long`, `currency/XXX`, `unit/xxx`, `.00`/`.0#` (fraction digits), `group-off`
  and `sign-always`, mapped to `Intl.NumberFormat` options. Unknown tokens are linted and ignored.
- `{d, date, short | medium | long | full}` and `{d, time, …}` through `Intl.DateTimeFormat`.
- `{n, plural, offset:1 =0 {…} one {…} other {…}}` with `#` (the number minus the offset, formatted); categories
  `zero one two few many other` from `Intl.PluralRules`. `{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}`.
- `{gender, select, female {…} male {…} other {…}}`: genders and any other choice. `other` is required in every
  `plural`, `selectordinal` and `select` (linted; the formatter falls back to the first branch).
- Apostrophe quoting as ICU's default mode: `''` is one apostrophe, `'{…}'` is literal text; a lone apostrophe in
  ordinary text (`l'heure`, `don't`) stays literal.
- **Not included:** references from one string to another (Fluent terms), rich-text tags (`UIText` has no rich text),
  and custom formatters. A game passes another string as an argument (`Locale.text(...)`, §6).

**Never throws.** A malformed message returns problems with positions and a best-effort AST (the broken part shown as
written). At runtime a malformed translation is skipped for the next language in the chain, with one warning.

**Checks** (`message/check.ts`, used by the editor, the export and the import preview): a translation may only use
argument names the reference message uses, with the same kind (a `plural` argument can't become a `select`); each
`plural` has the categories the target language needs (from `Intl.PluralRules(code).resolvedOptions().pluralCategories`:
"Polish needs `few` and `many`"); the message parses.

**Why our own implementation.** The formatter's hard part, CLDR plural rules and number and date formats, is `Intl`,
available in every target (Chromium, WebKit, WebView2, WebKitGTK, Node). What remains is an ICU MF1 parser of a few
hundred lines. Our own module never throws and reports positions (the engine's lenient-parse rule), exposes the AST
the editor needs for checks, pseudo-localisation (§9) and syntax highlighting, and is estimated at under 4 KB gzip in
every game build against 9.8 KB for `intl-messageformat`, which throws and hides its AST behind a second package.
`@formatjs/icu-messageformat-parser` (MIT) is added as a **dev dependency only**, as a differential test oracle: the
unit tests parse a corpus of messages with both and compare.

**Why ICU over Fluent.** A message is one cell in a CSV, one XLIFF segment and one PO `msgstr`, and translation tools
validate ICU plurals inside it; Unreal formats with ICU semantics and Unity's Smart Strings cover the same ground.
Fluent's richer features need its own file format and tooling. MF2 can be adopted later by converting messages
(`messageformat` 4 converts MF1 to MF2) without changing keys or tables.

### 3. Languages and fallback

The `languages` section of `project.json` (0354 §1) is the one language list for text and audio. This record adds
text fields, parsed by the same `src/engine/localisation/languages.ts`:

```jsonc
"languages": {
  "list": [
    { "code": "en", "name": "English" },
    { "code": "ja", "name": "日本語", "fonts": ["fonts/NotoSansJP-Regular.woff2"] },
    { "code": "ar", "name": "العربية", "direction": "rtl", "fonts": ["fonts/NotoNaskhArabic.woff2"],
      "fontReplace": { "fonts/Pirata.ttf": "fonts/ArefRuqaa.ttf" }, "intl": "ar-u-nu-latn" }
  ],
  "reference": "en", "default": "en", "fallback": ["en"], "useSystemLanguage": true, "remember": true,
  "assetRoots": ["images/loc"]                  // §10
}
```

- `direction`: `ltr | rtl`; default `rtl` for `ar`, `he`, `fa`, `ur`, `ps`, `sd`, `yi`, `dv`, `ckb` and any tag with an
  `Arab` or `Hebr` script subtag, else `ltr`.
- `fonts`: font files tried after a text's own font and before Inter (§5). `fontReplace`: a text whose `font` is the
  key draws in the value in this language. `intl`: the BCP 47 tag `Intl` formats with (default: the code), e.g. a
  numbering system or region.
- **Fallback** is 0354's `fallbackChain(L)` unchanged: L, its own `fallback` list, the project's `fallback`, duplicates
  removed. A key resolves to the first language in the chain with a translation (`translated` or `needsReview`) whose
  message parses; the reference language's text comes from the table. Missing everywhere: `Locale.t` returns the key
  itself and warns once.

### 4. Binding keys: UI documents, components and live updates (resolves 0077's open question)

**UI documents: `t:` attributes.** `t:<field>="<key>"` sets a string field to the localised message:

```xml
<Text t:text="menu.start"/>
<Text t:text="hud.coins"/>                         <!-- {count} comes from ui.data.count or the row's item -->
<InputField t:placeholder="profile.name_hint"/>
<Text t:text="weapon.{id}.name"/>                   <!-- {name} bindings inside a key pick the key per row -->
<Text translate="no">MYCO</Text>                     <!-- deliberately unlocalised: left out of reports -->
```

- **Arguments** come from the same scope as `{name}` bindings: the innermost `list()` row's item, then `ui.data`, so
  `ui.data.count = 12` updates "12 coins". Only the names the message uses are looked up.
- **Why a key attribute, not `{name}` bindings.** A `{name}` binding would need scripts to fill every string into
  `ui.data` and re-fill it on a language change; the key form keeps the key in the file the editor edits, so the
  Inspector, renames, reports and fit checks can see it. It is Unity UI Toolkit's model (a `LocalizedString` bound to an
  attribute) in markup, and `t:` is an XML namespace prefix `htmlparser2` already keeps.
- An element with `t:text` and text content shows the content only while the key resolves nowhere (useful during
  migration), with a lint when it differs from the reference text. `t:` on a non-string field is a lint.
- **Stylesheets** gain the `:lang(<code>)` pseudo-class, true when the current text language matches by BCP 47 prefix
  (`:lang(de)` matches `de-AT`): per-language font sizes, letter spacing or mirrored rows without scripts.

**Scenes: `LocalizedText`** (`engine.LocalizedText`, a component in `src/engine/ui/LocalizedText.ts`, Unity's
`LocalizeStringEvent`): `key` (a string key picker in the Inspector) and `field` (empty: the node's `UIText.text`, else
`Text.text`, else `UIInputField.placeholder`; or a named string field of a component on the node). It writes the
message into the field when it starts, on every language change and when `args` changes. `args`
(`Record<string, MessageArg>`) is set by scripts at runtime and not saved. Literal fields keep working unchanged.

**Live update.** `Locale.epoch` increases whenever resolved text can change (a language switch, a table edit in the
editor, hot reload). UI documents re-evaluate `t:` bindings and `:lang()` rules when the epoch moves (one integer
comparison per document per frame); `LocalizedText` does the same; `LocalText` values in `ui.data` re-resolve because
bindings compare the formatted string (§6). Text a script wrote once with `Locale.t` stays as written; scripts listen
to `Locale.onChange` or use `Locale.text`.

### 5. Fonts, line breaking and direction

- **Font stacks per language.** A text's family list becomes: its own `font` (after `fontReplace`), the current
  language's `fonts` in order, Inter, `system-ui, sans-serif`. `fonts.ts` loads language fonts when the language becomes
  current (and preloads the start language's before the first scene); `Locale.setLanguage` waits for them (at most
  3 s, then switches with the fallback and warns) so text doesn't flash in the wrong font. The `Text` component's
  `fontFamily` gets the same language fonts after it.
- **Han unification.** Japanese, Simplified and Traditional Chinese and Korean share code points but not glyph shapes,
  so the font must follow the language, not the character: that is what per-language `fonts` does. The engine ships no
  CJK or Arabic font (owner question 2); the guide lists Noto fonts (SIL OFL) and their sizes.
- **Line breaking** moves into a pure module, `src/engine/ui/text/lineBreak.ts`, used by both measuring (`textSize`) and
  drawing (`wordSplittingFunction`), so they always agree. `break-word` (default) breaks after spaces and between
  ideographs, kana and Hangul syllables, with Japanese and Chinese line-start and line-end rules (no line starts with
  `、。，．！？」』）】ー々ぁぃぅぇぉっゃゅょ` and the like, none ends with `「『（【`), and segments Thai, Lao, Khmer and
  Myanmar with `Intl.Segmenter` (word granularity). `keep-all` doesn't break between CJK characters (CSS's meaning;
  Korean by spaces); `break-all` breaks anywhere. Today's Latin behaviour is unchanged.
- **Right-to-left text: supported.** The language's `direction` sets each text's base direction (the canvas context's
  `direction`, through a small `TextBlock` subclass in `render/babylon/ui.ts`, Babylon-internal), and `textAlign`
  gains `start` and `end`, with `start` the new default (identical to `left` in LTR). The browser shapes Arabic and
  reorders mixed runs within each line; wrapping works on logical order, which is correct for RTL. `UIInputField`'s
  hidden DOM input gets `dir`; its drawn text aligns to `end`.
- **RTL layout mirroring: deferred.** Flipping rows, `left`/`right` and anchors automatically needs logical properties
  (`margin-inline-start`, `inset-inline`) across the UI core, the stylesheet subset and the editor's handles; Unity's UI
  Toolkit ships without it. Until a record adds it, a project mirrors with `:lang(ar)` rules (`flex-direction:
  row-reverse`). Caret placement inside mixed-direction input text is approximate (a known limit, in the guide).

### 5a. Numbers, dates and lists

`Locale.formatNumber`, `formatDate`, `formatList` and `formatRelativeTime` (§6) wrap `Intl.NumberFormat`,
`DateTimeFormat`, `ListFormat` and `RelativeTimeFormat` with the current language's `intl` tag, cached per tag and
options. Messages use the same formatters (§2). Pseudo-languages (§9) format as the reference language.

### 6. Script API

In `src/engine/localisation/Locale.ts`, exported from `src/engine/index.ts`. Engine-native types and standard `Intl`
option types only (0010).

```ts
type MessageArg = string | number | bigint | boolean | Date | LocalText | null | undefined;
type MessageArgs = Readonly<Record<string, MessageArg>>;

interface LocaleLanguage { readonly code: string; readonly name: string; readonly fallback: readonly string[];
                           readonly direction: "ltr" | "rtl" }

declare const Locale: {
  readonly language: string;                     // the current text language
  readonly pendingLanguage: string | null;       // a switch in progress
  readonly languages: readonly LocaleLanguage[]; // the shipped languages
  readonly direction: "ltr" | "rtl";             // the current language's
  readonly epoch: number;                        // rises whenever resolved text can change (§4)
  setLanguage(code: string): Promise<void>;      // atomic (below); 0357 adds the voice language to the same switch
  t(key: string, args?: MessageArgs): string;    // the message in the current language; the key itself when missing
  text(key: string, args?: MessageArgs): LocalText;
  has(key: string): boolean;                     // true when any language in the current chain has the key
  format(message: string, args?: MessageArgs): string;   // an ICU message written at runtime (mod data, servers)
  formatNumber(value: number | bigint, options?: Intl.NumberFormatOptions): string;
  formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  formatList(items: readonly string[], options?: Intl.ListFormatOptions): string;
  formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string;
  onChange(fn: (e: { language: string; previous: string }) => void): () => void;
};

class LocalText {                                 // Unreal's FText: a key and arguments, resolved when read
  readonly key: string;
  readonly args: MessageArgs | null;
  with(args: MessageArgs): LocalText;
  toString(): string;                             // Locale.t(key, args) in the current language
}
class LocalizedText extends Component { key: string; field: string; args: MessageArgs | null }
```

- **Start language** (Unity's selector chain, 0354 §4's rule): the remembered language (player storage, 0317,
  namespace `settings`, key `myco.locale.language`, when `remember`), else the best system match (when
  `useSystemLanguage`), else `default`; only shipped languages count. In the editor's Play it is the preview language.
  The start language's strings and fonts load before the first scene, as preload packages do.
- **A switch is atomic**: `setLanguage` loads the language's string file and fonts, then changes `language`, raises
  `epoch` and calls `onChange` listeners in one frame, then remembers it. An unknown or unshipped code rejects with one
  warning and changes nothing; a second switch supersedes a pending one. In the editor and in tests it resolves at
  once (tables are in memory).
- **`LocalText` in bindings.** `ui.data.title = Locale.text("quest.title", { name })` shows the title and follows
  language changes; its formatted string is cached per epoch and argument identity.
- `Locale.debug()` returns `{ language, pending, missing: [{ key, language }] }` (the last 64 keys that fell back or
  were missing) for the profiler and tests.
- The dedicated server and headless Worlds have `Locale` with the default language (no fonts).

### 7. Gathering and reports

`src/engine/localisation/gather.ts` (pure, Unreal's text gathering run as a report, not as source extraction) lists
where each key is used: `t:` attributes in UI documents, `LocalizedText.key` in scenes and prefabs, line tables' text
keys and captions (0357), and literal first arguments of `Locale.t` and `Locale.text` in scripts (best effort). It
also lists **unkeyed text**: literal text content in documents and literal `UIText`/`Text` fields in scenes that
contain letters and aren't marked `translate="no"` (dismissals kept in `.myco/localisation-ignore.json`).

### 8. Translator workflow

- **Exchange formats** (pure readers and writers in `src/engine/localisation/exchange/`):
  - **CSV** (UTF-8 with BOM, RFC 4180): `key, table, notes, maxLength, <reference>, <lang>, <lang>:status, …`; 0354's
    script CSV becomes this layout plus line columns (0357).
  - **XLIFF 1.2** (the version every CAT tool reads; Unity's default): one `<file>` per table and target language,
    `<trans-unit id resname>` = key, `<source>`, `<target state>` (`translated`, `needs-review-translation`,
    `needs-translation`), `<note>` for notes, `maxwidth` with `size-unit="char"` from `maxLength`. ICU messages travel
    as text; translation platforms detect and validate them.
  - **gettext PO**: one `.po` per language and a `.pot`; `msgctxt` = key, `msgid` = reference text, `msgstr` =
    translation, `#.` notes, `#:` table, `#, fuzzy` = `needsReview`. Unreal's and Godot's translator workflow.
- **Export** chooses tables (or all), languages, and "only missing and needs review". **Import** shows a preview
  before writing: new and changed translations, status changes, unknown keys (skipped), messages that fail the checks
  (§2, skipped with the reason), and translations made against an older reference text (XLIFF `<source>` or PO `msgid`
  differs from the current text: imported as `needsReview`). Applying is one undo step per affected document.
- **Length.** `maxLength` (graphemes, via `Intl.Segmenter`) is checked per language in the panel and on import. The
  **text fit check** lays out every UI document that uses keys, at its canvas's reference resolution, in each language
  and the pseudo-language, with each message formatted from its `examples` (numbers missing from `examples` use
  `88888`, strings `WWWWWWWW`), and reports elements whose text overflows its box (more lines than fit, or wider than
  the box with wrapping off). It runs in the editor on demand (it needs the canvas measurer).

### 9. Editor tooling

The editor owns UI and scenes, so text tooling is the editor's. The Studio (0341) is the audio app; it edits only
subtitle and caption text (0357).

- **Localisation panel** (`src/editor/ui/localisation/`, a dockable panel opened from Window and from Project
  Settings > Languages), built from the component kit (0349):
  - **Strings** tab: a table list and a grid of Key, Reference text, one column per language (text with a status chip:
    translated, needs review, missing, over length, check failed), Notes, Max length. Inline edits of keys, text and
    notes (refused-or-next edits, 0313); add, duplicate, delete, rename; search; filters ("missing in fr", "needs review
    in de", "over length"). A message editor with ICU syntax highlighting, inline check errors and **Add plural**
    (inserts the target language's categories). Cells preview in the language's font and direction.
  - **Report** tab: per language translated / needs review / missing counts; missing keys used by documents, scenes or
    scripts; keys used but defined nowhere; unused keys; unkeyed text (§7); the text fit results (§8). Each row opens
    its source.
  - **Exchange** tab: export and import (§8).
- **Inspector.** A UI document element's string field gets a **Localise** control: pick a key (search with previews)
  or **Extract to string table** (creates a key suggested from the document and element id in a chosen table, writes
  the literal text as reference text, replaces the content with `t:text`, one command). `LocalizedText` has a key
  picker with a preview. Both show the resolved text in the preview language.
- **Preview language** (0354 §1's per-user preference, the Play toolbar's Language menu) covers text too, and the menu
  gains two **pseudo-languages** (Microsoft's codes): `qps-ploc` (accented and expanded: `[!! Šţàŕţ ĝàɱé !!]`, padded
  by length, +100% under 10 characters down to +30% over 70, the IBM expansion guidance; placeholders, plural keywords
  and `#` untouched through the AST) and `qps-plocm` (the same, right-to-left). Literal text stays plain, so hard-coded
  strings stand out, and the brackets expose truncation. They exist only in the editor and in `--pseudo` QA builds.
- **Project Settings > Languages** (0354 L7) gains direction, fonts, font replacements, `intl` and `assetRoots`.
- **Ownership** (0341): string tables and translations are editor files, except tables named by audio data (0357:
  a line table's string table and the captions table), which the Studio owns. Each app writes the tables it owns, and
  the other app's only while that app holds no lock (0354 §1's rule); otherwise it shows them read-only with "Edit in
  the Studio" or "Edit in the editor".

### 10. Localised assets (asset tables, by folder)

`languages.assetRoots` applies 0354's folder rule to any asset: under a root, the first folder is a language code, a
reference names the reference language's file (`images/loc/en/logo.png`) and resolution tries each language of the
chain. 0354's `variantPath` is generic and lives in `src/engine/localisation/variants.ts` (one module for audio roots
and asset roots). `Assets` resolves textures and fonts under asset roots; `UIImage.image` and `SpriteRenderer`
re-resolve on a language change; other assets (materials, models) resolve when they load (a scene reload picks the new
language). Unity's per-entry asset tables are not added: folders need no per-asset edits (0354's reasoning).

### 11. Export and packages

- **Build files.** The export writes `strings/<code>.json` (`myco.strings.build@1`: `language`, `direction`, and per
  key the message resolved through that language's chain, so each file is complete on its own) for every shipped
  language (`ship: false` left out, `--languages` narrows, 0354 §6). Notes, status, `maxLength`, examples and sources
  never ship. A translation that fails the checks is replaced by its fallback with a build warning. `game.json` gains
  `localisation: { strings: { "<code>": { url, bytes } }, fonts: { "<code>": [url…] } }`. About 100 KB per language
  for 2,000 strings of 40 characters, before compression.
- **Every shipped language is in the build** (owner, D53): string files, language fonts and asset-root variants for
  each. Variants of unshipped languages are left out. `--pseudo` adds the two pseudo-languages for QA builds.
- **Packages (0351).** String files and fonts are not audio and never go into `.mycopak` files; they ship loose and load
  with the language switch, beside 0354's language parts of audio packages (0357 joins both in one switch).

### 12. Migration

Nothing changes until a project opts in. Literal text in documents, scenes and scripts stays valid; a project without
string tables behaves exactly as today; `t:`, `LocalizedText` and `Locale.t` are opt-in per string. The only visible
changes for existing projects: `textAlign` defaults to `start` (identical in LTR), and `break-word` now wraps CJK
text instead of overflowing.

## Alternatives considered

- **Fluent** (`@fluent/bundle`, 4.0 KB gzip) — more expressive, but a message isn't a self-contained segment for CSV,
  XLIFF or PO, and CAT tool support is thin; ICU is what translators' tools validate.
- **`intl-messageformat`** (9.8 KB gzip, BSD-3-Clause) — mature, but throws on malformed messages, ships its parser
  separately for the AST we need, and is larger than our `Intl`-based module; kept as a test oracle (its parser).
- **Unicode MessageFormat 2** — the future standard, but tools and translators don't use it yet; MF1 converts later.
- **Unity Smart Strings / SmartFormat syntax** — engine-specific; translators' tools don't validate it.
- **Source text as the key (gettext `msgid`, Godot's auto-translate)** — no key to invent, but fixing a typo in English
  orphans every translation, and identical English words with different meanings collide; keys with notes avoid both.
- **Every language in one table file** (0354's line-table layout) — one file to open, but parallel translators conflict
  in version control and vendors want a file per language.
- **Per-table namespaces (`menu:start`, Unity's collection + entry)** — no collisions, but every call site names its
  table; project-unique keys match 0354's line keys and the editor enforces uniqueness.
- **`{name}` bindings filled by scripts** — keeps markup unchanged, but strings live in scripts and nothing in the file
  says what to translate; `t:` keeps keys visible to tools.
- **A `t:` prefix in field values** (`text="t:menu.start"`) — works in scenes too, but makes literal text starting with
  `t:` ambiguous; an attribute in documents and a component in scenes need no escaping.
- **A Studio screen for strings** — the Studio is the audio app; UI text belongs beside the UI and scenes it serves.
- **Baking fallback at runtime from several files** — smaller files, but a switch fetches several; the build resolves
  chains once.
- **Full RTL layout mirroring now** — the complete answer for Arabic and Hebrew UIs, but a layout-model change across
  the UI core and editor for a small share of projects; RTL text now, mirroring by `:lang()` rules until a record adds it.

## Consequences

**Positive**
- UI documents, scenes and scripts show text in any shipped language, follow language changes live, and fall back
  through the same chains as voice-over.
- Plurals, genders, numbers and dates are correct per language through ICU messages and `Intl`, in a format
  translators' tools validate.
- Translators get CSV, XLIFF or PO with notes, length limits and status; imports are previewed and checked.
- Missing keys, hard-coded text and truncation show in the editor before export, through reports, pseudo-languages and
  fit checks.
- CJK text wraps, Arabic and Hebrew read right-to-left, and fonts follow the language.

**Negative / costs**
- Public API growth: `Locale`, `LocalText`, `LocalizedText`, `LocaleLanguage`, `MessageArg(s)`, `textAlign` values
  `start`/`end`; markup gains `t:` attributes and `translate="no"`; stylesheets gain `:lang()`.
- A message parser and formatter to own and keep compatible with ICU MF1.
- Font files for CJK are large (several MB each unsubset) and the engine doesn't subset them yet.
- RTL layout mirroring is manual; caret placement in mixed-direction input text is approximate.
- Two apps can write string tables, under the ownership rule.

## Deprecates

Nothing. 0354's line-table `text` field is retired by 0357 before it is built.

## Open questions

- Font subsetting at export (only the glyphs a language's strings use), to shrink CJK fonts.
- Automatic RTL layout mirroring with logical properties.
- Rich text in `UIText` (bold, colour spans) and tags in messages.
- Machine-translation drafts in the Localisation panel (always imported as `needsReview`).
- Downloading a language on demand (0354's open question) instead of shipping every language.

## References

- ICU MessageFormat (ICU User Guide, "Formatting Messages"); Unicode CLDR plural rules; ECMA-402 `Intl`;
  UAX #14 line breaking; JIS X 4051 line-start and line-end rules; Project Fluent; Unicode MessageFormat 2 (CLDR 47).
- Unity Localization (string tables, Smart Strings, asset tables, pseudo-locales, XLIFF/CSV); Unreal localisation
  (string tables, text gathering, `.po`/`.locres`, culture fallback, `FText::Format`, composite fonts); Godot
  internationalisation (CSV/PO, pseudolocalisation, layout direction).
- XLIFF 1.2 (OASIS); GNU gettext PO format; Microsoft pseudo-locales `qps-ploc`/`qps-plocm`; IBM text expansion
  guidance.
- `src/engine/ui/UIDocument.ts`, `document/markup.ts`, `document/stylesheet.ts`, `components.ts`, `fonts.ts`;
  `src/engine/render/babylon/ui.ts`; `src/engine/render/components.ts`; `src/engine/platform/Storage.ts`; ADR 0354 §1,
  §4, §6.
- Library sizes measured with esbuild 0.28.2 (minify, bundle, gzip -9) in a scratch project, 2026-11-22.

## Build plan

| # | Milestone | Contents | Files (owner) |
|---|---|---|---|
| T1 | Formats and messages | `languages.ts` text fields (`direction`, `fonts`, `fontReplace`, `intl`, `assetRoots`); `myco.strings@1` and `myco.translation@1` parse/write, limits, key rules, source hash; ICU MF1 parser (positions, problems), formatter on `Intl`, checks (argument names and kinds, plural categories per language), pseudo-localisation transform; build file format; unit tests (message corpus with the `@formatjs/icu-messageformat-parser` dev oracle, plural tables for en/fr/pl/ar/ja, apostrophes, malformed input never throws, check messages, pseudo leaves placeholders) | `src/engine/localisation/strings/**`, `message/**`, `src/engine/localisation/languages.ts` (single writer after 0354 L1), `package.json` (dev dependency) |
| T2 | Runtime `Locale` | registry over tables (editor) or build files (player); chain resolution; `Locale` API, `LocalText`, epoch, start selector, atomic switch with strings and fonts, player storage, `debug()`; the internal language-participant seam 0357 uses; exports; tests (fallback, missing key, switch supersede, LocalText cache, start selector) | `src/engine/localisation/runtime/**`, `src/engine/localisation/Locale.ts`, `src/engine/index.ts`, `src/player/main.ts` (start load) |
| T3 | UI binding | `t:` attributes (markup parse, binding with key templates and argument scope, epoch refresh), `translate="no"`, `:lang()`, `LocalizedText`; tests through `UIDocument` and the UI core headless | `src/engine/ui/document/markup.ts` + `stylesheet.ts`, `src/engine/ui/UIDocument.ts`, new `src/engine/ui/LocalizedText.ts`, `src/plugins/ui/runtime/**` (registration) |
| T4 | Fonts, breaking, direction | per-language font stacks and replacements, font preload on switch; `lineBreak.ts` (CJK and kinsoku, `Intl.Segmenter` for Thai and others) in measure and draw; `direction`, `textAlign` `start`/`end`, RTL `TextBlock`, input `dir`; `Text` component stacks; tests (break tables, RTL alignment through the core's text runs) | `src/engine/ui/fonts.ts`, new `src/engine/ui/text/**`, `src/engine/ui/components.ts`, `src/engine/render/babylon/ui.ts`, `src/engine/render/components.ts` |
| T5 | Localised assets | `variants.ts` in `src/engine/localisation/` (0354 L1 writes it there); `Assets` resolution under asset roots; `UIImage` and `SpriteRenderer` re-resolve on switch; tests | `src/engine/scene/Assets.ts`, `src/engine/localisation/variants.ts`, `src/plugins/sprites/runtime/**` (re-resolve hook) |
| T6 | Exchange and gathering | CSV, XLIFF 1.2, PO readers and writers; import diff with checks and stale-source detection; `gather.ts` (documents, scenes, prefabs, scripts, line tables); grapheme length; unit tests (round trips with quotes, BOM, plurals, fuzzy, `maxwidth`) | `src/engine/localisation/exchange/**`, `src/engine/localisation/gather.ts` |
| T7 | Editor | Localisation panel (Strings, Report with fit check, Exchange), message editor, Inspector Localise and Extract, `LocalizedText` inspector, key renames through 0314/0262, pseudo-languages in the Play toolbar's Language menu, Languages settings fields, ownership rule; stories with `play` tests | `src/editor/ui/localisation/**`, `src/editor/ui/settings/**` (Languages section, after 0354 L7), the Play toolbar file (after 0354 L7), the UI Inspector section |
| T8 | Export | `strings/<code>.json`, `game.json` `localisation`, language fonts and asset-root variants per shipped language, `--pseudo`, build warnings; tests in `buildWriter.test.ts` | `src/export/strings.ts` (new), `src/export/main.ts`, `src/export/format.ts` |
| T9 | Docs and e2e | `docs/wiki/guide/localising-text.md` (tables, ICU, binding, fonts, RTL limits, translators); e2e: the editor's Localisation panel adds a French translation, Play in French shows it in a UI document, the pseudo-language shows an unkeyed string plain; `@slow` export with two languages boots and `Locale.setLanguage("fr")` changes a document's text | `docs/wiki/guide/**`, `tests/e2e/localisation.spec.ts`, `tests/e2e/export-languages.spec.ts` (shared with 0354 L8: one writer) |

T1 runs after 0354's L1 (or in the same wave with `languages.ts` and `variants.ts` owned by L1 and handed to T1/T5
after it merges). T2 after T1; T3, T4, T5 and T6 beside each other after T2; T7 after T3, T6 and 0354's L7; T8 after
T2 and 0354's L3; T9 last. Single-writer files with 0354, 0355 and 0357 in W13: `src/engine/localisation/languages.ts`,
`src/myco.ts`, `src/engine/index.ts`, `src/editor/ui/settings/**` (Languages section), the Play toolbar file,
`src/export/main.ts`, `tests/e2e/export-languages.spec.ts`; the coordinator names one task per wave for each.
