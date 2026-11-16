# 0177. The wire generator describes the STATUS block once: a zero-allocation reader, the header record and the capture's columns

- **Status:** Accepted
- **Date:** 2026-11-15
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0157, 0171

## Context

The STATUS block is the audio worklet's report to the main thread (ADR 0157, api-and-models §4.3; 256 bytes of header and fifteen sections since ADR 0171's M5). Its layout is data in `native/audio/crates/audio-wire/src/schema/status.rs`, and `gen_wire` emits `writeStatus` and `readStatus` into `src/plugins/audio/runtime/wire.generated.ts`. The generated `readStatus` builds a fresh block, arrays and items per message, which the main thread can't afford per block (#66), so the layout was described three more times by hand:

- `core/statusReader.ts` (510 lines) re-implemented the decode with about 106 `DataView` reads "at the same field offsets", one `validateMn`/`readMn` pair per milestone.
- `capture/reader.ts` hand-coded a third offset table (`STATUS_COLUMNS`, 40 of the 56 header scalars) for the capture's `range`, cross-checked by a test.
- `core/mirror.ts` copied about 55 header fields one by one into its own properties, and `makeStatusBlock` listed them all again.

A single counter (`streamStartsLate`, `bedVoices`) appeared in six to eight files; commit 63ea09f ("StatusReader M5 sections, mirror fields") shows what each milestone paid. The hand copies are shallow modules: their interface (read a STATUS by name) is as wide as their implementation (one line per field), and the knowledge they hold is already in the schema.

## Decision

We will have `gen_wire`'s TypeScript emitter (`gen/ts.rs`) emit everything that follows from the layout, and keep in hand code only what the schema can't say (semantic checks and derived values). The schema, the generated Rust and the wasm don't change.

`wire.generated.ts` gains:

- **`StatusHeader`**: the header's scalars by name (section counts excluded: they are the sections' lengths). `StatusBlock` now `extends StatusHeader` (the same type as before), with `newStatusHeader()`, `copyStatusHeader(dst, src)` and `newStatusBlock()`.
- **`STATUS_HEADER_COLUMNS`**: every header scalar as `name: [byte offset from the envelope, type]`, `satisfies Record<keyof StatusHeader, …>`, with `readStatusHeaderField(view, off, field)` (in place, no allocation). The capture's `STATUS_COLUMNS` and `readStatusColumn` are these.
- **`StatusBlockReader`**: decodes a whole STATUS into one preallocated `block`. Section arrays are warmed to each cap once and multi-field items are pooled objects; `readView(view)` allocates nothing, `read(buf)` builds one `DataView`. The same checks, codes and messages as `readStatus`, and every section is validated before the block is touched. A subclass adds semantic checks in a protected `check(view, limit)` hook, which runs after the structural checks and before any write, with `sectionAt` and `sectionCount` (indexed by the generated `STATUS_SECTION`) filled in.
- `STATUS_<SECTION>_ITEM_AT` (field offsets) for the sections whose items hand code reads in place (today `loudBuses`, for the count-sum rule). Tests find count fields, caps and item fields through `writeStatus` and `readStatus` themselves (the per-section count-offset and cap tables were dropped: only a test read them).

Hand code:

- `core/statusReader.ts`'s `StatusReader` extends `StatusBlockReader` and adds only the M5 count-sum rule (the `loudBuses` new-block counts sum to `loudEnergyCount`, else `MALFORMED`; ADR 0171 §4.3).
- `StatusMirror` keeps the newest header as one record, `mirror.header` (a `StatusHeader`, copied whole by `copyStatusHeader`). Its own fields are only what main derives: `abiVersion` (the first non-zero), `loadPermille` (main's CPU figure; the wire's is reserved 0), `minSlackSinceFrame`, `frameAudio`/`frameDateMs`, `m3Recoveries`, `underrunFrame`. Readers of a header value use `mirror.header.<name>`.
- `CoreLink.statusDecoder` gets the link's own `DataView` as a second argument, so the core backend decodes with `readView` and the per-block decode allocates nothing at all.
- The capture's `checkStatusPayload` and the recorder tap read `currentFrame` at `STATUS_HEADER_COLUMNS.currentFrame[0]`.

A new header field or section now needs the schema and `npm run build:audio`; it reaches the reader, `mirror.header` and the capture's columns by name. Where `Audio.debug()` shows it (`counters`, `musicTotals`, `mix`, `core`) remains a one-line choice in `core/debug.ts`, since that is meaning, not layout.

The capture file format is unchanged: a capture stores raw STATUS blocks, and only the set of columns `range` accepts grows (from 40 to every header scalar). Saved `.mycap.bin` files open as before.

## Alternatives considered

- **Make the generated `readStatus` itself non-allocating** (an `into` parameter). It is the allocating convenience the capture Worker, the tests and fuzzers use to get a fresh object; pooled items in its result would surprise them. A separate class keeps both contracts plain.
- **Keep the mirror's per-field properties as generated getters over `header`.** Keeps every call site, but adds a second name for each field and a generated block of accessors to the mirror's interface; one record is the deeper interface.
- **Pass the raw header through to `AudioDebugInfo`** (for example `core.status`), so a new counter reaches `Audio.debug()` with no edit. It widens the public debug shape with wire names and reserved fields; not done here.
- **Emit the hand semantic rule from schema metadata.** Any schema change changes the schema hash, the generated Rust and the wasm; the one rule (the count sum) doesn't justify a rule language.

## Consequences

**Positive**
- The STATUS layout lives in one place; `statusReader.ts` falls from 510 lines to about 30, the capture's offset table and the mirror's ~55 copies go, and three per-milestone reader test files collapse into one generated round trip.
- The core backend's STATUS decode allocates nothing per block (before, one `DataView` per read).
- Every header field is a capture column.

**Negative / costs**
- `wire.generated.ts` grows by about 800 lines (the unrolled reader and the tables).
- `mirror.<field>` became `mirror.header.<field>` across call sites, end-to-end specs included.
- `gen/ts.rs` is hashed into the wasm's source hash (`wasm/sourceHash.test.ts`), so the generator change needs a rebuild of the committed wasm (its bytes change only in the embedded hash); see the build log.

## Deprecates

- `StatusReader`'s hand decode (`validateM3`/`readM3` … `readM5`): removed; it is now the generated `StatusBlockReader` plus the count-sum check.
- The capture reader's hand `STATUS_COLUMNS` table: replaced by the generated one (same export name).
- `StatusMirror`'s per-field header properties: removed in favour of `mirror.header`.
- `statusReader.test.ts`, `statusReaderM3.test.ts`, `statusReaderM4.test.ts`, the `StatusReader` section of `wireMainM5.test.ts` and the column parity test in `capture/worker.test.ts`: replaced by `core/statusBlock.test.ts` and the generator test `status_header_columns_and_reader_cover_every_field`.

## Open questions

- Whether `Audio.debug()` should carry the raw STATUS header for tools (see the third alternative).

## References

- ADR 0157 (api-and-models §4.3), ADR 0171 (§4.3, the M5 header and sections).
- `native/audio/crates/audio-wire/src/gen/ts.rs` (`emit_status_extras`), `src/plugins/audio/runtime/wire.generated.ts`.
- Commit 63ea09f (the per-milestone cost this removes).
