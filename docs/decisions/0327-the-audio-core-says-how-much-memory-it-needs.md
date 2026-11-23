# 0327. The audio core says how much Memory it needs; the shell asks a throwaway instance instead of mirroring the layout

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** 0162 in part (contract C8's "the shell's TypeScript mirror of the layout, tested against `myco_audio_layout_bytes`")
- **Related:** 0157 (api-and-models §5, the C ABI; architecture §5.1, the Memory's `maximum`), 0162 (C8, the M3 regions and the zone kernel budget), 0166 (the music rings; build log F-1), 0328 (the INIT record this reads)

## Context

The worklet creates the core's `WebAssembly.Memory({ initial: 64, maximum })` (architecture §5.1). `maximum` must hold
every fixed region, the arena grown to the clip ceiling, the zone kernels (outside `clipMemoryMB`) and the HRIR data.
Until now `worklet/coreMemory.ts` (187 lines) computed it from a TypeScript mirror of `layout.rs`: about fifteen copied
Rust constants (`BEDS_*` 20,800 / 33,792 / 65,600, `FX_ENTRY_BYTES` 448, `ZONE_SLOT_HEADER_BYTES` 2,208, 307,200 B per
music ring), a third copy of the HRTF FFT-size rule, and one guess, `M2_REGIONS_HEADROOM_BYTES` = 16 MiB, for every region
it did not copy. `core/debug.ts` built the memory row from differences of the mirror, and the tests compared mirror
differences with the wasm's `myco_audio_layout_bytes` within a 65,536 B tolerance.

The guess is measurably short. At a 192 kHz context with the voice counts the settings parser allows (`voices.logical`
8,192, `mixed` 512) the fixed regions are 43.25 MiB against 40.12 MiB of room: 3.13 MiB short, so the arena refuses to
grow below the clip memory the project asked for (open follow-up F-1 in `docs/design/0166-audio-music/build-log.md`).
`myco_audio_layout_bytes` and `myco_audio_zone_kernel_budget_bytes` were already pure and callable before `init`.

## Decision

We will let the core answer, and delete the mirror.

- **`myco_audio_memory_pages(clip_ceiling_bytes) -> i32`** (ABI 5.0): the 64 KiB pages the core grows its Memory by over
  its life, past the module's own pages, for the INIT record in the inbox (ADR 0328): `audio_core::layout::
  memory_growth_bytes` = the block `init` takes (`Layout::total`, the arena's initial reserve included) + the arena's
  growth to the clip ceiling + the zone kernel budget + the spatial data. Pure; a refused record gives its negative code.
- **Growth to the clip ceiling** (`clip_growth_bytes`): main counts `clipMemoryMB` in raw bytes, the arena in size
  classes, which waste under 25% of a request of 4 KB or more and give a smaller one 4 KB. So the clips take at most
  `5/4 × ceiling + 4,096 directory entries × 4 KB` (16 MiB), less the initial reserve. Fragmentation from unloads is not
  counted (the arena never splits or merges; refusedGrow stays the answer there).
- **Spatial data** (`spatial_data_bytes`): the largest HRIR table the core accepts (Chromium's 10 × 24 grid at
  `MAX_IR_LENGTH` 1,024) and its HRTF bank, at a rate HRTF runs at, plus the MagLS filters at 512 taps when a bed or a
  wide stream's private decoder is laid out; each rounded to its arena class.
- **`myco_audio_memory_part_bytes(part) -> i32`** (ABI 5.0): one generated `MemoryPart` (`Layout`, `Beds`, `Zones`,
  `Wide`, `ZoneKernels`, `SpatialData`) for the debug panel's memory row. They replace `myco_audio_layout_bytes` and
  `myco_audio_zone_kernel_budget_bytes`, which are removed.
- **The shell asks a throwaway instance** (`worklet/coreMemory.ts` `askCoreMemory`): the same module on a Memory of 64
  pages that never grows, the INIT record written into its inbox, the two exports read; `instantiateCore` then makes the
  real Memory with `maximum` = 64 + the answer. A refusal throws `CoreLoadError` naming the field.
- **The debug memory row** asks the same way, with the module the page loaded (`core/loader.ts` `loadedCoreWasm`, set by
  `loadCoreWasm`), memoised per module and preset. Before the page loaded a core (a recording host) there is no row.
- **Kept in TypeScript:** `clipSampleBytes` (the wire's clip formats) and `zoneKernelBlobBytes` (the format 3 blob main
  builds, from the schema's generated constants). No region size.

## Alternatives considered

- **Raise `M2_REGIONS_HEADROOM_BYTES`** (F-1's first suggestion): moves the tripwire once more; the next region or rate
  overruns it again, and the mirror and its tolerance stay.
- **Keep the mirror and test it harder:** fifteen constants and a rule copied three times stay; every region change edits
  two languages.
- **Report region sizes in STATUS:** the header is full (256 B), and main would know them only after the first block,
  which is too late for `maximum`.

## Consequences

**Positive**
- Locality: the layout rule lives only in `layout.rs`; a new region cannot silently overrun the Memory.
- F-1 is closed: the 192 kHz, 8,192-voice preset fits with an arena full to the ceiling (`coreDriver.test.ts`,
  `layout.rs` tests).
- Tests check the core's real answer, not mirror differences with a 64 KB tolerance.

**Negative / costs**
- Starting a core instantiates the compiled module twice (the throwaway's 4 MiB Memory is dropped at once); not
  measured separately.
- `maximum` is larger than before for large clip ceilings (5/4 of the ceiling plus 16 MiB, against the ceiling plus
  16 MiB); it is a cap, not committed memory.
- The debug memory row needs a loaded core: it is absent on the recording host unless a test loads one.

## Deprecates

`M2_REGIONS_HEADROOM_BYTES`, `memoryMaximumPages`, `fixedRegionsHeadroomBytes`, `spatialRegionsBytes`,
`zonesRegionBytes`, `zoneSlotStateBytes`, `zoneKernelBudgetBytes`, `arenaBlockBytes`, `m4FixedRegionsBytes`,
`musicRingsBytes`, `zoneMaxFrames` (removed); the exports `myco_audio_layout_bytes` and
`myco_audio_zone_kernel_budget_bytes` (removed in ABI 5.0).

## Open questions

None.

## References

- `native/audio/crates/audio-core/src/layout.rs` (`memory_growth_bytes`, `memory_part_bytes`, `clip_growth_bytes`,
  `spatial_data_bytes`), `native/audio/crates/audio-wasm/src/lib.rs`.
- `src/plugins/audio/runtime/worklet/coreMemory.ts`, `worklet/coreDriver.ts`, `core/debug.ts`, `core/loader.ts`.
- `docs/design/0166-audio-music/build-log.md` F-1.
