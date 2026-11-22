// The core's Memory layout as main and the worklet size it (architecture §5.1; ADR 0162 C8): the initial pages, the
// fixed regions past the arena (M2's headroom, the beds, zones, wide and music stream rings, the FX pool) and the
// Memory's maximum. A TypeScript mirror of audio-core's `layout.rs` and friends; `coreDriver.test.ts` checks it against
// the wasm's own `myco_audio_layout_bytes` and `myco_audio_zone_kernel_budget_bytes`, so a drift fails a test.
import type { CorePreset } from "./coreDriver";
import {
  ClipFormat,
  FX_MEMORY_SECONDS,
  STREAM_MAX_CHANNELS,
  STREAM_RING_FRAMES_WIDE,
  STREAM_WIDE_CHUNK_FRAMES,
  ZONE_HEAD_BINS,
  ZONE_KERNEL_HEADER_BYTES,
  ZONE_KERNEL_MAX_HEAD_PARTS,
  ZONE_TAIL_BINS,
} from "../wire.generated";

/** @internal Pages the shell's Memory starts with: the same every time (`native/audio/build.mjs` uses 64), which is what makes init deterministic (A0.1). */
export const MEMORY_INITIAL_PAGES = 64;
/** @internal WebAssembly's page size. */
export const PAGE_BYTES = 65_536;
/**
 * @internal Headroom in the Memory's `maximum` for M2's fixed regions past the arena (architecture §5.1: ≈ 7.7 MB, 9.6 MB
 * high, plus the 0.75 MB HRIR). ADR 0162's regions and the zone kernels come on top: `fixedRegionsHeadroomBytes`. 18 MiB since
 * ADR 0332/0328: the automation region's time clocks, voice start frames and loop-program pool took the last of 16 MiB on
 * the largest preset (8,192 logical voices at 96 kHz: 16.1 MB with the HRIR 16.9 MB).
 */
export const M2_REGIONS_HEADROOM_BYTES = 18 << 20;
/** wasm32's limit: 4 GiB. */
const MAX_PAGES = 65_536;

// ADR 0162 C8: a TypeScript mirror of the layout of the regions ABI 2.0 adds (audio-core `bed.rs`, `zones.rs`,
// `stream.rs`, `fxpool.rs`, `layout.rs`). `coreDriver.test.ts` checks it against the wasm's own
// `myco_audio_layout_bytes` and `myco_audio_zone_kernel_budget_bytes`, so a drift fails a test.
const REGION_ALIGN = 64;
const QUANTUM = 128;
/**
 * The `Beds` region's parts (`bed::region_bytes`, A4): a header, the FFT scratch, the shared MagLS filters for P partitions,
 * then one slot (16-channel accumulator + decoder) per bed or private decoder. P is the HRTF's partition count at the rate
 * (2 up to 48 kHz, 4 from 88.2 kHz); at other counts MagLS can't run and a slot is its accumulator alone.
 */
const BEDS_HEADER_BYTES = 20_800;
const BEDS_SCRATCH_BYTES = 33_792;
const BEDS_FILTER_BYTES: Readonly<Record<number, number>> = { 2: 65_600, 4: 131_136 };
const BEDS_SLOT_BYTES: Readonly<Record<number, number>> = { 2: 49_216, 4: 81_984 };
const BEDS_ACC_ONLY_SLOT_BYTES = 8_192;

/** `hrtf::partitions_for_sample_rate`: the HRTF's FFT size at the rate (as `core/hrir.ts`'s `hrtfFftSize`) over 256, at least 1. */
function bedPartitions(sampleRate: number): number {
  const ratio = Math.fround(Math.fround(sampleRate) / 44100);
  const exponent = Math.min(Math.max(0, Math.floor(Math.log2(256 * ratio))), 29);
  const fft = 2 * Math.max(2, 2 ** exponent);
  return Math.max(1, fft / 256);
}

function bedsRegionBytes(slots: number, sampleRate: number): number {
  if (slots === 0) return 0;
  const p = bedPartitions(sampleRate);
  return BEDS_HEADER_BYTES + BEDS_SCRATCH_BYTES + (BEDS_FILTER_BYTES[p] ?? 0) + slots * (BEDS_SLOT_BYTES[p] ?? BEDS_ACC_ONLY_SLOT_BYTES);
}
/** `stream::FADE_TAIL_FRAMES`. */
const FADE_TAIL_FRAMES = 1_536;
/** `stream::WIDE_RING_BYTES`: 16 × (32,768 + 2,048 + 1,536) × 4 B (R16 after B4's stall test). */
const WIDE_RING_BYTES = STREAM_MAX_CHANNELS * (STREAM_RING_FRAMES_WIDE + STREAM_WIDE_CHUNK_FRAMES + FADE_TAIL_FRAMES) * 4;
/** `fxpool::FX_ENTRY_BYTES`. */
const FX_ENTRY_BYTES = 448;
/** `layout::PLANAR_SCRATCH_BYTES`. */
const PLANAR_SCRATCH_BYTES = 16 * QUANTUM * 4;

