What I read: 0452, 0451, goal.md in full; `src/plugins/runtimeContext.ts` (take/debugLink points, lines 69-75, 143-144, 183-184); `src/engine/audio/take/extensions.ts` (the take-source registry); `src/engine/localisation/Locale.ts` (strings seam, lines 63, 145-157, 431-465) and `runtime/strings.ts` (`LocaleStrings`, `noStrings`); `src/editor/sdk/plugins.ts:78-80`, `src/editor/playStats.ts` (size), the two Play Stats registrations in the navigation and audio editor halves; file sizes in `plugins/audio/runtime/capture/` and `src/engine/{audio/take,debugLink}/`; the list of importers of `localisation/strings|message`. Not read in depth: the spikes, ADRs 0133-0417 (titles only), `src/studio/screens/profiler/`. Claims about those are marked as estimates.

**Verdict: approve with changes** (0451 is closer to approve than 0452).

Top 3 concerns:
1. 0452 bundles four separable moves (generalise the source registry, move the framing into the engine, one record key, profiler module) behind one "diagnostics" name. Only the first two serve goals 1 and 2 directly.
2. 0451's central piece already exists: `Locale` reaches messages only through `LocaleStrings` (`runtime/strings.ts:14-32`), and `noStrings` is already the disabled behaviour. The record doesn't say so, so it prices a seam that is mostly built.
3. Neither record's Alternatives lists the cut-down versions below.

## Issues

1. **major, 0451: the seam exists; the record invents a second one.** `Locale.ts:63` holds `strings: LocaleStrings`, defaulting to `noStrings`; `localeStringsChanged(next)` (`Locale.ts:459-462`) swaps it and raises the epoch. The new `lookup/format/changed` interface duplicates `message/load/keys` plus the epoch. Change: say the strings interface is `LocaleStrings`, and that the work is who installs it at boot.
2. **major, 0451: `format` in the interface is a second seam for no reason.** `Locale.ts:19-21` imports `formatMessage`/`parseMessage` directly, and fallback chains, parsing and formatting are `Locale`'s (`strings.ts:7-9`). Moving ICU into the plugin makes `Locale.t` depend on a plugin for the pure half of its pipeline. Change: keep `message/` in the engine (generic, pure, and subtitles and audio captions need it with the plugin off), or justify why a replacement provider must own plural rules.
3. **major, 0452: take sources are already a lazy, named registry.** `registerTakeSource(name, load)` (`extensions.ts:57-70`) with a host offering `write(type, payload)`, stopped with the take, in a reserved type range, is `diagnostics.source` minus keyframes, deep links and re-execution. The record doesn't say what the new point does that a rename plus those optional fields wouldn't. Change: state the delta, or take the cheaper route below.
4. **minor, 0452: the META source table solves a type-space problem that doesn't exist yet.** The plugin range 0x40-0x7e has 63 types; animation uses five (`extensions.ts:3-5`). Dynamic assignment costs every reader a table lookup. Say what number of plugins forces it.
5. **minor, both: the estimates (14-20 and 85-115 table-days) have no line items.** The cheaper options can't be compared without them. The record should show which tasks make up the 77.
6. **minor, 0452: Play Stats' two registrations are small registries** (`plugins.ts:78-80`; `playStats.ts` is 124 lines). Replacing them touches audio, animation and navigation (frozen, so an adapter) to fold counters into a data source. See below.

## The cheapest version of 0452

Premise: audio's pipeline can't carry other plugins' data and the Studio can't show it. The cheapest credible answer is a sequence where each step ships alone:

- **A. Generalise in place.** Rename `ctx.take.source` to `ctx.diagnostics.source`, move the registry from `src/engine/audio/take/extensions.ts` to `src/engine/diagnostics/`, add optional `deepLinks` and `reExecute` to what a source returns, and register `core/frames` through it. Audio keeps its type numbers. Gives up: nothing the owner asked for; the framing still lives in audio's plugin. Roughly a quarter of the proposed cost (my estimate).
- **B. Then move the framing into the engine, mechanically, with no META source table.** `format`, `reader`, `takeRecorder`, `takeOwnership` and `trigger` are about 1,100 lines (from the line counts). The engine owning the format is goal 1 ("feature knowledge out of the core"), so do it, but as a plain move.
- **C. Keep two formats, share a registry (a cut I price but would not take).** If collapsing take and capture is costly (the TAKE flag, F9/F10, `audioTake` vs `audioCapture`, `Audio.take`, amendments to 0348/0417), keep both and have both draw from the one registry. Gives up: "one concept, one key". Saves perhaps 10-15 of the 77 table-days (estimate). The owner asked for the collapse and it simplifies the user story, so this is the one cut I would not make.
- **Keep Play Stats' two points.** Make `core/frames` a source that Play Stats reads, and leave `registerPlayStatsCounter/Table` for plugin counters until a plugin wants a counter in a capture. Saves the navigation adapter and the audio and animation editor edits. Gives up: goal 2 for counters only, and goal 1's "one way to do each thing" (two registries for similar things persist).
- **Profiler: interface first, files last.** Write the host interface (open and save files, status, theme, open asset) as a type and make `src/studio/screens/profiler/` (39 files) use it; move files into `src/studio/profiler/` at the end. The owner fixed "self-contained module", so this is ordering, not a cut. It avoids churn while the audio views are still changing (0411/0412).
- **Defer the `diagnostics` manifest key.** Phase 1 has one plugin with views (audio) and core views; audio's views can move within audio's editor half. Add the key when a second plugin has views.

