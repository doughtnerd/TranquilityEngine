# 0326. One profiler table kit filters, summarises and chooses the empty state for every table

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0171, 0172, 0219, 0261

## Context

The Profiler's tables region (0171 amended by 0172, Pf5) shows four tables at the cursor under one name filter:
voices, buses, event instances and music. Each table's data was built by its own function with the same steps:
`busTableData` (`BusTable.tsx`), `voiceTableData` (`VoiceTable.tsx`) and `rowsData` for events and music
(`profilerTables.tsx`), each taking the filtered rows, an unfiltered count and a context, and writing its own summary
("N buses", "N voices", "N of M event instances") and calling `tableEmptyText`. The composition that fed them
(`profilerTablesData`) was private, so no test could ask "at this seek and filter, what does each table show". It
chose which context went to which table, read "before the first keyframe" from `seek.keyframe === null` for three
tables and from the replay's `fromKeyframe` for the voices, and ran `eventRows` and `musicRows` twice (with and without
the filter) to count the unfiltered rows; the filter lived in four row builders. The section markup (title, summary,
empty text or a windowed grid) was written three times (`BusTableView`, `VoiceTableView`, `RowsTableView`), and
`profilerTables.test.ts` and `profilerTables.stories.tsx` copied the private `TABLE_EMPTY` strings verbatim. 0261 did
the same deepening for the profiler's tracks.

## Decision

We will build every profiler table through one table kit and draw it in one section.

- **The kit** (`profilerTablesModel.ts`): `profilerTable(kind, all, filter, seek)` takes a table kind
  (`"voices" | "buses" | "events" | "music"`), the unfiltered rows and the seek context (`TableSeek`: answered,
  playing, truncated, before the first keyframe; `tableSeek` derives it once from the seek) and returns a
  `ProfilerTable`: the rows after the filter, every row (`all`, which names a voice's thief), the summary and the
  empty state. The filter (by each kind's names: clip and bus, bus, event, segment), the summary wording ("N voices",
  "2 of 4 voices", singular for one; the voices' keyframe caveat) and the empty-state choice are written once. The
  empty state is a value (`TableEmpty`: `noCursor`, `noMatch`, `none`, or one of `emptyStates.ts`' kinds), worded by
  `tableEmptyText(kind, empty)`.
- **The composition is the kit's interface**: `profilerTables(source, seek, filter, playing)` returns the four tables
  from the row builders (`voiceRows`, `busTableRows`, `eventRows`, `musicRows`, none of which filters any more), each
  built once. The region (`ProfilerTables`) calls it.
- **One section view** (`ProfilerTableSection.tsx`, `TableSection`) draws any table: title, summary, empty text or the
  windowed grid. A table is a `TableColumns<T>`: its title, column list, row key, cells (built once per table) and row
  state: `VOICE_TABLE` (`VoiceTable.tsx`), `BUS_TABLE` (`BusTable.tsx`), and the event and music tables in
  `profilerTables.tsx`.
- **Tests drive the kit**: given a seek state and a filter, each table's rows, summary and empty state
  (`profilerTables.test.ts`); the wording is checked once. The stories render `TableSection` and the region through
  their real props and compare empty texts with `tableEmptyText`; no test copies the strings.

## Alternatives considered

- **Keep per-table data functions and share only the markup** — leaves four summaries and four empty-state calls to
  drift, and the composition still untestable.
- **A generic `Table` component taking rows and callbacks, no model kit** — puts the filter and the wording in the view,
  where the unit tests can't reach them without a DOM.

## Consequences

**Positive**
- A new profiler table is a column list and a row builder; the filter, summary and empty states come with it.
- The region's behaviour at a seek state is unit tested without rendering.
- One source for "before the first keyframe" (the seek), and each row builder runs once per seek and filter.

**Negative / costs**
- The summaries now say "1 voice" and "1 bus" (they said "1 voices", "1 buses"); events and music already did.

## Deprecates

`busTableData`/`BusTableData` and the `BusTable` component, `voiceTableData`/`VoiceTableData` and the `VoiceTable`
component, `rowsData`, `profilerTablesData`, `RowsTable`, `voiceSummary`, `TableEmptyInput`, the old
`tableEmptyText(kind, input)`, and the `filter` parameters of `busTableRows` and `musicRows`. Removed (2026-11-22).

## Open questions

None.

## References

- `src/plugins/audio/editor/mix/profilerTablesModel.ts`, `ProfilerTableSection.tsx`, `BusTable.tsx`, `VoiceTable.tsx`,
  `profilerTables.tsx`; `profilerTables.test.ts`, `BusTable.stories.tsx`, `VoiceTable.stories.tsx`,
  `profilerTables.stories.tsx`.