const alignUp = (n: number, to: number): number => Math.ceil(n / to) * to;
const headParts = (frames: number): number => Math.min(Math.ceil(frames / QUANTUM), ZONE_KERNEL_MAX_HEAD_PARTS);
const tailParts = (frames: number): number => Math.ceil(Math.max(0, frames - ZONE_KERNEL_MAX_HEAD_PARTS * QUANTUM) / ZONE_TAIL_BINS);

/** @internal `zones::kernel_blob_bytes`: a format 3 blob for an IR of `frames`. */
export function zoneKernelBlobBytes(frames: number): number {
  return ZONE_KERNEL_HEADER_BYTES + 2 * headParts(frames) * ZONE_HEAD_BINS * 8 + 2 * tailParts(frames) * ZONE_TAIL_BINS * 8;
}

/** @internal `zones::kernel_budget_bytes` (`myco_audio_zone_kernel_budget_bytes`). */
export function zoneKernelBudgetBytes(maxZoneSlots: number, zoneMaxFrames: number): number {
  return maxZoneSlots === 0 ? 0 : maxZoneSlots * arenaBlockBytes(zoneKernelBlobBytes(zoneMaxFrames));
}

/** @internal `zones::arena_block_bytes`: the arena size class a request takes (four per doubling from 4 KB). */
export function arenaBlockBytes(bytes: number): number {
  for (let d = 0; d < 20; d++) {
    for (let s = 0; s < 4; s++) {
      const block = 1024 * 2 ** d * (4 + s);
      if (block >= bytes) return block;
    }
  }
  return Infinity;
}

/** `zones::SLOT_HEADER_BYTES`: a slot's header (state, ramps, stereo input and wet buffers), 32 past a 64-byte boundary. */
const ZONE_SLOT_HEADER_BYTES = 2_208;


/** @internal `zones::slot_state_bytes`: one zone slot's convolver state. */
export function zoneSlotStateBytes(frames: number): number {
  // `instance::state_bytes`: header, per channel the head input (32 x 128 bins + a quantum), the tail delay line,
  // the accumulator, the 8,192-frame input ring and the 4,096-frame accumulation buffer.
  const instance = 32 + 2 * (ZONE_KERNEL_MAX_HEAD_PARTS * ZONE_HEAD_BINS * 8 + QUANTUM * 4) + 2 * tailParts(frames) * ZONE_TAIL_BINS * 8 + 2 * ZONE_TAIL_BINS * 8 + 2 * 8_192 * 4 + 2 * 4_096 * 4;
  return alignUp(ZONE_SLOT_HEADER_BYTES + instance, REGION_ALIGN);
}

/**
 * @internal `zones::region_bytes`: the slots, the aux accumulator (`max_buses` x 1 KB, with or without slots), the sends
 * area (`zones::sends_bytes`: a 64-byte header and `max_buses` x 512 B of chain gains) and a 64-byte tail.
 */
export function zonesRegionBytes(maxZoneSlots: number, zoneMaxFrames: number, maxBuses: number): number {
  const slots = maxZoneSlots > 0 ? maxZoneSlots * zoneSlotStateBytes(zoneMaxFrames) : 0;
  return slots + maxBuses * 2 * QUANTUM * 4 + (REGION_ALIGN + maxBuses * QUANTUM * 4) + REGION_ALIGN;
}

/** @internal `zone_max_frames`: the preset's longest zone IR at the context rate (0 without zone slots). */
export function zoneMaxFrames(preset: CorePreset, sampleRate: number): number {
  return preset.maxZoneSlots > 0 ? Math.ceil(preset.zoneMaxSeconds * sampleRate) : 0;
}

/**
 * @internal ADR 0162 C8: bytes of the regions ABI 2.0 adds before the arena (`Beds`, `Zones`, `Wide`, `Fx` and the planar
 * scratch), each aligned as `layout.rs` aligns it. 0 for the first three when their parameter is 0.
 */
export function spatialRegionsBytes(preset: CorePreset, sampleRate: number): number {
  const beds = bedsRegionBytes(preset.maxBeds + preset.maxWide, sampleRate);
  const zones = zonesRegionBytes(preset.maxZoneSlots, zoneMaxFrames(preset, sampleRate), preset.maxBuses);
  const wide = preset.maxWide * WIDE_RING_BYTES;
  const fx = alignUp(preset.maxMixed * FX_ENTRY_BYTES, REGION_ALIGN);
  return [beds, zones, wide, fx, PLANAR_SCRATCH_BYTES].reduce((sum, n) => sum + alignUp(n, REGION_ALIGN), 0);
}

