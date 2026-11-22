# 0328. The audio core's init parameters are one generated wire record, written into the inbox

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0157 (api-and-models §5, the C ABI table and contract K2; amended: `myco_audio_init` takes no arguments), 0162 (C8, ABI 2.0), 0166 (W1, ABI 3.0), 0171/0172 (ABI 4.0), 0177 (the STATUS header described once), 0327 (the memory exports read the same record)

## Context

Every other record that crosses the core's seam is described once in `audio-wire`'s schema and generated for Rust,
TypeScript and the byte vectors, with a hash both sides check. The init parameters (`InitParams`, `audio-core/src/
params.rs`) were not: ten positional arguments in two exports (`myco_audio_init`, `myco_audio_layout_bytes`), written
three times in Rust and redeclared and called positionally in `coreDriver.ts`, its test and `core/debug.ts`'s
`emptyPreset`. ABI 2.0 and 3.0 were major bumps only because init gained parameters; an order mistake fails silently; a
refusal said only `INVALID_ARGUMENT`. Separately, the ABI version itself was copied by hand four times (`lib.rs`,
`coreDriver.ts`, `capture/format.ts` 0x400, `runtime/testing.ts`), and `coreDriver.ts` repeated the generated STATUS
column offsets and the trap flag.

## Decision

- **INIT is a wire kind** (13, `schema/envelope.rs`, `Dir::ShellToCore`): `sampleRate` f32, then `maxLogical`,
  `maxMixed`, `maxBuses`, `arenaInitialBytes`, `maxBeds`, `maxZoneSlots`, `zoneMaxFrames`, `maxWide`, `maxMusicRings`
  (u32), 40 B after the envelope. `gen_wire` generates `wire::Init` and `writeInit`/`readInit`; a vector covers it. It is
  never posted on a port, so the envelope version stays 1.3; the core's ABI major guards it.
- **The shell writes it at the inbox's start** (static, so it exists before init; `worklet/coreMemory.ts`
  `writeInitRecord`, from `initRecord(preset, rate)`, which turns `zoneMaxSeconds` into frames). `myco_audio_init()`,
  `myco_audio_memory_pages` and `myco_audio_memory_part_bytes` (ADR 0327) read it with the generated reader
  (`InitParams::read`).
- **A refusal names the field:** nine error codes `INIT_` + the field's name (`ERR_INIT_MAX_MIXED`, -17..-25; the old
  `Zones` refusal split into `INIT_MAX_ZONE_SLOTS` and `INIT_ZONE_MAX_FRAMES`). A schema test checks every `INIT_*` code
  names an INIT field; the shell's `CoreLoadError` reads "refused maxMixed 0 (INIT_MAX_MIXED, code -19)". A missing or
  foreign record is `BAD_MAGIC`, `VERSION_MISMATCH`, `TRUNCATED` or `MALFORMED`.
- **ABI 5.0** (a major change, contract K2: `myco_audio_init` changed meaning, two exports removed, two added; nothing
  is renumbered silently). The version is generated beside the schema hash (`CORE_ABI_MAJOR`, `CORE_ABI_MINOR`,
  `CORE_ABI_VERSION` in `schema.rs`): `lib.rs`, `coreDriver.ts` (`CORE_ABI_MAJOR` re-exported), `capture/format.ts`
  (`CAPTURE_ABI_VERSION`) and `testing.ts` read it. A future init parameter is a schema edit and an ABI minor at most.
- **The capture header stamps the running core's ABI** (its first STATUS `abiVersion`, now in `Audio.debug().core`),
  falling back to this build's on Babylon.
- **The shell's STATUS fields** come from the generated `STATUS_HEADER_COLUMNS` and `STATUS_FLAGS_TRAP_CAUGHT`.
- **`core/initParams.ts` stops clamping**: the settings parser holds each value in range and the core refuses anything
  else by name.
- The schema hash now covers the ABI version and INIT, so the shell checks the hash before writing INIT (`openCore`).

## Alternatives considered

- **Keep positional arguments, generate the TypeScript signature:** still an ABI major per parameter and no named
  refusal.
- **A blob header instead of a kind:** no envelope, so no magic or version check on a stale inbox.
- **Pass a pointer to a struct in linear memory:** what the inbox already is, without the generated reader.

## Consequences

**Positive**
- Leverage: a new parameter is a schema edit; the schema hash enforces both sides; order mistakes can't happen.
- A refused preset says which parameter and what value.
- One ABI number, generated.

**Negative / costs**
- Every caller must write INIT before `myco_audio_init`; an old shell against this core gets `BAD_MAGIC` (it is refused
  earlier on the ABI major anyway).
- The schema hash changes with every ABI bump.

## Deprecates

The ten-argument `myco_audio_init` and `myco_audio_layout_bytes` (ABI 4.0); `InitError::Zones`; the hand-copied ABI
numbers; `bedInitParams` and the clamps in `core/initParams.ts`; `emptyPreset` in `core/debug.ts`.

## Open questions

None.

## References

- `native/audio/crates/audio-wire/src/schema/envelope.rs` (`INIT_FIELDS`), `schema.rs` (`CORE_ABI`, `INIT_*` codes,
  `MemoryPart`), `vectors/cases.rs` (`init_cases`).
- `native/audio/crates/audio-core/src/params.rs` (`InitParams::read`, `InitError::code`), `audio-wasm/src/lib.rs`.
- `src/plugins/audio/runtime/worklet/coreMemory.ts`, `worklet/coreDriver.ts`, `capture/format.ts`, `capture/capture.ts`.