Cheapest total: A + B + the host interface. It meets the owner's constraints and delivers goal 1 and most of goal 2. It gives up the single registry for counters and the dynamic type table, neither of which a phase 1 consumer needs.

## The cheapest version of 0451

Premise: localisation can't be disabled, replaced or packaged because tables and messages live in the engine. Given issue 1:

- **Provider setter, no file moves (about 2-4 table-days, my estimate).** Add a setter (or `ctx.contribute` point) that calls `localeStringsChanged(provider)`. `myco.localisation` registers the provider and the panel. Plugin disabled: `noStrings`, so keys show and warn once, which is the record's own disabled behaviour, already in `Locale.ts:100,145-157`. Saves: the moves of `strings/`, `message/`, `runtime/`, `t.ts`, the import churn (about 17 non-test importers across editor, export, studio and audio from my grep), the `src/engine/index.ts` change, and `Locale`'s test rework. Gives up: goal 3 (a game with localisation off still ships the parsers and ICU, about 14 kB compressed, 2% of up-front load per the record) and part of goal 1 (feature code stays under `src/engine/`). "Smallest move, no rewrite" supports this reading.
- **Step 2, optional: move `strings/` and `runtime/` only.** Table parsing and the build registry are the part a replacement provider would actually replace. `message/` and `Locale` stay.
- **Step 3: panel and `strings` asset kind.** The editor half's registration is independent of the runtime half and can move last.

Against the record this saves the `message/` and `t.ts` moves and the new `myco.subtitles` and audio dependency edges (`Locale.has/t` keep working with the engine owning `Locale`). It gives up replacing ICU itself; a replacement can still replace tables and lookup.

## When the premise is wrong

**0452's premise is wrong if:**
- Only audio, animation and `core/frames` produce diagnostics over the next two milestones. Then a renamed registry is enough, and the source table, manifest key and dynamic type ranges serve plugins that don't exist.
- The take/capture collapse is the largest line item for the smallest user gain. Check it against the task table.
- Play Stats and captures want different data. Play Stats is live, per-frame, in-editor and cheap; captures are bounded, saved and heavy. If one shared `sample(writer, frame)` makes Play Stats sample into a writer while no tool is connected, that contradicts "nothing collected until a tool connects or Record is pressed".
- The profiler leaves the Studio later anyway. Then an interface now and a file move at the end loses nothing, and moving early only adds churn.

**0451's premise is wrong if:**
- A game with localisation off still needs `message/`. Audio captions and subtitles need `formatMessage` with the plugin off (the record gives audio an optional dependency), so `message/` must stay loadable from the engine, and moving it is bookkeeping, not decoupling.
- Nobody replaces the provider. "Others should be able to replace or extend it" is the only reason for a new `lookup/format/changed` interface, and `LocaleStrings` already is one.

**Where the records are right:** the plugin framing for localisation matches the owner's words, and one diagnostics point is cleaner than today's three registries (take source, debug topic, Play Stats). The question is scope and order, not direction.

## Cheaper alternatives

See the two "cheapest version" sections. Add them to each record's Alternatives list.

## Questions for the author

1. What does `diagnostics.source` do that `registerTakeSource` plus optional fields doesn't?
2. Why does `format` belong to the provider when `Locale` owns fallback chains and `Intl` plural rules (`strings.ts:7-9`)?
3. Does a source's `sample` run when no tool is connected and no capture is on, for `core/frames` and Play Stats? How is "nothing collected" kept?
4. Which tasks make up the 77 table-days, and how many are the take/capture collapse?
5. Is a game with localisation off meant to ship without `message/`? If not, why does it move?