/**
 * @internal The Memory's headroom past the arena for these parameters (replaces M2's constant): M2's regions, ADR 0162's
 * regions (`spatialRegionsBytes`) and the zone kernel budget (kernels are arena clips outside `clipMemoryMB`, C8).
 */
export function fixedRegionsHeadroomBytes(preset: CorePreset, sampleRate: number): number {
  return (
    M2_REGIONS_HEADROOM_BYTES +
    spatialRegionsBytes(preset, sampleRate) +
    m4FixedRegionsBytes() +
    fxMemRegionBytes(sampleRate) +
    musicRingsBytes(preset) +
    zoneKernelBudgetBytes(preset.maxZoneSlots, zoneMaxFrames(preset, sampleRate))
  );
}

/**
 * @internal ADR 0166 M4 (API section 3.1, 5.3): the regions the core lays out on every preset before the arena, which
 * Q1 adds to `layout.rs`: `Due` (256 due + 128 parked records of 48 B = 18,432 B), `Curves` (255 entries, 8,160 B) and
 * `Groups` (16 entries, 2,560 B) = 29,152 B, each aligned as `layout.rs` aligns it. A mirror of the core's layout once Q1
 * has merged; it is only a headroom bound (M2's 16 MiB constant already covers it), so a small drift cannot overrun.
 */
export function m4FixedRegionsBytes(): number {
  return [18_432, 8_160, 2_560].reduce((sum, n) => sum + alignUp(n, REGION_ALIGN), 0);
}

/** `fxmem::BLOCK_FLOATS` and `fxmem::MAX_BLOCKS`; the header is 4 counters and a byte per block, 64-byte aligned. */
const FX_BLOCK_FLOATS = 4_096;
const FX_MAX_BLOCKS = 2_048;
const FX_HEADER_BYTES = alignUp(16 + FX_MAX_BLOCKS, REGION_ALIGN);

/**
 * @internal ADR 0331 (ABI 4.6): the `FxMem` region (`audio-core/src/fxmem.rs` `region_bytes`): the effect memory of bus
 * chains and instance submixes (delay lines, reverbs), `FX_MEMORY_SECONDS` of stereo audio at the rate in 16 KB blocks
 * (7.7 MB at 48 kHz), laid out on every preset before the arena.
 */
export function fxMemRegionBytes(sampleRate: number): number {
  const rate = Math.fround(sampleRate) > 0 ? Math.fround(sampleRate) : 48_000;
  const blocks = Math.min(FX_MAX_BLOCKS, Math.ceil((FX_MEMORY_SECONDS * rate * 2) / FX_BLOCK_FLOATS));
  return FX_HEADER_BYTES + blocks * FX_BLOCK_FLOATS * 4;
}

/**
 * @internal The music rings' part of the `Streams` region: C1 sizes it `(G + M) x RING_BYTES` with `M` = `maxMusicRings`
 * (RING_BYTES 307,200). C1 lays them out after the general rings in the `Streams` region (`stream::region_bytes`).
 * C1 switched this function on (it returned 0 while W1 only passed the count); nothing else in the headroom changed.
 */
export function musicRingsBytes(preset: CorePreset): number {
  return preset.maxMusicRings * 307_200;
}

/** @internal Bytes per sample of a CLIP_BEGIN format (0 for a format the shell doesn't know): ADR 0162 C6 adds 3-5, all f32. */
export function clipSampleBytes(format: number): number {
  switch (format) {
    case ClipFormat.F32:
    case ClipFormat.ZoneKernel:
    case ClipFormat.MagLS:
    case ClipFormat.ZoneIrPcm:
      return 4;
    case ClipFormat.I16:
    case ClipFormat.HRIR:
      return 2;
    default:
      return 0;
  }
}


/**
 * @internal The Memory's `maximum` in pages: the initial pages, the fixed regions (`fixedRegionsHeadroomBytes`, with the
 * zone kernel budget) and the arena up to its ceiling (architecture §5.1, ADR 0162 C8).
 */
export function memoryMaximumPages(preset: CorePreset, sampleRate: number): number {
  const arena = Math.max(preset.arenaInitialBytes, preset.clipCeilingBytes);
  return Math.min(MAX_PAGES, MEMORY_INITIAL_PAGES + Math.ceil((fixedRegionsHeadroomBytes(preset, sampleRate) + arena) / PAGE_BYTES));
}
